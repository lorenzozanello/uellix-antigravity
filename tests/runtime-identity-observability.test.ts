// tests/runtime-identity-observability.test.ts
//
// STELLA_STAGING_B — the adversarial battery for the runtime identity surface.
//
// ---------------------------------------------------------------------------
// WHAT WOULD MAKE THIS FILE WORTHLESS
// ---------------------------------------------------------------------------
// A suite that stubs `readRuntimeIdentity` and then asserts the endpoint
// reports what the stub returned proves that JSON serialisation works. The
// property under test is that the reported identity COMES FROM the row the
// server sent, so every case here drives the fake at the level of the SQL
// RESULT SET and lets the real `readRuntimeIdentity`, the real collectors and
// the real projection run over it. `provenance` (T16) is the test that makes
// that explicit: change the row, the answer changes; change the environment,
// the role answer does not.
//
// Nothing here opens a socket. The fake postgres-js handle records every
// statement it is given, which is also how "read only" is proven (T12) rather
// than asserted.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import {
  assertRuntimeIdentity,
  collectRuntimeIdentityFailures,
  RuntimeIdentityError,
  type RuntimeIdentity,
} from '@/db/runtime-bootstrap'
import { ensureRuntimeIdentityVerified } from '@/db/runtime-bootstrap'
import {
  gateSqlOnRuntimeIdentity,
  GATE_PERMITTED_MEMBERS,
  RuntimeGateRefusalError,
} from '@/db/runtime-gate'
import {
  collectRuntimeTargetFailures,
  resolveRuntimeTargetExpectation,
} from '@/db/runtime-provenance'
import {
  observeRuntimeIdentityReport,
  toRuntimeIdentityPayload,
  unobservableRuntimeIdentityPayload,
} from '@/db/runtime-identity-report'
import { RUNTIME_DATABASE_ROLE, OWNER_DATABASE_ROLE } from '@/db/safety/database-role'
import { runtimeProjectPinFor } from '@/db/safety/runtime-project-pins'
import type { EnvironmentSource } from '@/db/safety/database-target'
import { readSourceText } from './helpers/source-text'

/* -------------------------------------------------------------------------- */
/* The fake server                                                            */
/* -------------------------------------------------------------------------- */

/** The seven columns `readRuntimeIdentity` selects, as the server would send them. */
interface IdentityRow {
  session_user: string
  current_user: string
  is_superuser: boolean
  bypasses_rls: boolean
  can_create_role: boolean
  can_set_owner_role: boolean
  can_create_in_public: boolean
}

const CLEAN_IDENTITY_ROW: IdentityRow = {
  session_user: RUNTIME_DATABASE_ROLE,
  current_user: RUNTIME_DATABASE_ROLE,
  is_superuser: false,
  bypasses_rls: false,
  can_create_role: false,
  can_set_owner_role: false,
  can_create_in_public: false,
}

const STAGING_PROJECT_REF = runtimeProjectPinFor('staging') as string

interface SentinelPlan {
  present: boolean
  readable: boolean
  environment: string | null
  projectRef: string | null
}

const STAGING_SENTINEL: SentinelPlan = {
  present: true,
  readable: true,
  environment: 'staging',
  projectRef: STAGING_PROJECT_REF,
}

interface FakePlan {
  identityRow?: IdentityRow | null
  /** Reject the identity statement, as a dropped socket or a refused query would. */
  identityThrows?: boolean
  sentinel?: SentinelPlan
}

interface FakeServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any
  statements: string[]
}

/**
 * A postgres-js stand-in that answers the three statements this surface issues
 * and REFUSES anything else.
 *
 * Refusing the unknown statement is deliberate: a permissive fake that returns
 * `[]` for whatever it is asked would let a future edit send an extra query — a
 * write, say — and still go green.
 */
function fakeServer(plan: FakePlan = {}): FakeServer {
  const statements: string[] = []
  const sentinel = plan.sentinel ?? STAGING_SENTINEL
  const identityRow = plan.identityRow === undefined ? CLEAN_IDENTITY_ROW : plan.identityRow

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.raw.join(values.map(() => '?').join(''))
    statements.push(text.trim())

    // Ordered most specific first: the existence probe also names
    // `staging_sentinel`, in a `relname =` predicate.
    if (/has_table_privilege/.test(text)) {
      return Promise.resolve([
        { sentinel_present: sentinel.present, sentinel_readable: sentinel.readable },
      ])
    }
    if (/FROM uellix_bootstrap\.staging_sentinel/.test(text)) {
      return Promise.resolve([
        { environment: sentinel.environment, project_ref: sentinel.projectRef },
      ])
    }
    if (/pg_has_role/.test(text)) {
      if (plan.identityThrows) {
        return Promise.reject(
          Object.assign(new Error('connection to db.example.supabase.co:5432 refused'), {
            code: '28P01',
            address: 'db.example.supabase.co',
            port: 5432,
          })
        )
      }
      return Promise.resolve(identityRow === null ? [] : [identityRow])
    }
    return Promise.reject(new Error(`fake server received an unexpected statement: ${text}`))
  }

  const sql = Object.assign(tagged, {
    begin: (options: string, callback: (tx: unknown) => Promise<unknown>) => {
      statements.push(`BEGIN ${options}`)
      return callback(sql)
    },
  })

  return { sql, statements }
}

