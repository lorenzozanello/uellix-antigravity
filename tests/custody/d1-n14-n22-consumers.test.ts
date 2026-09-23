// @vitest-environment node
// tests/custody/d1-n14-n22-consumers.test.ts
//
// N14, N21 and N22 over a FAKE transport. No socket. Every session is an
// in-memory script answering exact statement texts.
//
// Mutation controls carried here: N14 / N22 bypass N05 (vault in the closure),
// consumer spawns a child, wrong role, wrong project, unauthorized statement.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import { AUTHORITY_CONFLICTS, P1_STATEMENTS, type P1Id } from '@/db/custody/p1-reads'
import { BEGIN_READ_ONLY, ROLLBACK, runAuditorReadSession } from '@/db/custody/auditor-read-session'
import { N14_BODY, n14StatementTexts, runN14Observation } from '@/db/custody/n14-observation'
import { n22StatementTexts, runN21Mr3Poststate, runN22Poststate } from '@/db/custody/n22-poststate'
import type { N13Connect, Row } from '@/db/custody/n13-verification'
import { main as n14Main } from '@/scripts/custody/d1-auditor-n14-consumer'
import { main as n22Main, parseNode } from '@/scripts/custody/d1-auditor-n22-consumer'
import { parseLauncherArgs } from '@/scripts/custody/d1-deliver-n13'
import { deriveClosure } from '@/scripts/custody/build-production-entrypoints'

const VAR = 'UELLIX_AUDITOR_DATABASE_URL'
const PW = 'Q'.repeat(43)
const url = (host: string, role = 'uellix_auditor'): string => ['postgresql:', `//${role}:`, PW, `@${host}:5432/postgres`].join('')
const STAGING = url(`db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`)

const AUTHORITY = JSON.parse(
  readFileSync(join(process.cwd(), 'docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_CAPABILITY_PROVISIONING_AUTHORITY_v1.0.0.json'), 'utf8')
) as { AUTHORIZED_FUTURE_SQL: { PHASE_P1_OBSERVATION_ONLY_READS: string[] } }
const P1_LIST = AUTHORITY.AUTHORIZED_FUTURE_SQL.PHASE_P1_OBSERVATION_ONLY_READS

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

