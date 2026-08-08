// db/hosted/operator-runner.ts
//
// THE DECISION CORE OF THE BASELINE OPERATOR RUNNER.
//
// The runner exists because fifty operator round-trips is fifty chances to
// paste the wrong thing, and because a human comparing a psql result table
// against an expectation in a chat window is a verification step with no
// record. What it must NOT become is `foreach file { psql }` — the per-unit
// guarantees are the whole point, so they move into code rather than
// evaporating.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE HAS NO I/O
// ---------------------------------------------------------------------------
// Every function here is pure. The driver (scripts/baseline-operator-runner.ts)
// owns the process spawning and the psql invocation; this module owns every
// decision it makes. That split is not tidiness — it is what lets the
// adversarial suite drive a production PGUSER, a duplicated journal row and a
// corrupted hash through the SAME code the operator will run, without a
// database and without a network.
//
// ---------------------------------------------------------------------------
// WHAT IS REUSED RATHER THAN RESPELLED
// ---------------------------------------------------------------------------
//   sha256OfSql          the LF-normalizing hash — a CRLF checkout must not move a pin
//   BASELINE_UNITS       the one true order and the pinned hashes
//   reconcileJournal     the journal-vs-catalogue cross-check, and the refusal to
//                        believe a journal that was never cross-checked
//   scanBaselineSql      per-unit structural facts, DERIVED from the unit's own
//                        text, so a postcondition can never be invented
//   target-identity      the production denylist, the pooler contract, the redactor
//
// A second spelling of any of those would be a second thing to keep correct.

import { BASELINE_UNITS, type BaselineUnit } from './baseline-manifest'
import { reconcileJournal, type JournalRow, JOURNAL_TABLE } from './baseline-journal'
import { scanBaselineSql } from './baseline-scanner'
import { sha256OfSql } from './hosted-package-manifest'
import { STORAGE_UNIT_ID, PROJECT_REF_VAR } from './baseline-journal-wrapper'
import {
  STORAGE_BOUNDARY_ARTEFACT,
  evaluateStorageBoundaryArtefact,
  type StorageBoundaryArtefact,
} from './managed-policy-channel'
import type { ObservedStoragePolicy } from './baseline-postconditions'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  SESSION_POOLER_PORT,
  TRANSACTION_POOLER_PORT,
  deriveConnectionIdentity,
  projectRefFromPoolerUser,
  redactForHostedLog,
} from './target-identity'

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type OperatorStopCode =
  | 'OPERATOR_ENV_STAGING_REF_MISSING'
  | 'OPERATOR_ENV_STAGING_REF_NOT_PINNED'
  | 'OPERATOR_ENV_PRODUCTION_REF'
  | 'OPERATOR_ENV_PGUSER_MISSING'
  | 'OPERATOR_ENV_PGUSER_MISMATCH'
  | 'OPERATOR_ENV_PGUSER_PRODUCTION'
  | 'OPERATOR_ENV_PORT_INVALID'
  | 'OPERATOR_ENV_SSLMODE_INVALID'
  | 'OPERATOR_ENV_SSLROOTCERT_MISSING'
  | 'OPERATOR_ENV_PASSWORD_MISSING'
  | 'OPERATOR_ENV_DATABASE_INVALID'
  | 'OPERATOR_ENV_HOST_REFUSED'
  | 'OPERATOR_REPO_BRANCH_MISMATCH'
  | 'OPERATOR_REPO_HEAD_MISMATCH'
  | 'OPERATOR_REPO_DIRTY'
  | 'OPERATOR_SOURCE_SHA_MISMATCH'
  | 'OPERATOR_WRAPPER_INVALID'
  | 'OPERATOR_LEDGER_NOT_BOOTSTRAPPED'
  | 'OPERATOR_JOURNAL_UNRECONCILED'
  | 'OPERATOR_JOURNAL_FUTURE_UNIT'
  | 'OPERATOR_JOURNAL_DUPLICATE'
  | 'OPERATOR_JOURNAL_ROW_MISMATCH'
  | 'OPERATOR_APPLY_FAILED'
  | 'OPERATOR_VERIFICATION_QUERY_FAILED'
  | 'OPERATOR_POSTCONDITION_FAILED'
  | 'OPERATOR_STORAGE_HUMAN_BOUNDARY'
  | 'OPERATOR_ARGS_INVALID'

export interface OperatorStop {
  readonly ok: false
  readonly code: OperatorStopCode
  readonly message: string
}

/**
 * Every refusal message goes through the redactor on the way out.
 *
 * Not because the messages below quote secrets — they deliberately do not — but
 * because a message is built from operator-supplied values, and the one place a
 * whole connection string gets pasted is the field someone meant to put a
 * username in.
 */
const stop = (code: OperatorStopCode, message: string): OperatorStop => ({
  ok: false,
  code,
  message: redactOperatorLog(message),
})

/**
 * Scrubs a line before it reaches a terminal or a log.
 *
 * `redactForHostedLog` already removes connection strings, DSN passwords, JWTs
 * and Supabase keys. What it does not know about is the shell-variable spelling
 * — `PGPASSWORD=…` — which is exactly the form this runner's environment holds
 * and therefore the form most likely to be echoed by accident.
 */
export function redactOperatorLog(line: string): string {
  return redactForHostedLog(line)
    .replace(/\b(PG)?PASSWORD\s*[=:]\s*\S+/gi, 'PASSWORD=[redacted]')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/]*:[^\s@]*@\S*/gi, '[redacted]')
}

// ---------------------------------------------------------------------------
// Arguments and exit codes
// ---------------------------------------------------------------------------

/**
 * Three outcomes, three codes.
 *
 * The governed storage boundary gets its own code because it is NOT a failure —
 * it is the run arriving, correctly, at the step a machine must not take. A
 * shell that treats every non-zero as breakage would have the operator hunting
 * for a bug that is not there.
 */
export const OPERATOR_EXIT = {
  OK: 0,
  INTERRUPTED: 1,
  HUMAN_BOUNDARY: 3,
} as const

export function exitCodeFor(code: OperatorStopCode): number {
  return code === 'OPERATOR_STORAGE_HUMAN_BOUNDARY'
    ? OPERATOR_EXIT.HUMAN_BOUNDARY
    : OPERATOR_EXIT.INTERRUPTED
}

export interface OperatorArgs {
  readonly ok: true
  /** Absolute path to psql.exe. Never resolved from PATH. */
  readonly psqlPath: string
  /** The commit the operator is authorizing this run against. */
  readonly expectedHead: string
  readonly dryRun: boolean
  /** Read-only introspection of the probes. Cannot apply anything, ever. */
  readonly diagnose: boolean
}

/**
 * Parses the operator's arguments, refusing every convenience.
 *
 * No PATH fallback for psql: the operator shell deliberately has none, and
 * silently finding some other client would mean running an unknown version
 * against a hosted database. No default HEAD: "authorized commit" that defaults
 * to whatever is checked out authorizes nothing. No tolerated unknown flags: a
 * misspelled `--dry-run` that gets ignored applies fifty units.
 */
