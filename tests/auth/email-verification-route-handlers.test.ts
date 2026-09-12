// tests/auth/email-verification-route-handlers.test.ts
//
// PACKET B — E14 through E17, the four Route Handlers R3 found reachable by
// an authenticated-but-unverified subject holding a VALID membership and
// organisation (the state in which every Packet A rule passes and the
// governed effect would otherwise run).
//
// MANDATORY MOCKING DISCIPLINE (F-IA-11, S-IA-ROUTE-HANDLER-CONTROLS-DRIVE-
// THE-REAL-GATE): mocking is BELOW getCurrentOrganizationContext — at the
// identity/principal layer (supabase.auth.getUser, @/db/client) — so the
// `null` each route's `if (!ctx)` sees is produced by the REAL C5 logic, not
// handed to it by a mock of the helper itself. @/lib/auth/session and
// @/lib/auth/database-context are NEVER mocked in this file.
//
// Binds by id to docs/ops/tenancy/TENANCY_EMAIL_VERIFICATION_PACKET_B_TEST_
// MANIFEST_v1.0.0.json — N-B-10, N-B-11, N-B-12, N-B-13.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* -------------------------------------------------------------------------- */
/* Harness — identical shape to tests/auth/email-verification-gate.test.ts   */
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

const mockGetUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
}))

// CL-1 (HPO-ODS-W2-28) — this suite is about B0 (Packet B) Route Handlers,
// not L0. The in-memory @/db/client double has no SQL engine capable of
// evaluating deriveAccountAcceptanceCurrent's raw query, and this suite has
// no business exercising it: every fixture here is pinned explicitly
// acceptance-current.
vi.mock('@/lib/auth/legal-acceptance', () => ({
  deriveAccountAcceptanceCurrent: async () => true,
  ACCEPT_LEGAL_PATH: '/accept-legal',
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

const dbSelectSpy = vi.fn()
const selectedTableNames: string[] = []

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown): EqCondition => ({
    __type: 'eq',
    columnName: column.name,
    value,
  }),
  and: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  isNull: (column: { name: string }): IsNullCondition => ({ __type: 'isNull', columnName: column.name }),
  or: (...conditions: unknown[]): AndCondition => ({ __type: 'and', conditions }),
  ilike: (column: { name: string }, value: unknown): EqCondition => ({
    __type: 'eq',
    columnName: column.name,
    value,
  }),
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
  review_status: 'reviewStatus',
}

const TABLES: {
  users: Array<Record<string, unknown>>
  organization_members: Array<Record<string, unknown>>
  organizations: Array<Record<string, unknown>>
  financial_proxies: Array<Record<string, unknown>>
} = { users: [], organization_members: [], organizations: [], financial_proxies: [] }

function tableNameOf(table: { [key: symbol]: string } & { _?: { name?: string } }): string {
  return (table[Symbol.for('drizzle:Name')] as unknown as string) ?? table._?.name ?? 'unknown'
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation((...args: unknown[]) => {
      dbSelectSpy(...args)
      return {
        from: vi.fn().mockImplementation((table: { [key: symbol]: string } & { _?: { name?: string } }) => {
          const tableName = tableNameOf(table)
          selectedTableNames.push(tableName)
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
      }
    }),
  },
}))

/* -------------------------------------------------------------------------- */
/* Service functions each route calls — spied so an "uncalled" assertion is   */
/* about the REAL exported binding the route imports, not a stand-in.         */
/* -------------------------------------------------------------------------- */

const mockGetReportDraft = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called for an unverified subject')
})
const mockGetCalculationRunDetail = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/pipeline/sroi-results', () => ({
  getReportDraft: (...args: unknown[]) => mockGetReportDraft(...args),
  getCalculationRunDetail: (...args: unknown[]) => mockGetCalculationRunDetail(...args),
}))

const mockGetProjectByIdForCurrentOrganization = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/projects/service', () => ({
  getProjectByIdForCurrentOrganization: (...args: unknown[]) => mockGetProjectByIdForCurrentOrganization(...args),
}))

const mockListOutcomeMappingsForProject = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/taxonomies/service', () => ({
  listOutcomeMappingsForProject: (...args: unknown[]) => mockListOutcomeMappingsForProject(...args),
  groupMappingsByCatalog: () => [],
}))

