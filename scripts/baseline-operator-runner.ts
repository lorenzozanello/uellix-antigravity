// scripts/baseline-operator-runner.ts
//
// THE BASELINE OPERATOR RUNNER — the only part of this feature that does I/O.
//
//   pnpm baseline:operator:run -- --psql "<path to psql.exe>" --head <sha>
//   (normally invoked through scripts/baseline-operator-runner.ps1)
//
// Every DECISION this file makes is made by `db/hosted/operator-runner.ts`,
// which is pure and adversarially tested. What lives here is the part a test
// cannot own: spawning git, spawning psql, and printing.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
// It is not `foreach file { psql }`. Before every unit it re-derives the run's
// position from the REMOTE journal cross-checked against the REMOTE catalogue;
// after every unit it re-reads the journal and checks the catalogue effect the
// unit's own SQL says it must have produced. A unit that applies but does not
// verify stops the run — there is no retry, no skip, and nothing that writes an
// APPLIED row on the runner's say-so.
//
// `scripts/baseline-rehearsal-local.ts` is deliberately untouched. Its
// localhost-only anchor is the reason it can be trusted, and a rehearsal that
// learned to reach a hosted database would stop being a rehearsal.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { BASELINE_UNITS, type BaselineUnit } from '../db/hosted/baseline-manifest'
import { verifyBaselineManifest } from '../db/hosted/baseline-manifest'
import { scanBaselineSql } from '../db/hosted/baseline-scanner'
import { wrapperCarriesJournalAppend, wrapperPathFor, STORAGE_UNIT_ID } from '../db/hosted/baseline-journal-wrapper'
import type { JournalRow } from '../db/hosted/baseline-journal'
import { STORAGE_BOUNDARY_ARTEFACT, type StorageBoundaryArtefact } from '../db/hosted/managed-policy-channel'
import type { ObservedStoragePolicy } from '../db/hosted/baseline-postconditions'
import {
  CATALOGUE_TABLES_SQL,
  JOURNAL_SNAPSHOT_SQL,
  LEDGER_BOOTSTRAP_PROBE_SQL,
  OPERATOR_EXIT,
  PSQL_PROBE_FLAGS,
  STORAGE_HELPERS_PROBE_SQL,
  STORAGE_POLICIES_PROBE_SQL,
  STORAGE_RLS_PROBE_SQL,
  applyArgv,
  describeProbeOutput,
  reconcileStorageEvidence,
  type StorageLiveEvidence,
  parsePsqlJson,
  deriveNextUnit,
  evaluateCompletion,
  evaluateLedgerBootstrap,
  evaluateOperatorEnvironment,
  evaluateRepoState,
  evaluateUnitJournal,
  evaluateUnitPostconditions,
  exitCodeFor,
  parseOperatorArgs,
  postconditionProbeSql,
  redactOperatorLog,
  storageBoundaryStop,
  unitStructuralExpectation,
  verifyUnitSource,
  type OperatorStop,
} from '../db/hosted/operator-runner'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXPECTED_BRANCH = 'codex/stella-staging'

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

/** Every line the operator sees passes through the redactor. No exceptions. */
const say = (line: string): void => {
  process.stdout.write(`${redactOperatorLog(line)}\n`)
}

const pad = (n: number): string => String(n).padStart(3, '0')

// ---------------------------------------------------------------------------
// The one fail-closed exit
// ---------------------------------------------------------------------------

interface RunState {
  lastCommittedUnit: string | null
  expectedOrFailedUnit: string | null
  journalCount: number
}

const state: RunState = { lastCommittedUnit: null, expectedOrFailedUnit: null, journalCount: 0 }