/** An identity built from the clean baseline with one property moved. */
function identityWith(override: Partial<RuntimeIdentity>): RuntimeIdentity {
  return {
    sessionUser: RUNTIME_DATABASE_ROLE,
    currentUser: RUNTIME_DATABASE_ROLE,
    isSuperuser: false,
    bypassesRls: false,
    canCreateRole: false,
    canSetOwnerRole: false,
    canCreateInPublic: false,
    ...override,
  }
}

const STAGING_ENV: EnvironmentSource = { UELLIX_APP_ENV: 'staging' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/* -------------------------------------------------------------------------- */
/* T1 — the happy path, end to end over the real readers                      */
/* -------------------------------------------------------------------------- */

describe('T1 — a least-privilege session on the pinned project verifies', () => {
  it('reports every property as observed and proves the project', async () => {
    const server = fakeServer()
    const report = await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    expect(report.identity).toEqual(identityWith({}))
    expect(report.identityFailures).toEqual([])
    expect(report.targetFailures).toEqual([])
    expect(report.verified).toBe(true)

    const payload = toRuntimeIdentityPayload(report)
    expect(payload.status).toBe('ok')
    expect(payload.runtime).toEqual({
      sessionUser: RUNTIME_DATABASE_ROLE,
      currentUser: RUNTIME_DATABASE_ROLE,
      isSuperuser: false,
      bypassesRls: false,
      canCreateRole: false,
      canSetOwnerRole: false,
      canCreateInPublic: false,
    })
    expect(payload.target.projectRefProven).toBe(true)
    expect(payload.failures).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* T2-T8 — every divergence fails closed, driven from the RESULT SET          */
/* -------------------------------------------------------------------------- */

describe('T2-T8 — a diverging server answer is never reported as healthy', () => {
  const CASES: Array<[string, Partial<IdentityRow>, string]> = [
    ['T2 current_user is not uellix_app', { current_user: 'postgres' }, 'DB_RUNTIME_IDENTITY_WRONG_ROLE'],
    ['T3 session_user is not uellix_app', { session_user: 'postgres' }, 'DB_RUNTIME_IDENTITY_WRONG_ROLE'],
    ['T4 rolbypassrls', { bypasses_rls: true }, 'DB_RUNTIME_IDENTITY_BYPASSRLS'],
    ['T5 rolsuper', { is_superuser: true }, 'DB_RUNTIME_IDENTITY_SUPERUSER'],
    ['T6 rolcreaterole', { can_create_role: true }, 'DB_RUNTIME_IDENTITY_CREATEROLE'],
    ['T7 can SET ROLE to the owner', { can_set_owner_role: true }, 'DB_RUNTIME_IDENTITY_CAN_SET_OWNER'],
    ['T8 CREATE on public', { can_create_in_public: true }, 'DB_RUNTIME_IDENTITY_CAN_CREATE_PUBLIC'],
  ]

  it.each(CASES)('%s', async (_label, override, expectedCode) => {
    const server = fakeServer({ identityRow: { ...CLEAN_IDENTITY_ROW, ...override } })
    const report = await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    expect(report.verified).toBe(false)
    expect(report.identityFailures).toContain(expectedCode)

    const payload = toRuntimeIdentityPayload(report)
    expect(payload.status).toBe('degraded')
    expect(payload.failures).toContain(expectedCode)
  })

  it('reports EVERY divergence, not just the first — that is why the endpoint exists', async () => {
    const server = fakeServer({
      identityRow: {
        ...CLEAN_IDENTITY_ROW,
        session_user: 'postgres',
        current_user: 'postgres',
        is_superuser: true,
        bypasses_rls: true,
      },
    })
    const report = await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    // The startup gate would stop at WRONG_ROLE. An operator reading a health
    // surface needs to know the role ALSO bypasses RLS.
    expect(report.identityFailures).toEqual([
      'DB_RUNTIME_IDENTITY_WRONG_ROLE',
      'DB_RUNTIME_IDENTITY_SUPERUSER',
      'DB_RUNTIME_IDENTITY_BYPASSRLS',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* Canonicalization — one rule table, two readers                             */
/* -------------------------------------------------------------------------- */

describe('the reporting collector and the throwing gate are the same judgement', () => {
  const MUTATIONS: Array<Partial<RuntimeIdentity>> = [
    {},
    { sessionUser: 'postgres' },
    { currentUser: OWNER_DATABASE_ROLE },
    { isSuperuser: true },
    { bypassesRls: true },
    { canCreateRole: true },
    { canSetOwnerRole: true },
    { canCreateInPublic: true },
    { bypassesRls: true, canCreateRole: true, canCreateInPublic: true },
  ]

  it.each(MUTATIONS.map((mutation) => [JSON.stringify(mutation), mutation] as const))(
    'agrees on %s',
    (_label, mutation) => {
      const identity = identityWith(mutation)
      const failures = collectRuntimeIdentityFailures(identity)

      let thrownCode: string | null = null
      try {
        assertRuntimeIdentity(identity)
      } catch (error) {
        if (!(error instanceof RuntimeIdentityError)) throw error
        thrownCode = error.code
      }

      // Empty collection <=> the gate accepts. A drift in either direction
      // means the endpoint could report `verified` on a session the runtime
      // refuses, or the reverse.
      expect(failures.length === 0).toBe(thrownCode === null)
      if (thrownCode !== null) {
        // The gate throws the FIRST failure; the collector lists all of them in
        // the same order.
        expect(failures[0]).toBe(thrownCode)
      }
    }
  )
})

/* -------------------------------------------------------------------------- */
/* T9 / T13 — the project half                                                */
/* -------------------------------------------------------------------------- */

describe('T9 — a project the database does not confirm is never proven', () => {
  it('refuses a sentinel naming another project', async () => {
    const server = fakeServer({
      sentinel: { ...STAGING_SENTINEL, projectRef: 'aaaaaaaaaaaaaaaaaaaa' },
    })
    const report = await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    expect(report.targetFailures).toContain('DB_RUNTIME_TARGET_PROJECT_MISMATCH')
    expect(report.verified).toBe(false)
    expect(toRuntimeIdentityPayload(report).target.projectRefProven).toBe(false)
  })

  it('refuses a database that carries no sentinel at all', async () => {
    const server = fakeServer({
      sentinel: { present: false, readable: false, environment: null, projectRef: null },
    })
    const report = await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    expect(report.targetFailures).toEqual(['DB_RUNTIME_TARGET_SENTINEL_ABSENT'])
    expect(report.verified).toBe(false)
  })

  it('refuses a sentinel this role cannot read — silence is not agreement', async () => {
    const server = fakeServer({
      sentinel: { present: true, readable: false, environment: null, projectRef: null },
    })
    const report = await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    expect(report.targetFailures).toEqual(['DB_RUNTIME_TARGET_SENTINEL_UNREADABLE'])
  })

  it('refuses an environment that pins no project — "unknown" is a failure, not a pass', () => {
    const expectation = resolveRuntimeTargetExpectation({ UELLIX_APP_ENV: 'development' })
    expect(expectation.pinnedProjectRef).toBeNull()
    expect(collectRuntimeTargetFailures(
      { sentinelPresent: true, sentinelReadable: true, environment: 'staging', projectRef: STAGING_PROJECT_REF },
      expectation
    )).toContain('DB_RUNTIME_TARGET_ENVIRONMENT_NOT_PINNED')
  })
})

describe('T13 — an environment variable cannot manufacture a pass', () => {
  it('cannot make a wrong SESSION verify, whatever it declares', async () => {
    for (const declared of ['staging', 'production', 'development', 'not-an-environment']) {
      const server = fakeServer({
        identityRow: { ...CLEAN_IDENTITY_ROW, session_user: 'postgres', current_user: 'postgres' },
      })
      const report = await observeRuntimeIdentityReport(server.sql, {
        env: { UELLIX_APP_ENV: declared } satisfies EnvironmentSource,
      })
      expect(report.verified, `UELLIX_APP_ENV=${declared}`).toBe(false)
      expect(report.identityFailures).toContain('DB_RUNTIME_IDENTITY_WRONG_ROLE')
    }
  })

  it('declaring the OTHER environment does not relabel the database — it contradicts it', async () => {
    // Staging's database, a process claiming to be production. The expected pin
    // moves; the observed sentinel does not. Both halves disagree, and the
    // disagreement is the finding.
    const server = fakeServer()
    const report = await observeRuntimeIdentityReport(server.sql, {
      env: { UELLIX_APP_ENV: 'production' } satisfies EnvironmentSource,
    })

    expect(report.targetFailures).toEqual([
      'DB_RUNTIME_TARGET_ENVIRONMENT_MISMATCH',
      'DB_RUNTIME_TARGET_PROJECT_MISMATCH',
    ])
    expect(report.verified).toBe(false)
  })

  it('the ROLE half reads nothing from the environment at all', async () => {
    // Same result set, four declarations, one answer. If the role verdict could
    // be moved by configuration it would move here.
    const verdicts = await Promise.all(
      ['staging', 'production', 'ci', 'test'].map(async (declared) => {
        const report = await observeRuntimeIdentityReport(fakeServer().sql, {
          env: { UELLIX_APP_ENV: declared } satisfies EnvironmentSource,
        })
        return JSON.stringify(report.identity)
      })
    )
    expect(new Set(verdicts).size).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* T16 — provenance: the answer moves with the ROW                            */
/* -------------------------------------------------------------------------- */

describe('T16 — the reported identity comes from the query result, not from anywhere else', () => {
  it('a different result set produces a different identity', async () => {
    const a = await observeRuntimeIdentityReport(fakeServer().sql, { env: STAGING_ENV })
    const b = await observeRuntimeIdentityReport(
      fakeServer({ identityRow: { ...CLEAN_IDENTITY_ROW, current_user: 'uellix_auditor' } }).sql,
      { env: STAGING_ENV }
    )

    expect(a.identity.currentUser).toBe(RUNTIME_DATABASE_ROLE)
    expect(b.identity.currentUser).toBe('uellix_auditor')
    expect(a.verified).toBe(true)
    expect(b.verified).toBe(false)
  })

  it('every reported field is one the SERVER sent — nothing is defaulted in', async () => {
    // A projection that filled a missing column with `false` would report a
    // clean deployment on a server that answered nothing at all.
    const server = fakeServer({
      identityRow: {
        session_user: 'r1',
        current_user: 'r2',
        is_superuser: true,
        bypasses_rls: true,
        can_create_role: true,
        can_set_owner_role: true,
        can_create_in_public: true,
      },
    })
    const payload = toRuntimeIdentityPayload(
      await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })
    )
    expect(payload.runtime).toEqual({
      sessionUser: 'r1',
      currentUser: 'r2',
      isSuperuser: true,
      bypassesRls: true,
      canCreateRole: true,
      canSetOwnerRole: true,
      canCreateInPublic: true,
    })
  })

  it('no row at all is UNVERIFIABLE, never a clean answer', async () => {
    const server = fakeServer({ identityRow: null })
    await expect(observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })).rejects.toThrow(
      RuntimeIdentityError
    )
  })
})

/* -------------------------------------------------------------------------- */
/* T12 — strictly read-only, proven from the statements issued                */
/* -------------------------------------------------------------------------- */

describe('T12 — the observation cannot write', () => {
  it('opens a READ ONLY transaction and issues only SELECTs inside it', async () => {
    const server = fakeServer()
    await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    expect(server.statements[0]).toBe('BEGIN read only')
    for (const statement of server.statements.slice(1)) {
      expect(statement.startsWith('SELECT'), statement).toBe(true)
    }
  })

  it('names no mutating verb anywhere in what it sends', async () => {
    const server = fakeServer()
    await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    const sent = server.statements.join('\n')
    // CREATE, DROP and ALTER are checked by the statement-start assertion
    // above, not here: `'CREATE'` is a PRIVILEGE NAME inside
    // `has_schema_privilege(session_user, 'public', 'CREATE')`, and banning the
    // token anywhere would ban the very check that proves the runtime role
    // cannot create in public.
    for (const verb of [
      /\bINSERT\b/i, /\bUPDATE\s/i, /\bDELETE\b/i, /\bTRUNCATE\b/i,
      /\bGRANT\b/i, /\bREVOKE\b/i, /\bset_config\b/, /\bFOR\s+UPDATE\b/i,
    ]) {
      expect(verb.test(sent), `${verb} appears in the statements sent`).toBe(false)
    }
  })

  it('every statement is a SELECT — a DDL or DML verb could not open one', async () => {
    const server = fakeServer()
    await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })

    const nonSelect = server.statements
      .filter((statement) => statement !== 'BEGIN read only')
      .filter((statement) => !/^SELECT\b/.test(statement))
    expect(nonSelect).toEqual([])
  })

  it('the read-only flag is not merely documentation — it is the FIRST thing sent', async () => {
    const server = fakeServer()
    await observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })
    // A `SET TRANSACTION READ ONLY` issued after a statement would arrive too
    // late to constrain it. `BEGIN read only` cannot.
    expect(server.statements.indexOf('BEGIN read only')).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* T17 — an unobservable session is never healthy                             */
/* -------------------------------------------------------------------------- */

describe('T17 — a failed observation degrades, and carries nothing out with it', () => {
  it('propagates the failure rather than returning a report', async () => {
    const server = fakeServer({ identityThrows: true })
    await expect(observeRuntimeIdentityReport(server.sql, { env: STAGING_ENV })).rejects.toThrow()
  })

  it('the payload for an unobservable session asserts nothing', () => {
    const payload = unobservableRuntimeIdentityPayload('2026-08-17T00:00:00.000Z')
    expect(payload).toEqual({
      status: 'degraded',
      verified: false,
      runtime: null,
      target: { projectRefProven: false },
      failures: ['DB_RUNTIME_IDENTITY_UNOBSERVABLE'],
      observedAt: '2026-08-17T00:00:00.000Z',
    })
  })
})

/* -------------------------------------------------------------------------- */
/* T15 — one certification never vouches for another handle                   */
/* -------------------------------------------------------------------------- */

describe('T15 — the certification is per handle', () => {
  it('a second connection is verified on its own, not on the first one credit', async () => {
    const first = fakeServer()
    const second = fakeServer({
      identityRow: { ...CLEAN_IDENTITY_ROW, session_user: 'postgres', current_user: 'postgres' },
    })

    await expect(ensureRuntimeIdentityVerified(first.sql)).resolves.toMatchObject({
      currentUser: RUNTIME_DATABASE_ROLE,
    })
    await expect(ensureRuntimeIdentityVerified(second.sql)).rejects.toBeInstanceOf(
      RuntimeIdentityError
    )
    // The second handle really was asked; it did not inherit an answer.
    expect(second.statements.some((statement) => /pg_has_role/.test(statement))).toBe(true)
  })

  it('memoises per handle so a verified pool is asked once', async () => {
    const server = fakeServer()
    await ensureRuntimeIdentityVerified(server.sql)
    await ensureRuntimeIdentityVerified(server.sql)
    expect(server.statements.filter((statement) => /pg_has_role/.test(statement))).toHaveLength(1)
  })

  it('does NOT memoise a rejection — a dropped socket must be retryable', async () => {
    let attempts = 0
    const flaky = Object.assign(
      (strings: TemplateStringsArray): Promise<unknown[]> => {
        void strings
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('socket closed'))
          : Promise.resolve([CLEAN_IDENTITY_ROW])
      },
      { begin: () => Promise.resolve() }
    )

    await expect(ensureRuntimeIdentityVerified(flaky as never)).rejects.toThrow()
    await expect(ensureRuntimeIdentityVerified(flaky as never)).resolves.toMatchObject({
      currentUser: RUNTIME_DATABASE_ROLE,
    })
    expect(attempts).toBe(2)
  })
})

/* -------------------------------------------------------------------------- */
/* T14 — the db/client.ts fallback is governed                                */
/* -------------------------------------------------------------------------- */

describe('T14 — no runtime query reaches the driver before the identity is certified', () => {
  /** A handle that records dispatches and lets the test control when they resolve. */
  function instrumentedHandle(identityRow: IdentityRow | 'defer') {
    const dispatched: string[] = []
    let releaseIdentity: (() => void) | null = null

    const tagged = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const text = strings.raw.join('')
      dispatched.push(text.trim())
      if (identityRow === 'defer') {
        return new Promise((resolve) => {
          releaseIdentity = () => resolve([CLEAN_IDENTITY_ROW])
        })
      }
      return Promise.resolve([identityRow])
    }

    const handle = Object.assign(tagged, {
      unsafe: (query: string) => {
        dispatched.push(`UNSAFE ${query}`)
        return Object.assign(Promise.resolve([{ ok: true }]), {
          values: () => Promise.resolve([[true]]),
        })
      },
      begin: (...args: unknown[]) => {
        dispatched.push('BEGIN')
        void args
        return Promise.resolve('begun')
      },
    })

    return { handle, dispatched, release: () => releaseIdentity?.() }
  }

  it('holds the statement until certification resolves', async () => {
    const { handle, dispatched, release } = instrumentedHandle('defer')
    const gated = gateSqlOnRuntimeIdentity(handle as never)

    // Awaiting is what starts the gate — the deferred builds no statement until
    // it is settled, which is the ordering guarantee itself.
    let settled = false
    const pending = Promise.resolve(gated.unsafe('SELECT * FROM projects')).then(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    // The certification query is out; the business statement is NOT.
    expect(dispatched.some((entry) => entry.startsWith('UNSAFE'))).toBe(false)
    expect(settled).toBe(false)

    release()
    await pending
    expect(dispatched).toContain('UNSAFE SELECT * FROM projects')
  })

  it('rejects the statement — and never dispatches it — when the identity is wrong', async () => {
    const { handle, dispatched } = instrumentedHandle({
      ...CLEAN_IDENTITY_ROW,
      session_user: 'postgres',
      current_user: 'postgres',
      bypasses_rls: true,
    })
    const gated = gateSqlOnRuntimeIdentity(handle as never)

    await expect(gated.unsafe('SELECT * FROM projects')).rejects.toBeInstanceOf(RuntimeIdentityError)
    expect(dispatched.some((entry) => entry.startsWith('UNSAFE'))).toBe(false)
  })

  it('gates transactions and the tagged-template form too', async () => {
    const wrong: IdentityRow = { ...CLEAN_IDENTITY_ROW, current_user: 'postgres' }

    const tx = instrumentedHandle(wrong)
    await expect(
      gateSqlOnRuntimeIdentity(tx.handle as never).begin(async () => undefined)
    ).rejects.toBeInstanceOf(RuntimeIdentityError)
    expect(tx.dispatched).not.toContain('BEGIN')

    const tpl = instrumentedHandle(wrong)
    const gatedTpl = gateSqlOnRuntimeIdentity(tpl.handle as never)
    await expect((gatedTpl as unknown as (s: TemplateStringsArray) => Promise<unknown>)`SELECT 1`)
      .rejects.toBeInstanceOf(RuntimeIdentityError)
  })

  it('sends the statement exactly once even when awaited more than once', async () => {
    const { handle, dispatched } = instrumentedHandle(CLEAN_IDENTITY_ROW)
    const gated = gateSqlOnRuntimeIdentity(handle as never)

    const query = gated.unsafe('SELECT 1')
    await query
    await query
    expect(dispatched.filter((entry) => entry.startsWith('UNSAFE'))).toHaveLength(1)
  })

  it('db/client.ts routes the out-of-context fallback through the gate', () => {
    const source = readSourceText('db/client.ts')
    // The structural half of this test: the behavioural proofs above are about
    // `gateSqlOnRuntimeIdentity`, and they are only load-bearing if the proxy
    // actually uses it. A silent revert to `getDefaultClient().db` would leave
    // every assertion above passing over an unreachable function.
    //
    // Anchored on the FALLBACK EXPRESSION rather than on the file as a whole,
    // so a doc comment that quotes the old shape cannot satisfy or break it.
    expect(source).toContain('bound?.db ?? getGatedFallbackDatabase()')
    expect(source).toContain('gateSqlOnRuntimeIdentity(getDefaultClient().sql)')
    expect(source).not.toMatch(/bound\?\.db \?\? getDefaultClient\(\)\.db/)
  })
})

/* -------------------------------------------------------------------------- */
/* B-MINOR-02 — deny-by-default over the postgres-js surface                   */
/* -------------------------------------------------------------------------- */
//
// The first version of the gate was a Proxy that fell through to the raw handle
// for everything it did not intercept, which left every OTHER postgres-js
// capability ungated. These are the negative controls that stop it from
// becoming a passthrough again: each one names a capability that can drive the
// connection, and each one must fail closed through the gated handle while
// still existing on the raw one.

/** The members of a real postgres-js client that can drive the connection. */
const POSTGRES_JS_CAPABILITIES = [
  'reserve',
  'file',
  'listen',
  'notify',
  'subscribe',
  'largeObject',
  'close',
  'end',
] as const

/**
 * A stand-in shaped like postgres@3.4.9's `sql`: callable, with the same member
 * set (postgres/src/index.js lines 69-82 and 94-102), and recording every
 * dispatch so a leak is visible rather than inferred.
 */
function postgresJsLikeHandle(identityRow: IdentityRow = CLEAN_IDENTITY_ROW) {
  const dispatched: string[] = []

  const pending = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), {
      values: () => Promise.resolve(rows.map((row) => Object.values(row as object))),
    })

  const scoped = (depth: number) =>
    Object.assign(
      (strings: TemplateStringsArray) => {
        dispatched.push(`scoped#${depth} tagged ${strings.raw.join('').trim()}`)
        return Promise.resolve([])
      },
      {
        unsafe: (query: string) => {
          dispatched.push(`scoped#${depth} unsafe ${query}`)
          return pending([{ one: 1 }])
        },
        // Only the SCOPED handle carries it — see db/runtime-gate.ts, member 4.
        savepoint: (fn: (sql: unknown) => unknown) => {
          dispatched.push(`scoped#${depth} savepoint`)
          return Promise.resolve(fn(scoped(depth + 1)))
        },
      }
    )

  const tagged = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.raw.join('').trim()
    dispatched.push(`tagged ${text}`)
    return /pg_has_role/.test(text) ? Promise.resolve([identityRow]) : Promise.resolve([])
  }

  const capabilities = Object.fromEntries(
    POSTGRES_JS_CAPABILITIES.map((name) => [
      name,
      () => {
        dispatched.push(`RAW ${name}`)
        return 'raw-capability-result'
      },
    ])
  )

  const handle = Object.assign(tagged, capabilities, {
    unsafe: (query: string) => {
      dispatched.push(`unsafe ${query}`)
      return pending([{ one: 1 }])
    },
    begin: (...args: unknown[]) => {
      const callback = (typeof args[0] === 'function' ? args[0] : args[1]) as (
        sql: unknown
      ) => unknown
      dispatched.push('begin')
      return Promise.resolve(callback(scoped(0)))
    },
    options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
    // Non-executable members a real handle also carries.
    CLOSE: {},
    END: {},
    PostgresError: class PostgresError extends Error {},
    // A capability postgres-js does not have today. Deny-by-default is derived
    // from the handle, so this must be refused WITHOUT anyone listing it.
    futureCapability: () => {
      dispatched.push('RAW futureCapability')
      return 'raw'
    },
  })

  return { handle, dispatched }
}

describe('B-MINOR-02 — the gated handle is deny-by-default', () => {
  it.each(POSTGRES_JS_CAPABILITIES.map((name) => [name] as const))(
    '%s cannot be executed through the gate, and never reaches the raw handle',
    (name) => {
      const { handle, dispatched } = postgresJsLikeHandle()
      const gated = gateSqlOnRuntimeIdentity(handle as never) as unknown as Record<
        string,
        () => unknown
      >

      // It exists on the raw handle — otherwise this control proves nothing.
      expect(typeof (handle as unknown as Record<string, unknown>)[name]).toBe('function')

      expect(() => gated[name]()).toThrow(RuntimeGateRefusalError)
      expect(dispatched).not.toContain(`RAW ${name}`)
      // And it is not the raw function wearing a different name.
      expect(gated[name]).not.toBe((handle as unknown as Record<string, unknown>)[name])
    }
  )

  it('an executable member the gate has never heard of is refused, not forwarded', () => {
    const { handle, dispatched } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never) as unknown as Record<
      string,
      () => unknown
    >

    // Nothing in db/runtime-gate.ts names `futureCapability`. The refusal is
    // DERIVED from the handle, so a capability a future postgres-js release adds
    // lands as a refusal rather than as a hole.
    expect(() => gated.futureCapability()).toThrow(RuntimeGateRefusalError)
    expect(dispatched).not.toContain('RAW futureCapability')
  })

  it('a member that does not exist at all yields nothing to call', () => {
    const { handle } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never) as unknown as Record<string, unknown>
    expect(gated.somethingNobodyDefined).toBeUndefined()
  })

  it('non-executable members of the raw handle are ABSENT, not forwarded', () => {
    const { handle } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never) as unknown as Record<string, unknown>

    expect(gated.CLOSE).toBeUndefined()
    expect(gated.END).toBeUndefined()
    expect((handle as unknown as Record<string, unknown>).CLOSE).toBeDefined()
  })

  it('exposes exactly the permitted surface and no route back to the raw handle', () => {
    const { handle } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never) as unknown as Record<string, unknown>

    // `options` is the ONE by-reference member, because drizzle mutates it.
    expect(gated.options).toBe((handle as unknown as Record<string, unknown>).options)

    // No member hands back the raw callable. This is the `$client` equivalent
    // the hardening was asked to keep closed.
    const leaks = Object.keys(gated).filter(
      (key) => (gated[key] as unknown) === (handle as unknown)
    )
    expect(leaks).toEqual([])
    expect(gated.raw ?? gated.client ?? gated.$client ?? gated.sql).toBeUndefined()
  })

  it('THE INVARIANT: every permitted member is either intercepted or `options`', () => {
    // A regression that re-adds a passthrough branch would show up here as a
    // member that is neither of the two gated functions nor the options object.
    expect([...GATE_PERMITTED_MEMBERS].sort()).toEqual(['begin', 'options', 'unsafe'])

    const { handle } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never) as unknown as Record<string, unknown>
    const rawHandle = handle as unknown as Record<string, unknown>

    for (const member of ['unsafe', 'begin']) {
      expect(typeof gated[member]).toBe('function')
      expect(gated[member], `${member} is the RAW function`).not.toBe(rawHandle[member])
    }
  })

  it('a Proxy-style descriptor read cannot recover a raw capability either', () => {
    // The reason this is an object and not a Proxy: a `get` trap does not cover
    // `getOwnPropertyDescriptor`, so a proxy would have handed the raw function
    // back through this exact call.
    const { handle } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never)

    const descriptor = Object.getOwnPropertyDescriptor(gated, 'reserve')
    expect(descriptor?.value).not.toBe((handle as unknown as Record<string, unknown>).reserve)
    expect(() => (descriptor?.value as () => unknown)()).toThrow(RuntimeGateRefusalError)
  })
})

describe('B-MINOR-02 — drizzle still works through the gated handle', () => {
  it('drizzle() can construct over it and install its type handlers', () => {
    const { handle } = postgresJsLikeHandle()
    const gated = gateSqlOnRuntimeIdentity(handle as never)

    drizzle(gated)

    // driver.cjs `construct()` writes into options.parsers/serializers. If
    // `options` were a copy, these writes would land nowhere and value decoding
    // would silently change.
    expect(Object.keys(handle.options.parsers)).toContain('1184')
    expect(Object.keys(handle.options.serializers)).toContain('114')
  })

  it('an ordinary query still runs, after certification', async () => {
    const { handle, dispatched } = postgresJsLikeHandle()
    const db = drizzle(gateSqlOnRuntimeIdentity(handle as never))

    await db.execute(drizzleSql`select 1`)

    const identityAt = dispatched.findIndex((entry) => /pg_has_role/.test(entry))
    const queryAt = dispatched.findIndex((entry) => entry.startsWith('unsafe select 1'))
    expect(identityAt).toBeGreaterThanOrEqual(0)
    expect(queryAt).toBeGreaterThanOrEqual(0)
    // Ordering, not timing: certification is dispatched BEFORE the statement.
    expect(identityAt).toBeLessThan(queryAt)
  })

  it('a transaction still runs', async () => {
    const { handle, dispatched } = postgresJsLikeHandle()
    const db = drizzle(gateSqlOnRuntimeIdentity(handle as never))

    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`select 1`)
    })

    expect(dispatched).toContain('begin')
    expect(dispatched).toContain('scoped#0 unsafe select 1')
  })

  it('a NESTED transaction still runs, through the scoped handle savepoint', async () => {
    const { handle, dispatched } = postgresJsLikeHandle()
    const db = drizzle(gateSqlOnRuntimeIdentity(handle as never))

    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.execute(drizzleSql`select 2`)
      })
    })

    // This is the B-MINOR-01 point, executed rather than argued: `savepoint` is
    // reached on the handle postgres-js scoped inside `begin`, never on the
    // top-level gate — which is why the gate does not implement it.
    expect(dispatched).toContain('scoped#0 savepoint')
    expect(dispatched).toContain('scoped#1 unsafe select 2')
    expect(
      Object.getOwnPropertyDescriptor(gateSqlOnRuntimeIdentity(handle as never), 'savepoint')
    ).toBeUndefined()
  })

  it('a wrong identity stops every drizzle path before a statement is dispatched', async () => {
    const wrong: IdentityRow = { ...CLEAN_IDENTITY_ROW, current_user: 'postgres', bypasses_rls: true }

    // drizzle re-throws a driver failure as `DrizzleQueryError` with the original
    // on `cause` (drizzle-orm/errors.cjs), so the refusal is asserted on the ROOT
    // of the chain — otherwise this would pass for any error at all.
    const rootCause = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run()
      } catch (error) {
        let current: unknown = error
        while (current instanceof Error && current.cause !== undefined) current = current.cause
        return current
      }
      throw new Error('expected a rejection')
    }

    const query = postgresJsLikeHandle(wrong)
    const queryDb = drizzle(gateSqlOnRuntimeIdentity(query.handle as never))
    expect(await rootCause(() => queryDb.execute(drizzleSql`select 1`))).toBeInstanceOf(
      RuntimeIdentityError
    )
    expect(query.dispatched.some((entry) => entry.startsWith('unsafe'))).toBe(false)

    const transaction = postgresJsLikeHandle(wrong)
    const transactionDb = drizzle(gateSqlOnRuntimeIdentity(transaction.handle as never))
    expect(
      await rootCause(() => transactionDb.transaction(async (tx) => tx.execute(drizzleSql`select 1`)))
    ).toBeInstanceOf(RuntimeIdentityError)
    expect(transaction.dispatched).not.toContain('begin')
  })

  it('the certification is shared per handle across every gated wrapper over it', async () => {
    const { handle, dispatched } = postgresJsLikeHandle()
    const first = drizzle(gateSqlOnRuntimeIdentity(handle as never))
    const second = drizzle(gateSqlOnRuntimeIdentity(handle as never))

    await first.execute(drizzleSql`select 1`)
    await second.execute(drizzleSql`select 2`)

    // The memo is keyed by the RAW handle, so two wrappers over one pool ask
    // once — and, from T15, two different pools are never conflated.
    expect(dispatched.filter((entry) => /pg_has_role/.test(entry))).toHaveLength(1)
  })
})