const mockListEvidenceForProject = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/pipeline/evidence', () => ({
  listEvidenceForProject: (...args: unknown[]) => mockListEvidenceForProject(...args),
}))

const mockGetLatestEvidenceVersionsByEvidenceIds = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/pipeline/evidence-versions', () => ({
  getLatestEvidenceVersionsByEvidenceIds: (...args: unknown[]) => mockGetLatestEvidenceVersionsByEvidenceIds(...args),
}))

const mockListMethodologyReviewsForProject = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/pipeline/methodology-review', () => ({
  listMethodologyReviewsForProject: (...args: unknown[]) => mockListMethodologyReviewsForProject(...args),
}))

const mockRenderToBuffer = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
  Document: (props: { children?: unknown }) => props.children ?? null,
  Page: (props: { children?: unknown }) => props.children ?? null,
  Text: (props: { children?: unknown }) => props.children ?? null,
  View: (props: { children?: unknown }) => props.children ?? null,
  StyleSheet: { create: (styles: unknown) => styles },
}))

const mockUpdateFinancialProxyReviewStatusForContext = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
const mockGetOrCreateFxRate = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/pipeline/proxies', () => ({
  updateFinancialProxyReviewStatusForContext: (...args: unknown[]) =>
    mockUpdateFinancialProxyReviewStatusForContext(...args),
}))
vi.mock('@/lib/pipeline/fx-rates', () => ({
  getOrCreateFxRate: (...args: unknown[]) => mockGetOrCreateFxRate(...args),
}))
const mockGetOrCreateSharedCopRate = vi.fn(async (..._args: unknown[]) => {
  void _args
  throw new Error('must not be called')
})
vi.mock('@/lib/pipeline/fx', () => ({
  getOrCreateSharedCopRate: (...args: unknown[]) => mockGetOrCreateSharedCopRate(...args),
}))

/* -------------------------------------------------------------------------- */
/* Import routes AFTER mocks                                                 */
/* -------------------------------------------------------------------------- */

import { GET as reportPdfGET } from '@/app/app/projects/[projectId]/report/[reportId]/pdf/route'
import { POST as proxySuggestPOST } from '@/app/api/proxies/[id]/suggest/route'
import { POST as fxRatesFetchPOST } from '@/app/api/fx-rates/fetch/route'
import { GET as proxiesSearchGET } from '@/app/api/proxies/search/route'

/* -------------------------------------------------------------------------- */
/* Fixtures — the state in which every Packet A rule would pass              */
/* -------------------------------------------------------------------------- */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'

const USER_ROW = {
  id: USER_ID,
  email: 'member@example.test',
  fullName: 'Member',
  avatarUrl: null,
  isSuperAdmin: false,
  deletedAt: null,
}
const ORG_ROW = { id: ORG_ID, name: 'Org', slug: 'org' }
const MEMBERSHIP_ROW = { id: 'm1', userId: USER_ID, organizationId: ORG_ID, role: 'analyst', status: 'active' }

function unverified(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: USER_ID, email_confirmed_at: null } },
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  TABLES.users = [USER_ROW]
  TABLES.organizations = [ORG_ROW]
  TABLES.organization_members = [MEMBERSHIP_ROW]
  TABLES.financial_proxies = []
  fakeCookieStore.set('uellix_selected_organization_id', ORG_ID)
})

/* -------------------------------------------------------------------------- */
/* N-B-10 — E14, report PDF export                                           */
/* -------------------------------------------------------------------------- */

