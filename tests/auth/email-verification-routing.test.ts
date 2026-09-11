// tests/auth/email-verification-routing.test.ts
//
// PACKET B — the destination itself (app/(public)/verify-email/page.tsx),
// the auth callback's B0 translation, and the termination proof for the
// redirect graph B0 adds.
//
// Binds by id to docs/ops/tenancy/TENANCY_EMAIL_VERIFICATION_PACKET_B_TEST_
// MANIFEST_v1.0.0.json — P-B-8, P-B-9, T-B-1, N-B-5.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/* -------------------------------------------------------------------------- */
/* Same harness as tests/auth/email-verification-gate.test.ts                */
/* -------------------------------------------------------------------------- */

interface StoredCookie {
  value: string
}
class FakeCookieStore {
  private readonly entries = new Map<string, StoredCookie>()
  get(name: string): { name: string; value: string } | undefined {
    const entry = this.entries.get(name)
    return entry ? { name, value: entry.value } : undefined
  }
  set(name: string, value: string): void {
    this.entries.set(name, { value })
  }
  delete(nameOrOptions: string | { name: string }): void {
    this.entries.delete(typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name)
  }
  clear(): void {
    this.entries.clear()
  }
}
const fakeCookieStore = new FakeCookieStore()
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => fakeCookieStore),
}))

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({
  redirect: (p: string) => mockRedirect(p),
}))

// signup()/login() call this outside a real request scope in this harness;
// Next.js's revalidatePath needs a static-generation store that only exists
// inside an actual request. No assertion in this file depends on real cache
// invalidation.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

const mockGetUser = vi.fn()
const mockExchangeCodeForSession = vi.fn()
const mockSignUp = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      auth: {
        getUser: () => mockGetUser(),
        exchangeCodeForSession: (code: string) => mockExchangeCodeForSession(code),
        signUp: (credentials: unknown) => mockSignUp(credentials),
      },
    }),
}))

vi.mock('@/db/identity-context', async () => {
  const store = await import('@/db/identity-store')
  return {
    withDatabaseIdentityContext: async (
      identity: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
      callback: (db: unknown) => unknown
    ) => {
      const existing = store.getBoundDatabaseContext()
      if (existing !== undefined) return callback(existing.db)
      return store.runWithBoundDatabaseContext(
        { identity, db: undefined } as never,
        (async () => callback(undefined)) as () => Promise<never>
      )
    },
    getBoundDatabaseContext: () => store.getBoundDatabaseContext(),
  }
})

interface EqCondition {
  readonly __type: 'eq'
  readonly columnName: string
  readonly value: unknown
}
interface AndCondition {
  readonly __type: 'and'
  readonly conditions: unknown[]
}
interface IsNullCondition {
  readonly __type: 'isNull'
  readonly columnName: string
}
type Condition = EqCondition | AndCondition | IsNullCondition

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown): EqCondition => ({
    __type: 'eq',
    columnName: column.name,
    value,
  }),
  and: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }): IsNullCondition => ({ __type: 'isNull', columnName: column.name }),
}))

function evaluateCondition(condition: Condition, row: Record<string, unknown>): boolean {
  if (condition.__type === 'and') {
    return condition.conditions.every((c) => evaluateCondition(c as Condition, row))
  }
  if (condition.__type === 'eq') {
    return row[JS_KEY_BY_COLUMN_NAME[condition.columnName] ?? condition.columnName] === condition.value
  }
  return row[JS_KEY_BY_COLUMN_NAME[condition.columnName] ?? condition.columnName] == null
}

const JS_KEY_BY_COLUMN_NAME: Record<string, string> = {
  id: 'id',
  user_id: 'userId',
  organization_id: 'organizationId',
  status: 'status',
  role: 'role',
  email: 'email',
  deleted_at: 'deletedAt',
  full_name: 'fullName',
  avatar_url: 'avatarUrl',
  is_super_admin: 'isSuperAdmin',
}

const TABLES: {
  users: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
} = { users: [], organization_members: [], organizations: [] }

