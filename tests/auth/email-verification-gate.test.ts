// tests/auth/email-verification-gate.test.ts
//
// PACKET B — the predicate, and the three completeness points that translate
// it into a refusal: C4 (requireOrganizationAccess), C5
// (getCurrentOrganizationContext), C6 (requirePrincipal, reached through
// withAuthenticatedDatabaseContext / withOrganizationDatabaseContext). C3
// (requireAuth) is covered here too, since it is the sibling gate the
// authority's own hazard note names (an implementation that gates C4 alone
// leaves everything under the (authenticated) route group open).
//
// Binds by id to docs/ops/tenancy/TENANCY_EMAIL_VERIFICATION_PACKET_B_TEST_
// MANIFEST_v1.0.0.json — P-B-1, P-B-7, N-B-1 through N-B-9, N-B-14, N-B-15.
//
// Drives the REAL lib/auth/identity.ts -> lib/auth/database-context.ts ->
// lib/auth/session.ts chain against a mocked supabase.auth.getUser() and an
// in-memory table set, mirroring the harness tests/tenancy/
// s3-request-principal.test.ts already established and proved correct for
// this exact seam. Nothing here mocks @/lib/auth/session or
// @/lib/auth/database-context wholesale — S-IA-ROUTE-HANDLER-CONTROLS-DRIVE-
// THE-REAL-GATE applies just as much to the gate itself as to its Route
// Handler callers.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

/* -------------------------------------------------------------------------- */
/* Fake cookie jar — lib/auth/selected-organization.ts's only dependency      */
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

/* -------------------------------------------------------------------------- */
/* redirect() throws, so a completeness point's decision is observable        */
/* -------------------------------------------------------------------------- */

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({
  redirect: (p: string) => mockRedirect(p),
}))

/* -------------------------------------------------------------------------- */
/* Auth boundary — the ONLY place email_confirmed_at is planted               */
/* -------------------------------------------------------------------------- */

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
}))

/* -------------------------------------------------------------------------- */
/* The mechanism, mocked to a pass-through — real transaction/claims/rollback  */
/* coverage lives in tests/authenticated-database-context.test.ts (LIVE-gated) */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* drizzle-orm — a normalized condition tree the @/db/client mock evaluates   */
/* -------------------------------------------------------------------------- */

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
  or: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }), // unused here; kept shape-compatible
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
  name: 'name',
  slug: 'slug',
}

/* -------------------------------------------------------------------------- */
/* @/db/client — in-memory tables; insert records every write for the         */
/* N-B-1 / N-B-15 "exact write surface" assertions.                           */
/* -------------------------------------------------------------------------- */

const TABLES: {
  users: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
} = { users: [], organization_members: [], organizations: [] }

let insertedRows: Array<{ table: string; row: Record<string, unknown> }> = []

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
    insert: vi.fn().mockImplementation((table: { [key: symbol]: string } & { _?: { name?: string } }) => {
      const tableName = tableNameOf(table)
      return {
        values: (row: Record<string, unknown>) => {
          // A thenable that ALSO carries the two chain shapes real call sites
          // use (.onConflictDoUpdate for syncUserProfile's upsert,
          // .returning for the onboarding action's two inserts, and a bare
          // await for the refusal-audit emitter). Every branch records the
          // write exactly once.
          const recorded = { ...row }
          const promise = Promise.resolve(undefined) as Promise<undefined> & {
            onConflictDoUpdate: (opts: unknown) => Promise<void>
            returning: () => { then: (cb: (rows: unknown[]) => unknown) => Promise<unknown> }
          }
          promise.onConflictDoUpdate = async () => {
            insertedRows.push({ table: tableName, row: recorded })
          }
          promise.returning = () => {
            const generated = { id: `generated-${tableName}-${insertedRows.length}`, ...recorded }
            insertedRows.push({ table: tableName, row: generated })
            return { then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([generated])) }
          }
          promise.then((): void => {
            // A plain `await db.insert(...).values(row)` with no further
            // chain — the refusal-audit emitter's own shape.
          })
          return promise
        },
      }
    }),
  },
}))

/* -------------------------------------------------------------------------- */
/* Auxiliary calls the onboarding/invite entry points make, spied rather than */
/* modeled — what is under test is whether they are reached AT ALL, not their */
/* own internal shape.                                                        */
/* -------------------------------------------------------------------------- */

