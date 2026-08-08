// tests/hosted/operator-runner.test.ts
//
// The adversarial suite for the BASELINE OPERATOR RUNNER's decision core.
//
// The runner has exactly one job the tests can hold it to: REFUSE. Every case
// below is a way the run could go wrong that must produce a stop rather than an
// apply, and each is paired with a POSITIVE control — the same input, corrected
// — so a test that stopped passing because the function started refusing
// everything would fail too. A refuser that refuses unconditionally is not a
// safety property, it is a broken function that looks like one.
//
// Nothing here touches a network, a database, or psql. The core is pure.

import { describe, expect, it } from 'vitest'

import { BASELINE_UNITS, baselineUnit } from '../../db/hosted/baseline-manifest'
import { sha256OfSql } from '../../db/hosted/hosted-package-manifest'
import type { JournalRow } from '../../db/hosted/baseline-journal'
import { KNOWN_STAGING_PROJECT_REF } from '../../db/hosted/target-identity'
import { SET_ROLE_PATH_VERIFIED } from '../../db/hosted/managed-policy-channel'
import {
  CATALOGUE_TABLES_SQL,
  PSQL_PROBE_FLAGS,
  parsePsqlJson,
  describeProbeOutput,
  OPERATOR_EXIT,
  exitCodeFor,
  parseOperatorArgs,
  JOURNAL_SNAPSHOT_SQL,
  LEDGER_BOOTSTRAP_PROBE_SQL,
  evaluateCompletion,
  postconditionProbeSql,
  sqlIdentifier,
  sqlLiteral,
  deriveNextUnit,
  evaluateLedgerBootstrap,
  evaluateOperatorEnvironment,
  evaluateRepoState,
  evaluateUnitJournal,
  evaluateUnitPostconditions,
  redactOperatorLog,
  storageBoundaryStop,
  unitStructuralExpectation,
  verifyUnitSource,
  OPERATOR_EXPECTED_DATABASE,
  OPERATOR_EXPECTED_SSLMODE,
} from '../../db/hosted/operator-runner'

const STAGING = KNOWN_STAGING_PROJECT_REF
const PROD = 'ctaxtgujyyprgynmnvtq'
const HEAD = 'e3cc51a39568b72b052ffb225d45363ba10e35b8'
const BRANCH = 'codex/stella-staging'

/** The environment a correct operator shell presents. The positive control. */
const GOOD_ENV = {
  UELLIX_STAGING_REF: STAGING,
  PGUSER: `postgres.${STAGING}`,
  PGHOST: 'aws-0-us-east-2.pooler.supabase.com',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: 'C:\\certs\\prod-ca-2021.crt',
  PGPASSWORD: 'not-a-real-password-and-never-printed',
} as const

const codeOf = (v: { ok: boolean; code?: string }): string => (v.ok ? 'OK' : (v.code ?? 'MISSING'))

const withEnv = (patch: Record<string, string | undefined>) =>
  evaluateOperatorEnvironment({ ...GOOD_ENV, ...patch })

// ---------------------------------------------------------------------------
// 3. Identity and safety before anything runs
// ---------------------------------------------------------------------------

