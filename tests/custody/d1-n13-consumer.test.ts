// @vitest-environment node
// tests/custody/d1-n13-consumer.test.ts
//
// N13, THE PRODUCTION CONSUMER, OVER A FAKE TRANSPORT. No socket is opened by
// anything in this file: every session is an in-memory fake that records the
// statements it was sent and answers them from a script.
//
// Mutation controls carried here (lane section 14): consumer CLI secret,
// consumer logging, consumer persisting, consumer bypassing N05, wrong role,
// wrong project, missing KP assertion; and the launcher's refusal of a
// consumer that would run under a development runtime (topology leak).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import {
  N13_STATEMENTS,
  N13_STATEMENT_ORDER,
  assertKp1,
  assertKp2,
  parseSentinel,
  preConnectIdentity,
  runN13Verification,
  type N13Connect,
  type Row,
} from '@/db/custody/n13-verification'
import { assertKnownArguments, main as consumerMain } from '@/scripts/custody/d1-auditor-n13-consumer'
import { parseLauncherArgs } from '@/scripts/custody/d1-deliver-n13'
import { deriveClosure } from '@/scripts/custody/build-production-entrypoints'
import { d1AuditorWcmTarget } from '@/db/custody/production-custody'

const VAR = 'UELLIX_AUDITOR_DATABASE_URL'
const PW = 'W'.repeat(43)
const url = (host: string, role = 'uellix_auditor'): string => ['postgresql:', `//${role}:`, PW, `@${host}:5432/postgres`].join('')
const STAGING = url(`db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`)

type Script = Partial<Record<string, readonly Row[] | Error>>
const GOOD: Script = {
  [N13_STATEMENTS.BEGIN]: [],
  [N13_STATEMENTS.KP1]: [{ current_user: 'uellix_auditor', session_user: 'uellix_auditor' }],
  [N13_STATEMENTS.KP2]: [{ current_setting: 'on' }],
  [N13_STATEMENTS.SENTINEL]: [{ environment: 'staging', project_ref: KNOWN_STAGING_PROJECT_REF }],
  [N13_STATEMENTS.ROLLBACK]: [],
}

function fake(script: Script): { connect: N13Connect; sent: string[]; urls: string[]; closed: () => boolean } {
  const sent: string[] = []
  const urls: string[] = []
  let closed = false
  return {
    sent,
    urls,
    closed: () => closed,
    connect: async (u: string) => {
      urls.push(u)
      return {
        query: async (sql: string) => {
          sent.push(sql)
          const r = script[sql]
          if (r instanceof Error) throw r
          if (r === undefined) throw new Error('unscripted statement')
          return r
        },
        close: async () => {
          closed = true
        },
      }
    },
  }
}

const AUTHORITY = JSON.parse(
  readFileSync(join(process.cwd(), 'docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_CAPABILITY_PROVISIONING_AUTHORITY_v1.0.0.json'), 'utf8')
) as { AUTHORIZED_FUTURE_SQL: { PHASE_P1_OBSERVATION_ONLY_READS: string[]; TRANSACTION_SHAPE: { P1_and_P3: string } } }

describe('the pinned statements are the authority\'s own', () => {
  it('each read is a verbatim member of PHASE_P1_OBSERVATION_ONLY_READS', () => {
    const reads = AUTHORITY.AUTHORIZED_FUTURE_SQL.PHASE_P1_OBSERVATION_ONLY_READS
    for (const s of [N13_STATEMENTS.KP1, N13_STATEMENTS.KP2, N13_STATEMENTS.SENTINEL]) expect(reads).toContain(s)
  })
  it('BEGIN READ ONLY and ROLLBACK are the P1 transaction shape', () => {
    const shape = AUTHORITY.AUTHORIZED_FUTURE_SQL.TRANSACTION_SHAPE.P1_and_P3
    expect(shape).toContain('BEGIN READ ONLY')
    expect(shape).toContain('ROLLBACK unconditionally')
  })
})

describe('row assertions, without a database', () => {
  it('KP-1 requires exactly one row, exactly the two columns, both uellix_auditor', () => {
    expect(assertKp1([{ current_user: 'uellix_auditor', session_user: 'uellix_auditor' }])).toBe(true)
    expect(assertKp1([{ current_user: 'postgres', session_user: 'uellix_auditor' }])).toBe(false)
    expect(assertKp1([{ current_user: 'uellix_auditor', session_user: 'postgres' }])).toBe(false)
    expect(assertKp1([{ current_user: 'uellix_auditor', session_user: 'uellix_auditor', x: 1 }])).toBe(false)
    expect(assertKp1([])).toBe(false)
  })
  it('KP-2 requires the single value on', () => {
    expect(assertKp2([{ current_setting: 'on' }])).toBe(true)
    expect(assertKp2([{ current_setting: 'off' }])).toBe(false)
    expect(assertKp2([{ current_setting: 'on' }, { current_setting: 'on' }])).toBe(false)
  })
  it('the sentinel must be exactly two string columns of exactly one row', () => {
    expect(parseSentinel([{ environment: 'staging', project_ref: 'x' }])).toEqual({ environment: 'staging', projectRef: 'x' })
    expect(parseSentinel([{ environment: 'staging' }])).toBeNull()
    expect(parseSentinel([{ environment: 'staging', project_ref: 'x', extra: 1 }])).toBeNull()
    expect(parseSentinel([])).toBeNull()
  })
})