function halt(stop: OperatorStop): never {
  const boundary = stop.code === 'OPERATOR_STORAGE_HUMAN_BOUNDARY'
  say('')
  say(boundary ? 'PHASE_BASELINE_HUMAN_BOUNDARY' : 'PHASE_BASELINE_INTERRUPTED')
  say(`  lastCommittedUnit:      ${state.lastCommittedUnit ?? 'none'}`)
  say(`  expectedOrFailedUnit:   ${state.expectedOrFailedUnit ?? 'none'}`)
  say(`  journalCount:           ${state.journalCount}`)
  say(`  reason:                 ${stop.code}`)
  say(`  detail:                 ${stop.message}`)
  say(
    `  recovery posture:       ${
      boundary
        ? 'NOT a failure. Nothing was left half-applied. Complete the governed storage procedure, then re-run this runner; it resumes from the journal.'
        : 'STOP. Do not re-run until the reason is understood. No unit was left half-applied: every unit is applied under psql -1, so a failure rolls back the unit AND its journal row together. Re-running the runner is safe once the cause is fixed — it re-derives its position from the journal and never re-applies a recorded unit.'
    }`,
  )
  process.exit(exitCodeFor(stop.code))
}

const orHalt = <T,>(v: T | OperatorStop): T => {
  if (typeof v === 'object' && v !== null && 'ok' in v && (v as { ok: unknown }).ok === false) {
    halt(v as OperatorStop)
  }
  return v as T
}

// ---------------------------------------------------------------------------
// psql — the only process that talks to the target
// ---------------------------------------------------------------------------

let PSQL = ''

