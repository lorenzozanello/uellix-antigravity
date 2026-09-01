// tests/proxy-material-change.service.test.ts
// FIBIU-10 — PROXY_MATERIAL_CHANGE_POLICY_v1.0.0 + PROXY_MATERIAL_FIELDS_v1.0.0
// (FIBC-013/FIBDB-007). Direct coverage of the atomic fork primitive
// (applyMaterialChange) and the field classification map, plus the
// EXIT_GATE's own two named proofs: "atomic invalidation proven, with no
// window of surviving approved" and its negative control "an editorial
// change does not invalidate."

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------
// Pure classification coverage — no mocking required.
// ---------------------------------------------------------------------
import {
  classifyMaterialField,
  materialCategoriesTouched,
  MATERIAL_CATEGORIES,
  MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY,
  NON_MATERIAL,
} from '@/lib/pipeline/proxy-material-change'

describe('classifyMaterialField / materialCategoriesTouched — FIBC-013 field->category map', () => {
  it('classifies every field FinancialProxyInput can edit', () => {
    // The exact set FinancialProxyInput exposes — a change here without a
    // matching update to MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY is exactly
    // the failure mode this test exists to catch.
    const inputKeys = [
      'sourceId', 'name', 'description', 'proxyType', 'country', 'territory',
      'currency', 'value', 'unit', 'referenceYear', 'thematicArea', 'methodology',
      'confidenceLevel', 'methodologicalRisk', 'geographicContextualScope',
      'linkedOutcomeContext', 'recoverableReference', 'relevanceJustification',
      'documentedTransformations', 'consultationDate',
    ]
    for (const key of inputKeys) {
      expect(() => classifyMaterialField(key)).not.toThrow()
    }
    expect(Object.keys(MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY).sort()).toEqual(inputKeys.sort())
  })

  it('throws on an unclassified field — never silently defaults to non-material (fail-closed)', () => {
    expect(() => classifyMaterialField('someBrandNewField')).toThrow(/Unclassified proxy field/)
  })

  it('classifies name and description as the only non_material fields', () => {
    expect(classifyMaterialField('name')).toBe(NON_MATERIAL)
    expect(classifyMaterialField('description')).toBe(NON_MATERIAL)
    const nonMaterialKeys = Object.entries(MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY)
      .filter(([, v]) => v === NON_MATERIAL)
      .map(([k]) => k)
    expect(nonMaterialKeys.sort()).toEqual(['description', 'name'])
  })

  it('every non-non_material category resolves to a real, known category', () => {
    for (const [, category] of Object.entries(MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY)) {
      if (category === NON_MATERIAL) continue
      expect(MATERIAL_CATEGORIES).toContain(category)
    }
  })

  it('EDITORIAL CHANGE NEGATIVE CONTROL: touching only name/description yields zero material categories', () => {
    expect(materialCategoriesTouched(['name'])).toEqual([])
    expect(materialCategoriesTouched(['description'])).toEqual([])
    expect(materialCategoriesTouched(['name', 'description'])).toEqual([])
  })

  it('touching a real field yields its category — value is identity_economic_value', () => {
    expect(materialCategoriesTouched(['value'])).toEqual(['identity_economic_value'])
  })

  it('touching both a material and non-material field yields only the material category', () => {
    expect(materialCategoriesTouched(['name', 'value'])).toEqual(['identity_economic_value'])
  })

  it('deduplicates categories touched by multiple fields', () => {
    // value, currency, unit, referenceYear all map to identity_economic_value
    expect(materialCategoriesTouched(['value', 'currency', 'unit', 'referenceYear'])).toEqual([
      'identity_economic_value',
    ])
  })
})

// ---------------------------------------------------------------------
// Service-level coverage — the fork primitive and updateOrganizationFinancialProxy.
// ---------------------------------------------------------------------
const mockDbData = vi.hoisted(() => ({
  financialProxies: [] as any[],
  financialProxyVersions: [] as any[],
  proxySources: [] as any[],
  lastLiveUpdateValues: null as any,
}))