function tableNameOf(table: { [key: symbol]: string } & { _?: { name?: string } }): string {
  return (table[Symbol.for('drizzle:Name')] as unknown as string) ?? table._?.name ?? 'unknown'
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string } & { _?: { name?: string } }) => {
        const tableName = tableNameOf(table)
        const data = (TABLES as Record<string, Array<Record<string, unknown>>>)[tableName] ?? []
        return {
          where: vi.fn().mockImplementation((condition: Condition) => {
            const filtered = data.filter((row) => evaluateCondition(condition, row))
            return {
              limit: vi.fn().mockImplementation((n: number) => ({
                then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered.slice(0, n))),
              })),
              then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered)),
            }
          }),
        }
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: (row: Record<string, unknown>) => {
        const promise = Promise.resolve(undefined) as Promise<undefined> & {
          onConflictDoUpdate: (opts: unknown) => Promise<void>
        }
        promise.onConflictDoUpdate = async () => undefined
        void row
        return promise
      },
    })),
  },
}))

vi.mock('@/lib/audit/logger', () => ({ logAuditAction: vi.fn(async () => undefined) }))

/* -------------------------------------------------------------------------- */
/* Import after mocks                                                        */
/* -------------------------------------------------------------------------- */

import { requireOrganizationAccess } from '@/lib/auth/session'
import VerifyEmailPage from '@/app/(public)/verify-email/page'
import { GET as authCallback } from '@/app/auth/callback/route'
import { signup } from '@/app/(public)/login/actions'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const CONFIRMED_AT = '2024-01-01T00:00:00.000Z'

const USER_ROW = {
  id: USER_ID,
  email: 'member@example.test',
  fullName: 'Test Member',
  avatarUrl: null,
  isSuperAdmin: false,
  deletedAt: null,
}
const ORG_ROW = { id: ORG_ID, name: 'Org', slug: 'org' }
const MEMBERSHIP_ROW = { id: 'm1', userId: USER_ID, organizationId: ORG_ID, role: 'analyst', status: 'active' }

function signedInAs(userId: string, emailConfirmedAt: string | null): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email_confirmed_at: emailConfirmedAt } },
    error: null,
  })
}
function verified(): void {
  signedInAs(USER_ID, CONFIRMED_AT)
}
function unverified(): void {
  signedInAs(USER_ID, null)
}
function loggedOut(): void {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
}
function selectOrg(): void {
  fakeCookieStore.set('uellix_selected_organization_id', ORG_ID)
}

async function locationOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    const message = (error as Error).message
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length)
    throw error
  }
}

/**
 * BV independent audit (LANE IL-R3): every content assertion in this file
 * used to read `JSON.stringify(await VerifyEmailPage(...))` — the UNRENDERED
 * element. `VerifyEmailPage` returns `<GenericVerificationPending />` or
 * `<SubjectAwareVerificationPending email={...} />`: a shallow element whose
 * `type` is a FUNCTION REFERENCE. `JSON.stringify` drops function-valued
 * properties silently, so the entire subtree those components would produce
 * — every string of copy, every form, every button — was NEVER serialized.
 * Verified empirically: `JSON.stringify(React.createElement(Outer))` where
 * `Outer` renders `<p>secret-text-here</p>` yields
 * `{"key":null,"props":{},"_owner":null,"_store":{}}` — no trace of the text.
 * Every prior N-BNS and P-BNS content assertion built on that oracle was vacuous:
 * `not.toContain(X)` passed regardless of X because there was nothing to
 * contain X in the first place.
 *
 * This helper actually RENDERS the returned element to static HTML via
 * `react-dom/server`, so assertions observe real text, attributes, forms,
 * buttons and descendants — the same output a browser would receive.
 */
async function renderedMarkupOf(run: () => Promise<unknown>): Promise<string> {
  const element = await run()
  return renderToStaticMarkup(element as ReactElement)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRedirect.mockClear()
  TABLES.users = [USER_ROW]
  TABLES.organizations = [ORG_ROW]
  TABLES.organization_members = [MEMBERSHIP_ROW]
  fakeCookieStore.clear()
})

/* -------------------------------------------------------------------------- */
/* P-B-8 — the destination itself                                            */
/* -------------------------------------------------------------------------- */