interface RawProbe {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawns psql for one read-only probe and returns the raw streams.
 *
 * The flags come from the core so the invocation contract has ONE spelling and
 * a test can pin it. The SQL is already wrapped in BEGIN READ ONLY / ROLLBACK.
 */
function runProbe(sql: string): RawProbe {
  const r = spawnSync(PSQL, [...PSQL_PROBE_FLAGS, '-c', sql], {
    encoding: 'utf8',
    env: process.env,
  })
  return { exitCode: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Runs a read-only probe and returns the parsed payload, or halts. */
function probe<T>(sql: string, label: string): T {
  const raw = runProbe(sql)
  if (raw.exitCode !== 0) {
    halt({
      ok: false,
      code: 'OPERATOR_VERIFICATION_QUERY_FAILED',
      message: `${label}: psql exited ${raw.exitCode ?? 'with a spawn error'}. ${raw.stderr.trim()}`,
    })
  }
  const parsed = parsePsqlJson<T>(raw.stdout, label)
  if (!parsed.ok) {
    // The refusal stands. What changes is that the operator gets the bytes:
    // "not JSON" without the payload is a message that costs a round-trip.
    say('')
    say('PROBE DIAGNOSTICS')
    say(
      describeProbeOutput({
        stage: label,
        exitCode: raw.exitCode,
        stdout: raw.stdout,
        stderr: raw.stderr,
      }),
    )
    halt(parsed)
  }
  return parsed.value
}

interface RemoteJournalRow {
  environment: string
  project_ref: string
  package_id: string
  phase: string
  source_sha256: string
  derived_sha256: string | null
  security_surface_digest: string | null
  status: string
  applied_at: string
  apply_session_identity: string
}

const toJournalRow = (r: RemoteJournalRow): JournalRow => ({
  environment: r.environment,
  projectRef: r.project_ref,
  packageId: r.package_id,
  phase: r.phase,
  sourceSha256: r.source_sha256,
  derivedSha256: r.derived_sha256,
  securitySurfaceDigest: r.security_surface_digest,
  status: r.status as JournalRow['status'],
  appliedAt: r.applied_at,
  applySessionIdentity: r.apply_session_identity,
})

const journalRows = (): readonly JournalRow[] =>
  probe<RemoteJournalRow[]>(JOURNAL_SNAPSHOT_SQL, 'journal snapshot').map(toJournalRow)

const catalogueTables = (): readonly string[] =>
  probe<{ name: string }[]>(CATALOGUE_TABLES_SQL, 'catalogue tables').map((r) => r.name)

/** Tables each unit creates, derived from the SAME corpus the plan is built from. */
const tablesCreatedByUnit = (): Record<string, readonly string[]> => {
  const out: Record<string, readonly string[]> = {}
  for (const unit of BASELINE_UNITS) {
    const sql = read(unit.file)
    out[unit.id] = sql === null ? [] : scanBaselineSql(sql).tablesCreated
  }
  return out
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function main(): void {
  const args = orHalt(parseOperatorArgs(process.argv.slice(2)))
  PSQL = args.psqlPath

  if (!existsSync(PSQL)) {
    halt({
      ok: false,
      code: 'OPERATOR_ARGS_INVALID',
      message: `--psql points at ${PSQL}, which does not exist.`,
    })
  }

  // ---- identity, before anything connects ---------------------------------
  const env = orHalt(evaluateOperatorEnvironment(process.env))
  const git = (a: readonly string[]): string =>
    execFileSync('git', [...a], { cwd: ROOT, encoding: 'utf8' }).trim()
  orHalt(
    evaluateRepoState(
      {
        branch: git(['branch', '--show-current']),
        head: git(['rev-parse', 'HEAD']),
        dirty: git(['status', '--porcelain=v1']) !== '',
      },
      { branch: EXPECTED_BRANCH, head: args.expectedHead },
    ),
  )

  // ---- the corpus ---------------------------------------------------------
  const manifestProblems = verifyBaselineManifest(read, scanBaselineSql)
  if (manifestProblems.length > 0) {
    halt({
      ok: false,
      code: 'OPERATOR_ARGS_INVALID',
      message: `the manifest does not verify against the corpus: ${manifestProblems
        .map((p) => `${p.unit}/${p.kind}`)
        .join(', ')}`,
    })
  }

  say(`TARGET VERIFIED: staging ${env.projectRef} (corroborated by the pooler login role)`)
  say(`CORPUS VERIFIED: ${BASELINE_UNITS.length} units, order pinned, LF-normalized hashes match`)
  say(`PSQL:            ${path.basename(PSQL)} — ${execFileSync(PSQL, ['--version'], { encoding: 'utf8' }).trim()}`)

  // ---- --diagnose: report the probes, decide nothing, apply nothing --------
  if (args.diagnose) {
    say('')
    say('DIAGNOSE — read-only probes only. No unit can be applied on this path.')
    for (const [stage, sql] of [
      ['ledger bootstrap', LEDGER_BOOTSTRAP_PROBE_SQL],
      ['journal snapshot', JOURNAL_SNAPSHOT_SQL],
      ['catalogue tables', CATALOGUE_TABLES_SQL],
    ] as const) {
      const raw = runProbe(sql)
      say('')
      say(describeProbeOutput({ stage, exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr }))
      const parsed = parsePsqlJson<unknown>(raw.stdout, stage)
      say(`parses:           ${parsed.ok ? 'YES' : `NO — ${parsed.code}`}`)
    }
    process.exit(OPERATOR_EXIT.OK)
  }

  // ---- the ledger unit ZERO left ------------------------------------------
  const ledger = probe<
    {
      schema_count: number
      table_count: number
      check_count: number
      veto_count: number
      partial_unique_count: number
      pk_count: number
    }[]
  >(LEDGER_BOOTSTRAP_PROBE_SQL, 'ledger bootstrap')[0]
  if (ledger === undefined) {
    halt({
      ok: false,
      code: 'OPERATOR_LEDGER_NOT_BOOTSTRAPPED',
      message: 'the ledger probe returned no row.',
    })
  }
  orHalt(
    evaluateLedgerBootstrap({
      schemaExists: Number(ledger.schema_count) === 1,
      tableExists: Number(ledger.table_count) === 1,
      checkConstraints: Number(ledger.check_count),
      notProductionCheckPinsProductionRef: Number(ledger.veto_count) === 1,
      partialUniqueIndexes: Number(ledger.partial_unique_count),
      primaryKey: Number(ledger.pk_count),
    }),
  )
  say('LEDGER VERIFIED: uellix_provisioning.applied_units, 5 CHECKs incl. the production veto, 2 partial unique indexes')

  const created = tablesCreatedByUnit()

  // THE STORAGE BOUNDARY EVIDENCE — TWO WITNESSES.
  //
  // Independent audit demonstrated that reading the artefact alone let a
  // hand-written JSON derive 042 with PART B never installed. So the catalogue
  // is measured LIVE, read-only, through this same connection, and the artefact
  // is kept as the durable record that must agree with it.
  //
  // Measured only when the journal already records unit 41: before that the
  // boundary is not in play and three extra round-trips per loop would buy
  // nothing.
  let boundaryArtefact: StorageBoundaryArtefact | null = null
  let artefactProjectRef: string | null = null
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, STORAGE_BOUNDARY_ARTEFACT), 'utf8')) as
      StorageBoundaryArtefact & { projectRef?: string }
    boundaryArtefact = raw
    artefactProjectRef = typeof raw.projectRef === 'string' ? raw.projectRef : null
  } catch {
    boundaryArtefact = null
  }

