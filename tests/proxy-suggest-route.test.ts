// tests/proxy-suggest-route.test.ts
// W2-B2-R3-NARROW-REMEDIATION / R-B2-10 — app/api/proxies/[id]/suggest/route.ts
// was the fifth reachable live/version transition site (found by
// W2-B2-R2-AR): it wrote financial_proxies.review_status directly, leaving
// the current financial_proxy_versions row uncoupled
// (LIVE_VERSION_STATUS_COUPLING violated) and bypassing the canApproveProxy
// gate every other transition site enforces. It now delegates to
// lib/pipeline/proxies.ts updateFinancialProxyReviewStatusForContext — the
// SAME canonical governed primitive the organisation UI's own "submit for
// review" action already calls for this exact transition (see
// app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxyReviewStatus.action.ts).
//
// NODE TEST CONTRACT (frozen before implementation, per W2-B2-R3-NARROW-
// REMEDIATION Phase 1):
//   P1 — reachable authorized transition: live suggested -> pending_review,
//        current version draft -> under_review.
//   P2 — the canonical mapping primitive is used, not a second
//        implementation (static: the route contains no raw status literal
//        write and imports only the shared primitive).
//   P3 — live/version coupling holds at the (mocked) transaction commit.
//   N1 — unauthenticated caller refused (401).
//   N2 — authenticated but unauthorized actor (insufficient role) refused (403).
//   N3 — cross-tenant mutation refused (403 at the application layer — RLS
//        supplies an additional, separately-proven defense-in-depth barrier
//        at the database layer, see tests/postgres/b2-remediation.pg.test.ts).
//   N4 — invalid source state (not currently 'suggested') refused (400).
//   A1 — atomicity: real transactional rollback is proven against real
//        PostgreSQL (tests/postgres/b2-remediation.pg.test.ts, R-B2-10
//        section) — a mocked, non-transactional `db.transaction` cannot
//        demonstrate rollback. At this (service) layer, atomicity is proven
//        structurally instead: both writes are issued from the SAME locked
//        `transition` callback, and P3 below fails if either write is
//        skipped.
//   M1 — mutation control: a deliberately live-only implementation (the
//        pre-R-B2-10 defect shape) is caught by the coupling invariant.
//   R1/R2/R3/R4 — regression: run via the existing suites, not duplicated
//        here (tests/b2-remediation-sentinels.test.ts FIBIU-09/MNB-1;
//        tests/review-status-mapping.test.ts B2 mapping/coupling).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const mockDbData = vi.hoisted(() => ({
  financialProxies: [] as any[],
  financialProxyVersions: [] as any[],
  updated: {} as any,
  updatedVersion: {} as any,
  lastUpdateValues: null as any,
  lastVersionUpdateValues: null as any,
}))

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
  requireOrganizationAccess: vi.fn(),
}))

vi.mock('@/lib/auth/database-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/database-context')>()
  return {
    ...actual,
    // Real identity-context resolution needs a live Supabase session and a
    // bound DB connection — out of scope for a service-level test. `ctx` is
    // already resolved via the mocked getCurrentOrganizationContext above;
    // the route's callback ignores whatever this passes through.
    withOrganizationDatabaseContext: vi.fn((callback: (ctx: unknown) => Promise<unknown>) => callback(undefined)),
  }
})

vi.mock('@/lib/auth/permissions', () => ({
  canApproveProxy: vi.fn(),
}))

vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})

// Same proven query-builder shape as tests/proxies.service.test.ts, trimmed
// to the two tables this route's call graph touches.
vi.mock('@/db/client', () => {
  const database: any = {
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(database)),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: any) => {
        const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')]
        const dataToReturn: any[] = tableName === 'financial_proxy_versions'
          ? mockDbData.financialProxyVersions
          : mockDbData.financialProxies
        let rows: any[] = dataToReturn
        const fromObj: any = {
          where: vi.fn().mockImplementation(() => {
            // financial_proxy_versions callers in this call graph
            // (getLatestFinancialProxyVersion / updateCurrentFinancialProxyVersion)
            // always target the single seeded proxy's versions in these
            // tests, so no further filtering is needed to exercise the
            // route's actual behaviour.
            rows = dataToReturn
            return fromObj
          }),
          orderBy: vi.fn().mockImplementation(() => {
            if (tableName === 'financial_proxy_versions') {
              rows = [...rows].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))
            }
            return fromObj
          }),
          limit: vi.fn().mockImplementation(() => fromObj),
          then: vi.fn().mockImplementation((cb: (r: any[]) => unknown) => Promise.resolve(cb(rows))),
        }
        fromObj.for = vi.fn().mockImplementation(() => fromObj)
        return fromObj
      }),
    })),
    update: vi.fn().mockImplementation((table: any) => {
      const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')]
      return {
        set: vi.fn().mockImplementation((values: any) => {
          if (tableName === 'financial_proxy_versions') mockDbData.lastVersionUpdateValues = values
          else mockDbData.lastUpdateValues = values
          return {
            where: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockImplementation(() =>
                Promise.resolve([
                  tableName === 'financial_proxy_versions'
                    ? { ...mockDbData.updatedVersion, ...values }
                    : { ...mockDbData.updated, ...values },
                ])
              ),
            })),
          }
        }),
      }
    }),
  }
  return { db: database }
})

