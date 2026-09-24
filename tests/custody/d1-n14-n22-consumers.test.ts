// @vitest-environment node
// tests/custody/d1-n14-n22-consumers.test.ts
//
// N14, N21 and N22 over a FAKE transport. No socket. Every session is an
// in-memory script answering exact statement texts.
//
// Mutation controls carried here: N14 / N22 bypass N05 (vault in the closure),
// consumer spawns a child, wrong role, wrong project, unauthorized statement;
// AC-1 surface widened or made dynamic; AC-2 enumeration or proof skipped;
// AC-3 EXECUTE still required or silently PASSed; to_regprocedure introduced.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import { AC1_AUTHORIZED_SURFACE, P1_STATEMENTS, ac2ReachabilityProof, type P1Id } from '@/db/custody/p1-reads'
import { BEGIN_READ_ONLY, ROLLBACK, runAuditorReadSession } from '@/db/custody/auditor-read-session'
import { N14_BODY, n14StatementTexts, runN14Observation } from '@/db/custody/n14-observation'
import { N21_BODY, N22_BODY, n21ExitFromRows, n22ExitFromRows, n22Rows, n22StatementTexts, runN21Mr3Poststate, runN22Poststate, type PvRow } from '@/db/custody/n22-poststate'
import type { N13Connect, Row } from '@/db/custody/n13-verification'
import { main as n14Main } from '@/scripts/custody/d1-auditor-n14-consumer'
import { main as n22Main, parseNode } from '@/scripts/custody/d1-auditor-n22-consumer'
import { parseLauncherArgs } from '@/scripts/custody/d1-deliver-n13'
import { deriveClosure } from '@/scripts/custody/build-production-entrypoints'
import { AUTHORIZED_ROLE_OBSERVATIONS, roleEnumerationFindings } from '@/scripts/custody/d1-pre-hc1-post-mint'

const VAR = 'UELLIX_AUDITOR_DATABASE_URL'
const PW = 'Q'.repeat(43)
const url = (host: string, role = 'uellix_auditor'): string => ['postgresql:', `//${role}:`, PW, `@${host}:5432/postgres`].join('')
const STAGING = url(`db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`)
const RELEASE = join(process.cwd(), 'docs', 'ops', 'release')

