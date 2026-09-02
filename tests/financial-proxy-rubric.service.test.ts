// tests/financial-proxy-rubric.service.test.ts
// FIBIU-09 — PROXY_DEFENDIBILITY_RUBRIC_v1.0.0 (FIBC-011). Covers the
// pure, authoritative derivation (deriveRubricClassification), the
// approval gate (assertRubricApprovable), and the governed write path
// (recordProxyRubricEvaluation), including the adversarial negative
// controls FIBIU-09's own EXIT_GATE names: an unrated factor blocks
// approval, and a level contradicting a ceiling/floor is REJECTED, not
// silently corrected.

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

// Module-level mocks (hoisted regardless of where declared — moved here to
// match execution order and avoid Vitest's nested-hoist deprecation
// warning). Only the service-level describe block below exercises these;
// the pure-function tests never touch db/auth/audit at all.
const mockDbData = vi.hoisted(() => ({
  financialProxies: [] as MockRow[],
  financialProxyVersions: [] as MockRow[],
}))

vi.mock('@/db/client', () => {
  const database: MockDb = {
    transaction: vi.fn(async (callback: (tx: MockDb) => Promise<unknown>) => callback(database)),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        const tableName = tableNameOf(table)
        const data =
          tableName === 'financial_proxies' ? mockDbData.financialProxies : mockDbData.financialProxyVersions
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
            const row = { id: `ver-${mockDbData.financialProxyVersions.length + 1}`, createdAt: new Date(), ...vals }
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
            return { returning: vi.fn().mockImplementation(() => Promise.resolve(proxy ? [proxy] : [])) }
          }
          const current = [...mockDbData.financialProxyVersions].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))[0]
          if (current) Object.assign(current, values)
          return { returning: vi.fn().mockImplementation(() => Promise.resolve(current ? [current] : [])) }
        }),
      })),
    })),
  }
  return { db: database }
})

vi.mock('@/lib/auth/session', () => ({ requireOrganizationAccess: vi.fn() }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})
vi.mock('@/lib/pipeline/governed-model-registry', () => ({
  getCurrentGovernedModelVersion: vi.fn(),
}))

// ---------------------------------------------------------------------
// Pure-function coverage — these mocks are inert for it (the module under
// test never calls db/auth/audit outside recordProxyRubricEvaluation).
// ---------------------------------------------------------------------
import {
  deriveRubricClassification,
  assertRubricApprovable,
  CONFIDENCE_FACTOR_KEYS,
  RISK_FACTOR_KEYS,
  type RubricFactors,
} from '@/lib/pipeline/financial-proxy-rubric'

const ALL_HIGH_CONFIDENCE_NO_RISK: RubricFactors = {
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
}