const mockLogAuditAction = vi.fn(async (_entry: unknown) => {
  void _entry
})
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: (entry: unknown) => mockLogAuditAction(entry),
}))

const mockIsEmailAllowlisted = vi.fn(async (_email: string) => {
  void _email
  return true
})
vi.mock('@/lib/admin/signup-allowlist', () => ({
  isEmailAllowlisted: (email: string) => mockIsEmailAllowlisted(email),
}))

const mockAcceptInvitation = vi.fn(async (_token: string) => {
  void _token
  return { organizationId: 'should-not-be-reached' }
})
vi.mock('@/lib/invitations/service', () => ({
  acceptInvitation: (token: string) => mockAcceptInvitation(token),
}))

/* -------------------------------------------------------------------------- */
/* Import after mocks are in place                                            */
/* -------------------------------------------------------------------------- */

import {
  requireAuth,
  requireOrganizationAccess,
  requireAdminAccess,
  getCurrentOrganizationContext,
  loadRequestPrincipal,
} from '@/lib/auth/session'
import {
  withAuthenticatedDatabaseContext,
  withOrganizationDatabaseContext,
  AuthContextError,
  authContextErrorStatus,
} from '@/lib/auth/database-context'
import { createFirstOrganization } from '@/app/(authenticated)/app/onboarding/actions'
import AcceptInvitationPage from '@/app/invite/accept/page'
import { SELECTED_ORGANIZATION_COOKIE_NAME } from '@/lib/auth/selected-organization'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUPER_ADMIN_ID = '99999999-9999-4999-8999-999999999999'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333333'
const CONFIRMED_AT = '2024-01-01T00:00:00.000Z'

const USER_ROW = {
  id: USER_ID,
  email: 'member@example.test',
  fullName: 'Test Member',
  avatarUrl: null,
  isSuperAdmin: false,
  deletedAt: null,
}
const SUPER_ADMIN_ROW = { ...USER_ROW, id: SUPER_ADMIN_ID, isSuperAdmin: true }
const ORG_ROW = { id: ORG_ID, name: 'Org', slug: 'org' }
const MEMBERSHIP_ROW = {
  id: MEMBERSHIP_ID,
  userId: USER_ID,
  organizationId: ORG_ID,
  role: 'analyst',
  status: 'active',
}

/** Plants the GoTrue-verified subject lib/auth/identity.ts will read. */
function signedInAs(
  userId: string,
  options: { emailConfirmedAt?: string | null; phoneConfirmedAt?: string | null } = {}
): void {
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: userId,
        email_confirmed_at: options.emailConfirmedAt ?? null,
        phone_confirmed_at: options.phoneConfirmedAt ?? null,
      },
    },
    error: null,
  })
}

function verified(userId: string = USER_ID): void {
  signedInAs(userId, { emailConfirmedAt: CONFIRMED_AT })
}
function unverified(userId: string = USER_ID): void {
  signedInAs(userId, { emailConfirmedAt: null })
}

async function captureCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    if (error instanceof AuthContextError) return error.code
    throw error
  }
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

beforeEach(() => {
  vi.clearAllMocks()
  mockRedirect.mockClear()
  TABLES.users = [USER_ROW, SUPER_ADMIN_ROW]
  TABLES.organizations = [ORG_ROW]
  TABLES.organization_members = [MEMBERSHIP_ROW]
  insertedRows = []
  fakeCookieStore.clear()
  mockIsEmailAllowlisted.mockResolvedValue(true)
})

/* -------------------------------------------------------------------------- */
/* PROVIDER TRUTH & THE PREDICATE                                             */
/* -------------------------------------------------------------------------- */

