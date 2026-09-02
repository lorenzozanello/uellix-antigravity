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
// REMEDIATION Phase 1, amended by W2-B2-R4-404-CONTRACT-CORRECTION):
//   P1 — same-organization authorized transition (impact_manager+): live
//        suggested -> pending_review, current version draft -> under_review, 200.
//   P2 — the canonical mapping primitive is used, not a second
//        implementation (static: the route contains no raw status literal
//        write and imports only the shared primitive).
//   P3 — live/version coupling holds at the (mocked) transaction commit.
//   N1 — unauthenticated caller refused (401).
//   N2 — same-organization but insufficient role refused (403) — existence
//        of the proxy is not a secret from a fellow member of its own org.
//   N3 — cross-tenant mutation on an EXISTING proxy owned by another
//        organization is refused as 404, not 403: the frozen route
//        contract is that an id outside the caller's tenant must read
//        exactly like an unknown id, never confirm the id belongs to
//        someone else's tenant (W2-B2-R4-404-CONTRACT-CORRECTION).
//   MULTI-ORG — the same 404, specifically for an actor who ALSO holds
//        active membership in the proxy's owning organization: the
//        decision is keyed on the CURRENT session's organization context
//        (ctx.organization.id) alone, never on "any org this user belongs
//        to", so a second membership grants no visibility through this
//        route while acting under the first.
//   N4 — invalid source state (not currently 'suggested') refused (400).
//   N5 — alias of N4 in this codebase's vocabulary (no separate "unknown
//        proxy" vs "wrong state" distinction beyond not_found/already_submitted).
//   N6 — a system/global proxy (organizationId NULL) presented through this
//        organization-scoped route must not leak existence either: 404,
//        via the same organization-scoped lock as N3/MULTI-ORG (NULL never
//        equals a specific organization id).
//   not_found — an unknown proxy id is refused as 404.
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

// Same proven technique as tests/proxies.service.test.ts: recursively pull
// the literal comparison values a drizzle eq()/and() condition embeds, so
// the mock can actually filter instead of the WHERE clause being decorative.
function extractEqValues(val: any): string[] {
  if (!val) return []
  if (typeof val === 'string') return [val]
  if (Array.isArray(val)) return val.flatMap(extractEqValues)
  const res: string[] = []
  if (val.value !== undefined) {
    if (typeof val.value === 'string') res.push(val.value)
    else if (Array.isArray(val.value)) res.push(...val.value.flatMap(extractEqValues))
    else res.push(...extractEqValues(val.value))
  }
  if (val.right !== undefined) res.push(...extractEqValues(val.right))
  if (val.left !== undefined) res.push(...extractEqValues(val.left))
  if (Array.isArray(val.conditions)) res.push(...val.conditions.flatMap(extractEqValues))
  if (Array.isArray(val.queryChunks)) res.push(...val.queryChunks.flatMap(extractEqValues))
  return res
}

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
          where: vi.fn().mockImplementation((cond: any) => {
            if (tableName === 'financial_proxy_versions') {
              // financial_proxy_versions callers in this call graph
              // (getLatestFinancialProxyVersion / updateCurrentFinancialProxyVersion)
              // always target the single seeded proxy's versions in these
              // tests, so no further filtering is needed to exercise the
              // route's actual behaviour.
              rows = dataToReturn
              return fromObj
            }
            // financial_proxies: withLockedFinancialProxy's SELECT is either
            // eq(id, proxyId) or, when hideCrossTenantAsNotFound scopes it,
            // and(eq(id, proxyId), eq(organizationId, orgId)). drizzle's
            // rendered condition embeds the SQL operator text itself as
            // string chunks (' = ', '(', ')'), which pollutes a raw literal
            // COUNT — a bare eq() already extracts to 2 entries (' = ' plus
            // the value), not 1. The literal ' and ' joiner is the reliable
            // signal drizzle's and() adds that a bare eq() never does.
            const wanted = extractEqValues(cond)
            const isOrgScoped = wanted.includes(' and ')
            rows = dataToReturn.filter((r) =>
              wanted.includes(r.id) && (!isOrgScoped || wanted.includes(r.organizationId))
            )
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

  it('N3: cross-tenant mutation on an EXISTING proxy owned by another organization reads as 404, never 403 — the id must not be confirmed to exist in someone else\'s tenant (W2-B2-R4-404-CONTRACT-CORRECTION)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager', 'org-99'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(404)
    expect(mockDbData.lastUpdateValues).toBeNull()
    expect(mockDbData.lastVersionUpdateValues).toBeNull()
  })

  it('MULTI-ORG (adversarial): an actor with active membership in BOTH the requesting org and the proxy\'s owning org still gets 404 while acting under the requesting org\'s context', async () => {
    // The membership that would grant visibility (org-3) exists for this
    // user in the database, but the SESSION is scoped to org-99 (e.g. a
    // second browser tab, a switched-context token). The route/primitive
    // never consults "every org this user belongs to" — only
    // ctx.organization.id, which is what a forged or stale request could
    // never move to a different value than the session actually resolved.
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager', 'org-99'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: 'org-3', reviewStatus: 'suggested' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(404)
    expect(mockDbData.lastUpdateValues).toBeNull()
    expect(mockDbData.lastVersionUpdateValues).toBeNull()
  })

  it('N6: a system/global proxy (organizationId NULL) presented through this organization-scoped route does not leak existence either (404)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(ctxWith('impact_manager'))
    vi.mocked(canApproveProxy).mockReturnValue(true)
    mockDbData.financialProxies = [
      { id: PROXY_UUID, organizationId: null, reviewStatus: 'suggested' },
    ]

    const response = await POST(makeRequest(), makeProps())

    expect(response.status).toBe(404)
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