describe('arm A, before any socket', () => {
  it('accepts only the pinned project by its direct database host', () => {
    expect(preConnectIdentity(STAGING)).toBeNull()
  })
  it('CONTROL wrong-project: another well-formed Supabase project is refused', () => {
    expect(preConnectIdentity(url('db.abcdefghijklmnopqrst.supabase.co'))).toBe('HOSTED_TARGET_NOT_EXPECTED_PROJECT')
  })
  it('refuses production, a pooler, and a synthetic .invalid host', () => {
    const prod = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]
    if (prod !== undefined) expect(preConnectIdentity(url(`db.${prod}.supabase.co`))).toBe('HOSTED_TARGET_IS_PRODUCTION')
    expect(preConnectIdentity(url('x.invalid'))).toBe('HOSTED_TARGET_HOST_NOT_SUPABASE')
  })
})

describe('runN13Verification', () => {
  it('passes on the scripted server and issues exactly the pinned statements, in order, ending in ROLLBACK', async () => {
    const f = fake(GOOD)
    const r = await runN13Verification({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r.ok).toBe(true)
    expect(f.sent).toEqual([...N13_STATEMENT_ORDER])
    expect(r.statementsIssued).toEqual([...N13_STATEMENT_ORDER])
    expect(r.rolledBack).toBe(true)
    expect(f.closed()).toBe(true)
  })

  it('opens nothing by default: the default transport refuses', async () => {
    const r = await runN13Verification({ env: { [VAR]: STAGING } })
    expect(r).toMatchObject({ ok: false, failedAt: 'CONNECT', code: 'N13_CONNECT_NOT_AUTHORIZED_IN_THIS_MODE', connected: false })
  })

  it('CONTROL wrong-role: the resolver refuses another userinfo role before a socket', async () => {
    const f = fake(GOOD)
    const r = await runN13Verification({ env: { [VAR]: url(`db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`, 'postgres') }, connect: f.connect })
    expect(r).toMatchObject({ ok: false, failedAt: 'RESOLVE', code: 'DB_CAPABILITY_URL_WRONG_ROLE' })
    expect(f.urls).toEqual([])
  })

  it('CONTROL wrong-role (server side): KP-1 naming another role is STOP_AUDITOR_AUTHENTICATION_FAILED and still rolls back', async () => {
    const f = fake({ ...GOOD, [N13_STATEMENTS.KP1]: [{ current_user: 'postgres', session_user: 'postgres' }] })
    const r = await runN13Verification({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r).toMatchObject({ ok: false, failedAt: 'KP-1', token: 'STOP_AUDITOR_AUTHENTICATION_FAILED', rolledBack: true })
    expect(f.sent.at(-1)).toBe(N13_STATEMENTS.ROLLBACK)
  })

  it('CONTROL missing-KP-assertion: KP-2 off fails, and a passing run must have asked KP-1 and KP-2', async () => {
    const f = fake({ ...GOOD, [N13_STATEMENTS.KP2]: [{ current_setting: 'off' }] })
    const r = await runN13Verification({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r).toMatchObject({ ok: false, failedAt: 'KP-2', token: null, rolledBack: true })
    const g = fake(GOOD)
    const ok = await runN13Verification({ env: { [VAR]: STAGING }, connect: g.connect })
    expect(ok.kp1 && ok.kp2 && ok.targetIdentityArmB).toBe(true)
  })

  it('CONTROL wrong-project (server side): a sentinel naming another ref is a target-identity contradiction', async () => {
    const f = fake({ ...GOOD, [N13_STATEMENTS.SENTINEL]: [{ environment: 'staging', project_ref: 'abcdefghijklmnopqrst' }] })
    const r = await runN13Verification({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r).toMatchObject({ ok: false, failedAt: 'TARGET_IDENTITY_ARM_B', token: 'STOP_TARGET_IDENTITY_CONTRADICTION' })
  })

  it('a malformed sentinel row-set is refused before its values are judged', async () => {
    const f = fake({ ...GOOD, [N13_STATEMENTS.SENTINEL]: [] })
    const r = await runN13Verification({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r).toMatchObject({ ok: false, failedAt: 'SENTINEL_SHAPE' })
  })

  it('a server error mid-way is reported by code only, at its step, and still rolls back', async () => {
    const f = fake({ ...GOOD, [N13_STATEMENTS.SENTINEL]: new Error(`relation contains ${PW}`) })
    const r = await runN13Verification({ env: { [VAR]: STAGING }, connect: f.connect })
    expect(r).toMatchObject({ ok: false, failedAt: 'SENTINEL_SHAPE', code: 'N13_QUERY_FAILED', rolledBack: true })
    expect(JSON.stringify(r)).not.toContain(PW)
  })

  it('an authentication refusal at connect is STOP_AUDITOR_AUTHENTICATION_FAILED', async () => {
    const r = await runN13Verification({
      env: { [VAR]: STAGING },
      connect: async () => {
        throw new Error(`password authentication failed ${PW}`)
      },
    })
    expect(r).toMatchObject({ failedAt: 'CONNECT', token: 'STOP_AUDITOR_AUTHENTICATION_FAILED', code: 'N13_CONNECT_FAILED' })
    expect(JSON.stringify(r)).not.toContain(PW)
  })
})

describe('the consumer entry point', () => {
  let written = ''
  beforeEach(() => {
    written = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      written += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      written += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')
      return true
    })
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        written += a.map(String).join(' ')
      })
    }
  })
  afterEach(() => vi.restoreAllMocks())

  it('CONTROL consumer-CLI-secret: refuses any argument but its three flags, without echoing it', async () => {
    expect(() => assertKnownArguments(['--mode=dry-run', STAGING])).toThrow()
    expect(() => assertKnownArguments(['--mode=dry-run', `--url=${STAGING}`])).toThrow()
    await expect(consumerMain(['--mode=dry-run', STAGING], {})).rejects.toThrow(/not echoed/)
    expect(written).not.toContain(PW)
  })

  it('CONTROL consumer-logging: a dry run with the value delivered writes no representation of it anywhere', async () => {
    const code = await consumerMain(['--mode=dry-run'], { [VAR]: STAGING })
    expect(code).toBe(0)
    expect(written).not.toContain(PW)
    expect(written).not.toContain(Buffer.from(STAGING).toString('base64'))
    expect(written).not.toContain(KNOWN_STAGING_PROJECT_REF + '.supabase.co')
    expect(JSON.parse(written.trim())).toMatchObject({ node: 'N13', resolved: true, connected: false, code: 'N13_CONNECT_NOT_AUTHORIZED_IN_THIS_MODE' })
  })

  it('expect-absent passes only when nothing was delivered', async () => {
    expect(await consumerMain(['--mode=expect-absent'], {})).toBe(0)
    expect(await consumerMain(['--mode=expect-absent'], { [VAR]: STAGING })).toBe(1)
  })
})