export function parseOperatorArgs(argv: readonly string[]): OperatorArgs | OperatorStop {
  let psqlPath = ''
  let expectedHead = ''
  let dryRun = false
  let diagnose = false

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--psql') {
      psqlPath = argv[i + 1] ?? ''
      i += 1
    } else if (flag === '--head') {
      expectedHead = (argv[i + 1] ?? '').toLowerCase()
      i += 1
    } else if (flag === '--dry-run') {
      dryRun = true
    } else if (flag === '--diagnose') {
      diagnose = true
    } else {
      return stop('OPERATOR_ARGS_INVALID', `unrecognised argument ${JSON.stringify(flag ?? '')}.`)
    }
  }

  if (psqlPath.trim() === '') {
    return stop(
      'OPERATOR_ARGS_INVALID',
      '--psql <path to psql.exe> is required. This runner never resolves psql from PATH.',
    )
  }
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
    return stop(
      'OPERATOR_ARGS_INVALID',
      '--head <40-character commit sha> is required, and must be the full sha of the authorized commit.',
    )
  }
  return { ok: true, psqlPath: psqlPath.trim(), expectedHead, dryRun, diagnose }
}

// ---------------------------------------------------------------------------
// 3. The operator shell, judged before anything connects
// ---------------------------------------------------------------------------

export const OPERATOR_EXPECTED_SSLMODE = 'verify-full'
export const OPERATOR_EXPECTED_DATABASE = 'postgres'

/** The variables the runner reads. Nothing else is inspected, nothing is dumped. */
export const OPERATOR_ENV_CONTRACT: readonly string[] = [
  'UELLIX_STAGING_REF',
  'PGUSER',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGPASSWORD',
]

export interface OperatorEnvironment {
  readonly ok: true
  readonly projectRef: string
  readonly poolerUser: string
  readonly host: string | null
  readonly port: number | null
}

const trimmed = (v: string | undefined): string => (v ?? '').trim()

export function evaluateOperatorEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  production = KNOWN_PRODUCTION_IDENTIFIERS,
): OperatorEnvironment | OperatorStop {
  const ref = trimmed(env.UELLIX_STAGING_REF).toLowerCase()
  if (ref === '') {
    return stop(
      'OPERATOR_ENV_STAGING_REF_MISSING',
      'UELLIX_STAGING_REF is not set. The wrappers require it and an unattributed journal row could describe any database.',
    )
  }
  // THE VETO RUNS FIRST, before shape, before the pin. A production ref must be
  // refused by the check that names production, not by a check that happens to
  // reject it for some other reason today.
  if (production.projectRefs.includes(ref)) {
    return stop(
      'OPERATOR_ENV_PRODUCTION_REF',
      `UELLIX_STAGING_REF names ${ref}, which is a KNOWN PRODUCTION project. Refused.`,
    )
  }
  if (ref !== KNOWN_STAGING_PROJECT_REF) {
    return stop(
      'OPERATOR_ENV_STAGING_REF_NOT_PINNED',
      `UELLIX_STAGING_REF is ${ref}; this runner is pinned to ${KNOWN_STAGING_PROJECT_REF}.`,
    )
  }

  const poolerUser = trimmed(env.PGUSER)
  if (poolerUser === '') {
    return stop(
      'OPERATOR_ENV_PGUSER_MISSING',
      'PGUSER is not set. The pooler login role is the only in-band corroboration of the project ref.',
    )
  }
  const userRef = projectRefFromPoolerUser(poolerUser)
  if (userRef !== null && production.projectRefs.includes(userRef)) {
    return stop(
      'OPERATOR_ENV_PGUSER_PRODUCTION',
      `PGUSER routes to ${userRef}, which is a KNOWN PRODUCTION project. Refused regardless of what UELLIX_STAGING_REF says.`,
    )
  }
  if (userRef === null || userRef !== ref) {
    return stop(
      'OPERATOR_ENV_PGUSER_MISMATCH',
      `PGUSER must be the session pooler login role postgres.${ref}. It does not corroborate the pinned project ref.`,
    )
  }

  const rawPort = trimmed(env.PGPORT)
  let port: number | null = null
  if (rawPort !== '') {
    port = Number.parseInt(rawPort, 10)
    if (port === TRANSACTION_POOLER_PORT) {
      return stop(
        'OPERATOR_ENV_PORT_INVALID',
        `PGPORT is the TRANSACTION pooler (${TRANSACTION_POOLER_PORT}). psql -1 and SET LOCAL need session affinity; use ${SESSION_POOLER_PORT}.`,
      )
    }
    if (!Number.isInteger(port) || port !== SESSION_POOLER_PORT) {
      return stop(
        'OPERATOR_ENV_PORT_INVALID',
        `PGPORT is ${rawPort}; the session pooler and the direct endpoint both listen on ${SESSION_POOLER_PORT}.`,
      )
    }
  }

  if (trimmed(env.PGSSLMODE) !== OPERATOR_EXPECTED_SSLMODE) {
    return stop(
      'OPERATOR_ENV_SSLMODE_INVALID',
      `PGSSLMODE must be ${OPERATOR_EXPECTED_SSLMODE}. Anything weaker authenticates the connection without authenticating the server.`,
    )
  }
  if (trimmed(env.PGSSLROOTCERT) === '') {
    return stop(
      'OPERATOR_ENV_SSLROOTCERT_MISSING',
      'PGSSLROOTCERT is not set, so verify-full has no root of trust to verify against.',
    )
  }
  // Presence only. The value is never read, never compared, never printed.
  if (trimmed(env.PGPASSWORD) === '') {
    return stop(
      'OPERATOR_ENV_PASSWORD_MISSING',
      'PGPASSWORD is absent or blank in this shell.',
    )
  }
  const database = trimmed(env.PGDATABASE)
  if (database !== '' && database !== OPERATOR_EXPECTED_DATABASE) {
    return stop(
      'OPERATOR_ENV_DATABASE_INVALID',
      `PGDATABASE is ${database}; the baseline targets ${OPERATOR_EXPECTED_DATABASE}.`,
    )
  }

  const host = trimmed(env.PGHOST)
  if (host !== '') {
    const identity = deriveConnectionIdentity({
      connectionHost: host,
      poolerUser,
      connectionPort: port,
    })
    if (!identity.ok) {
      return stop('OPERATOR_ENV_HOST_REFUSED', identity.message)
    }
    if (identity.projectRef !== ref) {
      return stop(
        'OPERATOR_ENV_HOST_REFUSED',
        `the connection resolves to ${identity.projectRef}, the pin is ${ref}.`,
      )
    }
  }

  return { ok: true, projectRef: ref, poolerUser, host: host === '' ? null : host, port }
}

// ---------------------------------------------------------------------------
// The repo pin — the corpus the run is about
// ---------------------------------------------------------------------------

export interface RepoObservation {
  readonly branch: string
  readonly head: string
  readonly dirty: boolean
}

export interface RepoPin {
  readonly branch: string
  readonly head: string
}

