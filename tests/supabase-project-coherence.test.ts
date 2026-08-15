// tests/supabase-project-coherence.test.ts
//
// SYS-03 — CROSS-RESOURCE SUPABASE PROJECT COHERENCE.
//
// SYS-02 proved which Supabase project the POSTGRES connection points at, and
// pinned it per environment. Supabase Auth is configured independently, through
// `NEXT_PUBLIC_SUPABASE_URL`, and nothing compared the two. The measured gap on
// 4a6a34f, reproduced offline against the real production functions:
//
//   UELLIX_APP_ENV=staging
//   NEXT_PUBLIC_SUPABASE_URL   -> https://<production-ref>.supabase.co
//   UELLIX_RUNTIME_DATABASE_URL-> db.<staging-ref>.supabase.co
//     assertDatabaseOperationAllowed(app_runtime) -> ALLOWED
//     any auth-side check                         -> none exists
//
// A deployment in that state authenticates users against one project's GoTrue
// and reads their rows out of another project's database. Every `auth.uid()` in
// every RLS policy is then a subject the data does not belong to.
//
// NOTHING HERE TOUCHES A NETWORK. Every function under test is pure: it parses
// strings and compares refs. No Supabase client is constructed, no socket is
// opened, no GoTrue request is made.
//
// The two project refs below are PUBLIC identifiers — they appear in every URL
// the projects serve — and are imported from the canonical registry rather than
// retyped, so a test cannot drift from the pin it is supposed to be checking.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
} from '@/db/hosted/target-identity'
import { RUNTIME_PROJECT_PINS } from '@/db/safety/runtime-project-pins'
import {
  assertBrowserSupabaseAuthUrl,
  deriveSupabaseApiIdentity,
  SupabaseAuthIdentityError,
} from '@/lib/supabase/project-identity'
import {
  assertSupabaseProjectCoherence,
  SupabaseProjectCoherenceError,
} from '@/lib/supabase/project-coherence'
import { LOCAL_SUPABASE_API_URL } from '@/db/safety/local-stack'

const STAGING = KNOWN_STAGING_PROJECT_REF
const PRODUCTION = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]

/** The Auth/API host form the Supabase dashboard hands an operator. */
const authUrl = (ref: string) => `https://${ref}.supabase.co`

/**
 * A runtime Postgres URL for a project.
 *
 * The password is fictional and the role is the real runtime role, because
 * `resolveRuntimeDatabaseUrl` refuses anything that is not `uellix_app` before
 * the target is ever classified — a URL with a placeholder role would fail for
 * the wrong reason and prove nothing about SYS-03.
 */
const runtimeDbUrl = (ref: string) =>
  `postgresql://uellix_app:nOt-a-ReAl-p4ssw0rd@db.${ref}.supabase.co:5432/postgres`

/** The env a hosted deployment presents, with both halves declared. */
const hostedEnv = (options: {
  environment: string
  authRef?: string
  dbRef?: string
  dbUrl?: string
}) => ({
  UELLIX_APP_ENV: options.environment,
  UELLIX_RUNTIME_DATABASE_URL:
    options.dbUrl ?? runtimeDbUrl(options.dbRef ?? STAGING),
})

const coherence = (options: {
  environment: string
  authRef?: string
  authUrl?: string
  dbRef?: string
  dbUrl?: string
}) =>
  assertSupabaseProjectCoherence({
    env: hostedEnv(options),
    authUrl: options.authUrl ?? authUrl(options.authRef ?? STAGING),
  })

const codeOf = (run: () => unknown): string | null => {
  try {
    run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'THREW_WITHOUT_CODE'
  }
}

/* -------------------------------------------------------------------------- */
/* 0. The registry is shared, not duplicated                                  */
/* -------------------------------------------------------------------------- */