const AUTHORITY = JSON.parse(readFileSync(join(RELEASE, 'FIBDB053_D1_AUDITOR_CAPABILITY_PROVISIONING_AUTHORITY_v1.0.0.json'), 'utf8')) as {
  AUTHORIZED_FUTURE_SQL: { PHASE_P1_OBSERVATION_ONLY_READS: string[] }
}
const P1_LIST = AUTHORITY.AUTHORIZED_FUTURE_SQL.PHASE_P1_OBSERVATION_ONLY_READS
const V106 = JSON.parse(readFileSync(join(RELEASE, 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.6.json'), 'utf8')) as {
  SUCCESSOR_AUTHORIZED_SQL: { AC1_TABLE_PRIVILEGES: { sql: string; surface: Record<string, string[]> } }
}

const GOOD: Partial<Record<P1Id, readonly Row[]>> = {
  IDENTITY: [{ current_user: 'uellix_auditor', session_user: 'uellix_auditor' }],
  READ_ONLY: [{ current_setting: 'on' }],
  SENTINEL: [{ environment: 'staging', project_ref: KNOWN_STAGING_PROJECT_REF }],
  STELLA_OPS_EXISTS: [{ '?column?': true }],
  SERVER_VERSION: [{ current_setting: '170004' }],
  ROLE_ATTRIBUTES: [
    { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolinherit: true, rolconnlimit: -1, rolvaliduntil: null },
  ],
  MEMBERSHIPS: [],
  REACH: [
    { role_name: 'uellix_owner', can_member: false, can_usage: false, can_set: false },
    { role_name: 'postgres', can_member: false, can_usage: false, can_set: false },
  ],
  OWNERSHIP: [{ classes: '0', namespaces: '0', procs: '0', types: '0' }],
  DATDBA: [{ '?column?': false }],
  DATABASE_PRIVILEGES: [{ auditor_connect: true, auditor_temp: true, public_connect: true, public_temp: true }],
  SCHEMA_PRIVILEGES: [
    { schema_name: 'public', present: true, can_usage: true, can_create: false },
    { schema_name: 'uellix_bootstrap', present: true, can_usage: true, can_create: false },
    { schema_name: 'uellix_stella_ops', present: true, can_usage: true, can_create: false },
    { schema_name: 'uellix_grounding', present: false, can_usage: null, can_create: null },
  ],
  DEFAULT_ACL: [{ owner_role: 'uellix_owner', schema_name: 'public', object_type: 'r', privilege_type: 'SELECT' }],
  TABLE_PRIVILEGES: [{ sentinel_select: true, sentinel_insert: false, sentinel_update: false, sentinel_delete: false, sentinel_truncate: false, users_select: true }],
}

function fake(over: Partial<Record<P1Id, readonly Row[] | Error>> = {}): { connect: N13Connect; sent: string[] } {
  const bySql = new Map<string, readonly Row[] | Error>()
  for (const [id, rows] of Object.entries({ ...GOOD, ...over })) bySql.set(P1_STATEMENTS[id as P1Id].sql, rows as readonly Row[] | Error)
  const sent: string[] = []
  return {
    sent,
    connect: async () => ({
      query: async (sql: string) => {
        sent.push(sql)
        if (sql === BEGIN_READ_ONLY || sql === ROLLBACK) return []
        const r = bySql.get(sql)
        if (r === undefined) throw new Error('unscripted')
        if (r instanceof Error) throw r
        return r
      },
      close: async () => undefined,
    }),
  }
}
const tables = (o: Record<string, boolean>): Partial<Record<P1Id, readonly Row[]>> => ({ TABLE_PRIVILEGES: [{ ...GOOD.TABLE_PRIVILEGES![0], ...o }] })

describe('statement provenance', () => {
  it('every VERBATIM statement is byte-identical to its original authority entry', () => {
    for (const s of Object.values(P1_STATEMENTS).filter((x) => x.form === 'VERBATIM')) {
      expect(P1_LIST[s.authorityIndex!], s.id).toBe(s.sql)
      expect(s.authority, s.id).toBe('ORIGINAL_P1')
    }
  })
  it('every DESCRIBED statement maps to an original authority entry and uses nothing the authority forbids', () => {
    for (const s of Object.values(P1_STATEMENTS).filter((x) => x.form === 'DESCRIBED')) {
      expect(P1_LIST[s.authorityIndex!], s.id).toBeDefined()
      expect(s.sql.startsWith('SELECT '), s.id).toBe(true)
      expect(s.sql, s.id).not.toMatch(/pg_authid|pg_shadow|rolpassword|to_regprocedure|information_schema|pg_stat_activity|pg_locks|SET ROLE|SESSION AUTHORIZATION|\bCOPY\b|\bLISTEN\b|\bNOTIFY\b|;/i)
    }
  })
  it('AC-1: TABLE_PRIVILEGES is SUCCESSOR authority, never presented as original, byte-identical to the v1.0.6 pin', () => {
    expect(P1_STATEMENTS.TABLE_PRIVILEGES).toMatchObject({ form: 'SUCCESSOR_PINNED', authority: 'SUCCESSOR_V1_0_6_AC1', authorityIndex: null, disposition: 'ISSUABLE', ruling: 'AC-1' })
    expect(P1_STATEMENTS.TABLE_PRIVILEGES.sql).toBe(V106.SUCCESSOR_AUTHORIZED_SQL.AC1_TABLE_PRIVILEGES.sql)
    expect(P1_LIST).not.toContain(P1_STATEMENTS.TABLE_PRIVILEGES.sql)
  })
  it('CONTROL AC-1-surface: across EVERY statement, has_table_privilege names exactly the owner surface, as literals, for uellix_auditor only', () => {
    const pairs: string[] = []
    for (const s of Object.values(P1_STATEMENTS)) {
      const calls = s.sql.match(/has_table_privilege\(/g)?.length ?? 0
      const literal = [...s.sql.matchAll(/has_table_privilege\('uellix_auditor', '([a-z_]+\.[a-z_]+)', '([A-Z]+)'\)/g)]
      expect(literal.length, `${s.id}: a has_table_privilege call that is not a literal (role, relation, privilege) triple`).toBe(calls)
      for (const m of literal) pairs.push(`${m[1]}|${m[2]}`)
    }
    const allowed = Object.entries(AC1_AUTHORIZED_SURFACE).flatMap(([r, ps]) => ps.map((p) => `${r}|${p}`))
    expect(pairs.sort()).toEqual(allowed.sort())
    expect(AC1_AUTHORIZED_SURFACE).toEqual(V106.SUCCESSOR_AUTHORIZED_SQL.AC1_TABLE_PRIVILEGES.surface)
  })
  it('CONTROL AC-2-no-enumeration: REACH is a keyed lookup over the named roles, with no pattern', () => {
    expect(P1_STATEMENTS.REACH.sql).toMatch(/= ANY \(ARRAY\[/)
    expect(P1_STATEMENTS.REACH.sql).not.toMatch(/\bLIKE\b|SIMILAR TO|~|regexp|uellix_cap/i)
  })
  it('NB-4: NO statement of the observation surface can enumerate roles (every statement, not REACH only)', () => {
    expect(roleEnumerationFindings(P1_STATEMENTS)).toEqual([])
    for (const s of Object.values(P1_STATEMENTS)) expect(s.sql, s.id).not.toMatch(/\b(?:I?LIKE|SIMILAR\s+TO)\b|~|regexp|uellix_cap/i)
    // The guard is not vacuous: it covers every statement that reads a role catalog.
    const catalogReaders = Object.values(P1_STATEMENTS).filter((s) => /pg_catalog\.pg_(?:roles|auth_members)\b/.test(s.sql)).map((s) => s.id)
    expect(catalogReaders).toEqual(['ROLE_ATTRIBUTES', 'MEMBERSHIPS', 'REACH'])
  })
  it.each([
    ['MEMBERSHIPS widened with LIKE uellix_cap_%', 'MEMBERSHIPS', (q: string) => `${q} OR r.rolname LIKE 'uellix_cap_%'`],
    ['MEMBERSHIPS with its WHERE removed', 'MEMBERSHIPS', (q: string) => q.replace(/ WHERE [\s\S]*$/, '')],
    ['MEMBERSHIPS with an unkeyed disjunct', 'MEMBERSHIPS', (q: string) => `${q} OR r.rolcanlogin`],
    ['ROLE_ATTRIBUTES by regular expression', 'ROLE_ATTRIBUTES', (q: string) => q.replace("rolname = 'uellix_auditor'", "rolname ~ '^uellix_'")],
    ['REACH extended by starts_with', 'REACH', (q: string) => `${q} OR starts_with(r.rolname, 'uellix_')`],
    ['a new statement over pg_authid', 'OWNERSHIP', () => 'SELECT rolname FROM pg_catalog.pg_authid'],
    // NB-B (X10-equivalents): spellings a lexical guard on "pg_catalog.pg_roles" did not see.
    ['an unqualified pg_roles', 'SENTINEL', () => 'SELECT rolname FROM pg_roles'],
    ['a quoted pg_catalog.pg_roles', 'SENTINEL', () => 'SELECT r."rolname" FROM "pg_catalog"."pg_roles" r'],
    ['information_schema.applicable_roles', 'SERVER_VERSION', () => 'SELECT role_name FROM information_schema.applicable_roles'],
    ['information_schema.enabled_roles', 'READ_ONLY', () => 'SELECT role_name FROM information_schema.enabled_roles'],
    ['owners resolved through pg_get_userbyid', 'TABLE_PRIVILEGES', (q: string) => `${q.replace(/^SELECT /, 'SELECT (SELECT array_agg(pg_catalog.pg_get_userbyid(relowner)) FROM pg_catalog.pg_class) AS owners, ')}`],
    ['an authorized observation widened (OWNERSHIP OR true)', 'OWNERSHIP', (q: string) => q.replace("relowner = 'uellix_auditor'::regrole", "relowner = 'uellix_auditor'::regrole OR true")],
    ['an authorized observation re-keyed (DATDBA over every database)', 'DATDBA', (q: string) => q.replace(' WHERE datname = current_database()', '')],
  ] as const)('NB-4 CONTROL %s -> a finding', (_name, id, mutate) => {
    const mutated = { ...P1_STATEMENTS, [id]: { ...P1_STATEMENTS[id], sql: mutate(P1_STATEMENTS[id].sql) } }
    expect(roleEnumerationFindings(mutated).some((f) => f.startsWith(`${id}:`))).toBe(true)
  })
  it('NB-B: a NEW statement that touches the role surface is a finding, whatever it is called', () => {
    const extra = { ...P1_STATEMENTS, EXTRA: { id: 'EXTRA', sql: 'SELECT grantee FROM information_schema.role_table_grants' } }
    expect(roleEnumerationFindings(extra as never)).toContain('EXTRA: touches the role surface and is not an authorized role observation')
  })
  it('NB-B: the role surface is touched by exactly the pinned observations, and every pin matches', () => {
    expect(Object.keys(AUTHORIZED_ROLE_OBSERVATIONS).sort()).toEqual(['DATDBA', 'DEFAULT_ACL', 'IDENTITY', 'MEMBERSHIPS', 'OWNERSHIP', 'REACH', 'ROLE_ATTRIBUTES'])
    for (const id of Object.keys(AUTHORIZED_ROLE_OBSERVATIONS)) expect(P1_STATEMENTS[id as P1Id], id).toBeDefined()
    expect(roleEnumerationFindings(P1_STATEMENTS)).toEqual([])
  })
  it('CONTROL AC-3 / M20: FUNCTION_EXECUTE is deferred, and no statement uses to_regprocedure', () => {
    expect(P1_STATEMENTS.FUNCTION_EXECUTE).toMatchObject({ disposition: 'DEFERRED_TO_PRECHECK_R2', ruling: 'AC-3' })
    for (const s of Object.values(P1_STATEMENTS)) expect(s.sql, s.id).not.toMatch(/to_regprocedure/i)
  })
  it('no node sends FUNCTION_EXECUTE; N14 and N22 both send TABLE_PRIVILEGES', () => {
    expect([...n14StatementTexts(), ...n22StatementTexts()]).not.toContain(P1_STATEMENTS.FUNCTION_EXECUTE.sql)
    expect(n14StatementTexts()).toContain(P1_STATEMENTS.TABLE_PRIVILEGES.sql)
    expect(n22StatementTexts()).toContain(P1_STATEMENTS.TABLE_PRIVILEGES.sql)
    for (const body of [N14_BODY, N21_BODY, N22_BODY]) expect(body).not.toContain('FUNCTION_EXECUTE')
  })
})

describe('the AC-2 structural proof', () => {
  it('holds only when all three conditions are OBSERVED', () => {
    expect(ac2ReachabilityProof({ rolsuper: false, membershipEdgesAsMember: 0, datdbaIsAuditor: false }).holds).toBe(true)
    expect(ac2ReachabilityProof({ rolsuper: true, membershipEdgesAsMember: 0, datdbaIsAuditor: false }).holds).toBe(false)
    expect(ac2ReachabilityProof({ rolsuper: false, membershipEdgesAsMember: 1, datdbaIsAuditor: false }).holds).toBe(false)
    expect(ac2ReachabilityProof({ rolsuper: false, membershipEdgesAsMember: 0, datdbaIsAuditor: true }).holds).toBe(false)
    expect(ac2ReachabilityProof({ rolsuper: null, membershipEdgesAsMember: null, datdbaIsAuditor: undefined }).failed).toHaveLength(3)
  })
})

describe('the read session', () => {
  it('CONTROL unauthorized-statement: a body cannot send a deferred or unlisted statement, and nothing reaches the transport', async () => {
    const f = fake()
    const r = await runAuditorReadSession({
      env: { [VAR]: STAGING },
      connect: f.connect,
      bodyAllowlist: ['ROLE_ATTRIBUTES', 'FUNCTION_EXECUTE'],
      body: async (read) => read('FUNCTION_EXECUTE'),
    })
    expect(r.code).toBe('SESSION_UNAUTHORIZED_STATEMENT')
    expect(f.sent).not.toContain(P1_STATEMENTS.FUNCTION_EXECUTE.sql)
    expect(f.sent.at(-1)).toBe(ROLLBACK)
  })
  it('CONTROL wrong-role: KP-1 naming another role stops the session with STOP_AUDITOR_AUTHENTICATION_FAILED', async () => {
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: fake({ IDENTITY: [{ current_user: 'postgres', session_user: 'postgres' }] }).connect })
    expect(r.session).toMatchObject({ failedAt: 'KP-1', token: 'STOP_AUDITOR_AUTHENTICATION_FAILED', rolledBack: true })
    expect(r.exitMet).toBe(false)
  })
  it('CONTROL wrong-project: another project is refused before any socket, and a foreign sentinel after', async () => {
    const f = fake()
    const r = await runN22Poststate({ env: { [VAR]: url('db.abcdefghijklmnopqrst.supabase.co') }, connect: f.connect })
    expect(r.session).toMatchObject({ failedAt: 'PRE_CONNECT_IDENTITY', code: 'HOSTED_TARGET_NOT_EXPECTED_PROJECT' })
    expect(f.sent).toEqual([])
    const g = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake({ SENTINEL: [{ environment: 'staging', project_ref: 'abcdefghijklmnopqrst' }] }).connect })
    expect(g.session).toMatchObject({ failedAt: 'TARGET_IDENTITY_ARM_B', token: 'STOP_TARGET_IDENTITY_CONTRADICTION' })
  })
  it('opens nothing by default', async () => {
    const r = await runN14Observation({ env: { [VAR]: STAGING } })
    expect(r.session).toMatchObject({ failedAt: 'CONNECT', code: 'N13_CONNECT_NOT_AUTHORIZED_IN_THIS_MODE' })
  })
})

describe('N14', () => {
  it('measures every required prestate including the AC-1 rows, defers only FUNCTION_EXECUTE, and meets its exit on a clean target', async () => {
    const f = fake()
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r.token).toBeNull()
    expect(r.prestate).toMatchObject({ kp3StellaOpsExists: true, kp5StellaOpsUsage: true, kp6Req2NotPerformed: true, membershipEdges: 0, membershipEdgesAsMember: 0 })
    expect(r.prestate?.ac2Proof).toEqual({ holds: true, failed: [] })
    expect(r.prestate?.tablePrivileges).toEqual(GOOD.TABLE_PRIVILEGES![0])
    expect(r.deferredToPrecheckR2).toEqual(['FUNCTION_EXECUTE'])
    expect(r.exitMet).toBe(true)
    expect(f.sent[0]).toBe(BEGIN_READ_ONLY)
    expect(f.sent.at(-1)).toBe(ROLLBACK)
    expect(f.sent).toContain(P1_STATEMENTS.TABLE_PRIVILEGES.sql)
  })
  it('KP-3 first: an absent uellix_stella_ops is STOP_STELLA_OPS_SCHEMA_ABSENT and no privilege is read after it', async () => {
    const f = fake({ STELLA_OPS_EXISTS: [{ '?column?': false }] })
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r.token).toBe('STOP_STELLA_OPS_SCHEMA_ABSENT')
    expect(r.exitMet).toBe(false)
    expect(f.sent).not.toContain(P1_STATEMENTS.SCHEMA_PRIVILEGES.sql)
  })
  it.each([
    [{ ROLE_ATTRIBUTES: [{ ...GOOD.ROLE_ATTRIBUTES![0], rolbypassrls: true }] }, 'STOP_DANGEROUS_ROLE_ATTRIBUTE'],
    [{ MEMBERSHIPS: [{ granted_role: 'uellix_owner', member_role: 'uellix_auditor' }] }, 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP'],
    [{ OWNERSHIP: [{ classes: '1', namespaces: '0', procs: '0', types: '0' }] }, 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP'],
    [{ DATDBA: [{ '?column?': true }] }, 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP'],
    [{ DATABASE_PRIVILEGES: [{ ...GOOD.DATABASE_PRIVILEGES![0], auditor_connect: false }] }, 'STOP_CONNECT_PRIVILEGE_ABSENT'],
    [{ SCHEMA_PRIVILEGES: [{ schema_name: 'public', present: true, can_usage: true, can_create: true }, { schema_name: 'uellix_stella_ops', present: true, can_usage: true, can_create: false }] }, 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'],
    [tables({ sentinel_insert: true }), 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'],
    [tables({ sentinel_truncate: true }), 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'],
  ] as const)('raises %s', async (over, token) => {
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: fake(over as Partial<Record<P1Id, readonly Row[]>>).connect })
    expect(r.token).toBe(token)
    expect(r.exitMet).toBe(false)
  })
})

describe('N22 and N21', () => {
  it('N22 asserts all 34 rows: PV-22/28/32 are real assertions, PV-24/25 are DEFERRED_TO_PRECHECK_R2, and the exit is met on a clean target', async () => {
    const r = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake().connect })
    expect(r.rows).toHaveLength(34)
    const v = (id: string) => r.rows.find((x) => x.id === id)?.verdict
    expect(['PV-22', 'PV-28', 'PV-32'].map(v)).toEqual(['PASS', 'PASS', 'PASS'])
    expect(r.deferredToPrecheckR2).toEqual(['PV-24', 'PV-25'])
    expect(r.rows.filter((x) => x.verdict === 'FAIL')).toEqual([])
    expect(r.tokens).toEqual([])
    expect(r.readOnlyProof?.GRANTS).toEqual({ verdict: 'PASS', deferredRows: ['PV-24', 'PV-25'] })
    expect(Object.values(r.readOnlyProof!).every((l) => l.verdict === 'PASS')).toBe(true)
    expect(r.exitMet).toBe(true)
  })
  it.each([
    [tables({ sentinel_select: false }), 'PV-22', null],
    [tables({ sentinel_delete: true }), 'PV-28', 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'],
    [tables({ users_select: false }), 'PV-32', 'STOP_PRE_EXISTING_SURFACE_CHANGED'],
    [{ ROLE_ATTRIBUTES: [{ ...GOOD.ROLE_ATTRIBUTES![0], rolsuper: true }] }, 'PV-6', 'STOP_DANGEROUS_ROLE_ATTRIBUTE'],
    [{ DATDBA: [{ '?column?': true }] }, 'PV-14', 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP'],
  ] as const)('a wrong state FAILS its row and raises the authority token, and the exit is unmet (%#)', async (over, row, token) => {
    const r = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake(over as Partial<Record<P1Id, readonly Row[]>>).connect })
    expect(r.rows.find((x) => x.id === row)?.verdict).toBe('FAIL')
    if (token === null) expect(r.failedWithoutToken).toContain(row)
    else expect(r.tokens).toContain(token)
    expect(r.exitMet).toBe(false)
  })
  it('NB-5: PV-28 asserts exactly INSERT, UPDATE, DELETE and TRUNCATE on the sentinel — no more, no fewer', async () => {
    const clean = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake().connect })
    const pv28 = clean.rows.find((x) => x.id === 'PV-28')!
    expect(pv28.expected).toBe('INSERT, UPDATE, DELETE, TRUNCATE on uellix_bootstrap.staging_sentinel all false')
    expect(Object.keys(JSON.parse(pv28.actual) as object)).toEqual(['insert', 'update', 'delete', 'truncate'])
    expect(pv28.verdict).toBe('PASS')
    // AC-1's sentinel surface is SELECT plus exactly these four: PV-28 is not broadened beyond it.
    expect([...AC1_AUTHORIZED_SURFACE['uellix_bootstrap.staging_sentinel']!].sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'TRUNCATE', 'UPDATE'])
  })
  it.each(['sentinel_insert', 'sentinel_update', 'sentinel_delete', 'sentinel_truncate'] as const)('NB-5: %s alone true FAILS PV-28 and stops', async (priv) => {
    const r = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake(tables({ [priv]: true }) as Partial<Record<P1Id, readonly Row[]>>).connect })
    expect(r.rows.find((x) => x.id === 'PV-28')?.verdict).toBe('FAIL')
    expect(r.tokens).toContain('STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE')
    expect(r.exitMet).toBe(false)
  })
  it('CONTROL AC-2-proof: PV-14 FAILS when only the structural proof fails (datdba), even with every named role unreachable', async () => {
    const r = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake({ DATDBA: [{ '?column?': true }] }).connect })
    expect(r.rows.find((x) => x.id === 'PV-14')?.verdict).toBe('FAIL')
  })
  it('PV-1, PV-2 and PV-5 come from what the server reported, not from a constant', () => {
    const base = {
      attrs: GOOD.ROLE_ATTRIBUTES![0]!,
      memberships: [],
      reach: [],
      own: { classes: 0, namespaces: 0, procs: 0, types: 0 },
      datdba: false,
      db: GOOD.DATABASE_PRIVILEGES![0]!,
      schemas: new Map(),
      tables: GOOD.TABLE_PRIVILEGES![0]!,
    }
    const rows = n22Rows({ ...base, preflight: { connected: true, kp1: true, targetIdentityArmB: true, sentinel: null, identity: null } })
    expect(rows.find((x) => x.id === 'PV-5')?.verdict).toBe('FAIL')
    expect(rows.find((x) => x.id === 'PV-1')?.verdict).toBe('FAIL')
    const other = n22Rows({ ...base, preflight: { connected: true, kp1: true, targetIdentityArmB: true, sentinel: null, identity: { currentUser: 'uellix_auditor', sessionUser: 'postgres' } } })
    expect(other.find((x) => x.id === 'PV-2')?.verdict).toBe('FAIL')
  })
  it('CONTROL AC-3-silent-pass: a PV-24/25 reported PASS, or a deferral on any other row, does not satisfy the exit rule', () => {
    const rows = n22Rows({
      preflight: { connected: true, kp1: true, targetIdentityArmB: true, sentinel: { environment: 'staging', projectRef: KNOWN_STAGING_PROJECT_REF }, identity: { currentUser: 'uellix_auditor', sessionUser: 'uellix_auditor' } },
      attrs: GOOD.ROLE_ATTRIBUTES![0]!,
      memberships: [],
      reach: [],
      own: { classes: 0, namespaces: 0, procs: 0, types: 0 },
      datdba: false,
      db: GOOD.DATABASE_PRIVILEGES![0]!,
      schemas: new Map([
        ['public', { present: true, usage: true, create: false }],
        ['uellix_bootstrap', { present: true, usage: true, create: false }],
        ['uellix_stella_ops', { present: true, usage: true, create: false }],
      ]),
      tables: GOOD.TABLE_PRIVILEGES![0]!,
    })
    expect(n22ExitFromRows(rows, true)).toBe(true)
    const deferOther = rows.map((x): PvRow => (x.id === 'PV-26' ? { ...x, verdict: 'DEFERRED_TO_PRECHECK_R2' } : x))
    expect(n22ExitFromRows(deferOther, true)).toBe(false)
  })
  it('N21: USAGE and CREATE are asserted, EXECUTE is DEFERRED_TO_PRECHECK_R2, and the exit is met; FUNCTION_EXECUTE is never sent', async () => {
    const f = fake()
    const r = await runN21Mr3Poststate({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r.rows.map((x) => x.verdict)).toEqual(['PASS', 'PASS', 'DEFERRED_TO_PRECHECK_R2', 'DEFERRED_TO_PRECHECK_R2'])
    expect(r.exitMet).toBe(true)
    expect(f.sent).not.toContain(P1_STATEMENTS.FUNCTION_EXECUTE.sql)
    expect(n21ExitFromRows(r.rows.map((x) => (x.id.startsWith('N21-EXECUTE') ? { ...x, verdict: 'PASS' as const } : x)))).toBe(false)
  })
  it('N21 fails when CREATE is held', async () => {
    const r = await runN21Mr3Poststate({ env: { [VAR]: STAGING }, connect: fake({ SCHEMA_PRIVILEGES: [{ schema_name: 'uellix_stella_ops', present: true, can_usage: true, can_create: true }] }).connect })
    expect(r.exitMet).toBe(false)
  })
  it('N22 re-issues every ISSUABLE P1 read', async () => {
    const f = fake()
    await runN22Poststate({ env: { [VAR]: STAGING }, connect: f.connect })
    const issuedIds = Object.values(P1_STATEMENTS).filter((s) => f.sent.includes(s.sql)).map((s) => s.id).sort()
    const allIssuable = Object.values(P1_STATEMENTS).filter((s) => s.disposition === 'ISSUABLE').map((s) => s.id).sort()
    expect(issuedIds).toEqual(allIssuable)
  })
})

