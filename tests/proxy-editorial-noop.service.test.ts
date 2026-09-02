// tests/proxy-editorial-noop.service.test.ts
// W2-B2-R1 / R-B2-06 — closes M2 (editorial / no-op patch invalidated an
// approved version). NC-1 and NC-2, plus the state-semantics table of
// editorial_noop_patch_disposition and the positive control that a genuine
// one-field material edit still forks.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// COMMERCIAL-V1-WAVE2-RECONCILIATION successor remediation (HPO-ODS-W2-09, BLK-2):
// the mock scaffolding below is typed without `any`, mirroring the Product
// line's own hardening of the B1 evidence-erasure mocks (5f17b98). Type-only —
// every assertion is unchanged.
import type { OrganizationContext } from '@/lib/auth/session'

/** A mocked table row — the services read loosely-typed columns off it. */
interface MockRow {
  id?: string
  ordinal?: number
  financialProxyId?: string
  reviewStatus?: string
  [key: string]: unknown
}

/** The subset of Drizzle's internal table shape this mock's name-lookup reads. */
interface DrizzleTableRef {
  readonly _?: { readonly name?: string }
  readonly [key: symbol]: unknown
}

function tableNameOf(table: unknown): string {
  const t = table as DrizzleTableRef | undefined
  return t?._?.name || (t?.[Symbol.for('drizzle:Name')] as string | undefined) || ''
}

/** The chainable shape `db.select().from(table)` mocks return. */
interface MockQuery {
  __sorted?: MockRow[]
  __filtered?: MockRow[]
  where: (...args: unknown[]) => MockQuery
  orderBy: (...args: unknown[]) => MockQuery
  limit: (n: number) => MockQuery
  for?: (...args: unknown[]) => MockQuery
  then: (cb: (rows: MockRow[]) => unknown) => Promise<unknown>
}

interface MockDb {
  transaction?: (callback: (tx: MockDb) => Promise<unknown>) => Promise<unknown>
  select: () => unknown
  insert: (table: unknown) => unknown
  update: (table: unknown) => unknown
}
import { isSemanticProxyFieldChange } from '@/lib/pipeline/proxies'

const mockDbData = vi.hoisted(() => ({
  financialProxies: [] as MockRow[],
  financialProxyVersions: [] as MockRow[],
  proxySources: [] as MockRow[],
  lastLiveUpdateValues: null as MockRow | null,
  lastVersionUpdateValues: null as MockRow | null,
}))

vi.mock('@/db/client', () => {
  const database: MockDb = {
    transaction: vi.fn(async (callback: (tx: MockDb) => Promise<unknown>) => callback(database)),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        const tableName = tableNameOf(table)
        const data =
          tableName === 'financial_proxies'
            ? mockDbData.financialProxies
            : tableName === 'proxy_sources'
              ? mockDbData.proxySources
              : mockDbData.financialProxyVersions
        const query: MockQuery = {
          where: vi.fn().mockImplementation(() => query),
          orderBy: vi.fn().mockImplementation(() => {
            query.__sorted = [...data].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))
            return query
          }),
          limit: vi.fn().mockImplementation((n: number) => {
            query.__sorted = (query.__sorted ?? data).slice(0, n)
            return query
          }),
          for: vi.fn().mockImplementation(() => query),
          then: (cb: (rows: MockRow[]) => unknown) => Promise.resolve(cb(query.__sorted ?? data)),
        }
        return query
      }),
    })),
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((vals: MockRow) => ({
        returning: vi.fn().mockImplementation(() => {
          const tableName = tableNameOf(table)
          if (tableName === 'financial_proxy_versions') {
            const ordinal = Math.max(0, ...mockDbData.financialProxyVersions.map((v) => v.ordinal ?? 0)) + 1
            const row = { id: `ver-${mockDbData.financialProxyVersions.length + 1}`, ordinal, createdAt: new Date(), ...vals }
            mockDbData.financialProxyVersions.push(row)
            return Promise.resolve([row])
          }
          return Promise.resolve([vals])
        }),
      })),
    })),
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((values: MockRow) => ({
        where: vi.fn().mockImplementation(() => {
          const tableName = tableNameOf(table)
          if (tableName === 'financial_proxies') {
            const proxy = mockDbData.financialProxies[0]
            if (proxy) Object.assign(proxy, values)
            mockDbData.lastLiveUpdateValues = values
            return { returning: vi.fn().mockImplementation(() => Promise.resolve(proxy ? [proxy] : [])) }
          }
          const current = [...mockDbData.financialProxyVersions].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))[0]
          if (current) Object.assign(current, values)
          mockDbData.lastVersionUpdateValues = values
          return { returning: vi.fn().mockImplementation(() => Promise.resolve(current ? [current] : [])) }
        }),
      })),
    })),
  }
  return { db: database }
})