describe('P-B-8: /verify-email is terminal for an authenticated unverified subject', () => {
  it('renders (no redirect) and shows the pending address, not the subject id', async () => {
    unverified()
    const markup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(mockRedirect).not.toHaveBeenCalled()
    expect(markup).toContain(USER_ROW.email)
    expect(markup).not.toContain(USER_ID)
  })

  it('reads the principal WITHOUT calling requireAuth() or requireOrganizationAccess()', () => {
    const source = stripComments(read('app/(public)/verify-email/page.tsx'))
    expect(source).not.toMatch(/requireAuth\s*\(/)
    expect(source).not.toMatch(/requireOrganizationAccess\s*\(/)
    expect(source).toMatch(/loadRequestPrincipal\s*\(/)
  })
})

/* -------------------------------------------------------------------------- */
/* P-B-9 — not a dead end                                                    */
/* -------------------------------------------------------------------------- */

describe('P-B-9: /verify-email is not a dead end', () => {
  it('a now-verified subject is redirected to /app/dashboard (FIRST assertion — UNCHANGED, not superseded)', async () => {
    verified()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location).toBe('/app/dashboard')
  })

  // AM-B-S2 (docs/ops/tenancy/TENANCY_EMAIL_VERIFICATION_PACKET_B_NO_SESSION_
  // AUTHORITY_AMENDMENT_v1.0.0.json): P-B-9's SECOND assertion — that an
  // UNAUTHENTICATED visitor is redirected to /login — is SUPERSEDED. This is
  // the ONE permitted edit to a frozen control, and it is bounded to exactly
  // this assertion; the first assertion above is untouched. Replaced by
  // P-BNS-2/P-BNS-3 below.
  it('AM-B-S2: an unauthenticated visitor RENDERS the generic state and is NOT redirected to /login', async () => {
    loggedOut()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location, 'AM-B-S2 supersedes the redirect-to-/login behaviour for the no-session case').toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* RAT-EV-01 — the no-session state (docs/ops/tenancy/                       */
/* TENANCY_EMAIL_VERIFICATION_PACKET_B_NO_SESSION_{AUTHORITY,TEST_MANIFEST}_  */
/* AMENDMENT_v1.0.0.json)                                                    */
/* -------------------------------------------------------------------------- */

const SIGNUP_RATE_LIMIT_EMAIL_COUNTER = { n: 0 }
function freshSignupFormData(): FormData {
  SIGNUP_RATE_LIMIT_EMAIL_COUNTER.n += 1
  const fd = new FormData()
  fd.set('email', `no-session-${SIGNUP_RATE_LIMIT_EMAIL_COUNTER.n}@example.test`)
  fd.set('password', 'correct-horse-battery')
  return fd
}

describe('P-BNS-1: successful signup with NO session reaches and RENDERS the generic state', () => {
  it('signup(user != null, session == null) -> /verify-email -> RENDER, never /login', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null }, session: null },
      error: null,
    })

    const hop1 = await locationOf(() => signup(freshSignupFormData()))
    expect(hop1).toBe('/verify-email')

    // Hop 2 — the no-session destination itself. No cookie was ever set (no
    // session), so the principal cannot resolve.
    loggedOut()
    const hop2 = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(hop2, 'the walk did not terminate by rendering').toBeNull()
  })
})

describe('P-BNS-2 / P-BNS-3: a direct anonymous visit and an expired-session visit are FORCED to be identical (AM-B-N2)', () => {
  it('anonymous (no session at all) renders the generic state', async () => {
    loggedOut()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location).toBeNull()
  })

  it('expired/rejected session renders IDENTICAL rendered HTML to the anonymous case', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'JWT expired' } })
    const expiredMarkup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))

    loggedOut()
    const anonymousMarkup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))

    // Real rendered HTML compared directly — not the props of an unrendered
    // element. Both must be non-trivial (prove the comparison isn't
    // vacuously equal on two empty strings) and byte-identical to each other.
    expect(expiredMarkup.length).toBeGreaterThan(20)
    expect(expiredMarkup).toBe(anonymousMarkup)
  })

  it('the generic branch never touches the selected-organization carrier', () => {
    const source = read('app/(public)/verify-email/page.tsx')
    expect(source).not.toMatch(/selected-organization/)
  })
})