describe('B-MINOR-02 — $client has no consumers in this repository', () => {
  it('no production module reaches the driver handle through drizzle $client', () => {
    const roots = ['app', 'lib', 'db', 'components', 'scripts']
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__') continue
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry) || entry.includes('.test.')) continue
        // Comments are stripped first: a module that DOCUMENTS why it does not
        // use `$client` — db/runtime-gate.ts does — is not a consumer, and a
        // check that counted it would have to be silenced, which is how a
        // control stops controlling anything.
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        if (/\$client\b/.test(code)) {
          offenders.push(path.relative(process.cwd(), full).split(path.sep).join('/'))
        }
      }
    }

    for (const root of roots) walk(path.join(process.cwd(), root))

    expect(
      offenders,
      'drizzle exposes the client it was built over as `db.$client`. For the gated fallback that ' +
        'is the gated handle, so this is not a hole today — but a consumer would be the first ' +
        'place a future refactor could hand out a raw handle instead. Decide deliberately.'
    ).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* T10 / T11 / T18 — the HTTP surface                                         */
/* -------------------------------------------------------------------------- */

const authResult = vi.hoisted(() => vi.fn())
const defaultClient = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/identity', () => ({ getVerifiedAuthIdentityResult: authResult }))
vi.mock('@/db/client', () => ({ getDefaultDatabaseClient: defaultClient }))