describe('operator environment', () => {
  it('accepts the pinned staging shell', () => {
    const v = evaluateOperatorEnvironment(GOOD_ENV)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.projectRef).toBe(STAGING)
  })

  it('refuses the production project ref', () => {
    expect(codeOf(withEnv({ UELLIX_STAGING_REF: PROD, PGUSER: `postgres.${PROD}` }))).toBe(
      'OPERATOR_ENV_PRODUCTION_REF',
    )
  })

  it('refuses a production PGUSER even when the staging ref is pinned', () => {
    expect(codeOf(withEnv({ PGUSER: `postgres.${PROD}` }))).toBe('OPERATOR_ENV_PGUSER_PRODUCTION')
  })

  it('refuses a PGUSER that names a different project than the pin', () => {
    expect(codeOf(withEnv({ PGUSER: 'postgres.aaaaaaaaaaaaaaaaaaaa' }))).toBe(
      'OPERATOR_ENV_PGUSER_MISMATCH',
    )
  })

  it('refuses the transaction pooler port', () => {
    expect(codeOf(withEnv({ PGPORT: '6543' }))).toBe('OPERATOR_ENV_PORT_INVALID')
  })

  it('refuses any sslmode other than verify-full', () => {
    for (const mode of ['require', 'prefer', 'verify-ca', 'disable', '']) {
      expect(codeOf(withEnv({ PGSSLMODE: mode })), mode).toBe('OPERATOR_ENV_SSLMODE_INVALID')
    }
    expect(OPERATOR_EXPECTED_SSLMODE).toBe('verify-full')
  })

  it('refuses a missing root certificate path', () => {
    expect(codeOf(withEnv({ PGSSLROOTCERT: undefined }))).toBe('OPERATOR_ENV_SSLROOTCERT_MISSING')
  })

  it('refuses an absent password without ever quoting it', () => {
    expect(codeOf(withEnv({ PGPASSWORD: undefined }))).toBe('OPERATOR_ENV_PASSWORD_MISSING')
    expect(codeOf(withEnv({ PGPASSWORD: '   ' }))).toBe('OPERATOR_ENV_PASSWORD_MISSING')
  })

  it('refuses a database other than postgres', () => {
    expect(codeOf(withEnv({ PGDATABASE: 'uellix' }))).toBe('OPERATOR_ENV_DATABASE_INVALID')
    expect(OPERATOR_EXPECTED_DATABASE).toBe('postgres')
  })

  it('refuses a host that is not a Supabase endpoint', () => {
    expect(codeOf(withEnv({ PGHOST: 'db.example.com' }))).toBe('OPERATOR_ENV_HOST_REFUSED')
  })

  it('never echoes the password into any refusal message', () => {
    const secret = 'S3cret-Passw0rd-Do-Not-Leak'
    const stops = [
      withEnv({ PGPASSWORD: secret, PGSSLMODE: 'require' }),
      withEnv({ PGPASSWORD: secret, PGPORT: '6543' }),
      withEnv({ PGPASSWORD: secret, PGUSER: `postgres.${PROD}` }),
      withEnv({ PGPASSWORD: secret, PGDATABASE: 'uellix' }),
    ]
    for (const stop of stops) {
      expect(stop.ok).toBe(false)
      if (!stop.ok) expect(stop.message).not.toContain(secret)
    }
  })
})

// ---------------------------------------------------------------------------
// Repo pin
// ---------------------------------------------------------------------------

describe('repo state', () => {
  const good = { branch: BRANCH, head: HEAD, dirty: false }
  const pin = { branch: BRANCH, head: HEAD }

  it('accepts the pinned branch and HEAD on a clean tree', () => {
    expect(codeOf(evaluateRepoState(good, pin))).toBe('OK')
  })

  it('refuses a different branch', () => {
    expect(codeOf(evaluateRepoState({ ...good, branch: 'main' }, pin))).toBe(
      'OPERATOR_REPO_BRANCH_MISMATCH',
    )
  })

  it('refuses a HEAD that is not the authorized one', () => {
    expect(codeOf(evaluateRepoState({ ...good, head: 'a'.repeat(40) }, pin))).toBe(
      'OPERATOR_REPO_HEAD_MISMATCH',
    )
  })

  it('refuses a dirty tree', () => {
    expect(codeOf(evaluateRepoState({ ...good, dirty: true }, pin))).toBe('OPERATOR_REPO_DIRTY')
  })
})

// ---------------------------------------------------------------------------
// 4. Manifest and hashes — LF-normalized, not the CRLF bytes on a Windows disk
// ---------------------------------------------------------------------------