describe('P-BNS-4: an authenticated unverified subject sees ONLY its own subject identity, sourced from the principal', () => {
  it('shows the principal\'s own address, ignoring a different address supplied in the query string', async () => {
    unverified()
    const markup = await renderedMarkupOf(() =>
      VerifyEmailPage({
        searchParams: Promise.resolve({ next: undefined, email: 'attacker-supplied@example.test' } as never),
      })
    )
    expect(markup).toContain(USER_ROW.email)
    expect(markup).not.toContain('attacker-supplied@example.test')
  })

  it('discloses no tenancy: no organization name appears', async () => {
    unverified()
    const markup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(markup).not.toContain(ORG_ROW.name)
  })
})

describe('P-BNS-5: an authenticated VERIFIED subject exits with Packet A semantics intact, no auto-selection', () => {
  it('exits to /app/dashboard (deferring to C4/requireOrganizationAccess, not selecting anything itself)', async () => {
    verified()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location).toBe('/app/dashboard')
  })

  it('honours a carried, validated `next` over the default', async () => {
    verified()
    const location = await locationOf(() =>
      VerifyEmailPage({ searchParams: Promise.resolve({ next: '/app/organization' }) })
    )
    expect(location).toBe('/app/organization')
  })

  it('rejects an UNSAFE next and falls back to the default', async () => {
    verified()
    const location = await locationOf(() =>
      VerifyEmailPage({ searchParams: Promise.resolve({ next: 'https://evil.example/phish' }) })
    )
    expect(location).toBe('/app/dashboard')
  })

  it('performs no tenancy selection of its own: does not import the enumerator or the carrier writer', () => {
    const source = read('app/(public)/verify-email/page.tsx')
    expect(source).not.toMatch(/listSelectableMemberships|setSelectedOrganization|selected-organization/)
  })
})

describe('N-BNS-1: no redirect at all is issued for any of the three no-session conditions', () => {
  it.each([
    ['anonymous', () => loggedOut()],
    ['post-signup no-session', () => loggedOut()],
    ['expired session', () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'expired' } })],
  ])('%s: response is a RENDER, not a redirect to /login or anywhere else', async (_label, setup) => {
    setup()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location).toBeNull()
  })
})

describe('N-BNS-2: no identity can be injected from the request, including for display only', () => {
  const SENTINEL = 'sentinel-injected-value@example.test'

  it('a sentinel supplied via searchParams never appears in the no-session render', async () => {
    loggedOut()
    const markup = await renderedMarkupOf(() =>
      VerifyEmailPage({ searchParams: Promise.resolve({ email: SENTINEL, user: SENTINEL } as never) })
    )
    expect(markup).not.toContain(SENTINEL)
  })
})

describe('N-BNS-3: no query parameter can select which representation is rendered', () => {
  it.each(['pending=1', 'signup=1', 'state=authenticated', 'verified=true'])(
    'no-session + ?%s still renders the GENERIC state, never the subject-aware one',
    async (paramPair) => {
      loggedOut()
      const [key, value] = paramPair.split('=')
      const markup = await renderedMarkupOf(() =>
        VerifyEmailPage({ searchParams: Promise.resolve({ [key]: value } as never) })
      )
      expect(markup).not.toContain(USER_ROW.email)
      // Not merely "no email" — must be the ACTUAL generic copy, proving the
      // branch itself did not shift, not just that this one field is absent.
      expect(markup).toContain('verificación')
    }
  )

  it('an authenticated unverified principal still renders the SUBJECT-AWARE state regardless of a suppressing param', async () => {
    unverified()
    const markup = await renderedMarkupOf(() =>
      VerifyEmailPage({ searchParams: Promise.resolve({ generic: '1', anonymous: 'true' } as never) })
    )
    expect(markup).toContain(USER_ROW.email)
  })
})

