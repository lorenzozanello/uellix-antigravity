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

const mockGetUser = vi.fn()
const mockExchangeCodeForSession = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      auth: {
        getUser: () => mockGetUser(),
        exchangeCodeForSession: (code: string) => mockExchangeCodeForSession(code),
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
    const element = await VerifyEmailPage()
    expect(mockRedirect).not.toHaveBeenCalled()
    const markup = JSON.stringify(element)
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
  it('a now-verified subject is redirected to /app/dashboard', async () => {
    verified()
    const location = await locationOf(() => VerifyEmailPage())
    expect(location).toBe('/app/dashboard')
  })

  it('an unauthenticated visitor is redirected to /login', async () => {
    loggedOut()
    const location = await locationOf(() => VerifyEmailPage())
    expect(location).toBe('/login')
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
    const hop2 = await locationOf(() => VerifyEmailPage())
    expect(hop2, 'the walk did not terminate — /verify-email redirected again').toBeNull()

    expect(new Set(hops).size, 'a pathname repeated — the graph cycles').toBe(hops.length)
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-5 — password recovery cannot be trapped by the gate                   */
/* -------------------------------------------------------------------------- */

describe('N-B-5: password recovery cannot bypass, or be bypassed by, the gate', () => {
  it('the callback follows a safe `next` param BEFORE B0, even for an unverified subject, even when next names a protected path', async () => {
    unverified()
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: { id: USER_ID, email_confirmed_at: null } },
      error: null,
    })

    const request = new Request('https://example.test/auth/callback?code=abc123&next=%2Freset-password')
    const response = await authCallback(request)
    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
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
