// tests/database-runtime-target-identity.test.ts
//
// SYS-02 — THE RUNTIME MAY ONLY REACH THE PROJECT IT WAS AIMED AT.
//
// ---------------------------------------------------------------------------
// THE HOLE THIS SUITE CLOSES
// ---------------------------------------------------------------------------
// `app_runtime` is the one capability that may reach a managed remote without a
// destructive token — it is the product itself serving traffic. Before this
// suite its policy asked four questions, and a Production connection string
// answered all four exactly as Staging's does:
//
//   * is the target classifiable?     yes — managed_remote
//   * is the kind allowed?            yes — app_runtime accepts managed_remote
//   * is the environment allowed?     yes — app_runtime accepted all five
//   * does the project ref match?     NEVER ASKED (requiresProjectId: false)
//
// The role is no help either: BOTH projects expose `uellix_app`, because the
// role model is deployed from the same migrations. So "connects as uellix_app
// to a Supabase database called postgres over TLS" is true of Production and
// true of Staging, and nothing downstream could tell them apart.
//
// The fix is POSITIVE IDENTITY, not a wider denylist: a hosted environment
// declares which Supabase project it is allowed to reach, the connection must
// STRUCTURALLY prove which project it names, and the two must be equal. An
// identity that cannot be proven is a refusal, not a pass.
//
// ---------------------------------------------------------------------------
// EVERYTHING HERE IS OFFLINE
// ---------------------------------------------------------------------------
// Classification and authorization never open a socket, and the two blocks that
// exercise db/client.ts mock `postgres` so that "was the driver called?" is an
// assertion rather than a network event. No test in this file resolves a
// hostname, and the passwords are placeholders.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyDatabaseTarget } from '@/db/safety/database-target'
import {
  assertDatabaseOperationAllowed,
  DatabaseSafetyError,
  resolveEnvironment,
  resolveEnvironmentDecision,
} from '@/db/safety/database-access'
import {
  runtimeProjectPinFor,
  RUNTIME_PROJECT_PINS,
} from '@/db/safety/runtime-project-pins'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
} from '@/db/hosted/target-identity'
import { LOCAL_DB_PORT } from '@/db/safety/local-stack'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

// The two project refs are PUBLIC identifiers — they appear in every URL the
// projects serve — and they are imported rather than retyped so that this suite
// can never drift from the registry it is meant to protect.
const STAGING_REF = KNOWN_STAGING_PROJECT_REF
const PRODUCTION_REF = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]

// Placeholder. Never dialled: every URL below is either refused by the guard or
// intercepted by the `postgres` mock.
const PW = 'not-a-real-password'

/** The runtime role — IDENTICAL on both projects. That is the whole point. */
const RUNTIME_ROLE = 'uellix_app'

const directUrl = (ref: string, user = RUNTIME_ROLE) =>
  `postgresql://${user}:${PW}@db.${ref}.supabase.co:5432/postgres`

const poolerUrl = (ref: string, port = 6543) =>
  `postgresql://postgres.${ref}:${PW}@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`

const LOCAL_RUNTIME_URL = `postgresql://${RUNTIME_ROLE}:${PW}@127.0.0.1:${LOCAL_DB_PORT}/postgres`

function capture(run: () => unknown): { code?: string; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof DatabaseSafetyError) return { code: error.code, message: error.message }
    return { message: (error as Error).message }
  }
  throw new Error('expected a refusal, but the operation was allowed')
}

/** `app_runtime` against `url`, with the environment stated explicitly. */
const runtime = (url: string, environment: 'development' | 'test' | 'ci' | 'staging' | 'production') =>
  assertDatabaseOperationAllowed({ url, capability: 'app_runtime', environment, env: {} })