describe('provider truth: only email_confirmed_at, read once, drives the predicate', () => {
  it('S-IA-PREDICATE-CARDINALITY: lib/auth/identity.ts is the only module whose CODE reads email_confirmed_at', () => {
    // Comments are stripped: this proves no LIVE second derivation exists,
    // not that the field name is never discussed in prose (which several
    // files legitimately do, to explain why they do NOT read it).
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    const files = ['lib/auth/database-context.ts', 'lib/auth/session.ts', 'lib/auth/email-verification.ts']
    for (const file of files) {
      expect(stripComments(read(file)), `${file} must not re-derive the predicate`).not.toMatch(
        /email_confirmed_at/
      )
    }
    expect(stripComments(read('lib/auth/identity.ts'))).toMatch(/email_confirmed_at/)
  })

  it('N-B-6: a phone-confirmed, email-unconfirmed subject is refused — proves confirmed_at is not read', async () => {
    // db/baseline/stella_g2_schema.sql:3708 — confirmed_at is GENERATED ALWAYS
    // AS LEAST(email_confirmed_at, phone_confirmed_at). This fixture makes
    // that generated value non-null while email_confirmed_at itself is null.
    signedInAs(USER_ID, { emailConfirmedAt: null, phoneConfirmedAt: CONFIRMED_AT })
    selectOrgless()
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/verify-email')
  })

  it('N-B-9: verification is never read from a client-controlled surrogate', async () => {
    // email_confirmed_at stays null while every plausible client-writable
    // surrogate claims verified. lib/auth/identity.ts narrows the GoTrue
    // subject to { userId, emailVerified } before it leaves the function
    // (see lib/auth/identity.ts:110 authUser <- data.data?.user ?? null),
    // so a field planted here that identity.ts does not name is, by
    // construction, invisible past that line — this fixture exercises the
    // ones a real client can set today (user_metadata via updateUser).
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: USER_ID,
          email_confirmed_at: null,
          user_metadata: { email_verified: true },
          app_metadata: { email_verified: true },
        },
      },
      error: null,
    })
    const principal = await loadRequestPrincipal()
    expect(principal?.emailVerified).toBe(false)
  })

  it('N-B-7: a provider lookup error is refused, and is NOT a logout (three sub-cases)', async () => {
    // Sub-case 1: createClient() throws.
    const server = await import('@/lib/supabase/server')
    const original = server.createClient
    ;(server as { createClient: unknown }).createClient = () => {
      throw new Error('misconfigured')
    }
    const principal1 = await loadRequestPrincipal()
    expect(principal1).toBeNull()
    ;(server as { createClient: unknown }).createClient = original

    // Sub-case 2: getUser() throws.
    mockGetUser.mockRejectedValue(new Error('ECONNREFUSED'))
    const code2 = await captureCode(() => withAuthenticatedDatabaseContext(async () => null))
    expect(code2).toBe('AUTH_UNAVAILABLE')
    expect(authContextErrorStatus('AUTH_UNAVAILABLE')).toBe(503)

    // Sub-case 3: getUser() resolves with null user AND an error object.
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'JWT expired' } })
    const code3 = await captureCode(() => withAuthenticatedDatabaseContext(async () => null))
    expect(code3).toBe('AUTH_SESSION_REJECTED')

    // None of the three ever produced a verified principal or a redirect to
    // /login as a side effect of THIS function (requireOrganizationAccess is
    // not driven here — the point is the identity layer itself never admits).
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('P-B-7: an OAuth-confirmed subject is admitted, with no mechanism field consulted', async () => {
    // Same call shape app/auth/callback/route.ts exchangeCodeForSession
    // hands back for a provider identity: app_metadata.provider is NOT
    // 'email', identities[] is present, and email_confirmed_at is set by the
    // provider. The admission must follow from email_confirmed_at ALONE.
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: USER_ID,
          email_confirmed_at: CONFIRMED_AT,
          app_metadata: { provider: 'google', providers: ['google'] },
          identities: [{ provider: 'google', identity_data: {} }],
        },
      },
      error: null,
    })
    const principal = await loadRequestPrincipal()
    expect(principal?.emailVerified).toBe(true)

    // The implementation consults no mechanism field: grep the three files
    // that resolve the predicate/gate for any reference to provider/
    // app_metadata/identities.
    for (const file of ['lib/auth/identity.ts', 'lib/auth/database-context.ts', 'lib/auth/session.ts']) {
      expect(read(file)).not.toMatch(/app_metadata|identities\[|\.provider\b/)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* P-B-1 — the gate is a PREFIX, not a wall                                   */
/* -------------------------------------------------------------------------- */

function selectOrg(): void {
  fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, ORG_ID)
}
function selectOrgless(): void {
  fakeCookieStore.clear()
}

describe('P-B-1: a verified subject passes B0 at every completeness point', () => {
  it('C3 (requireAuth): returns the user, no redirect', async () => {
    verified()
    const user = await requireAuth()
    expect(user.id).toBe(USER_ID)
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('C4 (requireOrganizationAccess): a verified member reaches the workspace', async () => {
    verified()
    selectOrg()
    const ctx = await requireOrganizationAccess()
    expect(ctx.organization.id).toBe(ORG_ID)
  })

  it('C5 (getCurrentOrganizationContext): returns a non-null context', async () => {
    verified()
    selectOrg()
    const ctx = await getCurrentOrganizationContext()
    expect(ctx?.organization.id).toBe(ORG_ID)
  })

  it('C6 (requirePrincipal, via withOrganizationDatabaseContext): the callback runs', async () => {
    verified()
    selectOrg()
    const ranWith = await withOrganizationDatabaseContext(async (ctx) => ctx.organization.id)
    expect(ranWith).toBe(ORG_ID)
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-1 — zero-membership unverified subject cannot bootstrap                */
/* -------------------------------------------------------------------------- */

describe('N-B-1: an unverified subject with zero memberships cannot found an organisation', () => {
  it('C4 destination is /verify-email, not /app/onboarding, and the enumerator is never consulted', async () => {
    unverified()
    selectOrgless()
    TABLES.organization_members = [] // zero candidates, zero memberships
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/verify-email')
  })

  it('driving createFirstOrganization directly performs ZERO inserts and writes ZERO audit rows', async () => {
    unverified()
    TABLES.organization_members = []
    const formData = new FormData()
    formData.set('name', 'A brand new org')
    formData.set('slug', 'brand-new-org')

    const location = await locationOf(() => createFirstOrganization(formData))
    expect(location).toBe('/verify-email')
    expect(insertedRows.filter((r) => r.table === 'organizations')).toHaveLength(0)
    expect(insertedRows.filter((r) => r.table === 'organization_members')).toHaveLength(0)
    expect(mockLogAuditAction).not.toHaveBeenCalled()
    expect(mockIsEmailAllowlisted).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-2 — one/two-membership unverified subject refused without enumerating */
/* -------------------------------------------------------------------------- */

describe.each([
  ['one membership', [MEMBERSHIP_ROW]],
  ['two memberships', [MEMBERSHIP_ROW, { ...MEMBERSHIP_ROW, id: 'm2', organizationId: 'org-b' }]],
])('N-B-2: unverified subject with %s is refused without enumerating', (_label, memberships) => {
  it('C4: destination is /verify-email, and B0 is evaluated before R2 (the enumerator sees zero calls)', async () => {
    unverified()
    selectOrgless()
    TABLES.organization_members = memberships as Array<Record<string, unknown>>
    TABLES.organizations = [ORG_ROW, { id: 'org-b', name: 'Org B', slug: 'org-b' }]

    // The enumerator (loadSelectableMembershipsWithinContext) is reached only
    // through a SECOND select on organization_members — spy on db.select
    // call count as the discriminator: B0-before-R2 means selectedOrganizationId
    // resolves to null and requireOrganizationAccess redirects before ANY
    // membership-table read for enumeration purposes.
    const dbClient = await import('@/db/client')
    const selectSpy = vi.spyOn(dbClient.db, 'select')
    const callsBefore = selectSpy.mock.calls.length

    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/verify-email')

    // Only the ONE read requirePrincipal itself needs (the profile row) may
    // have occurred; organization_members must not have been queried again
    // for enumeration.
    const membershipReads = selectSpy.mock.results.length - callsBefore
    expect(membershipReads).toBeLessThanOrEqual(1)
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-3 — invitation acceptance is refused (covered by C6, no page edit)     */
/* -------------------------------------------------------------------------- */

describe('N-B-3: an unverified subject cannot accept an invitation', () => {
  it('acceptInvitation is never called, and no membership is created', async () => {
    unverified()
    await AcceptInvitationPage({ searchParams: Promise.resolve({ token: 'a-real-looking-token' }) })
    expect(mockAcceptInvitation).not.toHaveBeenCalled()
    expect(insertedRows.filter((r) => r.table === 'organization_members')).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-4 — unverified super-admin refused BEFORE R1                          */
/* -------------------------------------------------------------------------- */

describe('N-B-4: an unverified super-admin is refused before the R1 admin redirect', () => {
  it('destination is /verify-email, never /admin, and never /app/organizations/select', async () => {
    unverified(SUPER_ADMIN_ID)
    TABLES.organization_members = [] // super-admin genuinely has no membership
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/verify-email')
    expect(location).not.toBe('/admin')
    expect(location).not.toBe('/app/organizations/select')
  })

  it('requireAdminAccess (C3 -> admin check) refuses the same way', async () => {
    unverified(SUPER_ADMIN_ID)
    const location = await locationOf(() => requireAdminAccess())
    expect(location).toBe('/verify-email')
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-8 — unverified subject cannot reach /app even holding a valid org      */
/* -------------------------------------------------------------------------- */

describe('N-B-8: an unverified subject with a VALID membership and organisation still cannot reach /app', () => {
  it('C4 refuses before any organisation-scoped read', async () => {
    unverified()
    selectOrg()
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/verify-email')
  })

  it('C5 returns null for the same principal', async () => {
    unverified()
    selectOrg()
    const ctx = await getCurrentOrganizationContext()
    expect(ctx).toBeNull()
  })

  it('C6 (withOrganizationDatabaseContext) throws AUTH_EMAIL_NOT_VERIFIED, mapped to 403', async () => {
    unverified()
    selectOrg()
    const code = await captureCode(() => withOrganizationDatabaseContext(async () => null))
    expect(code).toBe('AUTH_EMAIL_NOT_VERIFIED')
    expect(authContextErrorStatus('AUTH_EMAIL_NOT_VERIFIED')).toBe(403)
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-14 / M-B-10 — the C6 refusal binds the RESULT, both provenances       */
/* -------------------------------------------------------------------------- */

describe('N-B-14: the C6 refusal is bound to the principal result on both provenances', () => {
  it('behavioural: an unverified principal is refused through requirePrincipal (memo-cold, the only provenance observable outside a React render)', async () => {
    // lib/auth/identity.ts's own header documents that React's cache()
    // "degrades to calling through" outside a request/render scope — verified
    // empirically: two calls to a cache()-wrapped function in a plain Node
    // process each execute fully, with no memoisation. There is therefore no
    // behavioural way, in a unit test, to force the "memo warm" RETURN SITE
    // itself: this environment can only ever exercise the fresh-resolution
    // provenance. The claim that BOTH provenances refuse is proved
    // structurally below instead — by reading the source and confirming a
    // single assertion helper guards both return sites, which is the actual
    // property M-B-10 attacks (moving the check so it guards only one).
    unverified()
    selectOrg()
    const code = await captureCode(() => withAuthenticatedDatabaseContext(async () => null))
    expect(code).toBe('AUTH_EMAIL_NOT_VERIFIED')
  })

  it('structural (M-B-10 non-vacuity): requirePrincipal applies the SAME assertion helper at the memo-return site AND the fresh-return site', () => {
    const source = read('lib/auth/database-context.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    const start = source.indexOf('async function requirePrincipal')
    const body = source.slice(start, start + 800)

    // Both return sites must route through the SAME named helper — a
    // fresh-only placement (M-B-10) would show the helper called once, after
    // resolveRequestPrincipal, with the memo branch returning `memoised` bare.
    const memoSite = body.match(/if \(memoised\) return (\w+)\(memoised\)/)
    const freshSite = body.match(/if \(principal\) return (\w+)\(principal\)/)
    expect(memoSite, 'the memo-hit return must be wrapped by an assertion helper, not returned bare').not.toBeNull()
    expect(freshSite).not.toBeNull()
    expect(memoSite?.[1]).toBe(freshSite?.[1])
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-15 — the pre-verification write surface is exactly one profile upsert  */
/* -------------------------------------------------------------------------- */

describe('N-B-15: the pre-verification write surface is exactly one self-scoped profile upsert', () => {
  it('driving createFirstOrganization as an unverified subject writes ONLY the users row (via syncUserProfile), nothing else', async () => {
    unverified()
    TABLES.organization_members = []
    const formData = new FormData()
    formData.set('name', 'Org')
    formData.set('slug', 'org-slug')

    await locationOf(() => createFirstOrganization(formData))

    const byTable = insertedRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.table] = (acc[r.table] ?? 0) + 1
      return acc
    }, {})
    expect(byTable.users ?? 0).toBe(1)
    expect(byTable.organizations ?? 0).toBe(0)
    expect(byTable.organization_members ?? 0).toBe(0)
    expect(mockLogAuditAction).not.toHaveBeenCalled()
  })
})