describe('N-BNS-4: the generic state discloses no email, no account and no tenancy', () => {
  it('contains none of: an email address, the subject id, or the organisation name', async () => {
    loggedOut()
    const markup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(markup.length, 'the render produced no content at all — the oracle is vacuous').toBeGreaterThan(20)
    expect(markup).not.toContain(USER_ROW.email)
    expect(markup).not.toContain(USER_ID)
    expect(markup).not.toContain(ORG_ROW.name)
  })

  it('contains no second-person possessive presupposing an account ("tu correo", "tu cuenta", "tu enlace")', async () => {
    loggedOut()
    const markup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(markup).not.toMatch(/tu correo|tu cuenta|tu enlace|te enviamos|tu bandeja/i)
  })
})

describe('N-BNS-5: there is no resend action in any state', () => {
  it('the generic (no-session) state has no <form> and no <button> in the rendered HTML', async () => {
    loggedOut()
    const markup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(markup.length).toBeGreaterThan(20)
    expect(markup).not.toMatch(/<form[\s>]/i)
    expect(markup).not.toMatch(/<button[\s>]/i)
  })

  it('the subject-aware (authenticated unverified) state has exactly the sign-out form, nothing that re-sends mail', async () => {
    unverified()
    const markup = await renderedMarkupOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    // Exactly one form, posting to /auth/signout — never to a resend
    // endpoint, and no fetch/action string mentioning resend anywhere.
    const formMatches = markup.match(/<form[\s>]/gi) ?? []
    expect(formMatches).toHaveLength(1)
    expect(markup).toContain('action="/auth/signout"')
    expect(markup).not.toMatch(/resend|reenviar/i)
  })

  it('the page source contains no resend call, no provider write and no route handler for resending', () => {
    const source = stripComments(read('app/(public)/verify-email/page.tsx'))
    expect(source).not.toMatch(/resend|reenviar|resendVerification/i)
  })
})

/* -------------------------------------------------------------------------- */
/* T-B-1 — the longest constructible walk terminates                         */
/* -------------------------------------------------------------------------- */