vi.mock('@/db/client', () => {
  const database: any = {
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(database)),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: any) => {
        const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')]
        const data =
          tableName === 'financial_proxies'
            ? mockDbData.financialProxies
            : tableName === 'proxy_sources'
              ? mockDbData.proxySources
              : mockDbData.financialProxyVersions
        const query: any = {
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
          then: (cb: (rows: any[]) => unknown) => Promise.resolve(cb(query.__sorted ?? data)),
        }
        return query
      }),
    })),
    insert: vi.fn().mockImplementation((table: any) => ({
      values: vi.fn().mockImplementation((vals: any) => ({
        returning: vi.fn().mockImplementation(() => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')]
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
    update: vi.fn().mockImplementation((table: any) => ({
      set: vi.fn().mockImplementation((values: any) => ({
        where: vi.fn().mockImplementation(() => {
          const tableName = table?._?.name || table?.[Symbol.for('drizzle:Name')]
          if (tableName === 'financial_proxies') {
            const proxy = mockDbData.financialProxies[0]
            if (proxy) Object.assign(proxy, values)
            mockDbData.lastLiveUpdateValues = values
            return { returning: vi.fn().mockImplementation(() => Promise.resolve(proxy ? [proxy] : [])) }
          }
          const current = [...mockDbData.financialProxyVersions].sort((a, b) => b.ordinal - a.ordinal)[0]
          if (current) Object.assign(current, values)
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
const ORG = { id: 'org-material' }
const SOURCE_ID = '550e8400-e29b-41d4-a716-446655440002'

function seedApprovedProxyWithVersion() {
  mockDbData.financialProxies = [
    {
      id: PROXY_ID,
      organizationId: ORG.id,
      sourceId: SOURCE_ID,
      reviewStatus: 'approved',
      value: '100',
      currency: 'USD',
      unit: 'person',
      referenceYear: 2025,
      valueUsd: '100',
      fxRateId: null,
      name: 'A proxy',
    },
  ]
  mockDbData.financialProxyVersions = [
    {
      id: 'version-approved-1',
      financialProxyId: PROXY_ID,
      ordinal: 1,
      reviewStatus: 'approved',
      sourceId: SOURCE_ID,
      value: '100',
      currency: 'USD',
      unit: 'person',
      referenceYear: 2025,
      valueUsd: '100',
      fxRateId: null,
      reviewerId: 'reviewer-1',
      reviewedAt: new Date('2026-01-01'),
      recoverableReference: 'https://example.org/proof',
      c1SourceQualityVerifiability: 3,
      c2OutcomeCorrespondence: 3,
      c3StakeholderPopulationFit: 3,
      c4GeographicContextFit: 3,
      c5TemporalFit: 3,
      c6MethodologicalUnitComparability: 3,
      r1ProvenanceRisk: 0,
      r2SourceLimitationRisk: 0,
      r3ConceptualFitRisk: 0,
      r4GeographicPopulationTransferRisk: 0,
      r5TemporalObsolescenceRisk: 0,
      r6TransformationRisk: 0,
      r7MethodologicalUncertaintyRisk: 0,
      confidenceScore: 100,
      confidenceLevel: 'high',
      methodologicalRiskScore: 0,
      methodologicalRisk: 'low',
      rubricVersion: '1.0.0',
      exceptionalDefendibilityDetermination: null,
    },
  ]
  mockDbData.proxySources = [{ id: SOURCE_ID, organizationId: null, status: 'active' }]
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockDbData.lastLiveUpdateValues = null
  seedApprovedProxyWithVersion()
  const { requireOrganizationAccess } = await import('@/lib/auth/session')
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: ORG,
    user: { id: 'user-1' },
    membership: { role: 'impact_manager' },
  } as any)
})

describe('updateOrganizationFinancialProxy — atomic fork on material change (FIBC-013 EXIT_GATE)', () => {
  it('ATOMIC INVALIDATION, NO WINDOW: a material edit on an approved proxy opens a new version and NEVER writes to the approved one', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    const approvedVersionBefore = { ...mockDbData.financialProxyVersions[0] }

    await updateOrganizationFinancialProxy(PROXY_ID, { value: '250' })

    // The approved version is byte-for-byte untouched.
    const approvedVersionAfter = mockDbData.financialProxyVersions.find((v) => v.id === 'version-approved-1')
    expect(approvedVersionAfter).toEqual(approvedVersionBefore)

    // A NEW version exists, inheriting neither approval, reviewer, timestamp,
    // rubric ratings, nor the exceptional determination.
    expect(mockDbData.financialProxyVersions).toHaveLength(2)
    const forked = mockDbData.financialProxyVersions.find((v) => v.id !== 'version-approved-1')
    // R-B2-01 — the successor opens as 'under_review', the mapped image of
    // the live row's 'pending_review' (LIVE_VERSION_STATUS_COUPLING).
    expect(forked.reviewStatus).toBe('under_review')
    expect(forked.reviewerId).toBeUndefined()
    expect(forked.reviewedAt).toBeUndefined()
    expect(forked.c1SourceQualityVerifiability).toBeNull()
    expect(forked.confidenceLevel).toBeNull()
    expect(forked.exceptionalDefendibilityDetermination).toBeNull()
    // Never outlives the material state that produced it.
    expect(forked.valueUsd).toBeNull()
    expect(forked.fxRateId).toBeNull()
    // Carries the new value.
    expect(forked.value).toBe('250')
    expect(forked.supersedesVersionId).toBe('version-approved-1')

    // The live row is reset — no window in which the row still claims approved.
    expect(mockDbData.financialProxies[0].reviewStatus).toBe('pending_review')
  })

  it('logs FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE on the superseded version and FINANCIAL_PROXY_VERSION_CREATED on the fork', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { value: '250' })

    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'version-approved-1',
        action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE,
      })
    )
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED })
    )
  })

  it('EDITORIAL CHANGE NEGATIVE CONTROL: renaming (non-material) does NOT invalidate — no fork, approval survives', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { name: 'Renamed proxy' })

    expect(mockDbData.financialProxyVersions).toHaveLength(1)
    expect(mockDbData.financialProxies[0].reviewStatus).toBe('approved')
    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    expect(logAuditAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE })
    )
  })

  it('a material change to a NOT-YET-approved version edits the SAME version in place — no fork, no approval to protect', async () => {
    mockDbData.financialProxies[0].reviewStatus = 'pending_review'
    mockDbData.financialProxyVersions[0].reviewStatus = 'under_review'

    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { value: '250' })

    expect(mockDbData.financialProxyVersions).toHaveLength(1)
    expect(mockDbData.financialProxyVersions[0].value).toBe('250')
  })

  it('HISTORICAL RUNS KEEP THEIR EXACT VERSION: the superseded version is retrievable afterward with its original approved content intact', async () => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    const { getFinancialProxyVersionById } = await import('@/lib/pipeline/financial-proxy-versions')

    await updateOrganizationFinancialProxy(PROXY_ID, { value: '250' })

    const historical = await getFinancialProxyVersionById('version-approved-1')
    expect(historical?.reviewStatus).toBe('approved')
    expect(historical?.value).toBe('100')
    expect(historical?.confidenceLevel).toBe('high')
  })
})