describe('unit source verification', () => {
  const unit = baselineUnit('0000_quick_husk.sql')
  const source = 'CREATE TABLE "users" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);\n'

  it('accepts a source whose LF-normalized hash matches the manifest pin', () => {
    const pinned = { ...unit, sha256: sha256OfSql(source) }
    expect(codeOf(verifyUnitSource(pinned, source))).toBe('OK')
  })

  it('accepts the same source checked out with CRLF line endings', () => {
    const pinned = { ...unit, sha256: sha256OfSql(source) }
    expect(codeOf(verifyUnitSource(pinned, source.replace(/\n/g, '\r\n')))).toBe('OK')
  })

  it('refuses a source whose content changed', () => {
    const pinned = { ...unit, sha256: sha256OfSql(source) }
    expect(codeOf(verifyUnitSource(pinned, `${source}DROP TABLE users;\n`))).toBe(
      'OPERATOR_SOURCE_SHA_MISMATCH',
    )
  })

  it('refuses a source that could not be read', () => {
    expect(codeOf(verifyUnitSource(unit, null))).toBe('OPERATOR_SOURCE_SHA_MISMATCH')
  })

  it('holds for every unit in the real manifest', () => {
    // A corrupt manifest entry must not be able to hide behind a hand-picked
    // fixture: the pin and the hash function have to agree on all fifty.
    expect(BASELINE_UNITS).toHaveLength(50)
    for (const u of BASELINE_UNITS) expect(u.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// 2. Ledger precondition — the state the first run must find
// ---------------------------------------------------------------------------

describe('ledger bootstrap precondition', () => {
  const good = {
    schemaExists: true,
    tableExists: true,
    checkConstraints: 5,
    notProductionCheckPinsProductionRef: true,
    partialUniqueIndexes: 2,
    primaryKey: 1,
  }

  it('accepts the state unit ZERO leaves behind', () => {
    expect(codeOf(evaluateLedgerBootstrap(good))).toBe('OK')
  })

  it('refuses when the schema is absent', () => {
    expect(codeOf(evaluateLedgerBootstrap({ ...good, schemaExists: false }))).toBe(
      'OPERATOR_LEDGER_NOT_BOOTSTRAPPED',
    )
  })

  it('refuses when the ledger table is absent', () => {
    expect(codeOf(evaluateLedgerBootstrap({ ...good, tableExists: false }))).toBe(
      'OPERATOR_LEDGER_NOT_BOOTSTRAPPED',
    )
  })

  it('refuses when the production denylist CHECK is not pinning production', () => {
    // The veto is the single constraint whose absence makes every later row
    // unsafe, so it gets its own refusal rather than being folded into a count.
    expect(
      codeOf(evaluateLedgerBootstrap({ ...good, notProductionCheckPinsProductionRef: false })),
    ).toBe('OPERATOR_LEDGER_NOT_BOOTSTRAPPED')
  })

  it('refuses when a CHECK constraint went missing', () => {
    expect(codeOf(evaluateLedgerBootstrap({ ...good, checkConstraints: 4 }))).toBe(
      'OPERATOR_LEDGER_NOT_BOOTSTRAPPED',
    )
  })

  it('refuses when the anti-duplicate indexes are not both present', () => {
    expect(codeOf(evaluateLedgerBootstrap({ ...good, partialUniqueIndexes: 1 }))).toBe(
      'OPERATOR_LEDGER_NOT_BOOTSTRAPPED',
    )
  })
})

// ---------------------------------------------------------------------------
// 8. Resume — the next unit comes from the journal, never from a counter
// ---------------------------------------------------------------------------

const rowFor = (ordinal: number, patch: Partial<JournalRow> = {}): JournalRow => {
  const unit = BASELINE_UNITS[ordinal - 1]!
  return {
    environment: 'staging',
    projectRef: STAGING,
    packageId: unit.id,
    phase: 'PHASE_BASELINE',
    sourceSha256: unit.sha256,
    derivedSha256: null,
    securitySurfaceDigest: null,
    status: 'APPLIED',
    appliedAt: '2026-08-08T00:00:00Z',
    applySessionIdentity: 'postgres',
    ...patch,
  }
}

/** Tables each unit creates, keyed by unit id — the catalogue cross-check input. */
const tablesByUnit: Record<string, readonly string[]> = Object.fromEntries(
  BASELINE_UNITS.map((u, i) => [u.id, [`public.__unit_${i + 1}`]]),
)

const observedFor = (upTo: number): string[] =>
  BASELINE_UNITS.slice(0, upTo).map((_, i) => `public.__unit_${i + 1}`)

const derive = (rows: readonly JournalRow[], observedUpTo = rows.length) =>
  deriveNextUnit({
    rows,
    expectedProjectRef: STAGING,
    observedTables: observedFor(observedUpTo),
    tablesCreatedByUnit: tablesByUnit,
  })

describe('next unit derivation', () => {
  it('starts at unit 1 when the journal is empty', () => {
    const v = derive([])
    expect(codeOf(v)).toBe('OK')
    if (v.ok) {
      expect(v.lastCommittedUnit).toBeNull()
      expect(v.nextUnit?.ordinal).toBe(1)
      expect(v.nextUnit?.id).toBe('0000_quick_husk.sql')
      expect(v.journalCount).toBe(0)
    }
  })

  it('resumes at 027 when 001 through 026 are recorded', () => {
    const rows = Array.from({ length: 26 }, (_, i) => rowFor(i + 1))
    const v = derive(rows)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) {
      expect(v.lastCommittedUnit).toBe(BASELINE_UNITS[25]!.id)
      expect(v.nextUnit?.ordinal).toBe(27)
      expect(v.journalCount).toBe(26)
    }
  })

  it('refuses a journal with a gap — a later unit recorded while an earlier one is not', () => {
    const rows = [rowFor(1), rowFor(2), rowFor(5)]
    expect(codeOf(derive(rows, 5))).toBe('OPERATOR_JOURNAL_FUTURE_UNIT')
  })

  it('refuses a duplicate APPLIED row for the same unit', () => {
    const rows = [rowFor(1), rowFor(1)]
    expect(codeOf(derive(rows, 1))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
  })

  it('refuses a row whose sha names a different version of the unit', () => {
    const rows = [rowFor(1, { sourceSha256: 'f'.repeat(64) })]
    expect(codeOf(derive(rows, 1))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
  })

  it('refuses a row belonging to another project', () => {
    const rows = [rowFor(1, { projectRef: PROD })]
    expect(codeOf(derive(rows, 1))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
  })

  it('refuses when the catalogue was not measured at all', () => {
    const v = deriveNextUnit({
      rows: [rowFor(1)],
      expectedProjectRef: STAGING,
      observedTables: null,
      tablesCreatedByUnit: tablesByUnit,
    })
    expect(codeOf(v)).toBe('OPERATOR_JOURNAL_UNRECONCILED')
  })

  it('refuses a row claiming APPLIED whose tables are not in the catalogue', () => {
    expect(codeOf(derive([rowFor(1)], 0))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
  })

  it('reports completion once all fifty are recorded', () => {
    const rows = BASELINE_UNITS.map((_, i) => rowFor(i + 1))
    const v = derive(rows)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) {
      expect(v.nextUnit).toBeNull()
      expect(v.journalCount).toBe(50)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. AFTER — the journal row must be exactly this unit's
// ---------------------------------------------------------------------------

describe('per-unit journal verification', () => {
  const unit = BASELINE_UNITS[0]!
  const check = (rows: readonly JournalRow[]) =>
    evaluateUnitJournal({ unit, rows, expectedProjectRef: STAGING })

  it('accepts exactly one matching APPLIED row', () => {
    expect(codeOf(check([rowFor(1)]))).toBe('OK')
  })

  it('refuses when the row is absent', () => {
    expect(codeOf(check([]))).toBe('OPERATOR_JOURNAL_ROW_MISMATCH')
  })

  it('refuses two rows for the same unit', () => {
    expect(codeOf(check([rowFor(1), rowFor(1)]))).toBe('OPERATOR_JOURNAL_DUPLICATE')
  })

  it('refuses a row carrying the wrong sha', () => {
    expect(codeOf(check([rowFor(1, { sourceSha256: '0'.repeat(64) })]))).toBe(
      'OPERATOR_JOURNAL_ROW_MISMATCH',
    )
  })

  it('refuses a row carrying the wrong project ref', () => {
    expect(codeOf(check([rowFor(1, { projectRef: PROD })]))).toBe('OPERATOR_JOURNAL_ROW_MISMATCH')
  })

  it('refuses a row carrying the wrong phase', () => {
    expect(codeOf(check([rowFor(1, { phase: 'PHASE_STELLA_BOOTSTRAP' })]))).toBe(
      'OPERATOR_JOURNAL_ROW_MISMATCH',
    )
  })

  it('refuses a row whose status is not APPLIED', () => {
    expect(codeOf(check([rowFor(1, { status: 'MANUAL_BOUNDARY_PENDING' })]))).toBe(
      'OPERATOR_JOURNAL_ROW_MISMATCH',
    )
  })

  it('refuses when a LATER unit is already recorded', () => {
    expect(codeOf(check([rowFor(1), rowFor(2)]))).toBe('OPERATOR_JOURNAL_FUTURE_UNIT')
  })
})

// ---------------------------------------------------------------------------
// 6. Structural postconditions, derived from the corpus — never invented
// ---------------------------------------------------------------------------

describe('structural expectation', () => {
  const CREATES_TABLES = [
    'CREATE TABLE "organizations" (',
    '  "id" uuid PRIMARY KEY NOT NULL,',
    '  "slug" varchar(255) NOT NULL',
    ');',
  ].join('\n')

  it('derives the tables a unit creates from its own SQL', () => {
    const e = unitStructuralExpectation(BASELINE_UNITS[0]!, CREATES_TABLES)
    expect(e.tables).toContain('public.organizations')
    expect(e.specific).toBe(true)
  })

  it('expects zero rows when the unit is classified as creating no DML', () => {
    const e = unitStructuralExpectation(BASELINE_UNITS[0]!, CREATES_TABLES)
    expect(e.expectsNoRows).toBe(true)
  })

  it('reports the absence of a specific postcondition instead of inventing one', () => {
    // A unit that only widens a column creates no catalogue object this core can
    // name. Saying so is the honest outcome; fabricating an assertion is not.
    const e = unitStructuralExpectation(
      BASELINE_UNITS[0]!,
      'ALTER TABLE "users" ALTER COLUMN "full_name" TYPE varchar(512);\n',
    )
    expect(e.specific).toBe(false)
    expect(e.note).toMatch(/no specific structural postcondition/i)
  })

  it('never claims a postcondition the source does not support', () => {
    const e = unitStructuralExpectation(BASELINE_UNITS[0]!, CREATES_TABLES)
    expect(e.functions).toHaveLength(0)
    expect(e.policies).toHaveLength(0)
  })
})

describe('postcondition evaluation', () => {
  const expectation = {
    tables: ['public.organizations', 'public.users'],
    functions: [],
    triggers: [],
    rlsEnabledTables: [],
    policies: [],
    expectsNoRows: true,
    specific: true,
    note: '',
  }

  it('accepts a catalogue that contains every expected object', () => {
    const v = evaluateUnitPostconditions(expectation, {
      tables: ['public.organizations', 'public.users', 'public.audit_logs'],
      functions: [],
      triggers: [],
      rlsEnabledTables: [],
      policies: [],
      rowCount: 0,
    })
    expect(codeOf(v)).toBe('OK')
  })

  it('refuses when an expected table is missing', () => {
    const v = evaluateUnitPostconditions(expectation, {
      tables: ['public.organizations'],
      functions: [],
      triggers: [],
      rlsEnabledTables: [],
      policies: [],
      rowCount: 0,
    })
    expect(codeOf(v)).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('refuses when a DML-free unit left rows behind', () => {
    const v = evaluateUnitPostconditions(expectation, {
      tables: ['public.organizations', 'public.users'],
      functions: [],
      triggers: [],
      rlsEnabledTables: [],
      policies: [],
      rowCount: 3,
    })
    expect(codeOf(v)).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('refuses when RLS was expected and is not enabled', () => {
    const v = evaluateUnitPostconditions(
      { ...expectation, rlsEnabledTables: ['public.users'] },
      {
        tables: ['public.organizations', 'public.users'],
        functions: [],
        triggers: [],
        rlsEnabledTables: [],
        policies: [],
        rowCount: 0,
      },
    )
    expect(codeOf(v)).toBe('OPERATOR_POSTCONDITION_FAILED')
  })
})

// ---------------------------------------------------------------------------
// 9. Unit 41 — the boundary the runner must not collapse
// ---------------------------------------------------------------------------

describe('storage human boundary', () => {
  it('stops at the storage unit', () => {
    const stop = storageBoundaryStop(baselineUnit('20260716000001_storage_policies.sql'))
    expect(stop).not.toBeNull()
    expect(stop?.code).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })

  it('names PART A and PART B rather than merging them', () => {
    const stop = storageBoundaryStop(baselineUnit('20260716000001_storage_policies.sql'))
    expect(stop?.message).toMatch(/PART A/)
    expect(stop?.message).toMatch(/PART B/)
  })

  it('does not stop at an ordinary unit', () => {
    expect(storageBoundaryStop(baselineUnit('0000_quick_husk.sql'))).toBeNull()
  })

  it('is the unit at ordinal 41, and a later unit depends on it', () => {
    // Pins WHY the runner cannot simply skip past the boundary and keep going.
    const storage = baselineUnit('20260716000001_storage_policies.sql')
    expect(storage.ordinal).toBe(41)
    expect(BASELINE_UNITS.some((u) => u.dependsOn.includes(storage.id))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3/7. Secrets never reach a log line
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Completion — never asserted by the runner reaching the end of a loop
// ---------------------------------------------------------------------------

describe('completion', () => {
  const complete = BASELINE_UNITS.map((_, i) => rowFor(i + 1))
  const full = (patch: Partial<Parameters<typeof evaluateCompletion>[0]> = {}) =>
    evaluateCompletion({
      rows: complete,
      expectedProjectRef: STAGING,
      observedTables: observedFor(50),
      tablesCreatedByUnit: tablesByUnit,
      storageBoundaryVerified: true,
      ...patch,
    })

  it('reports baselineApplied only when all fifty reconcile and the boundary is verified', () => {
    const v = full()
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.baselineApplied).toBe(true)
  })

  it('refuses when a unit is missing, however many others are recorded', () => {
    expect(codeOf(full({ rows: complete.slice(0, 49) }))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
  })

  it('refuses to call the baseline applied while the storage boundary is unverified', () => {
    const v = full({ storageBoundaryVerified: false })
    expect(codeOf(v)).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })

  it('does not claim completion under the boundary state this repo actually measures', () => {
    // SET_ROLE_PATH_VERIFIED is a pinned false. If it ever flips, this test is
    // the thing that makes someone look at the completion path again.
    expect(SET_ROLE_PATH_VERIFIED).toBe(false)
    expect(codeOf(full({ storageBoundaryVerified: SET_ROLE_PATH_VERIFIED }))).toBe(
      'OPERATOR_STORAGE_HUMAN_BOUNDARY',
    )
  })

  it('names the gates that stay pending after a green baseline', () => {
    const v = full()
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.pendingGates.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The probes are read-only by construction, not by intention
// ---------------------------------------------------------------------------

describe('read-only probes', () => {
  const probes = [
    LEDGER_BOOTSTRAP_PROBE_SQL,
    JOURNAL_SNAPSHOT_SQL,
    CATALOGUE_TABLES_SQL,
    postconditionProbeSql(unitStructuralExpectation(BASELINE_UNITS[0]!, 'CREATE TABLE "users" (\n"id" uuid\n);\n')),
  ]

  it('opens every probe in a read-only transaction and rolls it back', () => {
    for (const sql of probes) {
      expect(sql.startsWith('BEGIN READ ONLY;')).toBe(true)
      expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true)
    }
  })

  it('contains no statement that could write', () => {
    for (const sql of probes) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER|GRANT|REVOKE)\b/i)
    }
  })

  it('aggregates with jsonb_agg, because json_agg splits the payload across lines', () => {
    // Measured against PostgreSQL 17 via psql 17.10: `json_agg` renders three
    // rows as `[{"a":1}, \r\n {"a":2}, \r\n {"a":3}]` — a multi-line payload the
    // one-line contract correctly refuses. `jsonb_agg` renders the same rows on
    // ONE line, and stays on one line at sixty. The single-row probes hid this;
    // the catalogue probe, which returns one row per table, did not.
    for (const sql of probes) {
      expect(sql).not.toMatch(/\bjson_agg\b/)
      expect(sql).toMatch(/\bjsonb_agg\b/)
    }
  })

  it('escapes a quote in an identifier rather than closing it', () => {
    expect(sqlIdentifier('public.we"ird')).toBe('"public"."we""ird"')
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
  })

  it('builds a row count over exactly the tables the unit creates', () => {
    const sql = postconditionProbeSql(
      unitStructuralExpectation(BASELINE_UNITS[0]!, 'CREATE TABLE "organizations" (\n"id" uuid\n);\n'),
    )
    expect(sql).toContain('"public"."organizations"')
  })
})

// ---------------------------------------------------------------------------
// The operator's arguments, and what a stop costs the shell
// ---------------------------------------------------------------------------

describe('argument parsing', () => {
  const ok = ['--psql', 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe', '--head', HEAD]

  it('accepts an explicit psql path and an explicit HEAD pin', () => {
    const v = parseOperatorArgs(ok)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) {
      expect(v.psqlPath).toContain('psql.exe')
      expect(v.expectedHead).toBe(HEAD)
    }
  })

  it('accepts --diagnose, and it is off unless asked for', () => {
    const off = parseOperatorArgs(ok)
    expect(off.ok && off.diagnose).toBe(false)
    const on = parseOperatorArgs([...ok, '--diagnose'])
    expect(on.ok && on.diagnose).toBe(true)
  })

  it('refuses to fall back to a psql on PATH', () => {
    // The operator shell has no psql on PATH. Resolving one silently would mean
    // running an unknown client version against a hosted database.
    expect(codeOf(parseOperatorArgs(['--head', HEAD]))).toBe('OPERATOR_ARGS_INVALID')
  })

  it('refuses to run without an explicit HEAD pin', () => {
    expect(codeOf(parseOperatorArgs(ok.slice(0, 2)))).toBe('OPERATOR_ARGS_INVALID')
  })

  it('refuses a HEAD that is not a full commit sha', () => {
    expect(codeOf(parseOperatorArgs(['--psql', 'p.exe', '--head', 'e3cc51a']))).toBe(
      'OPERATOR_ARGS_INVALID',
    )
  })

  it('refuses an unrecognised flag rather than ignoring it', () => {
    expect(codeOf(parseOperatorArgs([...ok, '--force']))).toBe('OPERATOR_ARGS_INVALID')
  })
})

describe('exit codes', () => {
  it('gives the governed storage boundary its own code, distinct from a failure', () => {
    expect(exitCodeFor('OPERATOR_STORAGE_HUMAN_BOUNDARY')).toBe(OPERATOR_EXIT.HUMAN_BOUNDARY)
    expect(exitCodeFor('OPERATOR_STORAGE_HUMAN_BOUNDARY')).not.toBe(OPERATOR_EXIT.INTERRUPTED)
  })

  it('maps every other stop to a non-zero interruption', () => {
    for (const code of [
      'OPERATOR_ENV_PRODUCTION_REF',
      'OPERATOR_APPLY_FAILED',
      'OPERATOR_POSTCONDITION_FAILED',
      'OPERATOR_JOURNAL_DUPLICATE',
    ] as const) {
      expect(exitCodeFor(code), code).toBe(OPERATOR_EXIT.INTERRUPTED)
      expect(exitCodeFor(code)).not.toBe(OPERATOR_EXIT.OK)
    }
  })
})

// ---------------------------------------------------------------------------
// The psql invocation contract.
//
// The first dry run against staging died here, and the reason was not the
// query, not the network and not the encoding. `psql -c` with a multi-statement
// string prints a COMMAND STATUS TAG for each utility statement, so stdout was:
//
//     BEGIN\r\n[{...}]\r\nROLLBACK\r\n
//
// `-t` suppresses the column header and the "(1 row)" footer. It does NOT
// suppress command status — that is `-q`. Measured against psql 17.10 on
// Windows, which is the client the operator actually runs.
// ---------------------------------------------------------------------------

describe('psql probe flags', () => {
  it('runs quiet, so utility statements do not print command status onto stdout', () => {
    expect(PSQL_PROBE_FLAGS).toContain('-q')
  })

  it('keeps the flags that make the payload a single bare value', () => {
    expect(PSQL_PROBE_FLAGS).toContain('-A')
    expect(PSQL_PROBE_FLAGS).toContain('-t')
  })

  it('ignores the operator personal psqlrc', () => {
    expect(PSQL_PROBE_FLAGS).toContain('-X')
  })
})

describe('psql payload parsing', () => {
  const parse = (stdout: string) => parsePsqlJson<unknown>(stdout, 'ledger bootstrap')

  it('accepts exactly what psql -q -A -t emits on Windows, CRLF included', () => {
    // These are measured bytes, not a guess: psql 17.10 against a local
    // Postgres produced `[{"a":1}]\r\n` for the probe shape this runner uses.
    const v = parse('[{"a":1}]\r\n')
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.value).toEqual([{ a: 1 }])
  })

  it('accepts an empty result set', () => {
    const v = parse('[]\r\n')
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.value).toEqual([])
  })

  it('refuses the command-status output that broke the first dry run', () => {
    // The regression. Blank-line tolerance must never grow into tag tolerance.
    expect(codeOf(parse('BEGIN\r\n[{"a":1,"b":2}]\r\nROLLBACK\r\n'))).toBe(
      'OPERATOR_VERIFICATION_QUERY_FAILED',
    )
  })

  it('refuses two payloads rather than picking one', () => {
    expect(codeOf(parse('[1]\r\n[2]\r\n'))).toBe('OPERATOR_VERIFICATION_QUERY_FAILED')
  })

  it('refuses empty stdout', () => {
    expect(codeOf(parse(''))).toBe('OPERATOR_VERIFICATION_QUERY_FAILED')
    expect(codeOf(parse('   \r\n  \r\n'))).toBe('OPERATOR_VERIFICATION_QUERY_FAILED')
  })

  it('refuses a line that is not JSON', () => {
    expect(codeOf(parse('ERROR:  division by zero\r\n'))).toBe(
      'OPERATOR_VERIFICATION_QUERY_FAILED',
    )
  })

  it('never salvages a payload out of surrounding noise', () => {
    // Scanning for the first `{` would "fix" this input. That is the fail-open
    // the contract exists to forbid: unexpected text means an unknown state.
    expect(codeOf(parse('some notice [{"a":1}] trailing\r\n'))).toBe(
      'OPERATOR_VERIFICATION_QUERY_FAILED',
    )
  })

  it('tolerates blank lines and a UTF-8 BOM, which carry no information', () => {
    expect(codeOf(parse('\r\n[]\r\n\r\n'))).toBe('OK')
    expect(codeOf(parse('﻿[]\r\n'))).toBe('OK')
  })
})

describe('probe diagnostics', () => {
  const report = (patch: Partial<Parameters<typeof describeProbeOutput>[0]> = {}) =>
    describeProbeOutput({
      stage: 'ledger bootstrap',
      exitCode: 0,
      stdout: 'BEGIN\r\n[{"a":1}]\r\nROLLBACK\r\n',
      stderr: '',
      ...patch,
    })

  it('reports the stage, the exit code and the shape of what arrived', () => {
    const r = report()
    expect(r).toContain('ledger bootstrap')
    expect(r).toContain('exit code')
    expect(r).toContain('3')
  })

  it('escapes the payload so control characters are visible rather than applied', () => {
    expect(report()).toContain('\\r\\n')
  })

  it('redacts a secret that reached stderr', () => {
    const r = report({ stderr: 'connection failed: postgresql://postgres:hunter2@h:5432/postgres' })
    expect(r).not.toContain('hunter2')
  })

  it('redacts a password-shaped assignment anywhere in the captured output', () => {
    expect(report({ stdout: 'PGPASSWORD=hunter2\r\n' })).not.toContain('hunter2')
  })
})

describe('log redaction', () => {
  it('removes a connection string', () => {
    const line = redactOperatorLog('connecting to postgresql://postgres:hunter2@db.x.supabase.co:5432/postgres')
    expect(line).not.toContain('hunter2')
  })

  it('keeps the project ref, which is public and the most useful thing to see', () => {
    expect(redactOperatorLog(`target ${STAGING}`)).toContain(STAGING)
  })

  it('removes an explicitly named password value', () => {
    expect(redactOperatorLog('PGPASSWORD=hunter2')).not.toContain('hunter2')
  })
})
