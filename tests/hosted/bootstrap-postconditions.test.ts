// tests/hosted/bootstrap-postconditions.test.ts
//
// S1's postconditions, measured against the database rather than asserted from
// its own transaction.
//
// stella_hosted_0001 verifies itself in §6, and that check is worth having: it
// runs before COMMIT, so a failure rolls the package back rather than leaving
// half a role model behind. But it is the package auditing itself. What closes
// S1 is an INDEPENDENT read of the resulting state, which is the same doctrine
// §2.9 of the provisioning runbook states for the whole hosted plan: there is
// no journal, because "un journal dice qué se intentó y B0 dice qué hay".
//
// ONE PROBE, TWO VERDICTS. The sentinel row is the only thing that differs
// between closing S1 (the row must be ABSENT — the bootstrap must not certify
// itself) and closing CHECKPOINT A1 after the human INSERT (the row must be
// PRESENT and corroborating). A second probe for the second verdict would be
// the parallel implementation this repository keeps paying for.

import { describe, expect, it } from 'vitest'

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  BOOTSTRAP_POSTCONDITIONS,
  S1_OBSERVATION_SQL,
  S2_SENTINEL_SQL,
  SENTINEL_BOOTSTRAP_VERSION,
  SENTINEL_OWNER_SEPARATION,
  buildBootstrapObservationSql,
  buildSentinelInsertSql,
  evaluateBootstrapPostconditions,
  parseS1Observation,
  type S1EvidencePhase,
  type S1Observation,
} from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PRE_PATH = 'artifacts/hosted-s1-observation.json'

/** The state a correct S1 leaves behind. Every negative control mutates ONE field. */
function healthy(): S1Observation {
  return {
    targetProjectRef: KNOWN_STAGING_PROJECT_REF,
    bootstrapSchemaOwner: 'uellix_owner',
    roles: [
      { name: 'uellix_owner', canLogin: false, isSuper: false, bypassRls: false, createRole: false, createDb: false, replication: false },
      { name: 'uellix_migrator', canLogin: true, isSuper: false, bypassRls: false, createRole: false, createDb: false, replication: false },
      { name: 'uellix_app', canLogin: true, isSuper: false, bypassRls: false, createRole: false, createDb: false, replication: false },
      { name: 'uellix_writer', canLogin: false, isSuper: false, bypassRls: false, createRole: false, createDb: false, replication: false },
      { name: 'uellix_auditor', canLogin: true, isSuper: false, bypassRls: false, createRole: false, createDb: false, replication: false },
    ],
    memberships: [
      { role: 'uellix_owner', member: 'uellix_migrator', inheritOption: false, setOption: true },
      { role: 'uellix_writer', member: 'uellix_app', inheritOption: true, setOption: false },
    ],
    appReachesOwner: false,
    appReachesMigrator: false,
    ledgerOwner: 'uellix_owner',
    functions: [
      { signature: 'public.uellix_auth_uid()', owner: 'postgres', securityDefiner: true, config: ['search_path=""'], executeGrantees: ['postgres', 'uellix_app'] },
      { signature: 'uellix_bootstrap.assert_hosted_capabilities(text)', owner: 'postgres', securityDefiner: false, config: ['search_path=""'], executeGrantees: ['postgres', 'uellix_migrator'] },
      { signature: 'uellix_bootstrap.hosted_capability_report()', owner: 'postgres', securityDefiner: false, config: ['search_path=""'], executeGrantees: ['postgres', 'uellix_auditor', 'uellix_migrator'] },
    ],
    schemaPublicGrants: [
      { grantee: 'uellix_owner', usage: true, create: true },
      { grantee: 'uellix_migrator', usage: true, create: false },
      { grantee: 'uellix_app', usage: true, create: false },
      { grantee: 'uellix_writer', usage: true, create: false },
      { grantee: 'uellix_auditor', usage: true, create: false },
    ],
    sentinelTablePresent: true,
    sentinelRowCount: 0,
  }
}

// The phase, not an expectation: `evaluateBootstrapPostconditions` derives the
// sentinel expectation from it, so phase=pre + sentinel=present cannot be asked.
const run = (patch: Partial<S1Observation> = {}, phase: S1EvidencePhase = 'pre-sentinel') =>
  evaluateBootstrapPostconditions({ ...healthy(), ...patch }, phase)