const SIGNED_IN = { identity: { userId: '11111111-2222-3333-4444-555555555555' }, failure: null }

describe('T10 / T18 — the surface is not anonymous', () => {
  it('refuses a request with no session, and tells it nothing', async () => {
    authResult.mockResolvedValue({ identity: null, failure: 'NO_SESSION' })
    defaultClient.mockImplementation(() => {
      throw new Error('the database must not be touched for an unauthenticated caller')
    })

    const { GET } = await import('@/app/api/health/runtime-identity/route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    // T18: no role names, no booleans, no failure codes — nothing that answers
    // the question the endpoint exists to answer.
    expect(JSON.stringify(body)).not.toContain(RUNTIME_DATABASE_ROLE)
    expect(body).not.toHaveProperty('runtime')
    expect(body).not.toHaveProperty('verified')
  })

  it.each([['SESSION_REJECTED', 401], ['MALFORMED_SUBJECT', 401], ['AUTH_UNAVAILABLE', 503]])(
    '%s answers %i without leaking the reason into the body',
    async (failure, status) => {
      authResult.mockResolvedValue({ identity: null, failure })
      const { GET } = await import('@/app/api/health/runtime-identity/route')
      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(status)
      expect(JSON.stringify(body)).not.toContain(failure)
    }
  )
})

describe('T11 — the payload carries only what was decided', () => {
  it('answers 200 and exactly the allowlisted shape for a healthy deployment', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    authResult.mockResolvedValue(SIGNED_IN)
    defaultClient.mockReturnValue({ sql: fakeServer().sql })

    const { GET } = await import('@/app/api/health/runtime-identity/route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual([
      'failures',
      'observedAt',
      'runtime',
      'status',
      'target',
      'verified',
    ])
    expect(Object.keys(body.runtime).sort()).toEqual([
      'bypassesRls',
      'canCreateInPublic',
      'canCreateRole',
      'canSetOwnerRole',
      'currentUser',
      'isSuperuser',
      'sessionUser',
    ])
    expect(Object.keys(body.target)).toEqual(['projectRefProven'])
  })

  it('contains no identifier, credential, infrastructure detail or driver text', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    authResult.mockResolvedValue(SIGNED_IN)
    // The failing server carries a host, a port and a SQLSTATE on the error.
    defaultClient.mockReturnValue({ sql: fakeServer({ identityThrows: true }).sql })

    const { GET } = await import('@/app/api/health/runtime-identity/route')
    const response = await GET()
    const serialised = JSON.stringify(await response.json())

    expect(response.status).toBe(503)
    for (const forbidden of [
      SIGNED_IN.identity.userId,           // caller identity
      STAGING_PROJECT_REF,                 // project ref
      'supabase.co',                       // host
      '5432',                              // port
      '28P01',                             // SQLSTATE
      'postgresql://',                     // DSN
      'password',
      'refused',                           // driver message text
      'SELECT',                            // SQL
      'staging_sentinel',
    ]) {
      expect(serialised, `payload leaked ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('answers 503 with the failure codes when the identity diverges', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    authResult.mockResolvedValue(SIGNED_IN)
    defaultClient.mockReturnValue({
      sql: fakeServer({ identityRow: { ...CLEAN_IDENTITY_ROW, bypasses_rls: true } }).sql,
    })

    const { GET } = await import('@/app/api/health/runtime-identity/route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.verified).toBe(false)
    expect(body.failures).toContain('DB_RUNTIME_IDENTITY_BYPASSRLS')
  })
})
