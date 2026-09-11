/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/auth/session.test.ts
// Regression coverage for lib/auth/session.ts — the auth/org-context gate used
// by nearly every service function in the app (requireOrganizationAccess,
// requireAuth, requireRole, getCurrentUser, getCurrentOrganizationContext).
// Previously had zero test coverage despite being mocked everywhere else.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockImplementation(() =>
    Promise.resolve({
      auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    })
  ),
}))

const mockRedirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`)
})
vi.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}))

// S3 — lib/auth/database-context.ts now reads the S2 carrier
// (lib/auth/selected-organization.ts, unmocked and exercised for real below)
// to resolve which organization's membership to derive. That module's only
// dependency is next/headers' `cookies()`, so a minimal fake cookie jar is
// mocked here — the same shape tests/tenancy/s2-selected-org-carrier.test.ts
// already uses.
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

// In-memory table fixtures selected by table name, mirroring the pattern
// already used in tests/proxies.service.test.ts / evidence.service.test.ts
const mockDbData = {
  users: [] as any[],
  organizations: [] as any[],
  organizationMembers: [] as any[],
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table) => {
        const tableName = table?.[Symbol.for('drizzle:Name')] ?? table?._?.name
        let data: any[] = []
        if (tableName === 'users') data = mockDbData.users
        else if (tableName === 'organizations') data = mockDbData.organizations
        else if (tableName === 'organization_members') data = mockDbData.organizationMembers

        const chain = {
          where: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation(() => ({
              then: (cb: (rows: any[]) => unknown) => Promise.resolve(cb(data)),
            })),
            then: (cb: (rows: any[]) => unknown) => Promise.resolve(cb(data)),
          })),
        }
        return chain
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
}))

// The identity context is a pass-through here: this suite proves the auth
// helpers' branching, and it does so against the in-memory tables above. The
// transaction, the claims and the rollback are proved against a live database
// in tests/authenticated-database-context.test.ts.
// CORRECTED under ODS v1.0.26 F_DN_6_ADJUDICATION. This double used to be a
// pass-through whose getBoundDatabaseContext was a CONSTANT returning
// undefined — undefined even WHILE the callback was executing. That is not a
// simplification of the real module, it CONTRADICTS it: db/identity-context.ts
// binds a context for the duration of the callback, and its own nesting check
// reads getBoundDatabaseContext() back during execution.
//
// The lie became load-bearing once the S3 refusal emitter began asserting, at
// emission time, that a context IS bound for the refusal subject. Under the old
// double the guard observed nothing bound and correctly failed closed — the
// DOUBLE was wrong, not the guard, and the guard is deliberately not relaxed to
// accommodate it.
//
// It still opens no transaction and touches no database. It binds through the
// REAL async-local store, so binding and RESTORATION — on return and on throw
// alike, which matters because every refusal path here ends in a throw — come
// from the same mechanism production uses.
vi.mock('@/db/identity-context', async () => {
  const store = await import('@/db/identity-store')
  return {
    withDatabaseIdentityContext: async (
      identity: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
      callback: (db: unknown) => unknown
    ) => {
      // Re-entry with a context already open reuses it, exactly as the real
      // module does; these suites never nest a DIFFERENT identity.
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

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import {
  getCurrentUser,
  getCurrentMembership,
  requireAuth,
  requireRole,
  requireOrganizationAccess,
  requireAdminAccess,
  getCurrentOrganizationContext,
  syncUserProfile,
} from '@/lib/auth/session'
import { SELECTED_ORGANIZATION_COOKIE_NAME } from '@/lib/auth/selected-organization'

/** S3: set the S2 carrier the way a real browser session would. */
function selectOrganization(organizationId: string): void {
  fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, organizationId)
}

// PACKET B — this file mocks supabase.auth.getUser() at the raw GoTrue
// level, so the REAL lib/auth/identity.ts derives `emailVerified` from
// `email_confirmed_at` for every test below. This suite predates Packet B
// and exists to prove Packet A's own branching, so the fixture is pinned
// PROVIDER-CONFIRMED by default — an omitted field here would silently
// measure every test as an unverified subject and redirect all of them to
// /verify-email instead of exercising requireAuth/requireOrganizationAccess
// at all.
const AUTH_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@org.com',
  email_confirmed_at: '2024-01-01T00:00:00.000Z',
}

const DB_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@org.com',
  fullName: 'Test User',
  avatarUrl: null,
  isSuperAdmin: false,
}

const DB_MEMBERSHIP = {
  id: '33333333-3333-4333-8333-333333333333',
  organizationId: '22222222-2222-4222-8222-222222222222',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'analyst',
  status: 'active',
}

const DB_ORG = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Test Org',
  slug: 'test-org',
  legalName: null,
  country: null,
  sector: null,
  status: 'active',
  baseCurrency: 'COP',
  onboardingCompleted: true,
  stellaMonthlyQuota: 250,
  stellaPlanLabel: 'Pilot',
  logoUrl: 'https://example.com/logo.png',
  brandColor: '#112233',
  whiteLabelEnabled: true,
  stripeCustomerId: 'cus_test',
  stripeSubscriptionId: 'sub_test',
  stripePriceId: 'price_test',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDbData.users = []
  mockDbData.organizations = []
  mockDbData.organizationMembers = []
  mockGetUser.mockResolvedValue({ data: { user: null } })
  fakeCookieStore.clear()
})

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------
describe('getCurrentUser', () => {
  it('returns null when there is no Supabase session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const result = await getCurrentUser()

    expect(result).toBeNull()
  })

  it('returns null when the session exists but there is no matching users row', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = []

    const result = await getCurrentUser()

    expect(result).toBeNull()
  })

  it('returns the mapped AuthUser when session and DB row both exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]

    const result = await getCurrentUser()

    expect(result).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@org.com',
      fullName: 'Test User',
      avatarUrl: null,
      isSuperAdmin: false,
    })
  })
})

// ---------------------------------------------------------------------------
// getCurrentMembership
// ---------------------------------------------------------------------------
describe('getCurrentMembership', () => {
  // getCurrentMembership no longer queries: it reads the request principal,
  // which needs a verified session AND a readable users row. Both are set up
  // here for every case in this block. S3: it also needs a SELECTED
  // organization — membership is derived from the (user, selected
  // organization) pair, never pick-first — so each case that expects a real
  // row selects the organization that row belongs to.
  beforeEach(() => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
  })

  it('S3 / TENANCY_NO_ORGANIZATION_SELECTED: returns null when NO organization is selected, even with an active membership row present', async () => {
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    // No selectOrganization() call — the carrier is absent.

    const result = await getCurrentMembership('11111111-1111-4111-8111-111111111111')

    expect(result).toBeNull()
  })

  it('returns null when the user has no active membership row', async () => {
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = []

    const result = await getCurrentMembership('11111111-1111-4111-8111-111111111111')

    expect(result).toBeNull()
  })

  it('returns null when the stored role is not a recognized Role (defensive against DB drift)', async () => {
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [{ ...DB_MEMBERSHIP, role: 'not-a-real-role' }]

    const result = await getCurrentMembership('11111111-1111-4111-8111-111111111111')

    expect(result).toBeNull()
  })

  it('returns the mapped Membership for a valid active row in the SELECTED organization', async () => {
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [DB_MEMBERSHIP]

    const result = await getCurrentMembership('11111111-1111-4111-8111-111111111111')

    expect(result).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      organizationId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'analyst',
      status: 'active',
    })
  })
})

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------
describe('requireAuth', () => {
  it('redirects to /login when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    await expect(requireAuth()).rejects.toThrow('REDIRECT:/login')
  })

  it('returns the AuthUser when authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]

    const result = await requireAuth()

    expect(result.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------
describe('requireRole', () => {
  it('redirects to /app/dashboard when the user has no membership', async () => {
    mockDbData.organizationMembers = []

    await expect(requireRole('11111111-1111-4111-8111-111111111111', 'analyst')).rejects.toThrow(
      'REDIRECT:/app/dashboard'
    )
  })

  it('redirects to /app/dashboard when the membership role is below the threshold', async () => {
    mockDbData.organizationMembers = [{ ...DB_MEMBERSHIP, role: 'viewer' }]

    await expect(requireRole('11111111-1111-4111-8111-111111111111', 'organization_admin')).rejects.toThrow(
      'REDIRECT:/app/dashboard'
    )
  })

  it('returns the membership when the role meets the threshold', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [{ ...DB_MEMBERSHIP, role: 'organization_admin' }]

    const result = await requireRole('11111111-1111-4111-8111-111111111111', 'analyst')

    expect(result.role).toBe('organization_admin')
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// requireOrganizationAccess
// ---------------------------------------------------------------------------
describe('requireOrganizationAccess', () => {
  it('redirects to /login when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    await expect(requireOrganizationAccess()).rejects.toThrow('REDIRECT:/login')
  })

  it('redirects a super admin with no membership to /admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [{ ...DB_USER, isSuperAdmin: true }]
    mockDbData.organizationMembers = []

    await expect(requireOrganizationAccess()).rejects.toThrow('REDIRECT:/admin')
  })

  it('redirects a non-admin with no membership to /app/onboarding', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = []

    await expect(requireOrganizationAccess()).rejects.toThrow('REDIRECT:/app/onboarding')
  })

  it('S3 / single_membership_is_not_an_exception: redirects a non-admin with an ACTIVE membership but NO organization selected to /app/organizations/select — TENANCY-S3-SELECTOR-REACHABILITY (Packet A) makes this exact state P-A1-2: one selectable candidate, no carrier', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [DB_ORG]
    // No selectOrganization() call — an active membership exists, but the
    // carrier is absent. REQUEST_PRINCIPAL_CONTRACT.NO_FALLBACK.
    // single_membership_is_not_an_exception: this is still not an inference —
    // the enumerator finds exactly one candidate and NO_AUTO_SELECTION routes
    // it to the selector rather than choosing on the caller's behalf.

    await expect(requireOrganizationAccess()).rejects.toThrow('REDIRECT:/app/organizations/select')
  })

  it('redirects to /app/onboarding when the SELECTED membership references a deleted organization', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [] // org row missing/deleted

    await expect(requireOrganizationAccess()).rejects.toThrow('REDIRECT:/app/onboarding')
  })

  it('returns the full OrganizationContext when everything resolves', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [DB_ORG]

    const ctx = await requireOrganizationAccess()

    expect(ctx.user.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(ctx.membership.organizationId).toBe('22222222-2222-4222-8222-222222222222')
    expect(ctx.organization.id).toBe('22222222-2222-4222-8222-222222222222')
    expect(ctx.organization.name).toBe('Test Org')
    expect(ctx.organization).toMatchObject({
      baseCurrency: 'COP',
      onboardingCompleted: true,
      stellaMonthlyQuota: 250,
      stellaPlanLabel: 'Pilot',
      whiteLabelEnabled: true,
      stripeCustomerId: 'cus_test',
    })
  })
})

// ---------------------------------------------------------------------------
// requireAdminAccess
// ---------------------------------------------------------------------------
describe('requireAdminAccess', () => {
  it('redirects to /app/dashboard when the user is not a super admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER] // isSuperAdmin: false

    await expect(requireAdminAccess()).rejects.toThrow('REDIRECT:/app/dashboard')
  })

  it('returns the user when they are a super admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [{ ...DB_USER, isSuperAdmin: true }]

    const result = await requireAdminAccess()

    expect(result.isSuperAdmin).toBe(true)
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getCurrentOrganizationContext (non-redirecting variant)
// ---------------------------------------------------------------------------
describe('getCurrentOrganizationContext', () => {
  it('returns null when unauthenticated (does not redirect)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const ctx = await getCurrentOrganizationContext()

    expect(ctx).toBeNull()
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('S3 / TENANCY_NO_ORGANIZATION_SELECTED: returns null when authenticated with an active membership but NO organization selected', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [DB_ORG]
    // No selectOrganization() call.

    const ctx = await getCurrentOrganizationContext()

    expect(ctx).toBeNull()
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('returns null when there is no membership in the SELECTED organization (does not redirect)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = []

    const ctx = await getCurrentOrganizationContext()

    expect(ctx).toBeNull()
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('returns null when the organization row is missing (does not redirect)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = []

    const ctx = await getCurrentOrganizationContext()

    expect(ctx).toBeNull()
  })

  it('returns the full context when everything resolves', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    selectOrganization(DB_MEMBERSHIP.organizationId)
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [DB_ORG]

    const ctx = await getCurrentOrganizationContext()

    expect(ctx?.organization.id).toBe('22222222-2222-4222-8222-222222222222')
    expect(ctx?.membership.role).toBe('analyst')
    expect(ctx?.organization.baseCurrency).toBe('COP')
    expect(ctx?.organization.onboardingCompleted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// syncUserProfile
// ---------------------------------------------------------------------------
describe('syncUserProfile', () => {
  it('upserts using the authUser id, email, and metadata', async () => {
    const { db } = await import('@/db/client')
    const valuesSpy = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any)

    await syncUserProfile({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@org.com',
      user_metadata: { full_name: 'Test User', avatar_url: 'https://example.com/a.png' },
    })

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'user@org.com',
        fullName: 'Test User',
        avatarUrl: 'https://example.com/a.png',
      })
    )
  })

  it('defaults email/fullName/avatarUrl when metadata is absent', async () => {
    const { db } = await import('@/db/client')
    const valuesSpy = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any)

    await syncUserProfile({ id: '44444444-4444-4444-8444-444444444444' })

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '44444444-4444-4444-8444-444444444444',
        email: '',
        fullName: null,
        avatarUrl: null,
      })
    )
  })
})
