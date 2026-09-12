// tests/auth/legal-acceptance-enforcement.test.ts
//
// CL-1 (docs/ops/compliance/CUSTOMER_LIFECYCLE_CL1_EXECUTION_AUTHORITY_v1.0.0.json,
// HPO-ODS-W2-28) — L0 enforcement topology: K3 (requireAuth), K4
// (requireOrganizationAccess), K5 (getCurrentOrganizationContext), K6
// (requirePrincipal, reached through withAuthenticatedDatabaseContext).
//
// Drives the REAL lib/auth/identity.ts -> lib/auth/database-context.ts ->
// lib/auth/session.ts chain against a mocked supabase.auth.getUser() and an
// in-memory table set, mirroring tests/auth/email-verification-gate.test.ts
// (Packet B's own suite for the same seam). Only lib/auth/legal-acceptance.ts
// is mocked directly — deriveAccountAcceptanceCurrent is the ONE derivation
// site (S-AO-PREDICATE-CARDINALITY) and its own correctness is proven at the
// database boundary in tests/postgres/legal-acceptance.pg.test.ts; this file
// proves what CONSUMES its answer.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

/* -------------------------------------------------------------------------- */
/* Fake cookie jar                                                            */
/* -------------------------------------------------------------------------- */

class FakeCookieStore {
  private readonly entries = new Map<string, { value: string }>()
  get(name: string) {
    const entry = this.entries.get(name)
    return entry ? { name, value: entry.value } : undefined
  }
  set(name: string, value: string) {
    this.entries.set(name, { value })
  }
  delete(nameOrOptions: string | { name: string }) {
    this.entries.delete(typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name)
  }
  clear() {
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
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
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

/* -------------------------------------------------------------------------- */
/* The ONE derivation site, mocked and controlled per test                    */
/* -------------------------------------------------------------------------- */

const mockDeriveAccountAcceptanceCurrent = vi.fn(async (_userId: string) => true)
vi.mock('@/lib/auth/legal-acceptance', () => ({
  deriveAccountAcceptanceCurrent: (userId: string) => mockDeriveAccountAcceptanceCurrent(userId),
  ACCEPT_LEGAL_PATH: '/accept-legal',
}))

/* -------------------------------------------------------------------------- */
/* @/db/client — an in-memory table set, same shape as the Packet B suite     */
/* -------------------------------------------------------------------------- */

interface EqCondition { __type: 'eq'; columnName: string; value: unknown }
interface AndCondition { __type: 'and'; conditions: unknown[] }
interface IsNullCondition { __type: 'isNull'; columnName: string }
type Condition = EqCondition | AndCondition | IsNullCondition

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown): EqCondition => ({ __type: 'eq', columnName: column.name, value }),
  and: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }): IsNullCondition => ({ __type: 'isNull', columnName: column.name }),
}))

const JS_KEY_BY_COLUMN_NAME: Record<string, string> = {
  id: 'id', user_id: 'userId', organization_id: 'organizationId', status: 'status',
  role: 'role', email: 'email', deleted_at: 'deletedAt', is_super_admin: 'isSuperAdmin',
}

function evaluateCondition(condition: Condition, row: Record<string, unknown>): boolean {
  if (condition.__type === 'and') return condition.conditions.every((c) => evaluateCondition(c as Condition, row))
  const key = JS_KEY_BY_COLUMN_NAME[condition.columnName] ?? condition.columnName
  if (condition.__type === 'isNull') return row[key] == null
  return row[key] === condition.value
}

function tableNameOf(table: { [key: symbol]: string }): string {
  return table[Symbol.for('drizzle:Name')] as unknown as string
}

const TABLES: {
  users: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
} = { users: [], organization_members: [], organizations: [] }

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => {
        const data = (TABLES as Record<string, Array<Record<string, unknown>>>)[tableNameOf(table)] ?? []
        return {
          where: vi.fn().mockImplementation((condition: Condition) => {
            const filtered = data.filter((row) => evaluateCondition(condition, row))
            return {
              limit: () => ({ then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered)) }),
              then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(filtered)),
            }
          }),
        }
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({ values: async () => undefined })),
  },
}))

vi.mock('@/lib/audit/tenancy-refusal', () => ({
  emitMembershipRevalidationRefused: async () => undefined,
}))

/* -------------------------------------------------------------------------- */
/* Import after mocks are in place                                            */
/* -------------------------------------------------------------------------- */

import {
  requireAuth,
  requireOrganizationAccess,
  getCurrentOrganizationContext,
} from '@/lib/auth/session'
import {
  withAuthenticatedDatabaseContext,
  AuthContextError,
  authContextErrorStatus,
} from '@/lib/auth/database-context'
import { SELECTED_ORGANIZATION_COOKIE_NAME } from '@/lib/auth/selected-organization'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUPER_ADMIN_ID = '99999999-9999-4999-8999-999999999999'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333333'
const CONFIRMED_AT = '2024-01-01T00:00:00.000Z'

const USER_ROW = { id: USER_ID, email: 'member@example.test', isSuperAdmin: false, deletedAt: null }
const SUPER_ADMIN_ROW = { ...USER_ROW, id: SUPER_ADMIN_ID, isSuperAdmin: true }
const ORG_ROW = { id: ORG_ID, name: 'Org', slug: 'org' }
const MEMBERSHIP_ROW = { id: MEMBERSHIP_ID, userId: USER_ID, organizationId: ORG_ID, role: 'analyst', status: 'active' }