describe('SYS-03 reuses the SYS-02 project registry', () => {
  it('derives its expectations from RUNTIME_PROJECT_PINS, not a second copy', () => {
    // If SYS-03 had introduced its own environment -> ref table, these would be
    // able to drift apart, and the failure mode of an out-of-sync registry is
    // that the stale half silently authorises the wrong project.
    expect(RUNTIME_PROJECT_PINS.staging).toBe(STAGING)
    expect(RUNTIME_PROJECT_PINS.production).toBe(PRODUCTION)
    expect(STAGING).not.toBe(PRODUCTION)
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE I — adversarial Auth URL matrix                                      */
/* -------------------------------------------------------------------------- */

describe('the Auth project identity is derived structurally', () => {
  it('accepts the canonical hosted form and names the project', () => {
    expect(deriveSupabaseApiIdentity(authUrl(STAGING))).toEqual({
      kind: 'hosted',
      projectRef: STAGING,
    })
  })

  it('accepts a trailing slash — the dashboard form with a path root', () => {
    expect(deriveSupabaseApiIdentity(`${authUrl(STAGING)}/`)).toEqual({
      kind: 'hosted',
      projectRef: STAGING,
    })
  })

  it('lowercases the host deterministically rather than refusing it', () => {
    // DNS is case-insensitive, so an uppercase host reaches the SAME project.
    // Refusing it would be a fail-closed answer to a question that has a
    // correct one; guessing would be worse. Normalising is deterministic.
    expect(deriveSupabaseApiIdentity(`https://${STAGING.toUpperCase()}.supabase.co`)).toEqual({
      kind: 'hosted',
      projectRef: STAGING,
    })
  })

  it.each([
    ['a lookalike suffix domain', `https://${STAGING}.supabase.co.attacker.example`],
    ['the ref in the path only', `https://attacker.example/${STAGING}`],
    ['the ref in the query only', `https://attacker.example/?ref=${STAGING}`],
    ['the ref in the fragment only', `https://attacker.example/#${STAGING}`],
    ['the ref as the username only', `https://${STAGING}@attacker.example`],
    ['the ref as the password only', `https://user:${STAGING}@attacker.example`],
    ['a punycode lookalike', `https://xn--supabse-9va.co`],
    ['a supabase.co path prefix', `https://supabase.co/${STAGING}`],
    ['an extra label before the ref', `https://db.${STAGING}.supabase.co`],
    ['an extra label after the ref', `https://${STAGING}.api.supabase.co`],
    ['a trailing dot', `https://${STAGING}.supabase.co.`],
    ['a percent-encoded host', `https://${STAGING}%2esupabase.co`],
    ['an opaque custom domain', 'https://auth.uellix.com'],
    ['a bare hostname', 'https://supabase'],
    ['an unparseable value', 'not a url at all'],
    ['an empty value', ''],
    ['whitespace only', '   '],
  ])('refuses %s', (_label, url) => {
    expect(deriveSupabaseApiIdentity(url).kind).toBe('unproven')
  })

  it('refuses a missing URL', () => {
    expect(deriveSupabaseApiIdentity(undefined).kind).toBe('unproven')
    expect(deriveSupabaseApiIdentity(null).kind).toBe('unproven')
  })

  it('refuses a hosted Supabase URL served over plaintext', () => {
    // `classifySupabaseApiTarget` accepts http:// — correctly, because it
    // answers "what kind of host is this?" and a host has no transport. Auth
    // is a different question: the anon key and the session token travel on
    // this URL, so a hosted runtime that is not HTTPS is refused outright.
    const identity = deriveSupabaseApiIdentity(`http://${STAGING}.supabase.co`)
    expect(identity.kind).toBe('unproven')
    expect((identity as { code: string }).code).toBe('AUTH_URL_NOT_HTTPS')
  })

  it('refuses userinfo even on the correct project host', () => {
    const identity = deriveSupabaseApiIdentity(`https://u:p@${STAGING}.supabase.co`)
    expect(identity.kind).toBe('unproven')
    expect((identity as { code: string }).code).toBe('AUTH_URL_HAS_USERINFO')
  })

  it.each([
    ['the pinned local stack', LOCAL_SUPABASE_API_URL],
    ['loopback by name', 'http://localhost:56321'],
    ['IPv6 loopback', 'http://[::1]:56321'],
    ['127.0.0.1 on another port', 'http://127.0.0.1:54321'],
  ])('classifies %s as LOCAL, never as hosted', (_label, url) => {
    expect(deriveSupabaseApiIdentity(url).kind).toBe('local')
  })

  it('never lets a local URL claim a project ref', () => {
    const identity = deriveSupabaseApiIdentity(LOCAL_SUPABASE_API_URL)
    expect(identity).not.toHaveProperty('projectRef')
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE J — the cross-project matrix                                         */
/* -------------------------------------------------------------------------- */

describe('a hosted deployment requires expected == auth == postgres', () => {
  it('accepts staging when every source names the staging project', () => {
    const decision = coherence({ environment: 'staging', authRef: STAGING, dbRef: STAGING })
    expect(decision.environment).toBe('staging')
    expect(decision.projectRef).toBe(STAGING)
  })

  it('accepts production when every source names the production project', () => {
    const decision = coherence({
      environment: 'production',
      authRef: PRODUCTION,
      dbRef: PRODUCTION,
    })
    expect(decision.environment).toBe('production')
    expect(decision.projectRef).toBe(PRODUCTION)
  })

  it('REFUSES the reproduced defect: staging env, production Auth, staging DB', () => {
    // The headline case. SYS-02 is satisfied — the database IS the staging
    // one — so nothing before SYS-03 had anything to object to.
    expect(codeOf(() => coherence({ environment: 'staging', authRef: PRODUCTION, dbRef: STAGING })))
      .toBe('SUPABASE_AUTH_PROJECT_MISMATCH')
  })

  it('refuses staging env with staging Auth and production DB', () => {
    expect(codeOf(() => coherence({ environment: 'staging', authRef: STAGING, dbRef: PRODUCTION })))
      .toBe('SUPABASE_DB_PROJECT_MISMATCH')
  })

  it('refuses staging env when BOTH halves name production', () => {
    // Internally coherent and still wrong: a consistent identity for the wrong
    // project is the wrong project. Only the environment pin catches this.
    expect(codeOf(() =>
      coherence({ environment: 'staging', authRef: PRODUCTION, dbRef: PRODUCTION })
    )).toBe('SUPABASE_AUTH_PROJECT_MISMATCH')
  })

  it('refuses production env with staging Auth', () => {
    expect(codeOf(() =>
      coherence({ environment: 'production', authRef: STAGING, dbRef: PRODUCTION })
    )).toBe('SUPABASE_AUTH_PROJECT_MISMATCH')
  })

  it('refuses production env with staging DB', () => {
    expect(codeOf(() =>
      coherence({ environment: 'production', authRef: PRODUCTION, dbRef: STAGING })
    )).toBe('SUPABASE_DB_PROJECT_MISMATCH')
  })

  it('refuses production env when both halves name staging', () => {
    expect(codeOf(() =>
      coherence({ environment: 'production', authRef: STAGING, dbRef: STAGING })
    )).toBe('SUPABASE_AUTH_PROJECT_MISMATCH')
  })

  it('refuses an Auth URL whose project cannot be proven at all', () => {
    expect(codeOf(() =>
      coherence({
        environment: 'staging',
        authUrl: `https://${STAGING}.supabase.co.attacker.example`,
        dbRef: STAGING,
      })
    )).toBe('SUPABASE_AUTH_IDENTITY_UNPROVEN')
  })

  it('refuses a hosted environment whose Auth points at the local stack', () => {
    expect(codeOf(() =>
      coherence({ environment: 'staging', authUrl: LOCAL_SUPABASE_API_URL, dbRef: STAGING })
    )).toBe('SUPABASE_AUTH_LOCAL_IN_HOSTED_ENV')
  })

  it('refuses a hosted environment whose database proves no project', () => {
    // A shared-pooler URL with no routing parameter: a real deployment shape
    // that names no project. SYS-02 refuses it; SYS-03 must not accept it
    // merely because the Auth half is correct.
    expect(codeOf(() =>
      coherence({
        environment: 'staging',
        authRef: STAGING,
        dbUrl:
          'postgresql://uellix_app:nOt-a-ReAl-p4ssw0rd@aws-0-us-east-2.pooler.supabase.com:5432/postgres',
      })
    )).toBe('SUPABASE_DB_IDENTITY_UNPROVEN')
  })

  it('accepts the pooler when its routing parameter names the pinned project', () => {
    // SYS-02's `supavisor-reference` mechanism must still work end to end:
    // SYS-03 consumes the identity SYS-02 proved rather than re-deriving one.
    const decision = coherence({
      environment: 'staging',
      authRef: STAGING,
      dbUrl:
        `postgresql://uellix_app:nOt-a-ReAl-p4ssw0rd@aws-0-us-east-2.pooler.supabase.com:5432/postgres` +
        `?options=reference%3D${STAGING}`,
    })
    expect(decision.projectRef).toBe(STAGING)
  })

  it('refuses when the pooler routing parameter names the OTHER project', () => {
    expect(codeOf(() =>
      coherence({
        environment: 'staging',
        authRef: STAGING,
        dbUrl:
          `postgresql://uellix_app:nOt-a-ReAl-p4ssw0rd@aws-0-us-east-2.pooler.supabase.com:5432/postgres` +
          `?options=reference%3D${PRODUCTION}`,
      })
    )).toBe('SUPABASE_DB_PROJECT_MISMATCH')
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE J — non-hosted environments                                          */
/* -------------------------------------------------------------------------- */

describe('a non-hosted environment may never reach a hosted Supabase project', () => {
  it.each(['development', 'test', 'ci'])(
    '%s refuses a hosted Auth URL even when it names the staging project',
    (environment) => {
      expect(codeOf(() =>
        assertSupabaseProjectCoherence({
          env: { UELLIX_APP_ENV: environment },
          authUrl: authUrl(STAGING),
        })
      )).toBe('SUPABASE_AUTH_HOSTED_WITHOUT_PIN')
    }
  )

  it.each(['development', 'test', 'ci'])('%s accepts the local stack', (environment) => {
    const decision = assertSupabaseProjectCoherence({
      env: { UELLIX_APP_ENV: environment },
      authUrl: LOCAL_SUPABASE_API_URL,
    })
    expect(decision.environment).toBe(environment)
    expect(decision.projectRef).toBeNull()
  })

  it('does not require a database URL to authorise a local Auth target', () => {
    // Local development legitimately runs Auth against the container stack
    // while `UELLIX_RUNTIME_DATABASE_URL` is resolved separately and later.
    // Coupling the two here would break `pnpm dev` to guard a hosted-only risk.
    expect(() =>
      assertSupabaseProjectCoherence({
        env: { UELLIX_APP_ENV: 'development' },
        authUrl: LOCAL_SUPABASE_API_URL,
      })
    ).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE H — environment precedence                                           */
/* -------------------------------------------------------------------------- */

describe('environment precedence follows SYS-02 and never silently authorises production', () => {
  it('UELLIX_APP_ENV=staging outranks VERCEL_ENV=production', () => {
    const decision = assertSupabaseProjectCoherence({
      env: {
        UELLIX_APP_ENV: 'staging',
        VERCEL_ENV: 'production',
        UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(STAGING),
      },
      authUrl: authUrl(STAGING),
    })
    expect(decision.environment).toBe('staging')
  })

  it('VERCEL_ENV=preview with no declaration resolves to staging, not production', () => {
    const decision = assertSupabaseProjectCoherence({
      env: { VERCEL_ENV: 'preview', UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(STAGING) },
      authUrl: authUrl(STAGING),
    })
    expect(decision.environment).toBe('staging')
  })

  it('VERCEL_ENV=preview refuses a production Auth URL', () => {
    expect(codeOf(() =>
      assertSupabaseProjectCoherence({
        env: { VERCEL_ENV: 'preview', UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(PRODUCTION) },
        authUrl: authUrl(PRODUCTION),
      })
    )).toBe('SUPABASE_AUTH_PROJECT_MISMATCH')
  })

  it('VERCEL_ENV=production with no declaration resolves to production', () => {
    const decision = assertSupabaseProjectCoherence({
      env: { VERCEL_ENV: 'production', UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(PRODUCTION) },
      authUrl: authUrl(PRODUCTION),
    })
    expect(decision.environment).toBe('production')
  })

  it('NODE_ENV=test outranks VERCEL_ENV, so a suite can never reach hosted Auth', () => {
    expect(codeOf(() =>
      assertSupabaseProjectCoherence({
        env: { NODE_ENV: 'test', VERCEL_ENV: 'production' },
        authUrl: authUrl(PRODUCTION),
      })
    )).toBe('SUPABASE_AUTH_HOSTED_WITHOUT_PIN')
  })

  it('NODE_ENV=development refuses a hosted Auth URL', () => {
    expect(codeOf(() =>
      assertSupabaseProjectCoherence({ env: { NODE_ENV: 'development' }, authUrl: authUrl(STAGING) })
    )).toBe('SUPABASE_AUTH_HOSTED_WITHOUT_PIN')
  })

  it.each([
    ['a typo', 'produciton'],
    ['a case difference', 'Staging'],
    ['a trailing space', 'staging '],
  ])('refuses a hosted Auth URL when UELLIX_APP_ENV is %s', (_label, declared) => {
    // `resolveEnvironmentDecision` collapses an unrecognised declaration to
    // `production` because that is the most restrictive ENVIRONMENT. It must
    // not thereby become AUTHORITY to authenticate against the production
    // project — otherwise a mistyped variable is a credential.
    expect(codeOf(() =>
      assertSupabaseProjectCoherence({
        env: { UELLIX_APP_ENV: declared, UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(PRODUCTION) },
        authUrl: authUrl(PRODUCTION),
      })
    )).toBe('SUPABASE_ENVIRONMENT_UNRECOGNISED')
  })

  it('an empty UELLIX_APP_ENV falls through to inference rather than being honoured', () => {
    // Empty is not a declaration. With nothing else set this is development,
    // which refuses hosted Auth outright.
    expect(codeOf(() =>
      assertSupabaseProjectCoherence({ env: { UELLIX_APP_ENV: '' }, authUrl: authUrl(STAGING) })
    )).toBe('SUPABASE_AUTH_HOSTED_WITHOUT_PIN')
  })

  it('both env signals missing with NODE_ENV=production demands the production project', () => {
    const decision = assertSupabaseProjectCoherence({
      env: { NODE_ENV: 'production', UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(PRODUCTION) },
      authUrl: authUrl(PRODUCTION),
    })
    expect(decision.environment).toBe('production')
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE K — keys are never an identity source                                */
/* -------------------------------------------------------------------------- */

describe('project identity never comes from a key, and no error carries one', () => {
  it('ignores NEXT_PUBLIC_SUPABASE_ANON_KEY entirely', () => {
    // A key naming the WRONG project must not rescue a wrong URL, and a key
    // naming the right one must not rescue it either: identity is routing, and
    // routing comes from the URL.
    const withKey = () =>
      assertSupabaseProjectCoherence({
        env: {
          UELLIX_APP_ENV: 'staging',
          UELLIX_RUNTIME_DATABASE_URL: runtimeDbUrl(STAGING),
          NEXT_PUBLIC_SUPABASE_ANON_KEY: `anon-key-for-${PRODUCTION}`,
          SUPABASE_SERVICE_ROLE_KEY: `service-key-for-${PRODUCTION}`,
        },
        authUrl: authUrl(STAGING),
      })
    expect(withKey().projectRef).toBe(STAGING)
  })

  it('never puts the connection URL, a password or a key into the error message', () => {
    const secretish = 'sUp3r-s3cret-p4ssw0rd'
    let message = ''
    try {
      assertSupabaseProjectCoherence({
        env: {
          UELLIX_APP_ENV: 'staging',
          UELLIX_RUNTIME_DATABASE_URL: `postgresql://uellix_app:${secretish}@db.${PRODUCTION}.supabase.co:5432/postgres`,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
        },
        authUrl: authUrl(STAGING),
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain(secretish)
    expect(message).not.toContain('postgresql://')
    expect(message).not.toContain('eyJ')
  })

  it('names the environment so the refusal is actionable', () => {
    let message = ''
    try {
      coherence({ environment: 'staging', authRef: PRODUCTION, dbRef: STAGING })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('staging')
  })

  it('throws a typed error, not a bare Error', () => {
    expect(() => coherence({ environment: 'staging', authRef: PRODUCTION, dbRef: STAGING }))
      .toThrowError(SupabaseProjectCoherenceError)
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE D — the browser-safe half                                            */
/* -------------------------------------------------------------------------- */

describe('the browser guard enforces positive identity without server state', () => {
  it('accepts a hosted URL naming a project this application is deployed against', () => {
    expect(assertBrowserSupabaseAuthUrl(authUrl(STAGING))).toBe(authUrl(STAGING))
    expect(assertBrowserSupabaseAuthUrl(authUrl(PRODUCTION))).toBe(authUrl(PRODUCTION))
  })

  it('accepts the local stack', () => {
    expect(assertBrowserSupabaseAuthUrl(LOCAL_SUPABASE_API_URL)).toBe(LOCAL_SUPABASE_API_URL)
  })

  it('refuses a structurally valid Supabase project this application never uses', () => {
    // Positive identity, not a denylist: a well-formed ref for some OTHER
    // Supabase project is still a project the browser must not talk to.
    expect(() => assertBrowserSupabaseAuthUrl('https://abcdefghijklmnopqrst.supabase.co'))
      .toThrowError(SupabaseAuthIdentityError)
  })

  it.each([
    ['a lookalike suffix domain', `https://${STAGING}.supabase.co.attacker.example`],
    ['the ref in the query only', `https://attacker.example/?ref=${STAGING}`],
    ['plaintext transport', `http://${STAGING}.supabase.co`],
    ['a missing URL', undefined],
  ])('refuses %s', (_label, url) => {
    expect(() => assertBrowserSupabaseAuthUrl(url)).toThrowError(SupabaseAuthIdentityError)
  })

  it('returns the exact string it validated, so the caller cannot dial another', () => {
    // The whole point of returning the URL rather than merely approving it:
    // the value that was checked and the value handed to `createBrowserClient`
    // are the same reference, so no second read can disagree with the first.
    const url = `${authUrl(STAGING)}/`
    expect(assertBrowserSupabaseAuthUrl(url)).toBe(url)
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE F — every Supabase client factory inherits the guard                  */
/* -------------------------------------------------------------------------- */

// The parameters are DECLARED rather than inferred as empty: `mock.calls[0][0]`
// is what proves the factory dialled the URL the guard returned, and an
// untyped spy makes that index unreachable.
const ssr = vi.hoisted(() => ({
  createBrowserClient: vi.fn((_url: string, _anonKey: string) => ({ auth: {} })),
  createServerClient: vi.fn((_url: string, _anonKey: string, _options: unknown) => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
  })),
}))

vi.mock('@supabase/ssr', () => ssr)
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: () => {} })),
}))

describe('the three Supabase client factories inherit the guard', () => {
  const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const ORIGINAL_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  beforeEach(() => {
    ssr.createBrowserClient.mockClear()
    ssr.createServerClient.mockClear()
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'not-a-real-anon-key'
  })

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL
    if (ORIGINAL_KEY === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ORIGINAL_KEY
  })

  // The suite runs with NODE_ENV=test, which SYS-02 resolves to the `test`
  // environment: no pin, therefore no hosted project may be reached. That is
  // itself one of the properties under test — a suite must never be able to
  // authenticate against hosted GoTrue — so it is exercised rather than worked
  // around.

  it('the SERVER factory refuses a hosted Auth URL from a test process', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = authUrl(PRODUCTION)
    const { createClient } = await import('@/lib/supabase/server')
    await expect(createClient()).rejects.toThrowError(SupabaseProjectCoherenceError)
    expect(ssr.createServerClient).not.toHaveBeenCalled()
  })

  it('the SERVER factory dials exactly the URL the guard validated', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_SUPABASE_API_URL
    const { createClient } = await import('@/lib/supabase/server')
    await createClient()
    expect(ssr.createServerClient).toHaveBeenCalledTimes(1)
    expect(ssr.createServerClient.mock.calls[0][0]).toBe(LOCAL_SUPABASE_API_URL)
  })

  it('the PROXY factory refuses a hosted Auth URL from a test process', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = authUrl(PRODUCTION)
    const { updateSession } = await import('@/lib/supabase/proxy')
    const { NextRequest } = await import('next/server')
    await expect(
      updateSession(new NextRequest('https://app.example/app/dashboard'))
    ).rejects.toThrowError(SupabaseProjectCoherenceError)
    expect(ssr.createServerClient).not.toHaveBeenCalled()
  })

  it('the PROXY factory dials exactly the URL the guard validated', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_SUPABASE_API_URL
    const { updateSession } = await import('@/lib/supabase/proxy')
    const { NextRequest } = await import('next/server')
    await updateSession(new NextRequest('https://app.example/'))
    expect(ssr.createServerClient).toHaveBeenCalledTimes(1)
    expect(ssr.createServerClient.mock.calls[0][0]).toBe(LOCAL_SUPABASE_API_URL)
  })

  it('the BROWSER factory refuses a project this application never deploys against', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co'
    const { createClient } = await import('@/lib/supabase/client')
    expect(() => createClient()).toThrowError(SupabaseAuthIdentityError)
    expect(ssr.createBrowserClient).not.toHaveBeenCalled()
  })

  it('the BROWSER factory refuses a lookalike host', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${STAGING}.supabase.co.attacker.example`
    const { createClient } = await import('@/lib/supabase/client')
    expect(() => createClient()).toThrowError(SupabaseAuthIdentityError)
    expect(ssr.createBrowserClient).not.toHaveBeenCalled()
  })

  it('the BROWSER factory dials exactly the URL the guard validated', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = authUrl(STAGING)
    const { createClient } = await import('@/lib/supabase/client')
    createClient()
    expect(ssr.createBrowserClient).toHaveBeenCalledTimes(1)
    expect(ssr.createBrowserClient.mock.calls[0][0]).toBe(authUrl(STAGING))
  })
})

/* -------------------------------------------------------------------------- */
/* PHASE L — no unguarded Supabase client factory may be added                 */
/* -------------------------------------------------------------------------- */

describe('no Supabase client is constructed outside the guarded factories', () => {
  const ROOT = process.cwd()

  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const readSource = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

  /**
   * Every bundled source file that could construct a Supabase client.
   *
   * `scripts/**` and `tests/**` are excluded because they are not part of any
   * bundle and are already gated by `assertSupabaseApiOperationAllowed`, which
   * refuses a non-local target for every local capability.
   */
  const bundledSourceFiles = (): string[] => {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue
          walk(relative)
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          out.push(relative)
        }
      }
    }
    for (const root of ['app', 'lib', 'components', 'hooks', 'db']) walk(root)
    out.push('proxy.ts')
    return out
  }

  it('exactly three bundled modules import a Supabase client SDK, and they are the guarded ones', () => {
    // A new factory anywhere else fails HERE, naming the file, rather than
    // shipping an unguarded Auth client to production.
    const importers = bundledSourceFiles()
      .filter((relative) => /from ['"]@supabase\/(ssr|supabase-js)['"]/.test(readSource(relative)))
      .sort()
    expect(importers).toEqual([
      'lib/supabase/client.ts',
      'lib/supabase/proxy.ts',
      'lib/supabase/server.ts',
    ])
  })

  it.each([
    ['lib/supabase/server.ts', 'assertSupabaseProjectCoherence'],
    ['lib/supabase/proxy.ts', 'assertSupabaseProjectCoherence'],
    ['lib/supabase/client.ts', 'assertBrowserSupabaseAuthUrl'],
  ])('%s calls %s before it constructs a client', (relative, guard) => {
    const source = stripComments(readSource(relative))
    // The guard must run BEFORE the client is built, not merely appear in the
    // file: a check whose result arrives after the socket is a comment.
    const guardAt = source.indexOf(`${guard}(`)
    const clientAt = source.search(/create(Browser|Server)Client\(/)
    expect(guardAt).toBeGreaterThan(-1)
    expect(clientAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(clientAt)
  })

  it.each(['lib/supabase/server.ts', 'lib/supabase/proxy.ts', 'lib/supabase/client.ts'])(
    '%s no longer reads NEXT_PUBLIC_SUPABASE_URL for its own target',
    (relative) => {
      // One read, inside the guard. A factory that re-reads the variable could
      // be handed a different value than the one that was validated — the exact
      // divergence db/client.ts avoids by classifying the string it dials.
      expect(stripComments(readSource(relative))).not.toMatch(
        /process\.env\.NEXT_PUBLIC_SUPABASE_URL/
      )
    }
  )

  it('the browser-safe module never imports a server-only one', () => {
    // Importing lib/supabase/project-coherence.ts here would drag
    // UELLIX_RUNTIME_DATABASE_URL resolution into the browser bundle, and
    // db/safety/local-stack.ts would put a connection string in it.
    const source = readSource('lib/supabase/project-identity.ts')
    expect(source).not.toMatch(/project-coherence/)
    expect(source).not.toMatch(/from '@\/db\/safety\/(database-access|local-stack|resolve-)/)
    expect(stripComments(source)).not.toMatch(/UELLIX_RUNTIME_DATABASE_URL|SERVICE_ROLE/)
  })
})