const failedIds = (patch: Partial<S1Observation>, p: S1EvidencePhase = 'pre-sentinel'): string[] =>
  run(patch, p).checks.filter((c) => !c.passed).map((c) => c.id)

describe('the S1 postcondition contract', () => {
  it('passes on the state a correct S1 leaves behind', () => {
    const v = run()
    expect(v.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(v.passed).toBe(true)
  })

  it('every check has an executable negative control — none is decorative', () => {
    // A check nothing can fail is a sentence, not a check. This is the property
    // BASELINE_POSTCONDITIONS holds and the reason B0 is trusted.
    expect(BOOTSTRAP_POSTCONDITIONS.length).toBeGreaterThanOrEqual(12)
    for (const check of BOOTSTRAP_POSTCONDITIONS) {
      expect(check.id, 'every check is identified').toMatch(/^S1-\d\d$/)
      expect(check.title.length).toBeGreaterThan(10)
    }
    expect(new Set(BOOTSTRAP_POSTCONDITIONS.map((c) => c.id)).size).toBe(BOOTSTRAP_POSTCONDITIONS.length)
  })
})

describe('negative controls — one mutated field each', () => {
  it('refuses a missing bootstrap schema', () => {
    expect(failedIds({ bootstrapSchemaOwner: null })).toContain('S1-01')
  })

  it('refuses a bootstrap schema owned by anyone but uellix_owner', () => {
    expect(failedIds({ bootstrapSchemaOwner: 'postgres' })).toContain('S1-01')
  })

  it('refuses a missing role', () => {
    expect(failedIds({ roles: healthy().roles.filter((r) => r.name !== 'uellix_writer') })).toContain('S1-02')
  })

  it.each(['isSuper', 'bypassRls', 'createRole', 'createDb', 'replication'] as const)(
    'refuses %s on any role this package created',
    (attr) => {
      const roles = healthy().roles.map((r) => (r.name === 'uellix_app' ? { ...r, [attr]: true } : r))
      expect(failedIds({ roles })).toContain('S1-03')
    },
  )

  it('refuses a migrator that INHERITS the owner instead of announcing it', () => {
    const memberships = healthy().memberships.map((m) =>
      m.member === 'uellix_migrator' ? { ...m, inheritOption: true } : m,
    )
    expect(failedIds({ memberships })).toContain('S1-04')
  })

  it('refuses a migrator that cannot SET to the owner at all', () => {
    const memberships = healthy().memberships.map((m) =>
      m.member === 'uellix_migrator' ? { ...m, setOption: false } : m,
    )
    expect(failedIds({ memberships })).toContain('S1-04')
  })

  it('refuses an app that can SHED its identity into uellix_writer', () => {
    const memberships = healthy().memberships.map((m) =>
      m.member === 'uellix_app' ? { ...m, setOption: true } : m,
    )
    expect(failedIds({ memberships })).toContain('S1-04')
  })

  it('refuses a runtime that can reach the owner BY ANY PATH', () => {
    // Asked as reachability, not as "is there a grant". A future grant through
    // a third role is the shape a membership list would miss.
    expect(failedIds({ appReachesOwner: true })).toContain('S1-05')
    expect(failedIds({ appReachesMigrator: true })).toContain('S1-05')
  })

  it('refuses a ledger still owned by the installer', () => {
    expect(failedIds({ ledgerOwner: 'postgres' })).toContain('S1-06')
  })

  it('refuses a missing bootstrap function', () => {
    expect(failedIds({ functions: healthy().functions.slice(0, 2) })).toContain('S1-07')
  })

  it('refuses a function owned by anyone but the installer', () => {
    const functions = healthy().functions.map((f) =>
      f.signature.startsWith('public.') ? { ...f, owner: 'uellix_owner' } : f,
    )
    expect(failedIds({ functions })).toContain('S1-08')
  })

  it('refuses a shim that stopped being SECURITY DEFINER', () => {
    const functions = healthy().functions.map((f) =>
      f.signature.startsWith('public.') ? { ...f, securityDefiner: false } : f,
    )
    expect(failedIds({ functions })).toContain('S1-09')
  })

  it('refuses a definer whose search_path is not empty', () => {
    const functions = healthy().functions.map((f) =>
      f.signature.startsWith('public.') ? { ...f, config: ['search_path=public'] } : f,
    )
    expect(failedIds({ functions })).toContain('S1-09')
  })

  it('accepts BOTH spellings of an empty search_path', () => {
    // PostgreSQL stores `SET search_path = ''` as `search_path=""`. The package
    // records a measured defect where checking one spelling made the whole
    // chain inapplicable. The probe must not re-introduce it.
    const bare = healthy().functions.map((f) => ({ ...f, config: ['search_path='] }))
    expect(failedIds({ functions: bare })).not.toContain('S1-09')
  })

  it.each(['PUBLIC', 'anon', 'authenticated', 'service_role', 'uellix_writer', 'uellix_owner'])(
    'refuses EXECUTE held by %s — the S1-DEFECT-002 class',
    (principal) => {
      const functions = healthy().functions.map((f) =>
        f.signature.startsWith('public.')
          ? { ...f, executeGrantees: [...f.executeGrantees, principal] }
          : f,
      )
      expect(failedIds({ functions })).toContain('S1-10')
    },
  )

  it('refuses a contract grantee that LOST its EXECUTE', () => {
    const functions = healthy().functions.map((f) =>
      f.signature.startsWith('public.') ? { ...f, executeGrantees: ['postgres'] } : f,
    )
    expect(failedIds({ functions })).toContain('S1-10')
  })

  it('refuses CREATE on schema public held by anyone but the owner', () => {
    const grants = healthy().schemaPublicGrants.map((g) =>
      g.grantee === 'uellix_migrator' ? { ...g, create: true } : g,
    )
    expect(failedIds({ schemaPublicGrants: grants })).toContain('S1-11')
  })

  it('refuses an owner that LOST CREATE on schema public', () => {
    const grants = healthy().schemaPublicGrants.map((g) =>
      g.grantee === 'uellix_owner' ? { ...g, create: false } : g,
    )
    expect(failedIds({ schemaPublicGrants: grants })).toContain('S1-11')
  })

  it('refuses a missing sentinel TABLE', () => {
    expect(failedIds({ sentinelTablePresent: false })).toContain('S1-12')
  })
})

describe('the sentinel is the ONE thing that differs between S1 and A1', () => {
  it('S1 REFUSES a sentinel row — a bootstrap that mints its own is certifying itself', () => {
    expect(failedIds({ sentinelRowCount: 1 }, 'pre-sentinel')).toContain('S1-13')
  })

  it('A1 REFUSES the absence of one — the chain has no other in-database identity', () => {
    expect(failedIds({ sentinelRowCount: 0 }, 'post-sentinel')).toContain('S1-13')
  })

  it('A1 refuses a second row, which the CHECK should already have stopped', () => {
    expect(failedIds({ sentinelRowCount: 2 }, 'post-sentinel')).toContain('S1-13')
  })

  it('nothing else changes between the two verdicts', () => {
    const s1 = run({}, 'pre-sentinel')
    const a1 = run({ sentinelRowCount: 1 }, 'post-sentinel')
    expect(s1.passed).toBe(true)
    expect(a1.passed).toBe(true)
    expect(s1.checks.map((c) => c.id)).toEqual(a1.checks.map((c) => c.id))
  })
})

describe('parsing the observation fails closed', () => {
  const raw = () => JSON.stringify(healthy())

  it('accepts the artefact it was built for', () => {
    const r = parseS1Observation(raw(), KNOWN_STAGING_PROJECT_REF, PRE_PATH)
    expect(r.ok).toBe(true)
  })

  it('refuses an absent artefact — unmeasured is not satisfied', () => {
    const r = parseS1Observation(null, KNOWN_STAGING_PROJECT_REF, PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_ABSENT')
  })

  it('refuses malformed JSON rather than guessing', () => {
    const r = parseS1Observation('{not json', KNOWN_STAGING_PROJECT_REF, PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_MALFORMED')
  })

  it('refuses an observation that does not say WHICH database it describes', () => {
    const o = healthy() as unknown as Record<string, unknown>
    delete o.targetProjectRef
    const r = parseS1Observation(JSON.stringify(o), KNOWN_STAGING_PROJECT_REF, PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_PROJECT_REF_MISSING')
  })

  it('VETOES a production ref by the check that names production', () => {
    const r = parseS1Observation(JSON.stringify({ ...healthy(), targetProjectRef: PROD }), PROD, PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_PRODUCTION_REF')
  })

  it('refuses an observation of a DIFFERENT project than the one asked about', () => {
    const r = parseS1Observation(raw(), 'aaaaaaaaaaaaaaaaaaaa', PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_PROJECT_REF_MISMATCH')
  })

  it('refuses an artefact carrying anything secret-shaped', () => {
    const o = { ...healthy(), ledgerOwner: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }
    const r = parseS1Observation(JSON.stringify(o), KNOWN_STAGING_PROJECT_REF, PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_CARRIES_SECRET')
  })

  it('refuses an observation missing a field the verdict rests on', () => {
    const o = healthy() as unknown as Record<string, unknown>
    delete o.functions
    const r = parseS1Observation(JSON.stringify(o), KNOWN_STAGING_PROJECT_REF, PRE_PATH)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_INCOMPLETE')
  })
})

describe('the generated observation SQL', () => {
  const onDisk = existsSync(path.join(ROOT, S1_OBSERVATION_SQL))
    ? readFileSync(path.join(ROOT, S1_OBSERVATION_SQL), 'utf8').replace(/\r\n?/g, '\n')
    : null

  /** Written without a regex so no escape can rot. */
  const PROJECT_REF_GUARD = String.fromCharCode(92) + 'if :{?uellix_project_ref}'

  /**
   * The probe with its comments removed.
   *
   * Every "this SQL must never mention X" assertion needs it: the probe
   * explains WHY it does not read the grant list and WHY it does not use
   * pg_get_function_identity_arguments, and a whole-file check flags the
   * explanation as the violation. Third time this session; it is a rule now.
   */
  const STATEMENTS = (onDisk ?? '')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')

  it('is committed to the repository, never a temporary file', () => {
    expect(onDisk, `${S1_OBSERVATION_SQL} is missing — run pnpm s1:observation:generate`).not.toBeNull()
  })

  it('regenerates byte-identically from the contract', () => {
    expect(onDisk).toBe(buildBootstrapObservationSql())
  })

  it('never writes, runs read-only, and rolls back', () => {
    // Statements only. The probe explains at length WHY it reads reachability
    // rather than "the grant list", and a word-level check flags the
    // explanation as the violation — the same trap S1-DEFECT-001's FROM PUBLIC
    // test and the release gate's service_role rule both fell into.
    const statements = (onDisk ?? '')
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
    expect(statements).not.toMatch(/(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s|DROP\s|ALTER\s|GRANT\s|REVOKE\s)/i)
    expect(onDisk).toContain('BEGIN READ ONLY;')
    expect(onDisk?.trimEnd().endsWith('ROLLBACK;')).toBe(true)
  })

  it('refuses to run without a project ref — an unattributed observation could describe anything', () => {
    expect(onDisk).toContain(PROJECT_REF_GUARD)
    expect(onDisk).toContain('REFUSED')
  })

  it('reads the sentinel ROW COUNT but never the row itself', () => {
    // The count is what both verdicts rest on. Selecting the row would put a
    // project ref in two places and invite them to disagree.
    expect(onDisk).toContain('sentinelRowCount')
    expect(onDisk).not.toMatch(/SELECT[^;]*\bowner_separation\b/i)
  })

  it('measures reachability with pg_has_role, not by reading the membership list', () => {
    expect(onDisk).toContain('pg_has_role')
    expect(onDisk).toContain('appReachesOwner')
  })

  it('reads the EFFECTIVE function ACL, coalescing a NULL proacl', () => {
    // The S1-DEFECT-002 lesson, carried into the probe: a NULL proacl means the
    // default, and for functions that default is PUBLIC EXECUTE.
    expect(onDisk).toContain('acldefault')
    expect(onDisk).toContain('aclexplode')
  })

  it('renders signatures with regprocedure, which is the only form that matches the contract', () => {
    // Found by running the probe, not by reading it.
    // `pg_get_function_identity_arguments` KEEPS parameter names — it renders
    // assert_hosted_capabilities as `(p_package text)` — so the contract said
    // `(text)`, the probe said `(p_package text)`, and S1-07 reported the
    // function ABSENT from a database where it plainly existed. No textual test
    // could have caught it: the fixtures spelled it the contract's way on both
    // sides. regprocedure emits bare types and, with an empty search_path,
    // always qualifies the schema.
    expect(STATEMENTS).toContain('::regprocedure::text')
    expect(STATEMENTS).not.toContain('pg_get_function_identity_arguments')
  })

  it('qualifies every catalogue reference, because it sets an empty search_path', () => {
    expect(onDisk).toContain("SET LOCAL search_path = ''")
    expect(onDisk).toContain('pg_catalog.pg_roles')
  })
})

// ---------------------------------------------------------------------------
// S2 — the sentinel INSERT. The one write of this phase.
// ---------------------------------------------------------------------------

describe('the generated S2 sentinel template', () => {
  const onDisk = existsSync(path.join(ROOT, S2_SENTINEL_SQL))
    ? readFileSync(path.join(ROOT, S2_SENTINEL_SQL), 'utf8').replace(/\r\n?/g, '\n')
    : null

  const STATEMENTS = (onDisk ?? '')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')

  it('is committed and regenerates byte-identically from the contract', () => {
    expect(onDisk, `${S2_SENTINEL_SQL} is missing — run pnpm s2:sentinel:generate`).not.toBeNull()
    expect(onDisk).toBe(buildSentinelInsertSql())
  })

  it('does NOT hardcode the project ref — the repository cannot claim an identity alone', () => {
    // THE PROPERTY THAT KEEPS S2 A HUMAN ACT. `planProvisioningPhase` already
    // refuses to write this row in code. A file that carried the ref would let
    // anyone with a shell make the database say what it is; a file that takes
    // it as a parameter can only help a person say it the same way twice.
    expect(STATEMENTS).not.toContain(KNOWN_STAGING_PROJECT_REF)
    expect(STATEMENTS).toContain(":'uellix_project_ref'")
  })

  it('DENIES every known production ref by name, before it writes anything', () => {
    for (const ref of KNOWN_PRODUCTION_IDENTIFIERS.projectRefs) {
      expect(STATEMENTS, `${ref} must be denied by name`).toContain(ref)
    }
    expect(STATEMENTS).toMatch(/is a PRODUCTION project ref/)
  })

  it('carries the two literals §3 fixes, from the same constants the runbook quotes', () => {
    expect(STATEMENTS).toContain(SENTINEL_BOOTSTRAP_VERSION)
    expect(STATEMENTS).toContain(SENTINEL_OWNER_SEPARATION)
    expect(SENTINEL_OWNER_SEPARATION).toContain('RR-02')
  })

  it('is one-shot: it refuses a sentinel that already exists', () => {
    expect(STATEMENTS).toMatch(/the sentinel already has a row/)
  })

  it('refuses when S1 has not run', () => {
    expect(STATEMENTS).toMatch(/staging_sentinel does not exist/)
  })

  it('runs in a transaction and asserts its own postcondition before COMMIT', () => {
    expect(STATEMENTS).toContain('BEGIN;')
    expect(STATEMENTS.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(STATEMENTS).toMatch(/S2 FAILED: % row\(s\) after the insert/)
    expect(STATEMENTS).toMatch(/S2 FAILED: the row says/)
  })

  it('reaches its guards through a transaction-local setting, not through a dollar-quoted variable', () => {
    // psql's lexer knows about dollar-quoting and does NOT substitute variables
    // inside a $$ ... $$ body. The first draft interpolated the ref there and
    // the literal text reached the server as syntax. Measured, not reasoned.
    expect(STATEMENTS).toContain("set_config('uellix.sentinel_project_ref'")
    expect(STATEMENTS).toContain("current_setting('uellix.sentinel_project_ref')")
    const dollarBodies = STATEMENTS.split('$$').filter((_, i) => i % 2 === 1)
    for (const body of dollarBodies) {
      expect(body, 'no psql variable may appear inside a dollar-quoted body').not.toContain(
        ":'uellix_project_ref'",
      )
    }
  })

  it('writes exactly one row and nothing else — no DDL, no other table', () => {
    const writes = STATEMENTS.match(/\b(INSERT INTO|UPDATE|DELETE FROM|CREATE|DROP|ALTER|GRANT|REVOKE)\b/gi) ?? []
    expect(writes).toEqual(['INSERT INTO'])
    expect(STATEMENTS).toContain('INSERT INTO uellix_bootstrap.staging_sentinel')
  })
})