import { POST } from '@/app/api/proxies/[id]/suggest/route'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { canApproveProxy } from '@/lib/auth/permissions'
import { assertLiveVersionStatusCoupling } from '@/lib/pipeline/financial-proxy-versions'
import { NextRequest } from 'next/server'

const PROXY_UUID = '550e8400-e29b-41d4-a716-446655440002'

function makeRequest() {
  return new NextRequest(`http://localhost/api/proxies/${PROXY_UUID}/suggest`, { method: 'POST' })
}

function makeProps() {
  return { params: Promise.resolve({ id: PROXY_UUID }) }
}

function ctxWith(role: string, organizationId = 'org-3') {
  return {
    organization: { id: organizationId },
    user: { id: 'user-1', isSuperAdmin: false },
    membership: { role },
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDbData.financialProxies = []
  mockDbData.financialProxyVersions = []
  mockDbData.updated = {}
  mockDbData.updatedVersion = {}
  mockDbData.lastUpdateValues = null
  mockDbData.lastVersionUpdateValues = null
})

describe('POST /api/proxies/[id]/suggest — R-B2-10 (LIVE_VERSION_STATUS_COUPLING at the fifth transition site)', () => {
  it('P1/P2/P3: authorized suggest transition couples live suggested->pending_review with version draft->under_review, through the canonical primitive', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested' },
    ]
    mockDbData.financialProxyVersions = [
      { id: 'version-1', financialProxyId: PROXY_UUID, ordinal: 1, reviewStatus: 'draft' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
    // P1 + P3: both sides of the coupling actually committed, mapped —
    // this assertion is what a live-only regression (M1) would fail.
    expect(mockDbData.lastUpdateValues?.reviewStatus).toBe('pending_review')
    expect(mockDbData.lastVersionUpdateValues?.reviewStatus).toBe('under_review')
  })

  it('P2 (static): the route delegates to the shared primitive and defines no second status-transition implementation', () => {
    const src = readFileSync(path.join(process.cwd(), 'app/api/proxies/[id]/suggest/route.ts'), 'utf8')
    expect(src).toMatch(/updateFinancialProxyReviewStatusForContext/)
    // No raw status-literal write and no direct db/table import — the whole
    // mutation is delegated, not duplicated.
    expect(src).not.toMatch(/reviewStatus:\s*'(suggested|pending_review|draft|under_review)'/)
    expect(src).not.toMatch(/from ['"]@\/db\/client['"]/)
    expect(src).not.toMatch(/from ['"]@\/db\/schema['"]/)
  })

  it('N1: unauthenticated caller is refused (401)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(null)

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(401)
    expect(mockDbData.lastUpdateValues).toBeNull()
    expect(mockDbData.lastVersionUpdateValues).toBeNull()
  })

  it('N2: authenticated but unauthorized actor (insufficient role) is refused (403)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('analyst'))
    vi.mocked(canApproveProxy).mockReturnValue(false)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(403)
    expect(mockDbData.lastUpdateValues).toBeNull()
    expect(mockDbData.lastVersionUpdateValues).toBeNull()
  })

  it('N3: cross-tenant mutation is refused (403) — the organisation-boundary check inside the shared primitive fires independently of RLS', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager', 'org-99'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(403)
    expect(mockDbData.lastUpdateValues).toBeNull()
    expect(mockDbData.lastVersionUpdateValues).toBeNull()
  })

  it('N4: an invalid source state (not currently "suggested") is refused (400), per the route\'s own contract', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'approved' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(400)
    expect(mockDbData.lastUpdateValues).toBeNull()
    expect(mockDbData.lastVersionUpdateValues).toBeNull()
  })

  it('not_found: a proxy id with no matching row is refused (404)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = []

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(404)
  })

  it('M1 (mutation control): the exact pre-R-B2-10 defect shape (live pending_review, version left at draft) is caught by the coupling invariant this route now relies on', () => {
    expect(() => assertLiveVersionStatusCoupling('pending_review', 'draft')).toThrow(/COUPLING violated/)
  })
})