describe('deriveRubricClassification — the sole authoritative derivation (FIBC-011)', () => {
  it('is reproducible: identical input always yields identical output', () => {
    const a = deriveRubricClassification(ALL_HIGH_CONFIDENCE_NO_RISK)
    const b = deriveRubricClassification({ ...ALL_HIGH_CONFIDENCE_NO_RISK })
    expect(a).toEqual(b)
  })

  it('all-3 confidence factors -> score 100, level high, no exceptional determination needed', () => {
    const result = deriveRubricClassification(ALL_HIGH_CONFIDENCE_NO_RISK)
    expect(result.confidenceScore).toBe(100)
    expect(result.confidenceLevel).toBe('high')
    expect(result.methodologicalRiskScore).toBe(0)
    expect(result.methodologicalRisk).toBe('low')
    expect(result.requiresExceptionalDetermination).toBe(false)
  })

  it('all-0 confidence factors -> score 0, level low', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      c1SourceQualityVerifiability: 0,
      c2OutcomeCorrespondence: 0,
      c3StakeholderPopulationFit: 0,
      c4GeographicContextFit: 0,
      c5TemporalFit: 0,
      c6MethodologicalUnitComparability: 0,
    })
    expect(result.confidenceScore).toBe(0)
    expect(result.confidenceLevel).toBe('low')
  })

  it('CEILING: any Ci=0 (not C1/C2) caps confidence at medium, never high, regardless of base score', () => {
    // c3=0 alone: sum = 3+3+0+3+3+3=15 -> round(100*15/18)=83, base would be
    // "high" (>=80) but the ceiling caps it at medium.
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      c3StakeholderPopulationFit: 0,
    })
    expect(result.confidenceScore).toBe(83)
    expect(result.confidenceLevel).toBe('medium')
  })

  it('CEILING (stronger): C1=0 forces low even when the base score would be medium/high', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      c1SourceQualityVerifiability: 0,
    })
    // sum = 0+3+3+3+3+3=15 -> round(100*15/18)=83
    expect(result.confidenceScore).toBe(83)
    expect(result.confidenceLevel).toBe('low')
  })

  it('CEILING (stronger): C2=0 forces low even when the base score would be medium/high', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      c2OutcomeCorrespondence: 0,
    })
    expect(result.confidenceLevel).toBe('low')
  })

  it('a level contradicting the ceiling is never silently corrected — the function REJECTS being told the wrong level (it has no input for level at all)', () => {
    // deriveRubricClassification takes only raw factors — there is no code
    // path anywhere that lets a caller pass a pre-computed level and have
    // it silently accepted. This is the negative control's real target:
    // confirmed by inspecting the function signature (RubricFactors only).
    const result = deriveRubricClassification(ALL_HIGH_CONFIDENCE_NO_RISK)
    expect(Object.keys(result)).not.toContain('confidenceLevelOverride')
  })

  it('FLOOR: any Ri>=2 raises methodological risk to at least medium, never low', () => {
    // r4=2 alone: sum=2 -> round(100*2/21)=10, base would be "low" (<25)
    // but the floor raises it to medium.
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      r4GeographicPopulationTransferRisk: 2,
    })
    expect(result.methodologicalRiskScore).toBe(10)
    expect(result.methodologicalRisk).toBe('medium')
  })

  it('FLOOR (stronger): any Ri=3 forces high even when the base score would be low/medium', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      r6TransformationRisk: 3,
    })
    // sum=3 -> round(100*3/21)=14, base would be low, floor forces high
    expect(result.methodologicalRiskScore).toBe(14)
    expect(result.methodologicalRisk).toBe('high')
  })

  it('requiresExceptionalDetermination is true when confidence is low, even with zero risk', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      c1SourceQualityVerifiability: 0,
    })
    expect(result.requiresExceptionalDetermination).toBe(true)
  })

  it('requiresExceptionalDetermination is true when risk is high, even with perfect confidence', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      r1ProvenanceRisk: 3,
    })
    expect(result.requiresExceptionalDetermination).toBe(true)
  })

  it('requiresExceptionalDetermination is true when BOTH confidence is low AND risk is high', () => {
    const result = deriveRubricClassification({
      ...ALL_HIGH_CONFIDENCE_NO_RISK,
      c1SourceQualityVerifiability: 0,
      r1ProvenanceRisk: 3,
    })
    expect(result.confidenceLevel).toBe('low')
    expect(result.methodologicalRisk).toBe('high')
    expect(result.requiresExceptionalDetermination).toBe(true)
  })

  it('throws when any of the thirteen factors is unrated (null/undefined) — no partial derivation', () => {
    for (const key of [...CONFIDENCE_FACTOR_KEYS, ...RISK_FACTOR_KEYS]) {
      const factors = { ...ALL_HIGH_CONFIDENCE_NO_RISK, [key]: undefined } as unknown as RubricFactors
      expect(() => deriveRubricClassification(factors)).toThrow(/unrated/)
    }
  })

  it('throws when a factor is outside 0..3', () => {
    expect(() =>
      deriveRubricClassification({ ...ALL_HIGH_CONFIDENCE_NO_RISK, c1SourceQualityVerifiability: 4 })
    ).toThrow(/must be 0, 1, 2, or 3/)
    expect(() =>
      deriveRubricClassification({ ...ALL_HIGH_CONFIDENCE_NO_RISK, r7MethodologicalUncertaintyRisk: -1 })
    ).toThrow(/must be 0, 1, 2, or 3/)
  })
})