describe('T-B-1: /login -> /app/dashboard -> /verify-email terminates in two hops, no repeated state', () => {
  it('an unverified subject holding a valid membership: workspace gate redirects to /verify-email, which then RENDERS', async () => {
    unverified()
    selectOrg()

    const hops: string[] = ['/app/dashboard']

    // Hop 1: app/app/layout.tsx -> requireOrganizationAccess (C4).
    const hop1 = await locationOf(() => requireOrganizationAccess())
    expect(hop1).toBe('/verify-email')
    hops.push(hop1!)

    // Hop 2: the destination itself. Must RENDER, not redirect again.
    const hop2 = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(hop2, 'the walk did not terminate — /verify-email redirected again').toBeNull()

    expect(new Set(hops).size, 'a pathname repeated — the graph cycles').toBe(hops.length)
  })

  // P-BNS-6: the parent's three-behaviour enumeration is extended to FOUR
  // states (ROUTING_TERMINATION). Not a weakening of T-B-1 — its assertion
  // (every walk terminates, no repeated state) is unchanged; only the driven
  // edge set grows to cover the state RAT-EV-01 now names.
  it('P-BNS-6: state B (signup, no session) terminates at length two: signup -> /verify-email -> RENDER', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null }, session: null },
      error: null,
    })
    const hops: string[] = []

    const hop1 = await locationOf(() => signup(freshSignupFormData()))
    expect(hop1).toBe('/verify-email')
    hops.push(hop1!)

    loggedOut()
    const hop2 = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(hop2).toBeNull()

    expect(new Set(hops).size).toBe(hops.length)
  })

  it('P-BNS-6: state A (anonymous) terminates at length zero: a direct visit RENDERS immediately', async () => {
    loggedOut()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location).toBeNull()
  })

  it('P-BNS-6: state D (verified) terminates at length one: redirect out of the contract, never back into it', async () => {
    verified()
    const location = await locationOf(() => VerifyEmailPage({ searchParams: Promise.resolve({}) }))
    expect(location).not.toBe('/verify-email')
    expect(location).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-5 — password recovery cannot be trapped by the gate                   */
/* -------------------------------------------------------------------------- */

describe('N-B-5 / N-BNS-6 / N-BNS-7: a safe `next` NEVER outranks B0 — the corrected direction', () => {
  // IM's audit of PR136 R1 found the FIRST version of this test asserted the
  // OPPOSITE of the frozen control: it affirmed that a safe `next` was
  // honoured BEFORE B0, which is exactly the shape N-B-5 exists to catch. An
  // inverted test is the most dangerous defect class in this packet because
  // it is GREEN. This block asserts the frozen semantic in its ORIGINAL
  // direction: N_B_5_NOT_AMENDED (the no-session authority amendment leaves
  // N-B-5 untouched) and N-BNS-6/N-BNS-7 (docs/ops/tenancy/
  // TENANCY_EMAIL_VERIFICATION_PACKET_B_NO_SESSION_TEST_MANIFEST_AMENDMENT_
  // v1.0.0.json) restate it precisely because IM measured an implementation
  // that got it backwards.

  it.each([
    ['a next naming a protected path', '/reset-password'],
    ['a next naming an unprotected path', '/app/dashboard'],
  ])('N-BNS-6: unverified + safe next (%s) -> /verify-email, NEVER the next target', async (_label, nextPath) => {
    unverified()
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null } },
      error: null,
    })

    const request = new Request(
      `https://example.test/auth/callback?code=abc123&next=${encodeURIComponent(nextPath)}`
    )
    const response = await authCallback(request)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('/verify-email')
    expect(location).not.toContain(nextPath)
  })

  it('N-BNS-6: the next target is CARRIED FORWARD across the refusal, not discarded, so the journey can resume after confirmation', async () => {
    unverified()
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null } },
      error: null,
    })

    const request = new Request(
      'https://example.test/auth/callback?code=abc123&next=%2Finvite%2Faccept%3Ftoken%3Dabc'
    )
    const response = await authCallback(request)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('/verify-email')
    // Carried forward as a query parameter on the refusal destination — NOT
    // honoured as the redirect target itself (that would be the inversion).
    expect(location).toContain(encodeURIComponent('/invite/accept?token=abc'))
  })

  it('N-BNS-7 (= corrected N-B-5, recovery case): the ORIGINAL semantic — refusal, not admission', async () => {
    // Same fixture shape as the recovery-return path: an unverified subject
    // arriving through the callback with a safe next naming a protected
    // path. The frozen control asserts the REFUSAL.
    unverified()
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null } },
      error: null,
    })

    const request = new Request('https://example.test/auth/callback?code=abc123&next=%2Freset-password')
    const response = await authCallback(request)
    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(response.headers.get('location')).not.toContain('/reset-password')
    expect(response.headers.get('location')).toContain('/verify-email')
  })

  it('a VERIFIED subject with a safe next DOES proceed to the governed target — B0 is a prefix, not a universal block', async () => {
    verified()
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: CONFIRMED_AT } },
      error: null,
    })

    const request = new Request('https://example.test/auth/callback?code=abc123&next=%2Freset-password')
    const response = await authCallback(request)
    expect(response.headers.get('location')).toContain('/reset-password')
  })

  it('without a next param, an unverified subject from the callback is routed to /verify-email, not onboarding or dashboard', async () => {
    unverified()
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null } },
      error: null,
    })

    const request = new Request('https://example.test/auth/callback?code=abc123')
    const response = await authCallback(request)
    expect(response.headers.get('location')).toContain('/verify-email')
  })

  it('the password-change action itself is NOT gated — trapping an unrecoverable account is worse than a credential rotation that grants nothing', () => {
    const source = stripComments(read('app/(public)/reset-password/actions.ts'))
    expect(source).not.toMatch(/requireAuth|requireOrganizationAccess|loadRequestPrincipal|VERIFY_EMAIL_PATH/)
    // Still reads the session directly, exactly as at BASE.
    expect(source).toMatch(/supabase\.auth\.getUser\s*\(\s*\)/)
  })

  it('no new redirect-target vocabulary was introduced: the callback still validates next with the existing isSafeRedirectPath', () => {
    const source = read('app/auth/callback/route.ts')
    expect(source).toMatch(/isSafeRedirectPath\(nextParam\)/)
  })
})