  /** Measures the storage catalogue live. Read-only, three probes, no writes. */
  const measureStorage = (): StorageLiveEvidence | null => {
    const policies = probe<
      { schemaname: string; tablename: string; policyname: string; roles: string; cmd: string; qual: string | null; with_check: string | null }[]
    >(STORAGE_POLICIES_PROBE_SQL, 'storage policies')
    const helpers = probe<{ name: string; security_definer: boolean; proconfig: string }[]>(
      STORAGE_HELPERS_PROBE_SQL,
      'storage helpers',
    )
    const rls = probe<{ rls_enabled: boolean | null; evidence_bucket_count: number }[]>(
      STORAGE_RLS_PROBE_SQL,
      'storage rls + bucket',
    )[0]
    if (rls === undefined) return null
    return {
      helpers: helpers.map((h) => h.name),
      policies: policies.map<ObservedStoragePolicy>((p) => ({
        schemaname: p.schemaname,
        tablename: p.tablename,
        policyname: p.policyname,
        roles: p.roles,
        cmd: p.cmd,
        qual: p.qual,
        withCheck: p.with_check,
      })),
      rlsEnabled: rls.rls_enabled,
      bucketPresent: Number(rls.evidence_bucket_count) > 0,
    }
  }

  /** The boundary verdict, recomputed from the live catalogue every iteration. */
  const storageVerified = (rows: readonly JournalRow[]): boolean => {
    const partAJournalled = rows.some((r) => r.packageId === STORAGE_UNIT_ID && r.status === 'APPLIED')
    if (!partAJournalled) return false
    const verdict = reconcileStorageEvidence({
      live: measureStorage(),
      artefact: boundaryArtefact,
      artefactProjectRef,
      targetProjectRef: env.projectRef,
      partAJournalled,
    })
    say(`STORAGE BOUNDARY: ${verdict.state} — verified=${verdict.verified}`)
    for (const reason of verdict.reasons) say(`  - ${reason}`)
    return verdict.verified
  }

  // ---- the loop -----------------------------------------------------------
  for (;;) {
    const rows = journalRows()
    const position = orHalt(
      deriveNextUnit({
        rows,
        expectedProjectRef: env.projectRef,
        observedTables: catalogueTables(),
        tablesCreatedByUnit: created,
        storageBoundaryVerified: storageVerified(rows),
      }),
    )
    state.lastCommittedUnit = position.lastCommittedUnit
    state.journalCount = position.journalCount

    if (position.nextUnit === null) {
      const completion = orHalt(
        evaluateCompletion({
          rows,
          expectedProjectRef: env.projectRef,
          observedTables: catalogueTables(),
          tablesCreatedByUnit: created,
          storageBoundaryVerified: storageVerified(rows),
        }),
      )
      say('')
      say('PHASE_BASELINE = PASS')
      say('BASELINE_COMPLETION_GATE = PASS')
      say(`baselineApplied = ${completion.baselineApplied}`)
      for (const gate of completion.pendingGates) say(`  STILL PENDING: ${gate}`)
      process.exit(OPERATOR_EXIT.OK)
    }

    const unit = position.nextUnit
    state.expectedOrFailedUnit = unit.id
    say('')
    say(`JOURNAL VERIFIED: ${position.journalCount} unit(s) reconcile with the catalogue`)
    say(`NEXT UNIT: ${pad(unit.ordinal)} ${unit.id}`)

    // The governed boundary. Checked BEFORE the source is even read.
    const boundary = storageBoundaryStop(unit)
    if (boundary !== null) halt(boundary)

    applyAndVerify(unit, env.projectRef, args.dryRun)
    if (args.dryRun) {
      say('')
      say('DRY RUN: stopped before applying anything. No remote write was attempted.')
      process.exit(OPERATOR_EXIT.OK)
    }
  }
}

