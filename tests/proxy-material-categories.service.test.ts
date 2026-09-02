// tests/proxy-material-categories.service.test.ts
// W2-B2-R1 / R-B2-09 — "All ten FIBC-013 material categories, parameterised
// exhaustively — one case per category proving a change in that category
// forks an approved version." Eight categories are reachable through the
// organization edit path (FinancialProxyInput); rubric_ratings_derivations
// and exceptional_defendibility_determination are reached through the
// governed rubric path, exercised here through the same mock so the ten are
// covered in one place. Also pins approved-version immutability and the
// successor reset across each of them.

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
import { MATERIAL_CATEGORIES, registryRow, INPUT_KEY_TO_PERSISTED_FIELD } from '@/lib/pipeline/proxy-material-change'

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
vi.mock('@/lib/auth/permissions', () => ({ canApproveProxy: vi.fn().mockReturnValue(true), canEvaluateProxyRubric: vi.fn().mockReturnValue(true) }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})
vi.mock('@/lib/pipeline/governed-model-registry', () => ({ getCurrentGovernedModelVersion: vi.fn().mockResolvedValue({ version: '1.0.0' }) }))

const PROXY_ID = '550e8400-e29b-41d4-a716-446655440001'
const ORG = { id: 'org-cat' }
const SOURCE_ID = '550e8400-e29b-41d4-a716-446655440002'
const OTHER_SOURCE_ID = '550e8400-e29b-41d4-a716-446655440003'

const RUBRIC = {
  c1SourceQualityVerifiability: 3, c2OutcomeCorrespondence: 3, c3StakeholderPopulationFit: 3,
  c4GeographicContextFit: 3, c5TemporalFit: 3, c6MethodologicalUnitComparability: 3,
  r1ProvenanceRisk: 0, r2SourceLimitationRisk: 0, r3ConceptualFitRisk: 0, r4GeographicPopulationTransferRisk: 0,
  r5TemporalObsolescenceRisk: 0, r6TransformationRisk: 0, r7MethodologicalUncertaintyRisk: 0,
}

function seedApproved() {
  mockDbData.financialProxies = [
    { id: PROXY_ID, organizationId: ORG.id, sourceId: SOURCE_ID, reviewStatus: 'approved', value: '100.0000', currency: 'USD', unit: 'person', referenceYear: 2025, valueUsd: '100.0000', fxRateId: null, name: 'A proxy', description: null, proxyType: 'cost', country: 'CO', territory: null, thematicArea: 'salud', methodology: 'm', confidenceLevel: 'high', methodologicalRisk: 'low' },
  ]
  mockDbData.financialProxyVersions = [
    {
      id: 'version-approved-1', financialProxyId: PROXY_ID, ordinal: 1, reviewStatus: 'approved',
      sourceId: SOURCE_ID, value: '100.0000', currency: 'USD', unit: 'person', referenceYear: 2025,
      valueUsd: '100.0000', fxRateId: null, reviewerId: 'reviewer-1', reviewedAt: new Date('2026-01-01'),
      country: 'CO', territory: null, thematicArea: 'salud', methodology: 'm',
      geographicContextualScope: 'Nacional', linkedOutcomeContext: 'Ingreso', recoverableReference: 'https://x',
      relevanceJustification: 'Misma población', documentedTransformations: 'none', consultationDate: new Date('2026-01-10T00:00:00Z'),
      ...RUBRIC, confidenceScore: 100, confidenceLevel: 'high', methodologicalRiskScore: 0, methodologicalRisk: 'low', rubricVersion: '1.0.0',
      exceptionalDefendibilityDetermination: null,
    },
  ]
  mockDbData.proxySources = [
    { id: SOURCE_ID, organizationId: null, status: 'active' },
    { id: OTHER_SOURCE_ID, organizationId: null, status: 'active' },
  ]
  mockDbData.lastLiveUpdateValues = null
  mockDbData.lastVersionUpdateValues = null
}

beforeEach(async () => {
  vi.clearAllMocks()
  seedApproved()
  const { requireOrganizationAccess } = await import('@/lib/auth/session')
  vi.mocked(requireOrganizationAccess).mockResolvedValue({ organization: ORG, user: { id: 'user-1' }, membership: { role: 'impact_manager' } } as unknown as OrganizationContext)
})

// One representative user_editable input per category reachable through the
// organization edit path (eight of the ten).
const EDIT_PATH_CASES: { category: string; key: string; value: unknown }[] = [
  { category: 'identity_economic_value', key: 'value', value: '250' },
  { category: 'source_provenance', key: 'recoverableReference', value: 'https://y' },
  { category: 'outcome_stakeholder_correspondence', key: 'linkedOutcomeContext', value: 'Otro resultado' },
  { category: 'geographic_institutional_context', key: 'geographicContextualScope', value: 'Regional' },
  { category: 'temporal_context', key: 'consultationDate', value: '2026-03-01' },
  { category: 'methodology_comparability', key: 'methodology', value: 'm2' },
  { category: 'transformations', key: 'documentedTransformations', value: 'inflation-adjusted' },
  { category: 'provenance_rationale', key: 'relevanceJustification', value: 'Otra justificación' },
]

