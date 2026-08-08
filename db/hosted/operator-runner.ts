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
import { STORAGE_UNIT_ID } from './baseline-journal-wrapper'
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

export function deriveNextUnit(input: {
  readonly rows: readonly JournalRow[]
  readonly expectedProjectRef: string
  readonly observedTables: readonly string[] | null
  readonly tablesCreatedByUnit: Readonly<Record<string, readonly string[]>>
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
 * Every probe is wrapped in a read-only transaction and rolled back.
 *
 * Belt and braces: the statements are SELECTs, and the transaction refuses
 * writes anyway. A probe that could write is a probe that could repair the very
 * discrepancy it exists to find.
 */
export const readOnly = (sql: string): string => `BEGIN READ ONLY;\n${sql}\nROLLBACK;`

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