describe('the N14 and N22 consumer entry points', () => {
  let written = ''
  beforeEach(() => {
    written = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      written += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')
      return true
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('dry runs resolve the delivered value, open nothing, and print no representation of it', async () => {
    expect(await n14Main(['--mode=dry-run'], { [VAR]: STAGING })).toBe(0)
    expect(await n22Main(['--mode=dry-run'], { [VAR]: STAGING })).toBe(0)
    expect(await n22Main(['--mode=dry-run', '--node=N21'], { [VAR]: STAGING })).toBe(0)
    expect(written).not.toContain(PW)
    expect(written).not.toContain(Buffer.from(STAGING).toString('base64'))
  })
  it('refuse any argument outside the allowlist without echoing it', async () => {
    await expect(n14Main(['--mode=dry-run', STAGING], {})).rejects.toThrow(/not echoed/)
    expect(() => parseNode(['--node=N14'])).toThrow(/not echoed/)
    expect(written).not.toContain(PW)
  })
})

describe('runtime closures', () => {
  for (const entry of ['scripts/custody/d1-auditor-n14-consumer.ts', 'scripts/custody/d1-auditor-n22-consumer.ts']) {
    const closure = deriveClosure(process.cwd(), [entry])
    const text = [...closure.values()].join('\n')
    it(`CONTROL consumer-spawns-child / persists: ${entry} has no child_process, fs or network module`, () => {
      expect(text).not.toMatch(/require\("(node:)?child_process"\)/)
      expect(text).not.toMatch(/require\("(node:)?fs(\/promises)?"\)/)
      expect(text).not.toMatch(/require\("(node:)?(net|tls|http|https|dgram)"\)/)
    })
    it(`CONTROL bypasses-N05: ${entry} cannot read the vault`, () => {
      expect([...closure.keys()]).not.toContain('db/custody/wcm-credential-store.ts')
      expect([...closure.keys()]).not.toContain('db/custody/process-delivery.ts')
      expect([...closure.keys()]).toContain('db/safety/resolve-capability-database-url.ts')
    })
  }
  it('the launcher delivers to the three built consumers and passes --node only to N22', () => {
    for (const c of ['n13', 'n14', 'n22']) expect(parseLauncherArgs([`--consumer=C:\\b\\d1-auditor-${c}-consumer.js`, '--mode=dry-run']).consumer).toContain(c)
    expect(parseLauncherArgs(['--consumer=C:\\b\\d1-auditor-n22-consumer.js', '--mode=dry-run', '--node=N21']).node).toBe('N21')
    expect(() => parseLauncherArgs(['--consumer=C:\\b\\d1-auditor-n14-consumer.js', '--mode=dry-run', '--node=N21'])).toThrow()
    expect(() => parseLauncherArgs(['--consumer=C:\\b\\d1-auditor-n14-consumer.ts', '--mode=dry-run'])).toThrow()
  })
})