function applyAndVerify(unit: BaselineUnit, projectRef: string, dryRun: boolean): void {
  const tag = `[${pad(unit.ordinal)}/${pad(BASELINE_UNITS.length)}]`

  // ---- BEFORE -------------------------------------------------------------
  const source = read(unit.file)
  orHalt(verifyUnitSource(unit, source))
  const wrapperPath = wrapperPathFor(unit)
  const wrapper = read(wrapperPath)
  if (!wrapperCarriesJournalAppend(wrapper)) {
    halt({
      ok: false,
      code: 'OPERATOR_WRAPPER_INVALID',
      message: `${wrapperPath} does not carry the journal append. A wrapper that applies its unit and records nothing is the exact defect the journal exists to remove.`,
    })
  }
  say(`${tag} PRECHECK PASS  source sha ${unit.sha256.slice(0, 12)}…, wrapper carries the journal append`)

  if (dryRun) {
    say(`${tag} DRY RUN — would apply ${wrapperPath}`)
    return
  }

  // ---- APPLY --------------------------------------------------------------
  say(`${tag} APPLY`)
  const applied = spawnSync(PSQL, [...applyArgv(wrapperPath, projectRef)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  if (applied.status !== 0) {
    halt({
      ok: false,
      code: 'OPERATOR_APPLY_FAILED',
      message: `psql exited ${applied.status ?? '(spawn error)'} applying ${wrapperPath}. Under psql -1 the unit and its journal row rolled back together. ${(applied.stderr ?? '').trim()}`,
    })
  }

  // ---- AFTER: the journal -------------------------------------------------
  const rows = journalRows()
  orHalt(evaluateUnitJournal({ unit, rows, expectedProjectRef: projectRef }))
  state.lastCommittedUnit = unit.id
  state.journalCount = rows.filter((r) => r.status === 'APPLIED').length
  say(`${tag} JOURNAL PASS`)

  // ---- AFTER: the catalogue -----------------------------------------------
  const expectation = unitStructuralExpectation(unit, source ?? '')
  if (!expectation.specific) {
    // Saying "not applicable" is the honest outcome. Manufacturing a check here
    // would turn "we did not verify" into "we verified", which is worse than
    // not checking at all because it is indistinguishable from having checked.
    say(`${tag} POSTCONDITIONS NOT APPLICABLE — ${expectation.note}`)
  } else {
    const observed = probe<
      {
        tables: string[]
        functions: string[]
        triggers: string[]
        rls_enabled_tables: string[]
        policies: string[]
        row_count: string
      }[]
    >(postconditionProbeSql(expectation), `postconditions for ${unit.id}`)[0]
    if (observed === undefined) {
      halt({
        ok: false,
        code: 'OPERATOR_VERIFICATION_QUERY_FAILED',
        message: `the postcondition probe for ${unit.id} returned no row.`,
      })
    }
    orHalt(
      evaluateUnitPostconditions(expectation, {
        tables: observed.tables,
        functions: observed.functions,
        triggers: observed.triggers,
        rlsEnabledTables: observed.rls_enabled_tables,
        policies: observed.policies,
        rowCount: Number(observed.row_count),
      }),
    )
    say(
      `${tag} POSTCONDITIONS PASS  ${[
        expectation.tables.length > 0 ? `${expectation.tables.length} table(s)` : null,
        expectation.functions.length > 0 ? `${expectation.functions.length} function(s)` : null,
        expectation.triggers.length > 0 ? `${expectation.triggers.length} trigger(s)` : null,
        expectation.rlsEnabledTables.length > 0 ? `${expectation.rlsEnabledTables.length} RLS table(s)` : null,
        expectation.policies.length > 0 ? `${expectation.policies.length} policy(ies)` : null,
        expectation.expectsNoRows ? 'zero rows' : null,
      ]
        .filter(Boolean)
        .join(', ')}`,
    )
  }

  say(`${tag} VERIFIED`)
}

main()