export function evaluateRepoState(
  observed: RepoObservation,
  pin: RepoPin,
): { readonly ok: true } | OperatorStop {
  if (observed.branch !== pin.branch) {
    return stop(
      'OPERATOR_REPO_BRANCH_MISMATCH',
      `branch is ${observed.branch}, the authorized branch is ${pin.branch}.`,
    )
  }
  if (observed.head !== pin.head) {
    return stop(
      'OPERATOR_REPO_HEAD_MISMATCH',
      `HEAD is ${observed.head}, the authorized commit is ${pin.head}. The corpus is not the one the gate was computed over.`,
    )
  }
  if (observed.dirty) {
    return stop(
      'OPERATOR_REPO_DIRTY',
      'the working tree has uncommitted changes, so the bytes about to be applied are not the bytes any gate verified.',
    )
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 4. Hashes — LF-normalized, because Windows checks out CRLF
// ---------------------------------------------------------------------------

export function verifyUnitSource(
  unit: BaselineUnit,
  sql: string | null,
): { readonly ok: true } | OperatorStop {
  if (sql === null) {
    return stop('OPERATOR_SOURCE_SHA_MISMATCH', `${unit.file} could not be read.`)
  }
  const actual = sha256OfSql(sql)
  if (actual !== unit.sha256) {
    return stop(
      'OPERATOR_SOURCE_SHA_MISMATCH',
      `${unit.id}: LF-normalized source hashes to ${actual.slice(0, 12)}…, the manifest pins ${unit.sha256.slice(0, 12)}….`,
    )
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 2. The state the first run must find, left by unit ZERO
// ---------------------------------------------------------------------------

export interface LedgerBootstrapObservation {
  readonly schemaExists: boolean
  readonly tableExists: boolean
  readonly checkConstraints: number
  readonly notProductionCheckPinsProductionRef: boolean
  readonly partialUniqueIndexes: number
  readonly primaryKey: number
}

export const LEDGER_EXPECTED_CHECK_CONSTRAINTS = 5
export const LEDGER_EXPECTED_PARTIAL_UNIQUE_INDEXES = 2

export function evaluateLedgerBootstrap(
  observed: LedgerBootstrapObservation,
): { readonly ok: true } | OperatorStop {
  const failures: string[] = []
  if (!observed.schemaExists) failures.push('schema uellix_provisioning is absent')
  if (!observed.tableExists) failures.push(`${JOURNAL_TABLE} is absent`)
  if (observed.checkConstraints !== LEDGER_EXPECTED_CHECK_CONSTRAINTS) {
    failures.push(
      `${observed.checkConstraints} CHECK constraints, expected ${LEDGER_EXPECTED_CHECK_CONSTRAINTS}`,
    )
  }
  // Called out separately from the count because this is the constraint whose
  // absence makes every subsequent row unsafe rather than merely unusual.
  if (!observed.notProductionCheckPinsProductionRef) {
    failures.push('applied_units_not_production_check does not pin the known production ref')
  }
  if (observed.partialUniqueIndexes !== LEDGER_EXPECTED_PARTIAL_UNIQUE_INDEXES) {
    failures.push(
      `${observed.partialUniqueIndexes} partial unique indexes, expected ${LEDGER_EXPECTED_PARTIAL_UNIQUE_INDEXES}`,
    )
  }
  if (observed.primaryKey !== 1) failures.push('the ledger has no primary key')

  if (failures.length > 0) {
    return stop(
      'OPERATOR_LEDGER_NOT_BOOTSTRAPPED',
      `unit ZERO's ledger is not in the state it leaves behind: ${failures.join('; ')}.`,
    )
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 8. Resume — where the run is, derived from journal + manifest only
// ---------------------------------------------------------------------------

export interface NextUnitVerdict {
  readonly ok: true
  /** Id of the highest contiguous unit recorded APPLIED, or null before unit 1. */
  readonly lastCommittedUnit: string | null
  /** The unit to apply next, or null when all fifty are recorded. */
  readonly nextUnit: BaselineUnit | null
  readonly journalCount: number
}

export interface JournalCheckpoint {
  /** Highest unit of the contiguous manifest prefix recorded APPLIED. */
  readonly lastCommittedUnit: string | null
  /** Length of that prefix. NOT the raw row count — see below. */
  readonly journalCount: number
  /** The unit that follows the prefix, or null when all fifty are recorded. */
  readonly nextUnitId: string | null
  readonly storageRecorded: boolean
}

/**
 * WHERE THE RUN IS, FOR THE REPORT ONLY. THIS DECIDES NOTHING.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * The first real run after PART A refused correctly — 042 stayed blocked — and
 * then printed `lastCommittedUnit = none, journalCount = 0` while the same
 * process had just measured the 041 row and said so two lines earlier. The
 * driver assigned those fields from `deriveNextUnit`'s RESULT, so a refusal from
 * that call left the initial values in place.
 *
 * A report that contradicts the evidence beside it teaches the operator to
 * distrust the report, and the report is how a governed boundary explains
 * itself. So the checkpoint is computed from the rows BEFORE any decision runs.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A SECOND SPELLING OF THE DECISION
 * ---------------------------------------------------------------------------
 * It deliberately does LESS than `deriveNextUnit`: no catalogue cross-check, no
 * sha comparison, no project-ref check, no boundary. It answers one question —
 * "how far does the contiguous chain go?" — and it reports the PREFIX rather
 * than the row count, so a journal holding 1, 2 and 5 reports two rather than
 * overstating three. Anything that could authorise an apply stays in
 * `deriveNextUnit`, which is unchanged, and a test pins that the boundary still
 * refuses in exactly the state this function describes.
 */
export function journalCheckpoint(rows: readonly JournalRow[]): JournalCheckpoint {
  const applied = new Set(rows.filter((r) => r.status === 'APPLIED').map((r) => r.packageId))
  let count = 0
  while (count < BASELINE_UNITS.length && applied.has(BASELINE_UNITS[count]!.id)) count += 1
  return {
    lastCommittedUnit: count === 0 ? null : BASELINE_UNITS[count - 1]!.id,
    journalCount: count,
    nextUnitId: count >= BASELINE_UNITS.length ? null : BASELINE_UNITS[count]!.id,
    storageRecorded: applied.has(STORAGE_UNIT_ID),
  }
}

export function deriveNextUnit(input: {
  readonly rows: readonly JournalRow[]
  readonly expectedProjectRef: string
  readonly observedTables: readonly string[] | null
  readonly tablesCreatedByUnit: Readonly<Record<string, readonly string[]>>
  /**
   * Did the CATALOGUE show the three canonical policies on storage.objects?
   *
   * Derived by `evaluateStorageBoundaryArtefact` from pg_proc, pg_policies and
   * B0-16 — never an operator claim, never the journal. Absent means unmeasured,
   * and unmeasured is refused.
   */
  readonly storageBoundaryVerified?: boolean
}): NextUnitVerdict | OperatorStop {
  const { installed, problems } = reconcileJournal({
    rows: input.rows,
    expectedProjectRef: input.expectedProjectRef,
    observedTables: input.observedTables,
    tablesCreatedByUnit: input.tablesCreatedByUnit,
  })
  // JOURNAL_MISSING_UNIT IS NOT A DEFECT DURING A RUN, AND THIS IS THE ONE
  // PLACE THE DISTINCTION MATTERS.
  //
  // `reconcileJournal` answers "is this baseline COMPLETE?" — so it flags any
  // journal short of fifty, correctly, because a partial baseline is not a
  // smaller baseline. Mid-run that is the expected state after every single
  // unit, and treating it as blocking would mean the runner could never apply
  // unit 2. So it is set aside HERE, and only here: the completion gate below
  // requires the full problem list to be empty, and what replaces it in the
  // meantime is a STRICTER property — the recorded set must be an exact PREFIX
  // of the manifest order, which "how many are missing" never checked at all.
  const blocking = problems.filter((p) => p.kind !== 'JOURNAL_MISSING_UNIT')
  if (blocking.length > 0) {
    return stop(
      'OPERATOR_JOURNAL_UNRECONCILED',
      `the journal does not reconcile with the catalogue: ${blocking.map((p) => `${p.kind} — ${p.detail}`).join(' | ')}`,
    )
  }

  // CONTIGUITY IS THIS FUNCTION'S OWN JOB. reconcileJournal answers "is each row
  // true?"; it does not answer "is the SET of rows a prefix of the order?" A
  // journal holding 1, 2 and 5 has three true rows and describes a database that
  // skipped two units, which is the failure the manifest order exists to prevent.
  const applied = new Set(installed)
  const expectedPrefix = BASELINE_UNITS.slice(0, applied.size).map((u) => u.id)
  const outOfOrder = expectedPrefix.filter((id) => !applied.has(id))
  if (outOfOrder.length > 0) {
    const ahead = [...applied].filter((id) => !expectedPrefix.includes(id))
    return stop(
      'OPERATOR_JOURNAL_FUTURE_UNIT',
      `the journal is not a prefix of the manifest order. Recorded but out of order: ${ahead.join(', ') || '(none)'}; missing from the prefix: ${outOfOrder.join(', ')}. A partial baseline is not a smaller baseline.`,
    )
  }

  // A JOURNAL ROW FOR UNIT 41 IS NOT A CROSSED BOUNDARY.
  //
  // Independent audit found the vector: fabricate an APPLIED row for the storage
  // unit and a resume derives 042, with PART B never installed. The row is not
  // even CLAIMING part B — the wrapper includes PART A alone and says so in its
  // own header: "An APPLIED row here means the two public helpers exist —
  // nothing more." The three policies live in a channel psql cannot join, so the
  // only evidence that can cross this boundary is the catalogue.
  //
  // Placed AFTER the prefix check, so a journal that is both out of order and
  // past the boundary reports the ordering fault, which is the more specific
  // one. Units 001-040 are untouched: the guard reads the storage unit's own
  // presence, not a blanket "are we near the end".
  const storageRecorded = applied.has(STORAGE_UNIT_ID)
  if (storageRecorded && input.storageBoundaryVerified !== true) {
    return stop(
      'OPERATOR_STORAGE_HUMAN_BOUNDARY',
      `the journal records ${STORAGE_UNIT_ID}, but the canonical storage boundary is ` +
        `${input.storageBoundaryVerified === undefined ? 'UNMEASURED' : 'NOT VERIFIED'}. That row attests ` +
        `PART A — the two public.can_*_evidence_object helpers — and nothing else. Crossing to unit 42 ` +
        `requires the three canonical policies observed on storage.objects with their exact surface (role, ` +
        `command, predicate slot, bucket filter, isolation helper) and no extra policy beside them. Run the ` +
        `PART B procedure and the B0-16 reconciliation; a journal row cannot substitute for the catalogue.`,
    )
  }

  const nextIndex = applied.size
  return {
    ok: true,
    lastCommittedUnit: nextIndex === 0 ? null : BASELINE_UNITS[nextIndex - 1]!.id,
    nextUnit: nextIndex >= BASELINE_UNITS.length ? null : BASELINE_UNITS[nextIndex]!,
    journalCount: applied.size,
  }
}

// ---------------------------------------------------------------------------
// 5. AFTER — the row this unit was supposed to write, and nothing beyond it
// ---------------------------------------------------------------------------

const ordinalOf = (packageId: string): number =>
  BASELINE_UNITS.find((u) => u.id === packageId)?.ordinal ?? Number.POSITIVE_INFINITY

export function evaluateUnitJournal(input: {
  readonly unit: BaselineUnit
  readonly rows: readonly JournalRow[]
  readonly expectedProjectRef: string
}): { readonly ok: true } | OperatorStop {
  const { unit, rows, expectedProjectRef } = input
  const mine = rows.filter((r) => r.packageId === unit.id && r.status === 'APPLIED')

  if (mine.length > 1) {
    return stop(
      'OPERATOR_JOURNAL_DUPLICATE',
      `${unit.id} is recorded APPLIED ${mine.length} times. The ledger's partial unique index should have made this impossible.`,
    )
  }

  const ahead = rows.filter((r) => ordinalOf(r.packageId) > unit.ordinal)
  if (ahead.length > 0) {
    return stop(
      'OPERATOR_JOURNAL_FUTURE_UNIT',
      `units beyond ${unit.ordinal} are already recorded: ${ahead.map((r) => r.packageId).join(', ')}.`,
    )
  }

  if (mine.length !== 1) {
    return stop(
      'OPERATOR_JOURNAL_ROW_MISMATCH',
      `${unit.id} has no APPLIED row. Under psql -1 the unit and its row commit together, so a missing row means the unit did not commit.`,
    )
  }

  const row = mine[0]!
  const wrong: string[] = []
  if (row.environment !== 'staging') wrong.push(`environment=${row.environment}`)
  if (row.projectRef !== expectedProjectRef) wrong.push(`project_ref=${row.projectRef}`)
  if (row.phase !== 'PHASE_BASELINE') wrong.push(`phase=${row.phase}`)
  if (row.sourceSha256 !== unit.sha256) {
    wrong.push(`source_sha256=${row.sourceSha256.slice(0, 12)}… (expected ${unit.sha256.slice(0, 12)}…)`)
  }
  if (wrong.length > 0) {
    return stop(
      'OPERATOR_JOURNAL_ROW_MISMATCH',
      `${unit.id}'s row does not describe this unit on this target: ${wrong.join(', ')}.`,
    )
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 6. Structural postconditions — derived from the unit, or honestly absent
// ---------------------------------------------------------------------------

export interface StructuralExpectation {
  readonly tables: readonly string[]
  readonly functions: readonly string[]
  readonly triggers: readonly string[]
  readonly rlsEnabledTables: readonly string[]
  readonly policies: readonly string[]
  /** True when the unit's manifest class says it writes no rows AND it creates tables. */
  readonly expectsNoRows: boolean
  /** False when the corpus yields nothing this core can check remotely. */
  readonly specific: boolean
  /** Shown to the operator when `specific` is false. Never a fabricated assertion. */
  readonly note: string
}

/**
 * Reads the unit's own SQL and reports what the catalogue must therefore show.
 *
 * The scanner is the same one the manifest's `expect` block is verified against,
 * so this cannot drift into checking something the corpus does not say. When the
 * unit only widens a column or adds a constraint, the scanner yields nothing —
 * and the honest output is `specific: false` with a note. Manufacturing an
 * assertion there would turn "we did not check" into "we checked", which is the
 * single most expensive lie a verification step can tell.
 */
export function unitStructuralExpectation(
  unit: BaselineUnit,
  sourceSql: string,
): StructuralExpectation {
  const facts = scanBaselineSql(sourceSql)
  const tables = [...facts.tablesCreated]
  const specific =
    tables.length +
      facts.functionsCreated.length +
      facts.triggersCreated.length +
      facts.rlsEnabledTables.length +
      facts.policiesCreated.length >
    0

  return {
    tables,
    functions: [...facts.functionsCreated],
    triggers: [...facts.triggersCreated],
    rlsEnabledTables: [...facts.rlsEnabledTables],
    policies: [...facts.policiesCreated],
    expectsNoRows: unit.dml === 'none' && tables.length > 0,
    specific,
    note: specific
      ? ''
      : `no specific structural postcondition can be derived from ${unit.id}: it creates no table, function, trigger, policy and enables no RLS. The journal row and the psql exit code are the evidence for this unit; the catalogue check is reported as NOT APPLICABLE rather than faked.`,
  }
}

export interface StructuralObservation {
  readonly tables: readonly string[]
  readonly functions: readonly string[]
  readonly triggers: readonly string[]
  readonly rlsEnabledTables: readonly string[]
  readonly policies: readonly string[]
  readonly rowCount: number
}

export function evaluateUnitPostconditions(
  expectation: StructuralExpectation,
  observed: StructuralObservation,
): { readonly ok: true } | OperatorStop {
  const missing = (want: readonly string[], have: readonly string[]): string[] => {
    const present = new Set(have)
    return want.filter((w) => !present.has(w))
  }

  const gaps: string[] = []
  for (const [label, want, have] of [
    ['table', expectation.tables, observed.tables],
    ['function', expectation.functions, observed.functions],
    ['trigger', expectation.triggers, observed.triggers],
    ['rls', expectation.rlsEnabledTables, observed.rlsEnabledTables],
    ['policy', expectation.policies, observed.policies],
  ] as const) {
    const absent = missing(want, have)
    if (absent.length > 0) gaps.push(`${label}(s) absent: ${absent.join(', ')}`)
  }

  if (expectation.expectsNoRows && observed.rowCount > 0) {
    gaps.push(
      `${observed.rowCount} row(s) present in tables this unit created, but the manifest classifies it as dml: 'none'`,
    )
  }

  if (gaps.length > 0) {
    return stop('OPERATOR_POSTCONDITION_FAILED', `postconditions failed — ${gaps.join('; ')}.`)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 9. Unit 41 — the boundary that is not the runner's to cross
// ---------------------------------------------------------------------------

/**
 * Returns a stop when the next unit is the storage unit, otherwise null.
 *
 * PART A (two public helpers) is psql-applicable and would be recorded APPLIED.
 * PART B (the policies on storage.objects) requires OWNERSHIP of a table owned
 * by supabase_storage_admin, and `SET_ROLE_PATH_VERIFIED` is a pinned `false` —
 * MEMBER, USAGE and SET were all measured absent. So PART B runs through a
 * channel no psql transaction can join.
 *
 * Applying PART A automatically would OPEN that boundary unattended, leaving the
 * database in UNIT_41_POLICIES_PENDING with nothing scheduled to close it. The
 * runner therefore stops BEFORE the unit rather than half-through it: a boundary
 * a machine opens and a human must close is a boundary that gets forgotten.
 */
export function storageBoundaryStop(unit: BaselineUnit): OperatorStop | null {
  if (unit.id !== STORAGE_UNIT_ID) return null
  return stop(
    'OPERATOR_STORAGE_HUMAN_BOUNDARY',
    `unit ${unit.ordinal} (${unit.id}) is the governed human boundary and the runner will not cross it unattended.\n` +
      `  PART A — two helper functions in schema public. psql-applicable, recorded APPLIED inside the unit's transaction.\n` +
      `  PART B — the canonical policies on storage.objects. CREATE POLICY requires OWNERSHIP of a table owned by\n` +
      `           supabase_storage_admin; MEMBER, USAGE and SET were all measured false, so no psql session can\n` +
      `           assume it. PART B runs through the management-plane channel and is reconciled from pg_policies,\n` +
      `           never from an operator claim.\n` +
      `  Required before this unit: the 'uellix-evidence' bucket must exist (nothing in the fifty units creates it),\n` +
      `  and the canonical boundary must be verifiable. Run the storage boundary procedure, then re-run this runner.`,
  )
}

// ---------------------------------------------------------------------------
// 10. Completion — a verdict, never a side effect of the loop ending
// ---------------------------------------------------------------------------

/**
 * Gates that remain BLOCKING after a green baseline, by design.
 *
 * Listed so a completion report cannot read as "everything is done". They are
 * later phases, not oversights.
 */
export const GATES_PENDING_AFTER_BASELINE: readonly string[] = [
  'STAGING_RUNTIME_GATE / hosted-evidence-bucket-provisioning-ready — the uellix-evidence bucket is not created by any of the fifty units',
  'CHECKPOINT B0 — the read-only baseline postconditions, run as a whole rather than per unit',
  'PHASE_STELLA_BOOTSTRAP — the phase after PHASE_BASELINE',
]

export interface CompletionVerdict {
  readonly ok: true
  readonly baselineApplied: boolean
  readonly journalCount: number
  readonly pendingGates: readonly string[]
}

export function evaluateCompletion(input: {
  readonly rows: readonly JournalRow[]
  readonly expectedProjectRef: string
  readonly observedTables: readonly string[] | null
  readonly tablesCreatedByUnit: Readonly<Record<string, readonly string[]>>
  readonly storageBoundaryVerified: boolean
}): CompletionVerdict | OperatorStop {
  // Here the FULL problem list is blocking, JOURNAL_MISSING_UNIT included. This
  // is the question that check was written for.
  const { installed, problems } = reconcileJournal({
    rows: input.rows,
    expectedProjectRef: input.expectedProjectRef,
    observedTables: input.observedTables,
    tablesCreatedByUnit: input.tablesCreatedByUnit,
  })
  if (problems.length > 0) {
    return stop(
      'OPERATOR_JOURNAL_UNRECONCILED',
      `completion refused: ${problems.map((p) => `${p.kind} — ${p.detail}`).join(' | ')}`,
    )
  }
  if (installed.length !== BASELINE_UNITS.length) {
    return stop(
      'OPERATOR_JOURNAL_UNRECONCILED',
      `completion refused: ${installed.length} of ${BASELINE_UNITS.length} units reconcile.`,
    )
  }
  if (!input.storageBoundaryVerified) {
    return stop(
      'OPERATOR_STORAGE_HUMAN_BOUNDARY',
      'completion refused: the canonical storage boundary is not verified, so unit 41 is not COMPLETE and baselineApplied stays false.',
    )
  }
  return {
    ok: true,
    baselineApplied: true,
    journalCount: installed.length,
    pendingGates: GATES_PENDING_AFTER_BASELINE,
  }
}

// ---------------------------------------------------------------------------
// Read-only probes. One spelling, shared by the driver and the tests.
// ---------------------------------------------------------------------------

/** Escapes a value for embedding as an SQL string literal. */
export const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** Quotes a possibly schema-qualified name as an identifier. */
export const sqlIdentifier = (qualified: string): string =>
  qualified
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.')

/**
 * Every probe runs in a read-only transaction, with an EMPTY search_path, and
 * rolls back.
 *
 * ---------------------------------------------------------------------------
 * WHY `SET LOCAL search_path = ''`
 * ---------------------------------------------------------------------------
 * PART B installed cleanly and B0-16 refused, on one difference:
 *
 *     expected  public.can_read_evidence_object(name, auth.uid())
 *     observed         can_read_evidence_object(name, auth.uid())
 *
 * `pg_get_expr` — which is what `pg_policies.qual` runs through — omits a
 * function's schema when that schema is visible in the SESSION's search_path,
 * and staging's session has `public` in it. Measured on PostgreSQL 17: the same
 * deparser KEEPS `private.is_active_member` qualified because `private` is not
 * in the path, and DROPS the qualifier the instant `SET LOCAL search_path =
 * 'private'` makes it visible. With an empty path it qualifies everything.
 *
 * So the OBSERVATION was ambiguous, not the policy. Stabilising the probe is
 * the fix, and the verifier keeps strict equality untouched. Accepting the
 * unqualified form instead would accept a function of that name in ANY schema
 * sitting earlier in the path — precisely the near-name attack this surface
 * check exists to stop.
 *
 * Three properties, measured rather than assumed:
 *   - casts are unaffected (`'x'::text` either way) because pg_catalog is
 *     implicitly searched first regardless of this setting;
 *   - `auth.uid()` stays qualified, as it already was;
 *   - `SET LOCAL` is not a write — `transaction_read_only` stays `on`, and
 *     LOCAL confines it to the transaction that is about to roll back.
 *
 * Every probe here names its objects fully qualified already, so the empty path
 * costs them nothing and buys determinism for all of them: no probe can quietly
 * depend on the operator's session default.
 *
 * Belt and braces: the statements are SELECTs, and the transaction refuses
 * writes anyway. A probe that could write is a probe that could repair the very
 * discrepancy it exists to find.
 */
export const readOnly = (sql: string): string =>
  `BEGIN READ ONLY;\nSET LOCAL search_path = '';\n${sql}\nROLLBACK;`

const jsonRows = (inner: string): string =>
  `SELECT coalesce(jsonb_agg(t), '[]'::jsonb)::text FROM (${inner}) t;`

export const LEDGER_BOOTSTRAP_PROBE_SQL = readOnly(
  jsonRows(`
    SELECT
      (SELECT count(*) FROM information_schema.schemata WHERE schema_name='uellix_provisioning') AS schema_count,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema='uellix_provisioning' AND table_name='applied_units') AS table_count,
      (SELECT count(*) FROM pg_constraint ct JOIN pg_class c ON c.oid=ct.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='uellix_provisioning' AND c.relname='applied_units' AND ct.contype='c') AS check_count,
      (SELECT count(*) FROM pg_constraint ct JOIN pg_class c ON c.oid=ct.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='uellix_provisioning' AND c.relname='applied_units'
          AND ct.conname='applied_units_not_production_check'
          AND pg_get_constraintdef(ct.oid) LIKE ${sqlLiteral(`%${KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0] ?? ''}%`)}) AS veto_count,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='uellix_provisioning' AND tablename='applied_units'
        AND indexname IN ('applied_units_one_applied_per_package','applied_units_one_open_boundary')) AS partial_unique_count,
      (SELECT count(*) FROM pg_constraint ct JOIN pg_class c ON c.oid=ct.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='uellix_provisioning' AND c.relname='applied_units' AND ct.contype='p') AS pk_count
  `),
)

export const JOURNAL_SNAPSHOT_SQL = readOnly(
  jsonRows(`
    SELECT environment, project_ref, package_id, phase, source_sha256, derived_sha256,
           security_surface_digest, status, applied_at::text AS applied_at,
           apply_session_user AS apply_session_identity
    FROM ${JOURNAL_TABLE}
    ORDER BY id
  `),
)

/** Base tables in public — the catalogue side of `reconcileJournal`. */
export const CATALOGUE_TABLES_SQL = readOnly(
  jsonRows(`
    SELECT ('public.' || table_name) AS name
    FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
  `),
)

// ---------------------------------------------------------------------------
// The psql INVOCATION CONTRACT — flags and payload, both owned here
// ---------------------------------------------------------------------------

/**
 * The flags that make psql's stdout a single machine-readable value.
 *
 * ---------------------------------------------------------------------------
 * WHY `-q` IS LOAD-BEARING, AND HOW ITS ABSENCE WAS FOUND
 * ---------------------------------------------------------------------------
 * The first dry run against staging failed on the very first probe. The query
 * was right, the connection was right, the encoding was right. What was wrong
 * was an assumption about psql: `-c` with a multi-statement string makes psql
 * print a COMMAND STATUS TAG for every utility statement, so stdout was
 *
 *     BEGIN\r\n[{…}]\r\nROLLBACK\r\n
 *
 * `-t` suppresses the column header and the `(1 row)` footer — that is the
 * table renderer. Command status is a different code path, governed by QUIET.
 * The original comment on this call said "-A -t produce one bare line", which
 * was a plausible sentence about flags nobody had measured.
 *
 * Measured against psql 17.10 (the operator's client) driving a local Postgres:
 * with `-q` the same probe emits `[{"a":1}]\r\n` and nothing else, and NOTICE
 * goes to stderr where it cannot contaminate the payload.
 */
export const PSQL_PROBE_FLAGS: readonly string[] = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']

/**
 * The flags that make an APPLY atomic. Both are load-bearing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CONSTANT AND NOT TWO STRINGS IN THE DRIVER
 * ---------------------------------------------------------------------------
 * Independent audit mutated `-1` and `ON_ERROR_STOP=1` out of the apply call and
 * the entire suite still passed. The flags lived inline in the driver, which no
 * test imports, so atomicity was correct by inspection of one commit and by
 * nothing else. Every other invariant in this programme is pinned by something
 * that FAILS; this one was pinned by a reviewer's memory.
 *
 *   -1                wraps the WHOLE invocation in one transaction, so the
 *                     unit's DDL and its journal INSERT commit together or not
 *                     at all. Without it the crash window the ledger exists to
 *                     eliminate comes straight back.
 *   ON_ERROR_STOP=1   without it psql runs past a failed statement and exits 0,
 *                     so the runner reads a half-applied unit as a success.
 *
 * The wrappers also carry `\set ON_ERROR_STOP on` internally. That is defence in
 * depth, not a reason to drop the flag: a wrapper is generated, and the flag is
 * the guarantee that does not depend on the generator being right.
 */
export const PSQL_APPLY_FLAGS: readonly string[] = ['-1', '-v', 'ON_ERROR_STOP=1']

/** The complete argv for applying one unit. One spelling, pinned by tests. */
export function applyArgv(wrapperPath: string, projectRef: string): readonly string[] {
  return [...PSQL_APPLY_FLAGS, '-v', `${PROJECT_REF_VAR}=${projectRef}`, '-f', wrapperPath]
}

export interface ParsedPayload<T> {
  readonly ok: true
  readonly value: T
}

/**
 * Turns psql's stdout into a value, or refuses.
 *
 * The rule is EXACTLY ONE non-empty line, parsed whole. Blank lines and a BOM
 * are dropped because they carry no information — that is decoding, not
 * interpretation. Everything else is refused.
 *
 * What this deliberately does NOT do is hunt for a `{` and parse from there.
 * That would "fix" `BEGIN\r\n[{…}]\r\nROLLBACK` by ignoring the two lines
 * telling it the invocation was not what the runner thought it was, and it
 * would go on ignoring them the day they say something that matters. Unexpected
 * text means an unknown state, and an unknown state is a refusal.
 */
export function parsePsqlJson<T>(stdout: string, stage: string): ParsedPayload<T> | OperatorStop {
  const lines = stdout
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')

  if (lines.length === 0) {
    return stop(
      'OPERATOR_VERIFICATION_QUERY_FAILED',
      `${stage}: psql produced no output. An empty result is a refusal, not a pass.`,
    )
  }
  if (lines.length > 1) {
    return stop(
      'OPERATOR_VERIFICATION_QUERY_FAILED',
      `${stage}: psql produced ${lines.length} lines where the contract is exactly one payload. ` +
        `The runner will not choose between them. First line: ${JSON.stringify(lines[0]!.slice(0, 80))}.`,
    )
  }
  try {
    return { ok: true, value: JSON.parse(lines[0]!) as T }
  } catch {
    return stop(
      'OPERATOR_VERIFICATION_QUERY_FAILED',
      `${stage}: the single line psql returned is not JSON: ${JSON.stringify(lines[0]!.slice(0, 120))}.`,
    )
  }
}

/**
 * A sanitized description of what a probe actually returned.
 *
 * Used by `--diagnose`, and by nothing that decides anything: this reports, it
 * never judges. The payload is JSON-escaped so `\r\n` is READ rather than
 * applied — a diagnostic that prints raw control characters is a diagnostic
 * that hides the exact bytes you opened it to see.
 */
export function describeProbeOutput(input: {
  readonly stage: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}): string {
  const lines = input.stdout.split(/\r?\n/)
  const nonEmpty = lines.filter((l) => l.trim() !== '')
  const shown = input.stdout.length > 600 ? `${input.stdout.slice(0, 600)}…[truncated]` : input.stdout

  return redactOperatorLog(
    [
      `stage:            ${input.stage}`,
      `psql exit code:   ${input.exitCode ?? '(spawn error)'}`,
      `stdout chars:     ${input.stdout.length}`,
      `stdout lines:     ${lines.length} (${nonEmpty.length} non-empty)`,
      `stdout escaped:   ${JSON.stringify(shown)}`,
      `stderr:           ${input.stderr.trim() === '' ? '(empty)' : JSON.stringify(input.stderr.trim().slice(0, 400))}`,
    ].join('\n'),
  )
}

/**
 * How each catalogue fact is projected into a COMPARISON KEY.
 *
 * These live as named constants rather than buried in the query because the two
 * sides of the comparison have to agree on key SHAPE, and the only way a test
 * can check that agreement is if the projection is a value it can read. The
 * expectation side is produced by `scanBaselineSql`; the invariant a test pins
 * is that each expression concatenates the same number of segments the scanner
 * puts in the corresponding key.
 */
export const PROBE_KEY_EXPRESSIONS = {
  tables: `'public.' || table_name`,
  functions: `n.nspname || '.' || p.proname`,
  triggers: `tgname`,
  rlsEnabledTables: `n.nspname || '.' || c.relname`,
  // THREE segments, because `scanBaselineSql` emits `schema.table.policy` and a
  // bare `policyname` made all 69 of unit 032's policies read as absent while
  // every one of them existed. A policy name is not unique across tables either,
  // so the qualified key is also the only one that cannot match the wrong row.
  policies: `schemaname || '.' || tablename || '.' || policyname`,
} as const

/** Segments a projection produces, ignoring the `'.'` separators. */
export function keySegmentCount(expression: string): number {
  return expression
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part !== `'.'`).length
}

// ---------------------------------------------------------------------------
// B1 — LIVE CORROBORATION OF THE STORAGE BOUNDARY
//
// Independent audit demonstrated the vector by composition: a hand-written
// `artifacts/hosted-storage-boundary.json` carrying the three canonical shapes
// made the runner derive 042 with PART B never installed. The evaluator was
// right; its INPUT was a local file nobody had checked against the database.
//
// The round before rejected the REMOTE journal as sufficient evidence, on the
// grounds that a row can be fabricated. A LOCAL FILE IS WEAKER THAN THAT — it
// needs a text editor, not database write access. Replacing one with the other
// and calling it a hardening was the defect.
//
// So authority moves to a live read-only measurement of the same target, taken
// through the same connection the runner already uses for the journal. The
// artefact is kept, because a decision with no durable record is a decision
// nobody can audit later — but it is now the SECOND of two witnesses, and they
// must agree.
// ---------------------------------------------------------------------------

/** pg_policies, scoped to the one table PART B touches. */
export const STORAGE_POLICIES_PROBE_SQL = readOnly(
  jsonRows(`
    SELECT schemaname, tablename, policyname, roles::text AS roles, cmd,
           qual, with_check
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    ORDER BY policyname
  `),
)

/** The two PART A helpers, with the attributes that make them safe. */
export const STORAGE_HELPERS_PROBE_SQL = readOnly(
  jsonRows(`
    SELECT (n.nspname || '.' || p.proname) AS name,
           p.prosecdef AS security_definer,
           coalesce(array_to_string(p.proconfig, ','), '') AS proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('can_read_evidence_object', 'can_write_evidence_object')
    ORDER BY 1
  `),
)

/** RLS on storage.objects, and whether the bucket the predicates gate on exists. */
export const STORAGE_RLS_PROBE_SQL = readOnly(
  jsonRows(`
    SELECT
      (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'storage' AND c.relname = 'objects') AS rls_enabled,
      (SELECT count(*) FROM storage.buckets WHERE id = 'uellix-evidence') AS evidence_bucket_count
  `),
)

/** What the live probes measured. `null` anywhere means NOT MEASURED. */
export interface StorageLiveEvidence {
  readonly helpers: readonly string[]
  readonly policies: readonly ObservedStoragePolicy[]
  readonly rlsEnabled: boolean | null
  readonly bucketPresent: boolean | null
}

export interface StorageEvidenceVerdict {
  readonly verified: boolean
  readonly state: string
  readonly reasons: readonly string[]
}

/**
 * A stable fingerprint of one policy, for comparing two witnesses.
 *
 * Whitespace is collapsed because the artefact is transcribed from a terminal
 * and psql wraps; everything semantic is preserved verbatim. This is NOT the
 * surface check — `verifyStoragePolicySurface` already ran over the live rows
 * and compared them to the canonical text. This only asks "do the two witnesses
 * describe the same database?", so it must not normalize away anything the
 * surface check would have caught.
 */
const policyFingerprint = (p: ObservedStoragePolicy): string =>
  [
    p.schemaname,
    p.tablename,
    p.policyname,
    p.cmd.toUpperCase(),
    p.roles.replace(/\s/g, ''),
    (p.qual ?? '').replace(/\s+/g, ' ').trim(),
    (p.withCheck ?? '').replace(/\s+/g, ' ').trim(),
  ].join('|')

const HELPER_NAMES = ['public.can_read_evidence_object', 'public.can_write_evidence_object'] as const

/**
 * TWO WITNESSES, AND THEY MUST AGREE.
 *
 * A — the live catalogue, measured read-only through the connection whose
 *     identity the pooler login role already corroborated.
 * B — the local artefact, the durable record `boundary:status:verify` checks.
 *
 * Neither alone crosses the boundary. A fabricated artefact fails because the
 * catalogue contradicts it. A stale artefact fails for the same reason even
 * when the live surface is perfect — because "the operator recorded something
 * that was true once" is not the same claim as "the operator looked at this".
 * And an unmeasurable catalogue fails outright: unmeasured is never verified.
 */
export function reconcileStorageEvidence(input: {
  readonly live: StorageLiveEvidence | null
  readonly artefact: StorageBoundaryArtefact | null
  /** The project ref the artefact declares it was recorded against. */
  readonly artefactProjectRef: string | null
  /** The ref the CONNECTION resolves to, already corroborated by the pooler role. */
  readonly targetProjectRef: string
  readonly partAJournalled: boolean
}): StorageEvidenceVerdict {
  const reasons: string[] = []

  if (input.live === null) {
    return {
      verified: false,
      state: 'UNIT_41_UNMEASURED',
      reasons: [
        'the live storage probes did not return a usable measurement. An unmeasurable catalogue is a ' +
          'refusal — the artefact cannot stand in for it, which is the whole point of measuring.',
      ],
    }
  }
  const live = input.live

  // TARGET BINDING FIRST. An artefact recorded against localhost or another
  // project describes another database, however canonical its contents look.
  if (input.artefactProjectRef === null || input.artefactProjectRef.trim() === '') {
    reasons.push(
      `${STORAGE_BOUNDARY_ARTEFACT} declares no projectRef. An unattributed observation could describe ` +
        `any database, including the one it was copied from.`,
    )
  } else if (input.artefactProjectRef !== input.targetProjectRef) {
    reasons.push(
      `${STORAGE_BOUNDARY_ARTEFACT} was recorded against ${input.artefactProjectRef}; this connection ` +
        `resolves to ${input.targetProjectRef}.`,
    )
  }

  if (live.rlsEnabled !== true) {
    reasons.push(
      live.rlsEnabled === null
        ? 'RLS on storage.objects was not measured. Policies on a table without RLS are decoration.'
        : 'RLS is NOT enabled on storage.objects.',
    )
  }
  for (const helper of HELPER_NAMES) {
    if (!live.helpers.includes(helper)) reasons.push(`${helper} is absent from pg_proc on the target.`)
  }

  // THE LIVE SURFACE, judged by the same function B0-16 uses. Role, command,
  // predicate slot, bucket filter, isolation helper, and no extra policy.
  const liveVerdict = evaluateStorageBoundaryArtefact({
    helpersPresent: HELPER_NAMES.every((h) => live.helpers.includes(h)),
    policies: live.policies,
    journal: { partAApplied: input.partAJournalled, boundary: 'ABSENT' },
  })
  if (!liveVerdict.managedBoundaryVerified) {
    reasons.push(`live surface: ${liveVerdict.problems.join(' | ') || 'not verified'}`)
  }

  // THE SECOND WITNESS.
  if (input.artefact === null) {
    reasons.push(
      `${STORAGE_BOUNDARY_ARTEFACT} does not exist. The live catalogue may be correct, but nothing ` +
        `durable records that anyone observed it, and the boundary is an auditable event.`,
    )
  } else {
    const recorded = (input.artefact.policies ?? null)
    if (recorded === null) {
      reasons.push(`${STORAGE_BOUNDARY_ARTEFACT} records no policies, so the two witnesses cannot be compared.`)
    } else {
      const a = [...recorded].map(policyFingerprint).sort()
      const b = [...live.policies].map(policyFingerprint).sort()
      if (a.length !== b.length || a.some((f, i) => f !== b[i])) {
        reasons.push(
          `the artefact and the live catalogue disagree. Recorded ${a.length} polic(ies), measured ` +
            `${b.length}. A record that does not match what is there is stale, copied, or written by hand — ` +
            `and none of those is an observation of this database.`,
        )
      }
    }
  }

  return {
    verified: reasons.length === 0,
    state: reasons.length === 0 ? 'UNIT_41_COMPLETE' : liveVerdict.state,
    reasons,
  }
}

export function postconditionProbeSql(expectation: StructuralExpectation): string {
  const rowCount =
    expectation.tables.length === 0
      ? '0'
      : expectation.tables.map((t) => `(SELECT count(*) FROM ${sqlIdentifier(t)})`).join(' + ')

  return readOnly(
    jsonRows(`
      SELECT
        (SELECT coalesce(jsonb_agg(${PROBE_KEY_EXPRESSIONS.tables}), '[]'::jsonb)
           FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
        (SELECT coalesce(jsonb_agg(${PROBE_KEY_EXPRESSIONS.functions}), '[]'::jsonb)
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','storage')) AS functions,
        (SELECT coalesce(jsonb_agg(${PROBE_KEY_EXPRESSIONS.triggers}), '[]'::jsonb) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
        (SELECT coalesce(jsonb_agg(${PROBE_KEY_EXPRESSIONS.rlsEnabledTables}), '[]'::jsonb)
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE c.relkind='r' AND c.relrowsecurity) AS rls_enabled_tables,
        (SELECT coalesce(jsonb_agg(${PROBE_KEY_EXPRESSIONS.policies}), '[]'::jsonb) FROM pg_policies) AS policies,
        (${rowCount})::bigint AS row_count
    `),
  )
}