function signedInAs(userId: string, emailConfirmedAt: string | null): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email_confirmed_at: emailConfirmedAt } },
    error: null,
  })
}
const verified = (userId = USER_ID) => signedInAs(userId, CONFIRMED_AT)
const unverified = (userId = USER_ID) => signedInAs(userId, null)

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
  mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
  TABLES.users = [USER_ROW, SUPER_ADMIN_ROW]
  TABLES.organizations = [ORG_ROW]
  TABLES.organization_members = [MEMBERSHIP_ROW]
  fakeCookieStore.clear()
})

/* -------------------------------------------------------------------------- */
/* K3 — requireAuth                                                           */
/* -------------------------------------------------------------------------- */

describe('K3 (requireAuth): REMAIN AFTER B0', () => {
  it('a verified, ACCEPTED subject passes through with no redirect', async () => {
    verified()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
    const location = await locationOf(() => requireAuth())
    expect(location).toBeNull()
  })

  it('a verified, UNACCEPTED subject is redirected to ACCEPT_LEGAL_PATH', async () => {
    verified()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const location = await locationOf(() => requireAuth())
    expect(location).toBe('/accept-legal')
  })

  it('B0 THEN L0: an UNVERIFIED, unaccepted subject is redirected to /verify-email, never to ACCEPT_LEGAL_PATH', async () => {
    unverified()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const location = await locationOf(() => requireAuth())
    expect(location).toBe('/verify-email')
  })
})

/* -------------------------------------------------------------------------- */
/* K4 — requireOrganizationAccess                                            */
/* -------------------------------------------------------------------------- */

function selectOrg(orgId = ORG_ID): void {
  fakeCookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, orgId)
}

describe('K4 (requireOrganizationAccess): L0 is a PREFIX evaluated before R1 (super-admin) and before any selector question', () => {
  it('an accepted member with a selected org reaches the ordinary Packet A destination (context returned, no redirect)', async () => {
    verified()
    selectOrg()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBeNull()
  })

  it('an unaccepted member is redirected to ACCEPT_LEGAL_PATH, never reaching R1-R4', async () => {
    verified()
    selectOrg()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/accept-legal')
  })

  it('PACKET_A_PRESERVATION P-AO-13 analogue: an UNACCEPTED super-admin is ALSO redirected to ACCEPT_LEGAL_PATH, never auto-routed to /admin', async () => {
    verified(SUPER_ADMIN_ID)
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/accept-legal')
  })

  it('an ACCEPTED super-admin with no membership still reaches /admin — L0 does not disturb R1 once satisfied', async () => {
    verified(SUPER_ADMIN_ID)
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
    const location = await locationOf(() => requireOrganizationAccess())
    expect(location).toBe('/admin')
  })
})

/* -------------------------------------------------------------------------- */
/* K5 — getCurrentOrganizationContext                                        */
/* -------------------------------------------------------------------------- */

describe('K5 (getCurrentOrganizationContext)', () => {
  it('returns null for an unaccepted subject even with a full membership and organization', async () => {
    verified()
    selectOrg()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const ctx = await getCurrentOrganizationContext()
    expect(ctx).toBeNull()
  })

  it('returns the context for an accepted subject', async () => {
    verified()
    selectOrg()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
    const ctx = await getCurrentOrganizationContext()
    expect(ctx).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* K6 — requirePrincipal, via withAuthenticatedDatabaseContext                */
/* -------------------------------------------------------------------------- */

describe('K6 (requirePrincipal): AUTH_LEGAL_ACCEPTANCE_REQUIRED, 403 never 401, B0 precedes L0', () => {
  it('a verified, unaccepted subject throws AUTH_LEGAL_ACCEPTANCE_REQUIRED', async () => {
    verified()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const code = await captureCode(() => withAuthenticatedDatabaseContext(async () => null))
    expect(code).toBe('AUTH_LEGAL_ACCEPTANCE_REQUIRED')
  })

  it('AUTH_LEGAL_ACCEPTANCE_REQUIRED maps to 403, never 401 (a valid session is not told to sign in again)', () => {
    expect(authContextErrorStatus('AUTH_LEGAL_ACCEPTANCE_REQUIRED')).toBe(403)
  })

  it('N-AO-1 analogue: an UNVERIFIED and unaccepted subject is refused for B0, not L0', async () => {
    unverified()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(false)
    const code = await captureCode(() => withAuthenticatedDatabaseContext(async () => null))
    expect(code).toBe('AUTH_EMAIL_NOT_VERIFIED')
  })

  it('a verified, accepted subject passes through', async () => {
    verified()
    mockDeriveAccountAcceptanceCurrent.mockResolvedValue(true)
    const result = await withAuthenticatedDatabaseContext(async () => 'ok')
    expect(result).toBe('ok')
  })
})

/* -------------------------------------------------------------------------- */
/* Structural: the SAME assertion helper binds both requirePrincipal returns, */
/* and B0 is asserted before L0 within it.                                   */
/* -------------------------------------------------------------------------- */

describe('structural: requirePrincipal binds ONE helper on both provenances, ordered B0 then L0', () => {
  it('assertPrincipalGates asserts email-verification before acceptance-currency', () => {
    const source = read('lib/auth/database-context.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    const start = source.indexOf('function assertPrincipalGates')
    const body = source.slice(start, start + 200)
    expect(body).toMatch(/assertAccountAcceptanceCurrentPrincipal\(assertEmailVerifiedPrincipal\(/)
  })

  it('both requirePrincipal return sites route through assertPrincipalGates', () => {
    const source = read('lib/auth/database-context.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    const start = source.indexOf('async function requirePrincipal')
    const body = source.slice(start, start + 800)
    const memoSite = body.match(/if \(memoised\) return (\w+)\(memoised\)/)
    const freshSite = body.match(/if \(principal\) return (\w+)\(principal\)/)
    expect(memoSite?.[1]).toBe('assertPrincipalGates')
    expect(freshSite?.[1]).toBe('assertPrincipalGates')
  })
})