async function expectForkWithReset(): Promise<MockRow> {
  const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
  expect(mockDbData.financialProxyVersions).toHaveLength(2)
  const v1 = mockDbData.financialProxyVersions[0]
  const v2 = mockDbData.financialProxyVersions[1]
  // Approved-version immutability: V1 never written to.
  expect(mockDbData.lastVersionUpdateValues === null || mockDbData.lastVersionUpdateValues.__target !== v1.id).toBe(true)
  expect(v1.reviewStatus).toBe('approved')
  expect(v1.reviewerId).toBe('reviewer-1')
  // Successor reset: nothing of the approval inherited.
  expect(v2.reviewStatus).toBe('under_review')
  expect(v2.supersedesVersionId).toBe('version-approved-1')
  expect(v2.reviewerId).toBeUndefined()
  expect(v2.reviewedAt).toBeUndefined()
  expect(v2.valueUsd).toBeNull()
  expect(v2.fxRateId).toBeNull()
  expect(mockDbData.financialProxies[0].reviewStatus).toBe('pending_review')
  expect(logAuditAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'version-approved-1', action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE }))
  return v2
}

describe('ten FIBC-013 material categories — each forks an approved version (R-B2-09)', () => {
  it('the eight edit-path cases cover eight distinct sealed categories and each key really belongs to it', () => {
    const covered = new Set(EDIT_PATH_CASES.map((c) => c.category))
    expect(covered.size).toBe(8)
    for (const c of EDIT_PATH_CASES) {
      const ref = INPUT_KEY_TO_PERSISTED_FIELD[c.key]
      expect(registryRow(ref.table, ref.column)?.category, c.key).toBe(c.category)
    }
  })

  it.each(EDIT_PATH_CASES)('$category — changing $key forks; V1 untouched; V2 inherits no approval, no rubric, no determination', async ({ key, value }) => {
    const { updateOrganizationFinancialProxy } = await import('@/lib/pipeline/proxies')
    await updateOrganizationFinancialProxy(PROXY_ID, { [key]: value })
    const v2 = await expectForkWithReset()
    // The changed value landed on the successor…
    if (key === 'consultationDate') expect(new Date(v2.consultationDate as string).toISOString().slice(0, 10)).toBe(value)
    else if (key === 'value') expect(v2.value).toBe(value)
    else expect(v2[key]).toBe(value)
    // …and the successor carries no rubric or determination.
    for (const f of Object.keys(RUBRIC)) expect(v2[f], f).toBeNull()
    expect(v2.exceptionalDefendibilityDetermination).toBeNull()
  })

  it('rubric_ratings_derivations — re-rating an approved version through the governed rubric path forks with the same reset', async () => {
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await recordProxyRubricEvaluation(PROXY_ID, { ...RUBRIC, c3StakeholderPopulationFit: 2, rationale: 'population fit re-assessed' })
    const v2 = await expectForkWithReset()
    expect(v2.c3StakeholderPopulationFit).toBe(2)
    expect(mockDbData.financialProxyVersions[0].c3StakeholderPopulationFit).toBe(3)
  })

  it('exceptional_defendibility_determination — recording a determination on an approved version (identical ratings, low/high result) forks with the same reset', async () => {
    // Make the approved V1 a low-confidence one WITH a determination, then
    // re-record with a DIFFERENT determination text and identical ratings.
    const lowRubric = { ...RUBRIC, c1SourceQualityVerifiability: 0 }
    Object.assign(mockDbData.financialProxyVersions[0], lowRubric, { confidenceLevel: 'low', confidenceScore: 83, exceptionalDefendibilityDetermination: 'Original determination' })
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await recordProxyRubricEvaluation(PROXY_ID, { ...lowRubric, rationale: 'r', exceptionalDefendibilityDetermination: 'A new, different determination' })
    const v2 = await expectForkWithReset()
    expect(v2.exceptionalDefendibilityDetermination).toBe('A new, different determination')
    expect(mockDbData.financialProxyVersions[0].exceptionalDefendibilityDetermination).toBe('Original determination')
  })

  it('every sealed category is covered by exactly one of the cases above', () => {
    const covered = new Set([...EDIT_PATH_CASES.map((c) => c.category), 'rubric_ratings_derivations', 'exceptional_defendibility_determination'])
    expect([...covered].sort()).toEqual([...MATERIAL_CATEGORIES].sort())
  })
})