vi.mock('@/lib/auth/session', () => ({ requireOrganizationAccess: vi.fn() }))
vi.mock('@/lib/auth/permissions', () => ({ canApproveProxy: vi.fn().mockReturnValue(true) }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})

const PROXY_ID = '550e8400-e29b-41d4-a716-446655440001'
const ORG = { id: 'org-noop' }
const SOURCE_ID = '550e8400-e29b-41d4-a716-446655440002'

function seedApproved() {
  mockDbData.financialProxies = [
    { id: PROXY_ID, organizationId: ORG.id, sourceId: SOURCE_ID, reviewStatus: 'approved', value: '100.0000', currency: 'USD', unit: 'person', referenceYear: 2025, valueUsd: '100.0000', fxRateId: null, name: 'A proxy', description: null },
  ]
  mockDbData.financialProxyVersions = [
    {
      id: 'version-approved-1', financialProxyId: PROXY_ID, ordinal: 1, reviewStatus: 'approved',
      sourceId: SOURCE_ID, value: '100.0000', currency: 'USD', unit: 'person', referenceYear: 2025,
      valueUsd: '100.0000', fxRateId: null, reviewerId: 'reviewer-1', reviewedAt: new Date('2026-01-01'),
      geographicContextualScope: 'Nacional', linkedOutcomeContext: 'Ingreso', recoverableReference: 'https://x',
      relevanceJustification: 'Misma población', documentedTransformations: 'none', consultationDate: new Date('2026-01-10T00:00:00Z'),
      country: null, territory: null, thematicArea: null, methodology: null,
    },
  ]
  mockDbData.proxySources = [{ id: SOURCE_ID, organizationId: null, status: 'active' }]
  mockDbData.lastLiveUpdateValues = null
  mockDbData.lastVersionUpdateValues = null
}

beforeEach(async () => {
  vi.clearAllMocks()
  seedApproved()
  const { requireOrganizationAccess } = await import('@/lib/auth/session')
  vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: ORG, user: { id: 'user-1' }, membership: { role: 'impact_manager' } } as unknown as OrganizationContext)
})

async function expectNoInvalidation() {
  const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
  expect(mockDbData.financialProxyVersions).toHaveLength(1)
  expect(mockDbData.financialProxies[0].reviewStatus).toBe('approved')
  expect(mockDbData.financialProxies[0].valueUsd).toBe('100.0000')
  expect(mockDbData.lastLiveUpdateValues).toBeNull()
  expect(mockDbData.lastVersionUpdateValues).toBeNull()
  expect(logAuditAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE }))
  expect(logAuditAction).not.toHaveBeenCalled()
}

describe('NC-1 — empty / no-op submission against an APPROVED proxy', () => {
  it('four explicitly-undefined keys (the blank-form shape M2 measured): no fork, no new version, no status change, no value_usd null-out, no audit event', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { value: undefined, currency: undefined, unit: undefined, referenceYear: undefined })
    await expectNoInvalidation()
  })

  it('an empty object: the same', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, {})
    await expectNoInvalidation()
  })

  it('all eleven provenance keys re-submitted unchanged: the same', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, {
      sourceId: SOURCE_ID, value: '100', currency: 'USD', unit: 'person', referenceYear: 2025,
      geographicContextualScope: 'Nacional', linkedOutcomeContext: 'Ingreso', recoverableReference: 'https://x',
      relevanceJustification: 'Misma población', documentedTransformations: 'none', consultationDate: '2026-01-10',
    })
    await expectNoInvalidation()
  })
})