describe('the consumer runtime closure', () => {
  const closure = deriveClosure(process.cwd(), ['scripts/custody/d1-auditor-n13-consumer.ts'])
  const text = [...closure.values()].join('\n')

  it('CONTROL consumer-persisting: no filesystem, no network module of its own, no child process', () => {
    expect(text).not.toMatch(/require\("(node:)?fs(\/promises)?"\)/)
    expect(text).not.toMatch(/require\("(node:)?child_process"\)/)
    expect(text).not.toMatch(/require\("(node:)?(net|tls|http|https|dgram)"\)/)
  })

  it('CONTROL consumer-bypassing-N05: the consumer cannot read the vault; it only reads its delivered variable', () => {
    expect([...closure.keys()]).not.toContain('db/custody/wcm-credential-store.ts')
    expect([...closure.keys()]).not.toContain('db/custody/process-delivery.ts')
    expect([...closure.keys()]).toContain('db/safety/resolve-capability-database-url.ts')
  })
})

describe('the launcher arguments', () => {
  it('CONTROL topology-leak: refuses a TypeScript consumer, which would run under a development runtime', () => {
    expect(() => parseLauncherArgs(['--consumer=C:/x/scripts/custody/d1-auditor-n13-consumer.ts', '--mode=dry-run'])).toThrow()
    expect(() => parseLauncherArgs(['--consumer=C:/x/other.js', '--mode=dry-run'])).toThrow()
  })
  it('derives the production target and never takes one, except a sentinel-namespace one for the demonstration', () => {
    const a = parseLauncherArgs(['--consumer=C:/b/d1-auditor-n13-consumer.js', '--mode=dry-run'])
    expect(a.target).toBe(d1AuditorWcmTarget())
    expect(() => parseLauncherArgs(['--consumer=C:/b/d1-auditor-n13-consumer.js', '--mode=dry-run', '--synthetic-target=OTHER'])).toThrow()
    expect(() =>
      parseLauncherArgs(['--consumer=C:/b/d1-auditor-n13-consumer.js', '--mode=execute', '--driver-root=C:/r', '--synthetic-target=UELLIX-N05-SENTINEL-X'])
    ).toThrow()
  })
  it('refuses any unknown argument', () => {
    expect(() => parseLauncherArgs(['--consumer=C:/b/d1-auditor-n13-consumer.js', '--mode=dry-run', STAGING])).toThrow(/not echoed/)
  })
})