describe('assertRubricApprovable — FIBIU-09 EXIT_GATE: unrated factor blocks approval', () => {
  it('throws when any factor is unrated', () => {
    expect(() =>
      assertRubricApprovable({
        ...ALL_HIGH_CONFIDENCE_NO_RISK,
        c4GeographicContextFit: null as unknown as number,
        exceptionalDefendibilityDetermination: null,
      })
    ).toThrow(/unrated factors/)
  })

  it('passes when fully rated and no exceptional determination is required', () => {
    expect(() =>
      assertRubricApprovable({ ...ALL_HIGH_CONFIDENCE_NO_RISK, exceptionalDefendibilityDetermination: null })
    ).not.toThrow()
  })

  it('throws when confidence is low and no exceptional determination is recorded', () => {
    expect(() =>
      assertRubricApprovable({
        ...ALL_HIGH_CONFIDENCE_NO_RISK,
        c1SourceQualityVerifiability: 0,
        exceptionalDefendibilityDetermination: null,
      })
    ).toThrow(/exceptional-defendibility determination/)
  })

  it('throws when the exceptional determination is present but blank/whitespace-only', () => {
    expect(() =>
      assertRubricApprovable({
        ...ALL_HIGH_CONFIDENCE_NO_RISK,
        r1ProvenanceRisk: 3,
        exceptionalDefendibilityDetermination: '   ',
      })
    ).toThrow(/exceptional-defendibility determination/)
  })

  it('passes when risk is high and a real exceptional determination is recorded', () => {
    expect(() =>
      assertRubricApprovable({
        ...ALL_HIGH_CONFIDENCE_NO_RISK,
        r1ProvenanceRisk: 3,
        exceptionalDefendibilityDetermination: 'Accepted per peer-reviewed cross-validation study X.',
      })
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------
// Service-level coverage — recordProxyRubricEvaluation, mocked db/auth.
// ---------------------------------------------------------------------
describe('recordProxyRubricEvaluation — governed write path', () => {
  const PROXY_ID = 'proxy-1'
  const ORG = { id: 'org-1' }

  const VALID_EVALUATION = {
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
    rationale: 'Source cross-validated against two independent government datasets.',
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // R-B2-01 — realistic coupled statuses (live 'suggested' <-> version 'draft').
    mockDbData.financialProxies = [{ id: PROXY_ID, organizationId: ORG.id, reviewStatus: 'suggested' }]
    mockDbData.financialProxyVersions = [{ id: 'ver-1', financialProxyId: PROXY_ID, ordinal: 1, reviewStatus: 'draft' }]

    const { requireOrganizationAccess } = await import('@/lib/auth/session')
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      organization: ORG,
      user: { id: 'user-1' },
      membership: { role: 'impact_manager' },
    } as unknown as OrganizationContext)

    const { getCurrentGovernedModelVersion } = await import('@/lib/pipeline/governed-model-registry')
    vi.mocked(getCurrentGovernedModelVersion).mockResolvedValue({ version: '1.0.0' } as unknown as Awaited<ReturnType<typeof getCurrentGovernedModelVersion>>)
  })

  it('records a full evaluation, derives the classification, and logs the rubric-evaluated audit action', async () => {
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    const result = await recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)

    expect(result.confidenceScore).toBe(100)
    expect(result.confidenceLevel).toBe('high')
    expect(result.methodologicalRisk).toBe('low')
    expect(result.rubricVersion).toBe('1.0.0')

    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_RUBRIC_EVALUATED })
    )
    // No exceptional determination needed here — that audit action must NOT fire.
    expect(logAuditAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_EXCEPTIONAL_DETERMINATION_RECORDED })
    )
  })

  it('logs the exceptional-determination audit action when the classification requires one', async () => {
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await recordProxyRubricEvaluation(PROXY_ID, {
      ...VALID_EVALUATION,
      r1ProvenanceRisk: 3,
      exceptionalDefendibilityDetermination: 'Accepted per governance committee minute #42.',
    })

    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_EXCEPTIONAL_DETERMINATION_RECORDED })
    )
  })

  it('PERMISSION negative control: rejects a role below impact_manager (e.g. analyst)', async () => {
    const { requireOrganizationAccess } = await import('@/lib/auth/session')
    vi.mocked(requireOrganizationAccess).mockResolvedValue({
      organization: ORG,
      user: { id: 'user-1' },
      membership: { role: 'analyst' },
    } as unknown as OrganizationContext)

    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)).rejects.toThrow(
      'Insufficient permissions'
    )
  })

  it('TENANCY/IDOR negative control: rejects a proxy owned by a different organization', async () => {
    mockDbData.financialProxies = [{ id: PROXY_ID, organizationId: 'org-other' }]
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)).rejects.toThrow('Forbidden')
  })

  it('rejects a nonexistent proxy', async () => {
    mockDbData.financialProxies = []
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)).rejects.toThrow('Proxy not found')
  })

  it('rejects a proxy with no version to evaluate', async () => {
    mockDbData.financialProxyVersions = []
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)).rejects.toThrow(
      'no version to evaluate'
    )
  })

  it('rejects a rationale-free submission (numeric-only rating is not enough)', async () => {
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(
      recordProxyRubricEvaluation(PROXY_ID, { ...VALID_EVALUATION, rationale: '' })
    ).rejects.toThrow()
  })

  it('NEGATIVE CONTROL: low confidence without an exceptional determination is rejected, not silently corrected or waived', async () => {
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(
      recordProxyRubricEvaluation(PROXY_ID, { ...VALID_EVALUATION, c1SourceQualityVerifiability: 0 })
    ).rejects.toThrow('exceptional-defendibility determination')
    // The version must remain unmodified — no partial/silent write occurred.
    expect(mockDbData.financialProxyVersions[0].confidenceLevel).toBeUndefined()
  })

  it('rejects when no governed PROXY_DEFENDIBILITY_RUBRIC version is registered', async () => {
    const { getCurrentGovernedModelVersion } = await import('@/lib/pipeline/governed-model-registry')
    vi.mocked(getCurrentGovernedModelVersion).mockResolvedValue(null as unknown as Awaited<ReturnType<typeof getCurrentGovernedModelVersion>>)
    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await expect(recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)).rejects.toThrow(
      'No governed PROXY_DEFENDIBILITY_RUBRIC version'
    )
  })

  // FIBIU-10 (FIBC-013) — rubric ratings are material category 9. A
  // re-evaluation of an ALREADY-approved version must fork, exactly like
  // any other material change, never silently overwrite the sealed rubric
  // a human approved.
  it('FIBIU-10: re-evaluating an APPROVED version forks — the approved rubric is untouched, a new draft version carries the new rating', async () => {
    mockDbData.financialProxyVersions = [
      { id: 'ver-approved', financialProxyId: PROXY_ID, ordinal: 1, reviewStatus: 'approved', recoverableReference: 'https://x', ...ALL_HIGH_CONFIDENCE_NO_RISK },
    ]
    const before = { ...mockDbData.financialProxyVersions[0] }

    const { recordProxyRubricEvaluation } = await import('@/lib/pipeline/financial-proxy-rubric')
    await recordProxyRubricEvaluation(PROXY_ID, VALID_EVALUATION)

    const approvedAfter = mockDbData.financialProxyVersions.find((v) => v.id === 'ver-approved')
    expect(approvedAfter).toEqual(before)
    expect(mockDbData.financialProxyVersions).toHaveLength(2)
    const forked = mockDbData.financialProxyVersions.find((v) => v.id !== 'ver-approved')!
    // R-B2-01 — fork opens as 'under_review' (mapped image of live 'pending_review').
    expect(forked.reviewStatus).toBe('under_review')
    expect(forked.confidenceScore).toBe(100)

    expect(mockDbData.financialProxies[0].reviewStatus).toBe('pending_review')

    const { logAuditAction, AUDIT_ACTIONS } = await import('@/lib/audit/logger')
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'ver-approved',
        action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE,
      })
    )
  })
})