describe('N-B-10: report PDF export (E14) refuses before any protected data is read or rendered', () => {
  it('an unverified member gets a refusal, not a PDF, and every downstream read/render is uncalled', async () => {
    unverified()
    const response = await reportPdfGET(new Request('http://localhost/x'), {
      params: Promise.resolve({ projectId: 'p1', reportId: 'r1' }),
    })

    expect(response.status).not.toBe(200)
    expect(response.headers.get('Content-Type')).not.toBe('application/pdf')

    expect(mockGetReportDraft).not.toHaveBeenCalled()
    expect(mockGetProjectByIdForCurrentOrganization).not.toHaveBeenCalled()
    expect(mockGetCalculationRunDetail).not.toHaveBeenCalled()
    expect(mockListOutcomeMappingsForProject).not.toHaveBeenCalled()
    expect(mockListEvidenceForProject).not.toHaveBeenCalled()
    expect(mockListMethodologyReviewsForProject).not.toHaveBeenCalled()
    expect(mockRenderToBuffer).not.toHaveBeenCalled()

    const body = await response.text()
    expect(body).not.toContain(ORG_ROW.name)
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-11 — E15, proxy suggest write                                         */
/* -------------------------------------------------------------------------- */

describe('N-B-11: proxy suggest write (E15) refuses before the governed transition runs', () => {
  it('an unverified member is refused, and the write primitive is never called', async () => {
    unverified()
    const request = new NextRequest('http://localhost/api/proxies/proxy-1/suggest', { method: 'POST' })
    const response = await proxySuggestPOST(request, { params: Promise.resolve({ id: 'proxy-1' }) })

    expect(response.status).not.toBe(200)
    expect(mockUpdateFinancialProxyReviewStatusForContext).not.toHaveBeenCalled()
  })

  it('the verification refusal is NOT a new existence oracle: a cross-tenant id gets the SAME refusal as an own-org id', async () => {
    unverified()

    const ownOrgRequest = new NextRequest('http://localhost/api/proxies/own-org-proxy/suggest', { method: 'POST' })
    const ownOrgResponse = await proxySuggestPOST(ownOrgRequest, {
      params: Promise.resolve({ id: 'own-org-proxy' }),
    })

    const crossTenantRequest = new NextRequest('http://localhost/api/proxies/cross-tenant-proxy/suggest', {
      method: 'POST',
    })
    const crossTenantResponse = await proxySuggestPOST(crossTenantRequest, {
      params: Promise.resolve({ id: 'cross-tenant-proxy' }),
    })

    expect(crossTenantResponse.status).toBe(ownOrgResponse.status)
    expect(mockUpdateFinancialProxyReviewStatusForContext).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-12 — E16, FX-rate write                                               */
/* -------------------------------------------------------------------------- */

describe('N-B-12: FX-rate write (E16) refuses before the upsert', () => {
  it('an unverified member is refused, and BOTH fx-rate services are uncalled', async () => {
    unverified()
    const request = new NextRequest('http://localhost/api/fx-rates/fetch', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-01-01', currency: 'USD' }),
      headers: { 'content-type': 'application/json' },
    })
    const response = await fxRatesFetchPOST(request)

    expect(response.status).not.toBe(200)
    expect(mockGetOrCreateFxRate).not.toHaveBeenCalled()
    expect(mockGetOrCreateSharedCopRate).not.toHaveBeenCalled()
  })

  it('the COP branch (a SHARED, cross-tenant-blast-radius write) is refused identically', async () => {
    unverified()
    const request = new NextRequest('http://localhost/api/fx-rates/fetch', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-01-01', currency: 'COP' }),
      headers: { 'content-type': 'application/json' },
    })
    const response = await fxRatesFetchPOST(request)

    expect(response.status).not.toBe(200)
    expect(mockGetOrCreateSharedCopRate).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------------------------- */
/* N-B-13 — E17, global proxy catalogue read                                 */
/* -------------------------------------------------------------------------- */

describe('N-B-13: proxy search read (E17) refuses before the catalogue is queried', () => {
  it('an unverified member is refused, the financialProxies select never runs, and no proxy data leaks into the body', async () => {
    unverified()
    TABLES.financial_proxies = [
      {
        id: 'gp-1',
        organizationId: null,
        reviewStatus: 'approved',
        name: 'Global Approved Proxy',
        description: 'a matching description',
        thematicArea: 'health',
      },
    ]

    selectedTableNames.length = 0
    const request = new NextRequest('http://localhost/api/proxies/search?q=Global')
    const response = await proxiesSearchGET(request)

    expect(response.status).not.toBe(200)
    // C5 (getCurrentOrganizationContext) itself reads users/organization_
    // members/organizations to resolve the principal that turns out
    // unverified — that is expected. What must NEVER appear is a read of
    // financial_proxies: the select inside withOrganizationDatabaseContext
    // at the route's own :29-46 never executes, because C5 already refused.
    expect(selectedTableNames).not.toContain('financial_proxies')

    const body = await response.text()
    expect(body).not.toContain('Global Approved Proxy')
  })
})

