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

const AUTH_USER = { id: 'auth-user-1', email: 'user@org.com' }

const DB_USER = {
  id: 'auth-user-1',
  email: 'user@org.com',
  fullName: 'Test User',
  avatarUrl: null,
  isSuperAdmin: false,
}

const DB_MEMBERSHIP = {
  id: 'mem-1',
  organizationId: 'org-1',
  userId: 'auth-user-1',
  role: 'analyst',
  status: 'active',
}

const DB_ORG = {
  id: 'org-1',
  name: 'Test Org',
  slug: 'test-org',
  legalName: null,
  country: null,
  sector: null,
  status: 'active',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDbData.users = []
  mockDbData.organizations = []
  mockDbData.organizationMembers = []
  mockGetUser.mockResolvedValue({ data: { user: null } })
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
      id: 'auth-user-1',
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
  it('returns null when the user has no active membership row', async () => {
    mockDbData.organizationMembers = []

    const result = await getCurrentMembership('auth-user-1')

    expect(result).toBeNull()
  })

  it('returns null when the stored role is not a recognized Role (defensive against DB drift)', async () => {
    mockDbData.organizationMembers = [{ ...DB_MEMBERSHIP, role: 'not-a-real-role' }]

    const result = await getCurrentMembership('auth-user-1')

    expect(result).toBeNull()
  })

  it('returns the mapped Membership for a valid active row', async () => {
    mockDbData.organizationMembers = [DB_MEMBERSHIP]

    const result = await getCurrentMembership('auth-user-1')

    expect(result).toEqual({
      id: 'mem-1',
      organizationId: 'org-1',
      userId: 'auth-user-1',
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

    expect(result.id).toBe('auth-user-1')
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------
describe('requireRole', () => {
  it('redirects to /app/dashboard when the user has no membership', async () => {
    mockDbData.organizationMembers = []

    await expect(requireRole('auth-user-1', 'analyst')).rejects.toThrow(
      'REDIRECT:/app/dashboard'
    )
  })

  it('redirects to /app/dashboard when the membership role is below the threshold', async () => {
    mockDbData.organizationMembers = [{ ...DB_MEMBERSHIP, role: 'viewer' }]

    await expect(requireRole('auth-user-1', 'organization_admin')).rejects.toThrow(
      'REDIRECT:/app/dashboard'
    )
  })

  it('returns the membership when the role meets the threshold', async () => {
    mockDbData.organizationMembers = [{ ...DB_MEMBERSHIP, role: 'organization_admin' }]

    const result = await requireRole('auth-user-1', 'analyst')

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

  it('redirects to /app/onboarding when the membership references a deleted organization', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [] // org row missing/deleted

    await expect(requireOrganizationAccess()).rejects.toThrow('REDIRECT:/app/onboarding')
  })

  it('returns the full OrganizationContext when everything resolves', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [DB_ORG]

    const ctx = await requireOrganizationAccess()

    expect(ctx.user.id).toBe('auth-user-1')
    expect(ctx.membership.organizationId).toBe('org-1')
    expect(ctx.organization.id).toBe('org-1')
    expect(ctx.organization.name).toBe('Test Org')
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

  it('returns null when there is no membership (does not redirect)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = []

    const ctx = await getCurrentOrganizationContext()

    expect(ctx).toBeNull()
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('returns null when the organization row is missing (does not redirect)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = []

    const ctx = await getCurrentOrganizationContext()

    expect(ctx).toBeNull()
  })

  it('returns the full context when everything resolves', async () => {
    mockGetUser.mockResolvedValue({ data: { user: AUTH_USER } })
    mockDbData.users = [DB_USER]
    mockDbData.organizationMembers = [DB_MEMBERSHIP]
    mockDbData.organizations = [DB_ORG]

    const ctx = await getCurrentOrganizationContext()

    expect(ctx?.organization.id).toBe('org-1')
    expect(ctx?.membership.role).toBe('analyst')
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
      id: 'auth-user-1',
      email: 'user@org.com',
      user_metadata: { full_name: 'Test User', avatar_url: 'https://example.com/a.png' },
    })

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'auth-user-1',
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

    await syncUserProfile({ id: 'auth-user-2' })

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'auth-user-2',
        email: '',
        fullName: null,
        avatarUrl: null,
      })
    )
  })
})