describe('statement provenance', () => {
  it('every VERBATIM statement is byte-identical to its authority entry', () => {
    for (const s of Object.values(P1_STATEMENTS).filter((x) => x.form === 'VERBATIM')) {
      expect(P1_LIST[s.authorityIndex!], s.id).toBe(s.sql)
    }
  })
  it('every DESCRIBED statement maps to an authority entry and uses nothing the authority forbids', () => {
    for (const s of Object.values(P1_STATEMENTS).filter((x) => x.form === 'DESCRIBED')) {
      expect(P1_LIST[s.authorityIndex!], s.id).toBeDefined()
      expect(s.sql.startsWith('SELECT '), s.id).toBe(true)
      // One SELECT, no statement separator, so no DDL or DML can ride along;
      // and none of the reads EXPLICITLY_UNAUTHORIZED_SQL names.
      expect(s.sql, s.id).not.toMatch(/pg_authid|pg_shadow|rolpassword|to_regprocedure|information_schema|pg_stat_activity|pg_locks|SET ROLE|SESSION AUTHORIZATION|\bCOPY\b|\bLISTEN\b|\bNOTIFY\b|;/i)
    }
  })
  it('the statement outside the authority, and the one that raises on OLD_DB, are BLOCKED', () => {
    expect(P1_STATEMENTS.TABLE_PRIVILEGES).toMatchObject({ form: 'NOT_IN_AUTHORITY', blockedBy: 'AC-1' })
    expect(P1_STATEMENTS.FUNCTION_EXECUTE.blockedBy).toBe('AC-3')
    expect(AUTHORITY_CONFLICTS.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3'])
  })
  it('no node can send a blocked statement', () => {
    const texts = [...n14StatementTexts(), ...n22StatementTexts()]
    expect(texts).not.toContain(P1_STATEMENTS.TABLE_PRIVILEGES.sql)
    expect(texts).not.toContain(P1_STATEMENTS.FUNCTION_EXECUTE.sql)
  })
})

describe('the read session', () => {
  it('CONTROL unauthorized-statement: a body cannot send a blocked or unlisted statement, and nothing reaches the transport', async () => {
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
  it('measures every authorized prestate in one read-only transaction, raises no token on a clean target, and does NOT claim its exit while AC-1/AC-3 are open', async () => {
    const f = fake()
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r.token).toBeNull()
    expect(r.prestate).toMatchObject({ kp3StellaOpsExists: true, kp5StellaOpsUsage: true, kp6Req2NotPerformed: true, membershipEdges: 0 })
    expect(r.notMeasuredBecause).toEqual(['AC-1', 'AC-3'])
    expect(r.exitMet).toBe(false)
    expect(f.sent[0]).toBe(BEGIN_READ_ONLY)
    expect(f.sent.at(-1)).toBe(ROLLBACK)
    expect(f.sent.filter((s) => s === BEGIN_READ_ONLY)).toHaveLength(1)
  })
  it('KP-3 first: an absent uellix_stella_ops is STOP_STELLA_OPS_SCHEMA_ABSENT and no privilege is read after it', async () => {
    const f = fake({ STELLA_OPS_EXISTS: [{ '?column?': false }] })
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r.token).toBe('STOP_STELLA_OPS_SCHEMA_ABSENT')
    expect(f.sent).not.toContain(P1_STATEMENTS.SCHEMA_PRIVILEGES.sql)
    expect(f.sent.indexOf(P1_STATEMENTS.STELLA_OPS_EXISTS.sql)).toBeLessThan(f.sent.indexOf(ROLLBACK))
  })
  it.each([
    [{ ROLE_ATTRIBUTES: [{ ...GOOD.ROLE_ATTRIBUTES![0], rolbypassrls: true }] }, 'STOP_DANGEROUS_ROLE_ATTRIBUTE'],
    [{ MEMBERSHIPS: [{ granted_role: 'uellix_owner', member_role: 'uellix_auditor' }] }, 'STOP_UNEXPLAINED_ROLE_MEMBERSHIP'],
    [{ OWNERSHIP: [{ classes: '1', namespaces: '0', procs: '0', types: '0' }] }, 'STOP_UNEXPECTED_AUDITOR_OWNERSHIP'],
    [{ DATABASE_PRIVILEGES: [{ ...GOOD.DATABASE_PRIVILEGES![0], auditor_connect: false }] }, 'STOP_CONNECT_PRIVILEGE_ABSENT'],
    [{ SCHEMA_PRIVILEGES: [{ schema_name: 'public', present: true, can_usage: true, can_create: true }, { schema_name: 'uellix_stella_ops', present: true, can_usage: true, can_create: false }] }, 'STOP_UNEXPLAINED_PROHIBITED_PRIVILEGE'],
  ] as const)('raises %s', async (over, token) => {
    const r = await runN14Observation({ env: { [VAR]: STAGING }, connect: fake(over as Partial<Record<P1Id, readonly Row[]>>).connect })
    expect(r.token).toBe(token)
  })
  it('its body order starts at KP-3', () => {
    expect(N14_BODY[0]).toBe('STELLA_OPS_EXISTS')
  })
})

describe('N22 and N21', () => {
  it('N22 asserts all 34 rows; the AC-1/AC-3 rows are BLOCKED and keep the exit unmet', async () => {
    const r = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake().connect })
    expect(r.rows).toHaveLength(34)
    expect(r.rows.filter((x) => x.verdict === 'BLOCKED').map((x) => x.id)).toEqual(['PV-22', 'PV-24', 'PV-25', 'PV-28', 'PV-32'])
    expect(r.rows.filter((x) => x.verdict === 'FAIL')).toEqual([])
    expect(r.blockedBy).toEqual(['AC-1', 'AC-3'])
    expect(r.readOnlyProof).toMatchObject({ ATTRIBUTES: 'PASS', MEMBERSHIPS: 'PASS', OWNERSHIP: 'PASS', GRANTS: 'BLOCKED', SESSION: 'PASS' })
    expect(r.exitMet).toBe(false)
  })
  it('N22 fails a row on a wrong state and the proof layer with it', async () => {
    const r = await runN22Poststate({ env: { [VAR]: STAGING }, connect: fake({ ROLE_ATTRIBUTES: [{ ...GOOD.ROLE_ATTRIBUTES![0], rolsuper: true }] }).connect })
    expect(r.rows.find((x) => x.id === 'PV-6')?.verdict).toBe('FAIL')
    expect(r.readOnlyProof?.ATTRIBUTES).toBe('FAIL')
  })
  it('N22 re-issues the whole authorized P1 read list, not a subset', async () => {
    const f = fake()
    await runN22Poststate({ env: { [VAR]: STAGING }, connect: f.connect })
    const issuedIds = Object.values(P1_STATEMENTS).filter((s) => f.sent.includes(s.sql)).map((s) => s.id).sort()
    const allUnblocked = Object.values(P1_STATEMENTS).filter((s) => s.blockedBy === null).map((s) => s.id).sort()
    expect(issuedIds).toEqual(allUnblocked)
  })
  it('N21 passes USAGE and CREATE and cannot pass EXECUTE while AC-3 is open', async () => {
    const r = await runN21Mr3Poststate({ env: { [VAR]: STAGING }, connect: fake().connect })
    expect(r.rows.map((x) => x.verdict)).toEqual(['PASS', 'PASS', 'BLOCKED', 'BLOCKED'])
    expect(r.exitMet).toBe(false)
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