/* -------------------------------------------------------------------------- */
/* 1. The pin registry — one source of truth, and not reversed                 */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — the runtime project pins', () => {
  it('pins staging and production to the refs the hosted registry already records', () => {
    // Not a second registry: these come FROM db/hosted/target-identity.ts, which
    // is where the operator-facing chain already reads them. Two registries that
    // can disagree are worse than none, because the disagreement is invisible.
    expect(runtimeProjectPinFor('staging')).toBe(STAGING_REF)
    expect(runtimeProjectPinFor('production')).toBe(PRODUCTION_REF)
  })

  it('has NOT swapped the two — staging is not production and production is not staging', () => {
    // The single mistake that would turn this whole feature into an outage AND a
    // hole at once. Asserted explicitly because reviewing a 20-character ref by
    // eye is exactly how it would survive review.
    expect(runtimeProjectPinFor('staging')).not.toBe(PRODUCTION_REF)
    expect(runtimeProjectPinFor('production')).not.toBe(STAGING_REF)
    expect(STAGING_REF).not.toBe(PRODUCTION_REF)
  })

  it('pins NO hosted project for development, test or ci', () => {
    // Absence is the contract, not an oversight: these environments have no
    // hosted project, so "no pin" must mean "no managed remote", never
    // "any managed remote".
    for (const environment of ['development', 'test', 'ci']) {
      expect(runtimeProjectPinFor(environment)).toBeNull()
    }
  })

  it('returns null for an environment nobody declared', () => {
    expect(runtimeProjectPinFor('staging-ish')).toBeNull()
    expect(runtimeProjectPinFor('')).toBeNull()
  })

  it('exposes the staging pin without putting it in the production veto', () => {
    // Putting the target in its own denylist would refuse every staging
    // connection forever; the hosted module already asserts this and the runtime
    // pin must not reintroduce it from the other side.
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain(STAGING_REF)
    expect(Object.values(RUNTIME_PROJECT_PINS)).toContain(STAGING_REF)
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Structural identity derivation — what the CONNECTION proves              */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — provenIdentity is derived structurally, never by substring', () => {
  it('proves the project from a direct db.<ref>.supabase.co host', () => {
    const identity = classifyDatabaseTarget(directUrl(STAGING_REF)).provenIdentity
    expect(identity.proven).toBe(true)
    expect(identity.proven && identity.projectRef).toBe(STAGING_REF)
    expect(identity.proven && identity.mechanism).toBe('direct-db')
  })

  it('proves the project from a session-pooler login role', () => {
    // The shared pooler host is REGIONAL — every project in us-east-2 presents
    // it — so the host proves nothing and the login role is the routing key.
    const identity = classifyDatabaseTarget(poolerUrl(STAGING_REF)).provenIdentity
    expect(identity.proven).toBe(true)
    expect(identity.proven && identity.projectRef).toBe(STAGING_REF)
    expect(identity.proven && identity.mechanism).toBe('session-pooler')
  })

  it('proves the project from the Supavisor reference parameter', () => {
    // The third supported form: `?options=reference%3D<ref>`, which is what the
    // pooler itself routes by when the login role is plain `postgres`.
    const url =
      `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres` +
      `?options=reference%3D${STAGING_REF}`
    const identity = classifyDatabaseTarget(url).provenIdentity
    expect(identity.proven).toBe(true)
    expect(identity.proven && identity.projectRef).toBe(STAGING_REF)
  })

  it('refuses a pooler host that names no project at all', () => {
    // Case 5 of the brief: an opaque hosted target. No login-role ref, no
    // reference parameter — nothing to compare, so nothing is proven.
    const url = `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`
    expect(classifyDatabaseTarget(url).provenIdentity.proven).toBe(false)
  })

  it('refuses a lookalike domain that merely CONTAINS the staging ref', () => {
    // `url.includes('<ref>')` would have accepted this. Structural parsing reads
    // the registrable suffix, so an attacker-controlled parent domain fails.
    const url = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.supabase.co.attacker.example:5432/postgres`
    const target = classifyDatabaseTarget(url)
    expect(target.kind).toBe('managed_remote')
    expect(target.provenIdentity.proven).toBe(false)
  })

  it('refuses an extra label between the ref and the suffix', () => {
    // `db.<ref>.<anything>.supabase.co` is Supabase-controlled but does NOT name
    // the project the way `db.<ref>.supabase.co` does. Accepting it would
    // degrade the one signal this check exists to provide.
    const url = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.x.supabase.co:5432/postgres`
    expect(classifyDatabaseTarget(url).provenIdentity.proven).toBe(false)
  })

  it('does not read identity out of the password, the path or an unrelated query key', () => {
    // Every one of these embeds the PRODUCTION ref somewhere the driver does not
    // route by. None of them may make the target "prove" production — and, more
    // importantly, none may make a staging-pinned check pass or fail on them.
    const inPassword = `postgresql://${RUNTIME_ROLE}:${PRODUCTION_REF}@db.${STAGING_REF}.supabase.co:5432/postgres`
    const inPath = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.supabase.co:5432/${PRODUCTION_REF}`
    const inQuery = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.supabase.co:5432/postgres?application_name=${PRODUCTION_REF}`

    for (const url of [inPassword, inPath, inQuery]) {
      const identity = classifyDatabaseTarget(url).provenIdentity
      expect(identity.proven).toBe(true)
      expect(identity.proven && identity.projectRef).toBe(STAGING_REF)
    }
  })

  it('refuses a DUPLICATED reference parameter — the driver reads the last, we read the first', () => {
    // ADVERSARIAL REVIEW OF THIS VERY CHANGE. postgres-js builds its query map
    // with `[...url.searchParams].reduce((a,[b,c]) => (a[b]=c, a), {})`
    // (src/index.js `parseOptions`, postgres@3.4.9), so a REPEATED key resolves
    // to the LAST value — while `URLSearchParams.get()` returns the FIRST.
    //
    //   ?options=reference%3D<staging>&options=reference%3D<production>
    //     guard  -> staging     (pin matches, allowed)
    //     driver -> production  (routes to production)
    //
    // Exactly the divergence class `hasAmbiguousAuthority` already refuses for
    // multihost lists, arriving through the query string instead. An ambiguous
    // parameter is refused outright rather than emulated: no legitimate
    // connection string in this repository repeats `options`.
    const url =
      `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres` +
      `?options=reference%3D${STAGING_REF}&options=reference%3D${PRODUCTION_REF}`
    expect(classifyDatabaseTarget(url).provenIdentity.proven).toBe(false)
    expect(capture(() => runtime(url, 'staging')).code).toBe('DB_RUNTIME_PROJECT_UNPINNED')
  })

  it('refuses a duplicated reference parameter even when both copies agree', () => {
    // Agreement today is not agreement after the next driver release. The
    // refusal is about the AMBIGUITY, not about the values.
    const url =
      `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres` +
      `?options=reference%3D${STAGING_REF}&options=reference%3D${STAGING_REF}`
    expect(classifyDatabaseTarget(url).provenIdentity.proven).toBe(false)
  })

  it('refuses two identity sources that disagree instead of preferring one', () => {
    // A direct staging host with a production login role. Silently preferring
    // either source is how a contradiction becomes a pass.
    const url = `postgresql://postgres.${PRODUCTION_REF}:${PW}@db.${STAGING_REF}.supabase.co:5432/postgres`
    expect(classifyDatabaseTarget(url).provenIdentity.proven).toBe(false)
  })

  it('reads a percent-encoded login role the way the driver will', () => {
    // postgres-js decodes the userinfo, so a guard that does not would classify
    // a different identity than the one the connection authenticates with.
    const url = `postgresql://postgres%2E${PRODUCTION_REF}:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`
    const identity = classifyDatabaseTarget(url).provenIdentity
    expect(identity.proven).toBe(true)
    expect(identity.proven && identity.projectRef).toBe(PRODUCTION_REF)
  })

  it('resolves host casing deterministically', () => {
    const upper = `postgresql://${RUNTIME_ROLE}:${PW}@DB.${STAGING_REF.toUpperCase()}.SUPABASE.CO:5432/postgres`
    const identity = classifyDatabaseTarget(upper).provenIdentity
    expect(identity.proven).toBe(true)
    expect(identity.proven && identity.projectRef).toBe(STAGING_REF)
  })

  it('treats a single trailing dot as the same name and anything stranger as unproven', () => {
    // `db.<ref>.supabase.co.` is the fully-qualified form of the SAME host and
    // resolves identically, so refusing it would refuse a legitimate URL. A
    // doubled dot is not a name at all.
    const fqdn = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.supabase.co.:5432/postgres`
    expect(classifyDatabaseTarget(fqdn).provenIdentity.proven).toBe(true)

    const doubled = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.supabase.co..:5432/postgres`
    expect(classifyDatabaseTarget(doubled).provenIdentity.proven).toBe(false)
  })

  it('proves nothing for a local or private target', () => {
    // Not a failure — a category error. A loopback database has no Supabase
    // project, and the authorization layer must not ask it for one.
    expect(classifyDatabaseTarget(LOCAL_RUNTIME_URL).provenIdentity.proven).toBe(false)
    expect(
      classifyDatabaseTarget(`postgresql://${RUNTIME_ROLE}:${PW}@10.0.0.5:5432/postgres`)
        .provenIdentity.proven
    ).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* 3. The authorization verdict — same role, different project, different answer */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — a hosted environment may only reach its own project', () => {
  it('accepts the staging project when staging is intended', () => {
    const decision = runtime(directUrl(STAGING_REF), 'staging')
    expect(decision.targetKind).toBe('managed_remote')
    expect(decision.environment).toBe('staging')
  })

  it('REFUSES the production project when staging is intended', () => {
    // The regression this whole suite exists for.
    expect(capture(() => runtime(directUrl(PRODUCTION_REF), 'staging')).code).toBe(
      'DB_RUNTIME_PROJECT_MISMATCH'
    )
  })

  it('accepts the production project when production is intended', () => {
    // The pin must not become an outage: production reaching production is the
    // normal, healthy path and stays allowed.
    expect(runtime(directUrl(PRODUCTION_REF), 'production').targetKind).toBe('managed_remote')
  })

  it('REFUSES the staging project when production is intended', () => {
    expect(capture(() => runtime(directUrl(STAGING_REF), 'production')).code).toBe(
      'DB_RUNTIME_PROJECT_MISMATCH'
    )
  })

  it('does not let the identical runtime role decide the verdict', () => {
    // CASE 3 of the brief, stated as one assertion: the two URLs differ ONLY in
    // the project ref — same role, same database, same port, same scheme — and
    // the verdicts must still diverge.
    const staging = directUrl(STAGING_REF, RUNTIME_ROLE)
    const production = directUrl(PRODUCTION_REF, RUNTIME_ROLE)
    expect(staging.replace(STAGING_REF, '<ref>')).toBe(production.replace(PRODUCTION_REF, '<ref>'))

    expect(runtime(staging, 'staging').environment).toBe('staging')
    expect(capture(() => runtime(production, 'staging')).code).toBe('DB_RUNTIME_PROJECT_MISMATCH')
  })

  it('REFUSES a production ref carried in a pooler login role while staging is intended', () => {
    expect(capture(() => runtime(poolerUrl(PRODUCTION_REF), 'staging')).code).toBe(
      'DB_RUNTIME_PROJECT_MISMATCH'
    )
  })

  it('accepts the staging ref in the pooler form, in either pooling mode', () => {
    // Pooling MODE is a provisioning concern (a `psql -1` baseline needs session
    // affinity); the RUNTIME legitimately uses the transaction pooler. Identity
    // must not be entangled with mode, or the fix becomes a production outage.
    expect(runtime(poolerUrl(STAGING_REF, 6543), 'staging').targetKind).toBe('managed_remote')
    expect(runtime(poolerUrl(STAGING_REF, 5432), 'staging').targetKind).toBe('managed_remote')
  })

  it('REFUSES an opaque hosted target whose project cannot be proven', () => {
    const url = `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`
    expect(capture(() => runtime(url, 'staging')).code).toBe('DB_RUNTIME_PROJECT_UNPINNED')
  })

  it('REFUSES a non-Supabase managed host in a hosted environment', () => {
    const url = `postgresql://${RUNTIME_ROLE}:${PW}@db.example.com:5432/postgres`
    expect(capture(() => runtime(url, 'staging')).code).toBe('DB_RUNTIME_PROJECT_UNPINNED')
  })

  it('REFUSES the lookalike domain at the authorization layer too', () => {
    const url = `postgresql://${RUNTIME_ROLE}:${PW}@db.${STAGING_REF}.supabase.co.attacker.example:5432/postgres`
    expect(capture(() => runtime(url, 'staging')).code).toBe('DB_RUNTIME_PROJECT_UNPINNED')
  })

  it('REFUSES a malformed hosted URL before any identity question is asked', () => {
    expect(capture(() => runtime('not a url', 'staging')).code).toBe('DB_TARGET_URL_INVALID')
    expect(capture(() => runtime(undefined as unknown as string, 'staging')).code).toBe(
      'DB_TARGET_URL_MISSING'
    )
  })

  it('REFUSES a loopback target when a hosted environment is intended', () => {
    // A local database is not the staging project, and a hosted environment that
    // silently accepted one would be running on fixtures.
    expect(capture(() => runtime(LOCAL_RUNTIME_URL, 'staging')).code).toBe(
      'DB_RUNTIME_TARGET_NOT_HOSTED'
    )
  })

  it('REFUSES a private-network target when a hosted environment is intended', () => {
    const url = `postgresql://${RUNTIME_ROLE}:${PW}@10.0.0.5:5432/postgres`
    expect(capture(() => runtime(url, 'production')).code).toBe('DB_RUNTIME_TARGET_NOT_HOSTED')
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Non-hosted environments may not reach a hosted project at all            */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — development, test and ci reach no managed remote', () => {
  it.each(['development', 'test', 'ci'] as const)(
    'REFUSES the production project under %s',
    (environment) => {
      expect(capture(() => runtime(directUrl(PRODUCTION_REF), environment)).code).toBe(
        'DB_RUNTIME_REMOTE_NOT_ALLOWED'
      )
    }
  )

  it.each(['development', 'test', 'ci'] as const)(
    'REFUSES even the STAGING project under %s',
    (environment) => {
      // Deliberately symmetric. "It is only staging" is how a suite that
      // truncates tables ends up truncating a shared database.
      expect(capture(() => runtime(directUrl(STAGING_REF), environment)).code).toBe(
        'DB_RUNTIME_REMOTE_NOT_ALLOWED'
      )
    }
  )

  it('still accepts the local stack under development and test', () => {
    expect(runtime(LOCAL_RUNTIME_URL, 'development').targetKind).toBe('local_loopback')
    expect(runtime(LOCAL_RUNTIME_URL, 'test').targetKind).toBe('local_loopback')
  })

  it('NODE_ENV=test does not weaken a hosted requirement — it forbids the remote outright', () => {
    // Case 19: a test process must never be the thing that authorises
    // production. Resolved (not declared) environment, so this is the real path.
    const decision = capture(() =>
      assertDatabaseOperationAllowed({
        url: directUrl(PRODUCTION_REF),
        capability: 'app_runtime',
        env: { NODE_ENV: 'test' },
      })
    )
    expect(decision.code).toBe('DB_RUNTIME_REMOTE_NOT_ALLOWED')
  })
})

/* -------------------------------------------------------------------------- */
/* 5. Environment resolution cannot be the bypass                              */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — how the environment is resolved', () => {
  it('maps VERCEL_ENV=preview to staging when UELLIX_APP_ENV is absent', () => {
    // Without this, a preview deployment resolves to `production` via NODE_ENV
    // and the pin would demand the PRODUCTION project of a staging database —
    // a fail-closed outage rather than a hole, but wrong either way.
    expect(resolveEnvironment({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe('staging')
    expect(resolveEnvironment({ VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(
      'production'
    )
    expect(resolveEnvironment({ VERCEL_ENV: 'development', NODE_ENV: 'production' })).toBe(
      'development'
    )
  })

  it('still lets an explicit UELLIX_APP_ENV outrank VERCEL_ENV', () => {
    expect(resolveEnvironment({ UELLIX_APP_ENV: 'staging', VERCEL_ENV: 'production' })).toBe(
      'staging'
    )
  })

  it('reports the provenance of the answer, not just the answer', () => {
    expect(resolveEnvironmentDecision({ UELLIX_APP_ENV: 'staging' })).toEqual({
      environment: 'staging',
      provenance: 'declared',
    })
    expect(resolveEnvironmentDecision({ UELLIX_APP_ENV: 'stagng' })).toEqual({
      environment: 'production',
      provenance: 'unrecognised_declaration',
    })
    expect(resolveEnvironmentDecision({ VERCEL_ENV: 'preview' })).toEqual({
      environment: 'staging',
      provenance: 'inferred',
    })
  })

  it('REFUSES a managed remote when UELLIX_APP_ENV was set to something unrecognised', () => {
    // Resolving a typo to `production` is the right DEFAULT — it is the most
    // restrictive answer — but it must not become AUTHORITY to reach the
    // production database. A typo is not a declaration.
    expect(
      capture(() =>
        assertDatabaseOperationAllowed({
          url: directUrl(PRODUCTION_REF),
          capability: 'app_runtime',
          env: { UELLIX_APP_ENV: 'produciton' },
        })
      ).code
    ).toBe('DB_RUNTIME_ENVIRONMENT_UNRECOGNISED')
  })

  it('an explicit caller-declared environment is not overridden by the ambient one', () => {
    // Case 17: environment-variable contamination cannot silently redirect a
    // caller that stated its intent.
    expect(
      capture(() =>
        assertDatabaseOperationAllowed({
          url: directUrl(PRODUCTION_REF),
          capability: 'app_runtime',
          environment: 'staging',
          env: { UELLIX_APP_ENV: 'production' },
        })
      ).code
    ).toBe('DB_RUNTIME_PROJECT_MISMATCH')
  })
})

/* -------------------------------------------------------------------------- */
/* 6. The refusal happens BEFORE the driver exists                             */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({ postgresCalls: [] as string[] }))

vi.mock('postgres', () => ({
  default: (connectionString: string) => {
    spies.postgresCalls.push(connectionString)
    return { end: async () => undefined }
  },
}))

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: () => ({ select: () => 'select()' }),
}))

describe('SYS-02 — a refused target never reaches the connection factory', () => {
  let client: typeof import('@/db/client')
  const originalRuntimeUrl = process.env.UELLIX_RUNTIME_DATABASE_URL
  const originalAppEnv = process.env.UELLIX_APP_ENV

  beforeEach(async () => {
    spies.postgresCalls.length = 0
    vi.resetModules()
    client = await import('@/db/client')
  })

  afterEach(() => {
    if (originalRuntimeUrl === undefined) delete process.env.UELLIX_RUNTIME_DATABASE_URL
    else process.env.UELLIX_RUNTIME_DATABASE_URL = originalRuntimeUrl
    if (originalAppEnv === undefined) delete process.env.UELLIX_APP_ENV
    else process.env.UELLIX_APP_ENV = originalAppEnv
  })

  /** Asserts by error SHAPE: `vi.resetModules()` gives the re-import its own class. */
  function expectRefusal(run: () => unknown, expectedCode: string): void {
    try {
      run()
    } catch (error) {
      expect((error as { code?: string }).code).toBe(expectedCode)
      return
    }
    throw new Error(`expected a refusal with code ${expectedCode}, but it was allowed`)
  }

  it('refuses the production project for a staging runtime without calling postgres()', () => {
    expectRefusal(
      () =>
        client.createDatabaseClient({
          connectionString: directUrl(PRODUCTION_REF),
          capability: 'app_runtime',
          environment: 'staging',
          env: {},
        }),
      'DB_RUNTIME_PROJECT_MISMATCH'
    )
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('refuses an opaque hosted target without calling postgres()', () => {
    expectRefusal(
      () =>
        client.createDatabaseClient({
          connectionString: `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`,
          capability: 'app_runtime',
          environment: 'staging',
          env: {},
        }),
      'DB_RUNTIME_PROJECT_UNPINNED'
    )
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('refuses the production project on the DEFAULT client path without connecting', () => {
    // The real shape of the accident: nobody passes a URL, the environment
    // supplies it, and the shared `db` proxy builds the client on first use.
    process.env.UELLIX_APP_ENV = 'staging'
    process.env.UELLIX_RUNTIME_DATABASE_URL = directUrl(PRODUCTION_REF)
    expectRefusal(() => client.db.select, 'DB_RUNTIME_PROJECT_MISMATCH')
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('connects for the staging project on the default client path', () => {
    process.env.UELLIX_APP_ENV = 'staging'
    process.env.UELLIX_RUNTIME_DATABASE_URL = directUrl(STAGING_REF)
    void client.db.select
    expect(spies.postgresCalls).toEqual([directUrl(STAGING_REF)])
  })

  it('validates the SAME bytes it then hands to the driver', () => {
    // Phase G invariant: no revalidation gap. The string the guard classified is
    // the string `postgres()` receives — not a re-read of the environment.
    //
    // The POOLER form is used deliberately, and it is the reference-parameter
    // variant rather than the `postgres.<ref>` login-role variant, because the
    // runtime resolver demands the role be exactly `uellix_app` BEFORE the
    // target guard runs. That makes the login-role mechanism unreachable on
    // this path — so the reference parameter is the only way a runtime can
    // prove its identity through the shared pooler, and it has to work.
    process.env.UELLIX_APP_ENV = 'staging'
    const url =
      `postgresql://${RUNTIME_ROLE}:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres` +
      `?options=reference%3D${STAGING_REF}`
    process.env.UELLIX_RUNTIME_DATABASE_URL = url
    void client.db.select
    expect(spies.postgresCalls).toEqual([url])
  })

  it('refuses the production project through the pooler reference parameter', () => {
    // The same mechanism must refuse as reliably as it accepts.
    process.env.UELLIX_APP_ENV = 'staging'
    process.env.UELLIX_RUNTIME_DATABASE_URL =
      `postgresql://${RUNTIME_ROLE}:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres` +
      `?options=reference%3D${PRODUCTION_REF}`
    expectRefusal(() => client.db.select, 'DB_RUNTIME_PROJECT_MISMATCH')
    expect(spies.postgresCalls).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* 7. The DDL-containment helper cannot reach a hosted database                */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — tests/helpers/local-runtime pins itself to the local stack', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'tests/helpers/local-runtime.ts'),
    'utf8'
  )

  it('restricts the shared client BEFORE it opens the runtime probe', () => {
    // Six suites import this helper, including the fifteen destructive DDL
    // probes. Order is the whole guarantee: `restrictDefaultDatabaseClient` is
    // refused once a client exists, so a restriction placed after the probe
    // would throw instead of protecting anything.
    const restrictAt = source.indexOf('restrictDefaultDatabaseClient({')
    const probeAt = source.indexOf('await probe(() => getDefaultDatabaseClient())')
    expect(restrictAt).toBeGreaterThan(-1)
    expect(probeAt).toBeGreaterThan(restrictAt)
  })

  it('pins the capability to local_integration_test and this worktree’s port', () => {
    expect(source).toMatch(/capability:\s*'local_integration_test'/)
    expect(source).toMatch(/expectedLocalPort:\s*LOCAL_DB_PORT/)
  })

  it('treats anything but "already applied" as a refusal to run', () => {
    // A bare catch would also swallow DB_RESTRICTION_TOO_LATE — the one case
    // where the restriction did NOT apply and the client is still app_runtime.
    expect(source).toContain('DB_RESTRICTION_ALREADY_APPLIED')
  })
})

describe('SYS-02 — the restriction beats an exported hosted environment', () => {
  let client: typeof import('@/db/client')
  const originalRuntimeUrl = process.env.UELLIX_RUNTIME_DATABASE_URL
  const originalAppEnv = process.env.UELLIX_APP_ENV

  beforeEach(async () => {
    spies.postgresCalls.length = 0
    vi.resetModules()
    client = await import('@/db/client')
  })

  afterEach(() => {
    if (originalRuntimeUrl === undefined) delete process.env.UELLIX_RUNTIME_DATABASE_URL
    else process.env.UELLIX_RUNTIME_DATABASE_URL = originalRuntimeUrl
    if (originalAppEnv === undefined) delete process.env.UELLIX_APP_ENV
    else process.env.UELLIX_APP_ENV = originalAppEnv
  })

  it('refuses the STAGING project — the environment declaration cannot widen it', () => {
    // The residual hole the helper's restriction closes: the guard's own
    // environment rule would ALLOW this, because the operator declared staging
    // and the target really is the staging project. Only the capability pin
    // refuses it, and a suite that TRUNCATEs append-only tables is exactly the
    // caller that must be refused.
    client.restrictDefaultDatabaseClient({
      capability: 'local_integration_test',
      expectedLocalPort: LOCAL_DB_PORT,
    })
    process.env.UELLIX_APP_ENV = 'staging'
    process.env.UELLIX_RUNTIME_DATABASE_URL = directUrl(STAGING_REF)

    try {
      void client.db.select
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('DB_OPERATION_NOT_ALLOWED')
    }
    expect(spies.postgresCalls).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* 8. Refusals stay credential-free                                            */
/* -------------------------------------------------------------------------- */

describe('SYS-02 — refusals leak nothing', () => {
  it.each([
    ['production ref under staging', directUrl(PRODUCTION_REF), 'staging' as const],
    ['unproven pooler', `postgresql://postgres:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`, 'staging' as const],
    ['remote under test', directUrl(STAGING_REF), 'test' as const],
  ])('%s: the message carries no password, no URL and no unmasked host', (_label, url, environment) => {
    const { message } = capture(() => runtime(url, environment))
    expect(message).not.toContain(PW)
    expect(message).not.toContain('postgresql://')
    expect(message).not.toContain('supabase.co:')
    // The masked provider suffix is what a diagnosing operator gets instead.
    expect(message).toContain('***.supabase.co')
  })

  it('does not print either project ref', () => {
    // Both refs are public, but the safety layer's rule is stricter than the
    // hosted operator path's: nothing organisation-identifying reaches a log
    // line that a run report might capture.
    const { message } = capture(() => runtime(directUrl(PRODUCTION_REF), 'staging'))
    expect(message).not.toContain(PRODUCTION_REF)
    expect(message).not.toContain(STAGING_REF)
  })

  it('names the environment and the capability, so the refusal is actionable', () => {
    const { message } = capture(() => runtime(directUrl(PRODUCTION_REF), 'staging'))
    expect(message).toContain('app_runtime')
    expect(message).toContain('staging')
  })
})