describe('NC-2 — byte-identical and numerically-equal resubmissions are unchanged', () => {
  it("'100' against a persisted '100.0000' is NOT a change (canonicalDecimal), so no fork", async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { value: '100' })
    await expectNoInvalidation()
  })

  it("'' against a persisted NULL text field is NOT a change", async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { territory: '' })
    await expectNoInvalidation()
  })

  it('the same consultation date in a different string form is NOT a change (compared by instant)', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { consultationDate: '2026-01-10T00:00:00.000Z' })
    await expectNoInvalidation()
  })
})

describe('positive control — a genuine change still behaves as FIBC-013 requires', () => {
  it('a real one-field material edit (value 100 -> 250) forks the approved version', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    await updateOrganizationFinancialProxy(PROXY_ID, { value: '250', currency: 'USD', unit: 'person', referenceYear: 2025 })
    expect(mockDbData.financialProxyVersions).toHaveLength(2)
    expect(mockDbData.financialProxyVersions[1]).toMatchObject({ reviewStatus: 'under_review', value: '250', valueUsd: null })
    expect(mockDbData.financialProxies[0].reviewStatus).toBe('pending_review')
    expect(mockDbData.financialProxies[0].valueUsd).toBeNull()
    // Only the changed key is written to the live row (plus the derived resets).
    expect(Object.keys(mockDbData.lastLiveUpdateValues ?? {}).sort()).toEqual(['fxRateId', 'reviewStatus', 'updatedAt', 'value', 'valueUsd'])
    expect(logAuditAction).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE }))
  })

  it('an editorial (non_material) change writes the live row but neither forks nor resets', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    await updateOrganizationFinancialProxy(PROXY_ID, { name: 'Renamed' })
    expect(mockDbData.financialProxyVersions).toHaveLength(1)
    expect(mockDbData.financialProxies[0].reviewStatus).toBe('approved')
    expect(mockDbData.lastLiveUpdateValues).toMatchObject({ name: 'Renamed' })
    expect(logAuditAction).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_UPDATED }))
    expect(logAuditAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE }))
  })

  it('a unit-only change is material (forks) but does NOT null value_usd (unit is not an FX-derivation field)', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { unit: 'household' })
    expect(mockDbData.financialProxyVersions).toHaveLength(2)
    expect(mockDbData.lastLiveUpdateValues?.valueUsd).toBeUndefined()
    expect(mockDbData.financialProxies[0].reviewStatus).toBe('pending_review')
  })
})

describe('state semantics table (editorial_noop_patch_disposition)', () => {
  it.each([
    ['UNDEFINED', 'value', undefined, '100.0000', false],
    ['NULL clears a present value', 'territory', null, 'Bogotá', true],
    ['NULL against an absent value', 'territory', null, null, false],
    ['EMPTY_STRING against NULL', 'territory', '', null, false],
    ['EMPTY_STRING against a present value', 'territory', '', 'Bogotá', true],
    ['UNCHANGED numeric (formatting only)', 'value', '100', '100.0000', false],
    ['CHANGED numeric', 'value', '100.5', '100.0000', true],
    ['UNCHANGED integer', 'referenceYear', 2025, 2025, false],
    ['CHANGED integer', 'referenceYear', 2024, 2025, true],
    ['UNCHANGED date by instant', 'consultationDate', '2026-01-10', new Date('2026-01-10T00:00:00Z'), false],
    ['CHANGED date', 'consultationDate', '2026-02-10', new Date('2026-01-10T00:00:00Z'), true],
    ['text exact — no trimming', 'territory', 'Bogotá ', 'Bogotá', true],
    ['text exact — no case folding', 'territory', 'bogotá', 'Bogotá', true],
    ['text unchanged', 'territory', 'Bogotá', 'Bogotá', false],
  ])('%s', (_label, key, incoming, persisted, expected) => {
    expect(isSemanticProxyFieldChange(key, incoming, persisted)).toBe(expected)
  })
})
