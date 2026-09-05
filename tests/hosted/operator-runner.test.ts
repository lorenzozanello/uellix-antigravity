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

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BASELINE_UNITS, baselineUnit } from '../../db/hosted/baseline-manifest'
import { scanBaselineSql } from '../../db/hosted/baseline-scanner'
import { wrapperCarriesJournalAppend, wrapperPathFor } from '../../db/hosted/baseline-journal-wrapper'
import { evaluateStorageBoundaryArtefact } from '../../db/hosted/managed-policy-channel'
import {
  EXPECTED_STORAGE_POLICY_SURFACE,
  verifyStoragePolicySurface,
  type ObservedStoragePolicy,
} from '../../db/hosted/baseline-postconditions'
import { sha256OfSql } from '../../db/hosted/hosted-package-manifest'
import type { JournalRow } from '../../db/hosted/baseline-journal'
import { KNOWN_STAGING_PROJECT_REF } from '../../db/hosted/target-identity'
import { SET_ROLE_PATH_VERIFIED } from '../../db/hosted/managed-policy-channel'
import {
  CATALOGUE_TABLES_SQL,
  PROBE_KEY_EXPRESSIONS,
  PSQL_APPLY_FLAGS,
  STORAGE_HELPERS_PROBE_SQL,
  STORAGE_POLICIES_PROBE_SQL,
  STORAGE_RLS_PROBE_SQL,
  applyArgv,
  reconcileStorageEvidence,
  type StorageLiveEvidence,
  keySegmentCount,
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
  journalCheckpoint,
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
    // fixture: the pin and the hash function have to agree on every unit.
    // W2-B2 (FIBIU-08/09/10) — re-derived: 64 (FIB Wave 2 B1 closure) + 3
    // (0053_fib_proxy_versions_provenance.sql, 0054_fib_proxy_rubric_
    // constraints.sql, 0055_fib_proxy_material_change_registry.sql) = 67.
    // Same derivation as tests/hosted/baseline-journal-wrapper.test.ts.
    // W2-B2-R1 (R-B2-03): + 0056 = 68; (R-B2-07): + policies unit 010 = 69.
    // COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08): + 0057/0058/0059
    // (W2-B3) = 72; + 0060 (W2-B3 completeness) = 73. Same derivation as
    // tests/hosted/baseline-journal-wrapper.test.ts.
    // HPO-ODS-W2-09 (COMMERCIAL-V1-WAVE2-RECONCILIATION successor remediation):
    // + 0061_fib_disposition_governance_function_execute_revocation.sql (the
    // B0-17 security successor to sealed 0060, REVOKE-only, no DML) = 74.
    // HPO-ODS-W2-12 (W2-B4 assumptions and causality): + 0062/0063 = 76.
    // HPO-ODS-W2-17 (W2-B5 governed models): + 0064/0065 = 78.
    expect(BASELINE_UNITS).toHaveLength(78)
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

  it('reports completion once all fifty are recorded AND the storage boundary is verified', () => {
    // This test used to omit the boundary evidence and pass. That was the
    // vulnerable behaviour independent audit found: fifty journal rows with
    // PART B never installed read as a finished baseline. The evidence is now
    // required, and the paired refusal lives in
    // "storage boundary cannot be crossed by a journal row".
    const rows = BASELINE_UNITS.map((_, i) => rowFor(i + 1))
    const v = deriveNextUnit({
      rows,
      expectedProjectRef: STAGING,
      observedTables: observedFor(BASELINE_UNITS.length),
      tablesCreatedByUnit: tablesByUnit,
      storageBoundaryVerified: true,
    })
    expect(codeOf(v)).toBe('OK')
    if (v.ok) {
      expect(v.nextUnit).toBeNull()
      expect(v.journalCount).toBe(BASELINE_UNITS.length)
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
// THE KEY-SHAPE CONTRACT
//
// Unit 032 (0031_rls_core.sql) applied and journalled correctly against staging,
// then its postcondition declared all 69 policies absent. A read-only inspection
// showed all 69 present. The two sides of the comparison were not disagreeing
// about the database — they were speaking different languages:
//
//   expected  (scanBaselineSql):  public.users.users_select_own
//   observed  (probe):            users_select_own
//
// Every Set.has() missed, so every policy was "missing". The tests could not see
// it because the projection lived inside a SQL string that nothing read.
// ---------------------------------------------------------------------------

describe('comparison key shape', () => {
  const sourceOf = (id: string): string =>
    readFileSync(path.join(process.cwd(), baselineUnit(id).file), 'utf8')

  /** Segments the scanner puts in a key, measured over the real corpus. */
  const scannerSegments = (pick: (f: ReturnType<typeof scanBaselineSql>) => readonly string[]): number => {
    const seen = new Set<number>()
    for (const unit of BASELINE_UNITS) {
      let sql: string
      try {
        sql = sourceOf(unit.id)
      } catch {
        continue
      }
      for (const key of pick(scanBaselineSql(sql))) seen.add(key.split('.').length)
    }
    expect(seen.size, 'the scanner must use ONE key shape per fact kind').toBeLessThanOrEqual(1)
    return [...seen][0] ?? 0
  }

  it('projects policies with schema, table AND policy name', () => {
    // THE REGRESSION. The scanner emits three segments; the probe emitted one.
    expect(scannerSegments((f) => f.policiesCreated)).toBe(3)
    expect(keySegmentCount(PROBE_KEY_EXPRESSIONS.policies)).toBe(3)
  })

  it('agrees on key shape for every other fact kind too', () => {
    // Written as one sweep rather than four cases, because the defect was a
    // CLASS: any projection that disagrees with the scanner silently reports a
    // present object as absent.
    for (const [kind, pick] of [
      ['tables', (f: ReturnType<typeof scanBaselineSql>) => f.tablesCreated],
      ['functions', (f: ReturnType<typeof scanBaselineSql>) => f.functionsCreated],
      ['triggers', (f: ReturnType<typeof scanBaselineSql>) => f.triggersCreated],
      ['rlsEnabledTables', (f: ReturnType<typeof scanBaselineSql>) => f.rlsEnabledTables],
    ] as const) {
      expect(
        keySegmentCount(PROBE_KEY_EXPRESSIONS[kind]),
        `${kind}: probe projection and scanner key must have the same shape`,
      ).toBe(scannerSegments(pick))
    }
  })

  it('counts segments without mistaking a separator for one', () => {
    expect(keySegmentCount(`tgname`)).toBe(1)
    expect(keySegmentCount(`'public.' || table_name`)).toBe(2)
    expect(keySegmentCount(`a || '.' || b || '.' || c`)).toBe(3)
  })
})

describe('the unit 032 false negative', () => {
  const unit = baselineUnit('0031_rls_core.sql')
  const source = readFileSync(path.join(process.cwd(), unit.file), 'utf8')
  const expectation = unitStructuralExpectation(unit, source)

  /** What staging really holds, in pg_policies' own columns. */
  const REMOTE = [
    ['public', 'users', 'users_select_own'],
    ['public', 'users', 'users_insert_own'],
    ['public', 'users', 'users_update_own'],
    ['public', 'organizations', 'orgs_select_member_or_admin'],
    ['public', 'organization_members', 'members_select_own_org'],
    ['public', 'audit_logs', 'audit_logs_select_member_or_admin'],
    ['public', 'evidence_items', 'evidence_items_select'],
    ['public', 'projects', 'projects_select_member_or_admin'],
    ['public', 'outcomes', 'outcomes_select'],
    ['public', 'financial_proxies', 'financial_proxies_select'],
  ] as const

  const qualified = REMOTE.map(([s, t, p]) => `${s}.${t}.${p}`)
  const bare = REMOTE.map(([, , p]) => p)

  const evaluateAgainst = (policies: readonly string[]) =>
    evaluateUnitPostconditions(
      { ...expectation, tables: [], functions: [], rlsEnabledTables: [], policies: qualified },
      {
        tables: [],
        functions: [],
        triggers: [],
        rlsEnabledTables: [],
        policies,
        rowCount: 0,
      },
    )

  it('derives 69 three-segment policy keys from the real unit', () => {
    expect(expectation.policies).toHaveLength(69)
    expect(expectation.policies).toContain('public.users.users_select_own')
  })

  it('reports policies present when both sides use the qualified key', () => {
    expect(codeOf(evaluateAgainst(qualified))).toBe('OK')
  })

  it('reproduces the incident: bare policy names read as every policy absent', () => {
    const v = evaluateAgainst(bare)
    expect(codeOf(v)).toBe('OPERATOR_POSTCONDITION_FAILED')
    if (!v.ok) expect(v.message).toContain('public.users.users_select_own')
  })

  it('still fails when one expected policy is genuinely absent', () => {
    expect(codeOf(evaluateAgainst(qualified.slice(1)))).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('refuses the same policy name on a different table', () => {
    const moved = qualified.map((k) =>
      k === 'public.users.users_select_own' ? 'public.projects.users_select_own' : k,
    )
    expect(codeOf(evaluateAgainst(moved))).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('refuses the right table carrying a different policy name', () => {
    const renamed = qualified.map((k) =>
      k === 'public.users.users_select_own' ? 'public.users.users_select_any' : k,
    )
    expect(codeOf(evaluateAgainst(renamed))).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('refuses the right table and name in the wrong schema', () => {
    const reschemad = qualified.map((k) =>
      k === 'public.users.users_select_own' ? 'auth.users.users_select_own' : k,
    )
    expect(codeOf(evaluateAgainst(reschemad))).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('never accepts a substring or prefix match', () => {
    expect(codeOf(evaluateAgainst(qualified.map((k) => `${k}_extra`)))).toBe(
      'OPERATOR_POSTCONDITION_FAILED',
    )
    expect(codeOf(evaluateAgainst(qualified.map((k) => k.replace('public.', ''))))).toBe(
      'OPERATOR_POSTCONDITION_FAILED',
    )
  })

  it('refuses an empty catalogue', () => {
    expect(codeOf(evaluateAgainst([]))).toBe('OPERATOR_POSTCONDITION_FAILED')
  })

  it('enables RLS on 24 tables, keyed as schema.table', () => {
    // The same sweep for the sibling check the incident put under suspicion.
    expect(expectation.rlsEnabledTables).toHaveLength(24)
    expect(expectation.rlsEnabledTables).toContain('public.users')
    expect(expectation.rlsEnabledTables.every((k) => k.split('.').length === 2)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Resume from the state staging is actually in
// ---------------------------------------------------------------------------

describe('resume after unit 032', () => {
  const rows = Array.from({ length: 32 }, (_, i) => rowFor(i + 1))
  const position = derive(rows)

  it('reconciles exactly 32 units', () => {
    expect(codeOf(position)).toBe('OK')
    if (position.ok) expect(position.journalCount).toBe(32)
  })

  it('names 0031_rls_core.sql as the last committed unit', () => {
    if (position.ok) expect(position.lastCommittedUnit).toBe('0031_rls_core.sql')
  })

  it('does not re-run ordinal 032', () => {
    if (position.ok) expect(position.nextUnit?.id).not.toBe('0031_rls_core.sql')
  })

  it('derives ordinal 033 — 0032_rls_specialized.sql — as the next unit', () => {
    if (position.ok) {
      expect(position.nextUnit?.ordinal).toBe(33)
      expect(position.nextUnit?.id).toBe('0032_rls_specialized.sql')
    }
  })

  it('refuses if that journal had a gap, a duplicate or a future unit', () => {
    expect(codeOf(derive([...rows.slice(0, 30), rowFor(32)], 32))).toBe(
      'OPERATOR_JOURNAL_FUTURE_UNIT',
    )
    expect(codeOf(derive([...rows, rowFor(32)], 32))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
    expect(codeOf(derive([...rows, rowFor(34)], 34))).toBe('OPERATOR_JOURNAL_FUTURE_UNIT')
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
// HARDENING 1 — the APPLY invocation contract
//
// Independent audit mutated `-1` and `ON_ERROR_STOP=1` out of the apply call and
// all 911 tests still passed: the flags lived inline in the driver, which no
// test imports. Atomicity was correct by inspection of one SHA and by nothing
// else. A future regression has to be caught by a test, not by a reviewer
// happening to read line 388 again.
// ---------------------------------------------------------------------------

describe('psql apply flags', () => {
  it('wraps the whole invocation in ONE transaction', () => {
    // Without -1 the unit's DDL and its journal INSERT commit separately, and a
    // crash between them leaves a unit applied and unrecorded — the exact state
    // the ledger exists to make impossible.
    expect(PSQL_APPLY_FLAGS).toContain('-1')
  })

  it('stops on the first error', () => {
    // Without ON_ERROR_STOP psql runs on past a failed statement and exits 0, so
    // a half-applied unit reports success to the runner.
    expect(PSQL_APPLY_FLAGS).toContain('ON_ERROR_STOP=1')
    expect(PSQL_APPLY_FLAGS[PSQL_APPLY_FLAGS.indexOf('ON_ERROR_STOP=1') - 1]).toBe('-v')
  })

  it('never carries a probe flag that would suppress the apply output', () => {
    expect(PSQL_APPLY_FLAGS).not.toContain('-t')
    expect(PSQL_APPLY_FLAGS).not.toContain('-A')
  })

  it('builds the apply argv with the wrapper and the project ref, and nothing else', () => {
    const argv = applyArgv('db/prepared/journal/001_0000_quick_husk.sql', STAGING)
    expect(argv).toEqual(['-1', '-v', 'ON_ERROR_STOP=1', '-v', `uellix_project_ref=${STAGING}`, '-f', 'db/prepared/journal/001_0000_quick_husk.sql'])
  })

  it('keeps migration and journal row in the same transaction for every wrapper', () => {
    // -1 is only half the guarantee. The other half is that the INSERT is INSIDE
    // the file psql is given, which is what makes "both or neither" structural
    // rather than a property of how the runner sequences two calls.
    for (const unit of BASELINE_UNITS) {
      const wrapper = readFileSync(path.join(process.cwd(), wrapperPathFor(unit)), 'utf8')
      expect(wrapperCarriesJournalAppend(wrapper), unit.id).toBe(true)
      expect(wrapper, unit.id).toContain('\\ir ')
    }
  })
})

// ---------------------------------------------------------------------------
// HARDENING 2 — a journal row for unit 41 is not a crossed boundary
//
// The audit's vector: fabricate an APPLIED row for the storage unit and a resume
// derives 042 as next, with PART B never installed. The row means only that the
// two PUBLIC helpers exist — the wrapper includes PART A alone and says so. The
// three policies on storage.objects live in a channel psql cannot join, so the
// only evidence that counts is the catalogue.
// ---------------------------------------------------------------------------

describe('storage boundary cannot be crossed by a journal row', () => {
  const through = (n: number) => Array.from({ length: n }, (_, i) => rowFor(i + 1))

  const deriveWith = (rows: readonly JournalRow[], storageBoundaryVerified: boolean, obs = rows.length) =>
    deriveNextUnit({
      rows,
      expectedProjectRef: STAGING,
      observedTables: observedFor(obs),
      tablesCreatedByUnit: tablesByUnit,
      storageBoundaryVerified,
    })

  it('stops at 041 with forty units recorded', () => {
    const v = deriveWith(through(40), false)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.nextUnit?.ordinal).toBe(41)
    if (v.ok && v.nextUnit) expect(storageBoundaryStop(v.nextUnit)?.code).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })

  it('REFUSES to derive 042 from a 41-row journal when PART B is not verified', () => {
    // THE VECTOR. Before this, the row alone advanced the run.
    expect(codeOf(deriveWith(through(41), false))).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })

  it('refuses when the boundary evidence was never measured at all', () => {
    const v = deriveNextUnit({
      rows: through(41),
      expectedProjectRef: STAGING,
      observedTables: observedFor(41),
      tablesCreatedByUnit: tablesByUnit,
    })
    expect(codeOf(v)).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })

  it('derives 042 only once PART B is verified against the catalogue', () => {
    const v = deriveWith(through(41), true)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) {
      expect(v.nextUnit?.ordinal).toBe(42)
      expect(v.lastCommittedUnit).toBe('20260716000001_storage_policies.sql')
    }
  })

  it('refuses a fabricated 042 row while the boundary is unverified', () => {
    expect(codeOf(deriveWith(through(42), false))).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })

  it('does not gate units before the boundary on storage evidence', () => {
    // The guard must not become a blanket refusal: 001–040 are unaffected.
    const v = deriveWith(through(32), false)
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.nextUnit?.ordinal).toBe(33)
  })

  it('refuses completion while the boundary is unverified, even with every row', () => {
    expect(
      codeOf(
        evaluateCompletion({
          rows: through(BASELINE_UNITS.length),
          expectedProjectRef: STAGING,
          observedTables: observedFor(BASELINE_UNITS.length),
          tablesCreatedByUnit: tablesByUnit,
          storageBoundaryVerified: false,
        }),
      ),
    ).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
  })
})

describe('PART B surface evidence feeding the boundary', () => {
  const canonical: ObservedStoragePolicy[] = [
    { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "(bucket_id = 'uellix-evidence') AND public.can_read_evidence_object(name, auth.uid())", withCheck: null },
    { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "(bucket_id = 'uellix-evidence') AND public.can_write_evidence_object(name, auth.uid())" },
    { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "(bucket_id = 'uellix-evidence') AND public.can_write_evidence_object(name, auth.uid())", withCheck: null },
  ]

  const boundary = (policies: readonly ObservedStoragePolicy[], journalled = true) =>
    evaluateStorageBoundaryArtefact({
      helpersPresent: true,
      policies,
      journal: { partAApplied: journalled, boundary: 'MANUAL_BOUNDARY_PENDING' },
    })

  it('verifies the boundary only on the full canonical surface', () => {
    expect(boundary(canonical).managedBoundaryVerified).toBe(true)
  })

  it('refuses a partial PART B — two of three', () => {
    expect(boundary(canonical.slice(0, 2)).managedBoundaryVerified).toBe(false)
  })

  it('refuses the right policy name on the wrong table', () => {
    const moved = canonical.map((p) => (p.policyname === 'select_evidence' ? { ...p, tablename: 'buckets' } : p))
    expect(boundary(moved).managedBoundaryVerified).toBe(false)
  })

  it('refuses the right policy name in the wrong schema', () => {
    const moved = canonical.map((p) => (p.policyname === 'select_evidence' ? { ...p, schemaname: 'public' } : p))
    expect(boundary(moved).managedBoundaryVerified).toBe(false)
  })

  it('refuses a widened predicate that still contains the canonical text', () => {
    const widened = canonical.map((p) =>
      p.policyname === 'select_evidence' ? { ...p, qual: `((${p.qual}) OR true)` } : p,
    )
    expect(boundary(widened).managedBoundaryVerified).toBe(false)
  })

  it('refuses a widened role', () => {
    const widened = canonical.map((p) =>
      p.policyname === 'select_evidence' ? { ...p, roles: '{authenticated,anon,service_role}' } : p,
    )
    expect(boundary(widened).managedBoundaryVerified).toBe(false)
  })

  it('refuses an extra policy nothing in this repository generates', () => {
    const extra = [...canonical, { schemaname: 'storage', tablename: 'objects', policyname: 'temp_debug', roles: '{authenticated}', cmd: 'SELECT', qual: 'true', withCheck: null }]
    expect(boundary(extra).managedBoundaryVerified).toBe(false)
  })

  it('refuses ambiguous evidence — policies present, surface never measured', () => {
    const v = evaluateStorageBoundaryArtefact({
      helpersPresent: true,
      journal: { partAApplied: true, boundary: 'MANUAL_BOUNDARY_PENDING' },
    })
    expect(v.managedBoundaryVerified).toBe(false)
    expect(v.surfaceVerified).toBeNull()
  })

  it('refuses an absent artefact — unmeasured is never verified', () => {
    expect(evaluateStorageBoundaryArtefact(null).managedBoundaryVerified).toBe(false)
  })

  it('refuses a canonical surface whose PART A was never journalled', () => {
    expect(boundary(canonical, false).managedBoundaryVerified).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B1 — LIVE CORROBORATION
//
// Independent audit demonstrated the vector by composition: a hand-written
// `artifacts/hosted-storage-boundary.json` carrying the three canonical shapes
// made the runner derive 042 with PART B never installed. The evaluator was
// correct; its INPUT was a local file nobody had checked against the database.
//
// The previous round rejected the REMOTE journal as sufficient evidence. A
// LOCAL file is weaker still. The artefact stays — it is the auditable record —
// but authority moves to a live read-only measurement of the same target.
// ---------------------------------------------------------------------------

const SEL_PRED = "(bucket_id = 'uellix-evidence') AND public.can_read_evidence_object(name, auth.uid())"
const WRITE_PRED = "(bucket_id = 'uellix-evidence') AND public.can_write_evidence_object(name, auth.uid())"

const pol = (
  policyname: string,
  cmd: string,
  qual: string | null,
  withCheck: string | null,
  patch: Partial<ObservedStoragePolicy> = {},
): ObservedStoragePolicy => ({
  schemaname: 'storage',
  tablename: 'objects',
  policyname,
  roles: '{authenticated}',
  cmd,
  qual,
  withCheck,
  ...patch,
})

const CANONICAL_SURFACE: ObservedStoragePolicy[] = [
  pol('select_evidence', 'SELECT', SEL_PRED, null),
  pol('insert_evidence', 'INSERT', null, WRITE_PRED),
  pol('delete_evidence', 'DELETE', WRITE_PRED, null),
]

const HELPERS = ['public.can_read_evidence_object', 'public.can_write_evidence_object']

const live = (patch: Partial<StorageLiveEvidence> = {}): StorageLiveEvidence => ({
  helpers: HELPERS,
  policies: CANONICAL_SURFACE,
  rlsEnabled: true,
  bucketPresent: true,
  ...patch,
})

const reconcile = (input: {
  live?: StorageLiveEvidence | null
  artefactPolicies?: readonly ObservedStoragePolicy[] | null
  artefactHelpers?: boolean
  artefactProjectRef?: string | null
  partAJournalled?: boolean
}) =>
  reconcileStorageEvidence({
    live: input.live === undefined ? live() : input.live,
    artefact:
      input.artefactPolicies === null
        ? null
        : {
            helpersPresent: input.artefactHelpers ?? true,
            policies: input.artefactPolicies ?? CANONICAL_SURFACE,
            journal: { partAApplied: true, boundary: 'ABSENT' },
          },
    artefactProjectRef: input.artefactProjectRef === undefined ? STAGING : input.artefactProjectRef,
    targetProjectRef: STAGING,
    partAJournalled: input.partAJournalled ?? true,
  })

describe('B1 — the boundary needs a live measurement, not a file', () => {
  it('case 9: artefact and live evidence agree on the canonical surface → VERIFIED', () => {
    const v = reconcile({})
    expect(v.verified, v.reasons.join(' | ')).toBe(true)
  })

  it('THE VECTOR: a fabricated canonical artefact with no live policies is refused', () => {
    // Hand-write the JSON, measure the database, and the database wins.
    expect(reconcile({ live: live({ policies: [] }) }).verified).toBe(false)
  })

  it('case 1: artefact canonical, remote policies absent → REFUSE', () => {
    expect(reconcile({ live: live({ policies: [] }) }).verified).toBe(false)
  })

  it('case 2: artefact canonical, remote helpers absent → REFUSE', () => {
    expect(reconcile({ live: live({ helpers: [] }) }).verified).toBe(false)
  })

  it('case 3: artefact canonical, remote 2/3 → REFUSE', () => {
    expect(reconcile({ live: live({ policies: CANONICAL_SURFACE.slice(0, 2) }) }).verified).toBe(false)
  })

  it('case 4: artefact canonical, remote 3/3 plus a fourth policy → REFUSE', () => {
    const extra = [...CANONICAL_SURFACE, pol('temp_debug', 'SELECT', 'true', null)]
    expect(reconcile({ live: live({ policies: extra }) }).verified).toBe(false)
  })

  it('case 5: artefact canonical, remote role widened → REFUSE', () => {
    const widened = CANONICAL_SURFACE.map((p) =>
      p.policyname === 'select_evidence' ? { ...p, roles: '{authenticated,service_role}' } : p,
    )
    expect(reconcile({ live: live({ policies: widened }) }).verified).toBe(false)
  })

  it('case 6: artefact canonical, remote predicate differs → REFUSE', () => {
    const widened = CANONICAL_SURFACE.map((p) =>
      p.policyname === 'select_evidence' ? { ...p, qual: `((${SEL_PRED}) OR true)` } : p,
    )
    expect(reconcile({ live: live({ policies: widened }) }).verified).toBe(false)
  })

  it('case 7: a STALE artefact that disagrees with a canonical live surface → REFUSE', () => {
    // Both sides are individually "fine": live is canonical, the artefact
    // describes a real past state. They disagree, so nothing is verified.
    const stale = [...CANONICAL_SURFACE, pol('update_evidence', 'UPDATE', WRITE_PRED, WRITE_PRED)]
    expect(reconcile({ artefactPolicies: stale }).verified).toBe(false)
  })

  it('case 8: an artefact recorded against another project → REFUSE', () => {
    expect(reconcile({ artefactProjectRef: 'aaaaaaaaaaaaaaaaaaaa' }).verified).toBe(false)
    expect(reconcile({ artefactProjectRef: PROD }).verified).toBe(false)
  })

  it('refuses an artefact with no target binding at all', () => {
    expect(reconcile({ artefactProjectRef: null }).verified).toBe(false)
  })

  it('refuses when the live measurement could not be taken', () => {
    expect(reconcile({ live: null }).verified).toBe(false)
  })

  it('refuses when the artefact is absent, even with a canonical live surface', () => {
    const v = reconcile({ artefactPolicies: null })
    expect(v.verified).toBe(false)
    // Names the missing record, so the operator knows the live surface was fine
    // and what is absent is the durable observation of it.
    expect(v.reasons.join(' ')).toContain('hosted-storage-boundary.json')
  })

  it('refuses when RLS on storage.objects is off or unmeasured', () => {
    expect(reconcile({ live: live({ rlsEnabled: false }) }).verified).toBe(false)
    expect(reconcile({ live: live({ rlsEnabled: null }) }).verified).toBe(false)
  })

  it('refuses when PART A is not journalled, however good the surface looks', () => {
    expect(reconcile({ partAJournalled: false }).verified).toBe(false)
  })
})

describe('B1 — the live probes', () => {
  const probes = [STORAGE_POLICIES_PROBE_SQL, STORAGE_HELPERS_PROBE_SQL, STORAGE_RLS_PROBE_SQL]

  it('reads only, in a read-only transaction that rolls back', () => {
    for (const sql of probes) {
      expect(sql.startsWith('BEGIN READ ONLY;')).toBe(true)
      expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER|GRANT|REVOKE)\b/i)
    }
  })

  it('scopes the policy probe to storage.objects', () => {
    expect(STORAGE_POLICIES_PROBE_SQL).toContain("schemaname = 'storage'")
    expect(STORAGE_POLICIES_PROBE_SQL).toContain("tablename = 'objects'")
  })

  it('asks for every field the surface comparison needs', () => {
    for (const field of ['schemaname', 'tablename', 'policyname', 'roles', 'cmd', 'qual', 'with_check']) {
      expect(STORAGE_POLICIES_PROBE_SQL, field).toContain(field)
    }
  })

  it('measures RLS and the evidence bucket from the catalogue', () => {
    expect(STORAGE_RLS_PROBE_SQL).toContain('relrowsecurity')
    expect(STORAGE_RLS_PROBE_SQL).toContain('uellix-evidence')
  })

  it('carries no psql meta-command that would escape the transaction', () => {
    for (const sql of probes) expect(sql).not.toMatch(/(^|\n)\s*\\/)
  })
})

// ---------------------------------------------------------------------------
// C2 — the surface matrix, per policy
//
// Audit found the violations were exercised almost entirely against
// select_evidence, and a mutation reducing the verifier's loop to 2 of 3
// survived the whole suite. Every policy now carries its own row.
// ---------------------------------------------------------------------------

describe('C2 — surface violations, for each of the three policies', () => {
  const surfaceOf = (policies: readonly ObservedStoragePolicy[]) =>
    verifyStoragePolicySurface(policies).passed

  const replace = (name: string, patch: Partial<ObservedStoragePolicy>) =>
    CANONICAL_SURFACE.map((p) => (p.policyname === name ? { ...p, ...patch } : p))

  it('accepts the canonical surface — the positive control', () => {
    expect(surfaceOf(CANONICAL_SURFACE)).toBe(true)
  })

  for (const [name, ownSlot, ownPred, otherSlot] of [
    ['select_evidence', 'qual', SEL_PRED, 'withCheck'],
    ['insert_evidence', 'withCheck', WRITE_PRED, 'qual'],
    ['delete_evidence', 'qual', WRITE_PRED, 'withCheck'],
  ] as const) {
    describe(name, () => {
      it('refuses the wrong command', () => {
        expect(surfaceOf(replace(name, { cmd: 'ALL' }))).toBe(false)
      })
      it('refuses a widened role', () => {
        expect(surfaceOf(replace(name, { roles: '{authenticated,anon}' }))).toBe(false)
        expect(surfaceOf(replace(name, { roles: '{public}' }))).toBe(false)
        expect(surfaceOf(replace(name, { roles: '{authenticated,service_role}' }))).toBe(false)
      })
      it('refuses a weakened bucket predicate', () => {
        expect(surfaceOf(replace(name, { [ownSlot]: ownPred.replace("'uellix-evidence'", "'uellix-evidence-2'") }))).toBe(false)
        expect(surfaceOf(replace(name, { [ownSlot]: ownPred.replace(/\(bucket_id = '[^']+'\) AND /, '') }))).toBe(false)
      })
      it('refuses the wrong isolation helper', () => {
        expect(surfaceOf(replace(name, { [ownSlot]: ownPred.replace('public.can_', 'public.bypass_can_') }))).toBe(false)
      })
      it('refuses OR true appended to its predicate', () => {
        expect(surfaceOf(replace(name, { [ownSlot]: `((${ownPred}) OR true)` }))).toBe(false)
      })
      it('refuses an empty predicate in its own slot', () => {
        expect(surfaceOf(replace(name, { [ownSlot]: null }))).toBe(false)
      })
      it('refuses a predicate appearing in the other slot', () => {
        expect(surfaceOf(replace(name, { [otherSlot]: ownPred }))).toBe(false)
      })
      it('refuses its absence', () => {
        expect(surfaceOf(CANONICAL_SURFACE.filter((p) => p.policyname !== name))).toBe(false)
      })
      it('refuses it living on the wrong table', () => {
        expect(surfaceOf(replace(name, { tablename: 'buckets' }))).toBe(false)
      })
      it('refuses it living in the wrong schema', () => {
        expect(surfaceOf(replace(name, { schemaname: 'public' }))).toBe(false)
      })
    })
  }

  it('refuses a fourth policy, permissive or restrictive-looking', () => {
    expect(surfaceOf([...CANONICAL_SURFACE, pol('temp_debug', 'SELECT', 'true', null)])).toBe(false)
    expect(surfaceOf([...CANONICAL_SURFACE, pol('deny_all', 'ALL', 'false', null)])).toBe(false)
  })

  it('refuses update_evidence, which PART B drops and never creates', () => {
    expect(surfaceOf([...CANONICAL_SURFACE, pol('update_evidence', 'UPDATE', WRITE_PRED, WRITE_PRED)])).toBe(false)
  })

  it('FAILS IF THE VERIFIER STOPS ITERATING ALL THREE', () => {
    // The mutation that survived: EXPECTED_STORAGE_POLICY_SURFACE.slice(0, 2).
    // Checking 2-of-3 cases is not enough — a corrupted THIRD policy has to be
    // caught by its own case, and the contract's length has to be pinned too.
    expect(EXPECTED_STORAGE_POLICY_SURFACE).toHaveLength(3)
    expect(EXPECTED_STORAGE_POLICY_SURFACE.map((p) => p.policyname)).toEqual([
      'select_evidence',
      'insert_evidence',
      'delete_evidence',
    ])
    for (const expected of EXPECTED_STORAGE_POLICY_SURFACE) {
      const slot = expected.predicateKind === 'qual' ? 'qual' : 'withCheck'
      expect(surfaceOf(replace(expected.policyname, { [slot]: 'true' })), expected.policyname).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// THE HUMAN-BOUNDARY REPORT
//
// The first real run after PART A decided correctly — 042 stayed blocked — and
// then reported `lastCommittedUnit = none, journalCount = 0` while the same
// process had just measured the 041 row. The state fields were assigned AFTER
// `deriveNextUnit`, so a refusal FROM that call printed the initial values.
//
// A report that contradicts the evidence teaches the operator to distrust the
// report. The checkpoint is therefore computed from the rows BEFORE any decision
// is taken, and the decision is untouched.
// ---------------------------------------------------------------------------

describe('journal checkpoint (reporting only)', () => {
  const through = (n: number) => Array.from({ length: n }, (_, i) => rowFor(i + 1))

  it('reports 41 units and the storage unit after PART A', () => {
    const c = journalCheckpoint(through(41))
    expect(c.journalCount).toBe(41)
    expect(c.lastCommittedUnit).toBe('20260716000001_storage_policies.sql')
    expect(c.storageRecorded).toBe(true)
  })

  it('reports 40 units and unit 040 before PART A', () => {
    const c = journalCheckpoint(through(40))
    expect(c.journalCount).toBe(40)
    expect(c.lastCommittedUnit).toBe('20260716000000_auth_trigger.sql')
    expect(c.storageRecorded).toBe(false)
    expect(c.nextUnitId).toBe('20260716000001_storage_policies.sql')
  })

  it('reports nothing committed on an empty journal', () => {
    const c = journalCheckpoint([])
    expect(c.journalCount).toBe(0)
    expect(c.lastCommittedUnit).toBeNull()
    expect(c.nextUnitId).toBe('0000_quick_husk.sql')
  })

  it('counts only APPLIED rows', () => {
    const rows = [...through(39), rowFor(40, { status: 'FAILED' })]
    expect(journalCheckpoint(rows).journalCount).toBe(39)
  })

  it('reports the contiguous prefix, not the raw row count', () => {
    // A journal holding 1,2 and 5 has three rows and a checkpoint of two. The
    // decision refuses this state anyway; the report must not overstate it.
    const c = journalCheckpoint([rowFor(1), rowFor(2), rowFor(5)])
    expect(c.journalCount).toBe(2)
    expect(c.lastCommittedUnit).toBe(BASELINE_UNITS[1]!.id)
  })

  it('ignores a row naming a unit the manifest does not have', () => {
    const rows = [...through(40), rowFor(1, { packageId: 'not_a_unit.sql' })]
    expect(journalCheckpoint(rows).journalCount).toBe(40)
  })

  it('does NOT change the decision it reports on', () => {
    // The regression guard. Fixing the message must not move the boundary.
    const v = deriveNextUnit({
      rows: through(41),
      expectedProjectRef: STAGING,
      observedTables: observedFor(41),
      tablesCreatedByUnit: tablesByUnit,
      storageBoundaryVerified: false,
    })
    expect(codeOf(v)).toBe('OPERATOR_STORAGE_HUMAN_BOUNDARY')
    // …and the checkpoint of that very state is still the honest 41.
    expect(journalCheckpoint(through(41)).journalCount).toBe(41)
  })
})

// ---------------------------------------------------------------------------
// THE DEPARSE FIX
//
// PART B installed cleanly and B0-16 refused, on one difference:
//
//   expected  public.can_read_evidence_object(name, auth.uid())
//   observed         can_read_evidence_object(name, auth.uid())
//
// MEASURED CAUSE (PostgreSQL 17, local, read-only + one disposable fixture):
// pg_get_expr omits a function's schema when that schema is visible in the
// SESSION's search_path. Staging's session has `public` in it. The same
// deparser keeps `private.is_active_member` qualified — because `private` is
// not in the path — and drops the qualifier the moment `SET LOCAL search_path
// = 'private'` makes it visible. Casts are untouched either way, because
// pg_catalog is implicitly first regardless.
//
// So the OBSERVATION was ambiguous, not the policy. The fix stabilises the
// probe; the verifier is not touched.
//
// AND THE UNQUALIFIED FORM MUST KEEP FAILING. Accepting a bare
// `can_read_evidence_object` would accept a function of that name in ANY schema
// that happens to sit earlier in the path — which is the near-name attack this
// surface check exists to stop. The probe now guarantees the qualified form, so
// an unqualified one means the probe was not the one this contract describes.
// ---------------------------------------------------------------------------

describe('deparse: the probe pins the representation', () => {
  it('forces schema-qualified function names by emptying the search_path', () => {
    expect(STORAGE_POLICIES_PROBE_SQL).toContain("SET LOCAL search_path = ''")
  })

  it('sets it INSIDE the read-only transaction, so it cannot leak or grant', () => {
    const begin = STORAGE_POLICIES_PROBE_SQL.indexOf('BEGIN READ ONLY;')
    const setLocal = STORAGE_POLICIES_PROBE_SQL.indexOf("SET LOCAL search_path = ''")
    const rollback = STORAGE_POLICIES_PROBE_SQL.indexOf('ROLLBACK;')
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(setLocal).toBeGreaterThan(begin)
    expect(rollback).toBeGreaterThan(setLocal)
    // SET LOCAL is not a write, and the transaction stays read-only: measured
    // against a live PostgreSQL 17, transaction_read_only remained `on`.
    expect(STORAGE_POLICIES_PROBE_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE)\b/i)
  })

  it('accepts the qualified predicate the fixed probe returns', () => {
    // Exactly the bytes PostgreSQL emits under search_path = '' — measured, and
    // including the `::text` cast it adds to the literal.
    const asDeparsed: ObservedStoragePolicy[] = [
      pol('select_evidence', 'SELECT', "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", null),
      pol('insert_evidence', 'INSERT', null, "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))"),
      pol('delete_evidence', 'DELETE', "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", null),
    ]
    expect(verifyStoragePolicySurface(asDeparsed).passed).toBe(true)
  })

  it('REFUSES the unqualified predicate — a bare name is not an identification', () => {
    // The form staging returned before the fix. It must stay a refusal: an
    // unqualified `can_read_evidence_object` is satisfied by a function of that
    // name in any schema earlier in the path.
    const unqualified: ObservedStoragePolicy[] = [
      pol('select_evidence', 'SELECT', "((bucket_id = 'uellix-evidence'::text) AND can_read_evidence_object(name, auth.uid()))", null),
      pol('insert_evidence', 'INSERT', null, "((bucket_id = 'uellix-evidence'::text) AND can_write_evidence_object(name, auth.uid()))"),
      pol('delete_evidence', 'DELETE', "((bucket_id = 'uellix-evidence'::text) AND can_write_evidence_object(name, auth.uid()))", null),
    ]
    expect(verifyStoragePolicySurface(unqualified).passed).toBe(false)
  })

  it('keeps refusing every impostor the qualified form could be confused with', () => {
    const Q = (fn: string) => `((bucket_id = 'uellix-evidence'::text) AND ${fn}(name, auth.uid()))`
    for (const fn of [
      'public.can_read_evidence_object_fake',
      'evil.can_read_evidence_object',
      'public.bypass_can_read_evidence_object',
      'public.can_write_evidence_object', // write helper in the READ slot
    ]) {
      const surface: ObservedStoragePolicy[] = [
        pol('select_evidence', 'SELECT', Q(fn), null),
        pol('insert_evidence', 'INSERT', null, "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))"),
        pol('delete_evidence', 'DELETE', "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", null),
      ]
      expect(verifyStoragePolicySurface(surface).passed, fn).toBe(false)
    }
  })

  it('refuses the read helper standing in for the write helper', () => {
    const surface: ObservedStoragePolicy[] = [
      pol('select_evidence', 'SELECT', "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", null),
      pol('insert_evidence', 'INSERT', null, "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))"),
      pol('delete_evidence', 'DELETE', "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", null),
    ]
    expect(verifyStoragePolicySurface(surface).passed).toBe(false)
  })

  it('refuses OR true and a wrong bucket even in the qualified form', () => {
    const good = "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))"
    for (const q of [`(${good} OR true)`, good.replace('uellix-evidence', 'uellix-evidence-2')]) {
      const surface: ObservedStoragePolicy[] = [
        pol('select_evidence', 'SELECT', q, null),
        pol('insert_evidence', 'INSERT', null, "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))"),
        pol('delete_evidence', 'DELETE', "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", null),
      ]
      expect(verifyStoragePolicySurface(surface).passed, q).toBe(false)
    }
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
      observedTables: observedFor(BASELINE_UNITS.length),
      tablesCreatedByUnit: tablesByUnit,
      storageBoundaryVerified: true,
      ...patch,
    })

  it('reports baselineApplied only when every unit reconciles and the boundary is verified', () => {
    const v = full()
    expect(codeOf(v)).toBe('OK')
    if (v.ok) expect(v.baselineApplied).toBe(true)
  })

  it('refuses when a unit is missing, however many others are recorded', () => {
    expect(codeOf(full({ rows: complete.slice(0, BASELINE_UNITS.length - 1) }))).toBe('OPERATOR_JOURNAL_UNRECONCILED')
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

  it('stops on the first error, so a failed probe cannot exit 0', () => {
    // C3. The flag was present and unpinned: mutating it to 0 passed the whole
    // suite. A probe that runs past an error and exits 0 hands the parser a
    // partial result, and "ambiguous is a refusal" only works if the exit code
    // is honest first.
    expect(PSQL_PROBE_FLAGS).toContain('ON_ERROR_STOP=1')
    expect(PSQL_PROBE_FLAGS[PSQL_PROBE_FLAGS.indexOf('ON_ERROR_STOP=1') - 1]).toBe('-v')
    expect(PSQL_PROBE_FLAGS).not.toContain('ON_ERROR_STOP=0')
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
    const r = report({ stderr: 'connection failed: postgresql://postgres:not-a-real-password@h:5432/postgres' })
    expect(r).not.toContain('not-a-real-password')
  })

  it('redacts a password-shaped assignment anywhere in the captured output', () => {
    expect(report({ stdout: 'PGPASSWORD=hunter2\r\n' })).not.toContain('hunter2')
  })
})

describe('log redaction', () => {
  it('removes a connection string', () => {
    const line = redactOperatorLog('connecting to postgresql://postgres:not-a-real-password@db.x.supabase.co:5432/postgres')
    expect(line).not.toContain('not-a-real-password')
  })

  it('keeps the project ref, which is public and the most useful thing to see', () => {
    expect(redactOperatorLog(`target ${STAGING}`)).toContain(STAGING)
  })

  it('removes an explicitly named password value', () => {
    expect(redactOperatorLog('PGPASSWORD=hunter2')).not.toContain('hunter2')
  })
})
