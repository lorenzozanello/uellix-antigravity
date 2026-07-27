// lib/stella/aggregation/__tests__/declaration-query.test.ts
// Etapa A2.3.1 (STL-A231-017) — no real DB. Covers every branch of
// getSensitiveAggregationDeclarationStatus / findValidSensitiveAggregationDeclaration:
// missing, pending, revoked, superseded, below_threshold, invalid_dimensions,
// outdated_policy, valid — plus fail-closed on a DB error.

import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  // .orderBy() is the terminal call for the batch query (no .limit()) — make
  // it both chainable (for the single-row queries that call .limit() after)
  // AND awaitable directly (for the batch query, which awaits the result of
  // .orderBy() itself).
  chain.orderBy = vi.fn().mockImplementation(() => ({ ...chain, then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolvedValue).then(resolve) }))
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const mockSelect = vi.fn()
vi.mock('@/db/client', () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}))

import {
  getSensitiveAggregationDeclarationStatus,
  findValidSensitiveAggregationDeclaration,
  findValidSensitiveAggregationDeclarations,
  resolveDeclarationStatus,
  canonicalDeclarationKey,
} from '../declaration-query'
import { CURRENT_SENSITIVE_AGGREGATION_POLICY } from '../policy'
import type { SensitiveAggregationPolicy } from '../policy'

const PARAMS = {
  organizationId: 'org-1',
  projectId: 'proj-1',
  entityType: 'outcome' as const,
  entityId: 'o-1',
  sensitiveCategory: 'minors' as const,
}

function verifiedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'decl-1',
    verificationStatus: 'verified',
    groupSize: 50,
    dimensions: [],
    policyVersion: 'v1',
    minimumGroupSizeApplied: 10,
    verifiedAt: new Date('2026-07-26T00:00:00Z'),
    sensitiveCategory: 'minors',
    entityType: 'outcome',
    entityId: 'o-1',
    groupSizeBucket: '50_249',
    ...overrides,
  }
}

describe('getSensitiveAggregationDeclarationStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns missing when no declaration exists', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result).toEqual({ status: 'missing' })
  })

  it('returns pending for a not-yet-verified declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', verificationStatus: 'pending' }]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result).toEqual({ status: 'pending', declarationId: 'decl-1' })
  })

  it('returns revoked for a revoked declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', verificationStatus: 'revoked' }]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result).toEqual({ status: 'revoked', declarationId: 'decl-1' })
  })

  it('returns superseded for a superseded declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', verificationStatus: 'superseded' }]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result).toEqual({ status: 'superseded', declarationId: 'decl-1' })
  })

  it('returns valid for a verified declaration meeting the current policy', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow()]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result.status).toBe('valid')
    expect(result.groupSizeBucket).toBe('50_249')
    expect(result.minimumGroupSizeApplied).toBe(10)
  })

  it('returns below_threshold for a verified declaration whose groupSize no longer meets the current minimum', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ groupSize: 5 })]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result.status).toBe('below_threshold')
  })

  it('returns invalid_dimensions for a verified declaration whose dimensions no longer pass the current allowlist', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ dimensions: ['exact_school_name'] })]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result.status).toBe('invalid_dimensions')
  })

  it('returns invalid_dimensions for a verified declaration whose dimensions are now a high-risk combination', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ dimensions: ['gender', 'territory_level'] })]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result.status).toBe('invalid_dimensions')
  })

  it('returns outdated_policy for a verified declaration under an older policy version', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ policyVersion: 'v0' })]))
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result.status).toBe('outdated_policy')
    expect(result.policyVersion).toBe('v0')
  })

  it('fails closed to missing on a DB error', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('connection lost')
    })
    const result = await getSensitiveAggregationDeclarationStatus(PARAMS)
    expect(result).toEqual({ status: 'missing' })
  })
})

describe('findValidSensitiveAggregationDeclaration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when no verified declaration exists', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).toBeNull()
  })

  it('returns a usable AggregateDataDeclaration for a currently-valid verified declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ groupSize: 50, dimensions: ['age_band'] })]))
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).toEqual({
      sensitiveCategory: 'minors',
      aggregationLevel: 'aggregate',
      groupSize: 50,
      dimensions: ['age_band'],
      sourceEntityType: 'outcome',
      sourceEntityId: 'o-1',
    })
  })

  it('returns null when the verified declaration is now below the current threshold', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ groupSize: 5 })]))
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).toBeNull()
  })

  it('returns null when the verified declaration has invalid dimensions under the current policy', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ dimensions: ['exact_school_name'] })]))
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).toBeNull()
  })

  it('returns null when the verified declaration is under an outdated policy version', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ policyVersion: 'v0' })]))
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).toBeNull()
  })

  it('fails closed to null on a DB error', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('connection lost')
    })
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).toBeNull()
  })

  it('never returns a declarationId, actor, or reason — only the fields assessSensitiveData needs', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow()]))
    const result = await findValidSensitiveAggregationDeclaration(PARAMS)
    expect(result).not.toHaveProperty('declaredBy')
    expect(result).not.toHaveProperty('verifiedBy')
    expect(result).not.toHaveProperty('id')
  })
})

// Etapa A2.3.2 (STL-A232-007): policy injection, no real DB, no mutation of
// the productive CURRENT_SENSITIVE_AGGREGATION_POLICY constant. Proves a
// declaration verified under v1/groupSize-10 becomes outdated/below-threshold
// under an injected v2/minimum-15 policy fixture.
describe('resolveDeclarationStatus — policy injection (v1 → v2)', () => {
  const V2_HIGHER_THRESHOLD: SensitiveAggregationPolicy = {
    ...CURRENT_SENSITIVE_AGGREGATION_POLICY,
    policyVersion: 'v2',
    minimumGroupSize: 15,
  }

  it('a groupSize-10 declaration verified under v1 is valid under the CURRENT (v1) policy', () => {
    const row = verifiedRow({ groupSize: 10, policyVersion: 'v1' })
    const status = resolveDeclarationStatus(row)
    expect(status.status).toBe('valid')
  })

  it('the SAME groupSize-10/v1 declaration becomes below_threshold under an injected v2 policy with minimum 15', () => {
    const row = verifiedRow({ groupSize: 10, policyVersion: 'v1' })
    const status = resolveDeclarationStatus(row, V2_HIGHER_THRESHOLD)
    expect(status.status).toBe('below_threshold')
  })

  it('a declaration meeting the new minimum but still tagged with the old policyVersion is outdated_policy, not valid', () => {
    const row = verifiedRow({ groupSize: 20, policyVersion: 'v1' })
    const status = resolveDeclarationStatus(row, V2_HIGHER_THRESHOLD)
    expect(status.status).toBe('outdated_policy')
  })

  it('a dimension that was allowed under v1 can be rejected under an injected policy with a narrower allowlist', () => {
    const narrowedPolicy: SensitiveAggregationPolicy = {
      ...CURRENT_SENSITIVE_AGGREGATION_POLICY,
      policyVersion: 'v2',
      allowedDimensions: ['age_band'], // 'gender' no longer allowed under v2
    }
    const row = verifiedRow({ dimensions: ['gender'] })
    const status = resolveDeclarationStatus(row, narrowedPolicy)
    expect(status.status).toBe('invalid_dimensions')
  })

  it('a combination that was safe under v1 can become high-risk under an injected policy', () => {
    const newHighRiskPolicy: SensitiveAggregationPolicy = {
      ...CURRENT_SENSITIVE_AGGREGATION_POLICY,
      policyVersion: 'v2',
      highRiskCombinations: [['program_period', 'education_level_band']],
    }
    const row = verifiedRow({ dimensions: ['program_period', 'education_level_band'] })
    const status = resolveDeclarationStatus(row, newHighRiskPolicy)
    expect(status.status).toBe('invalid_dimensions')
  })

  it('does not mutate the productive CURRENT_SENSITIVE_AGGREGATION_POLICY constant', () => {
    resolveDeclarationStatus(verifiedRow({ groupSize: 10 }), V2_HIGHER_THRESHOLD)
    expect(CURRENT_SENSITIVE_AGGREGATION_POLICY.minimumGroupSize).toBe(10)
    expect(CURRENT_SENSITIVE_AGGREGATION_POLICY.policyVersion).toBe('v1')
  })

  it('a pending/revoked/superseded status is unaffected by the policy parameter', () => {
    expect(resolveDeclarationStatus({ ...verifiedRow(), verificationStatus: 'pending' }, V2_HIGHER_THRESHOLD).status).toBe('pending')
    expect(resolveDeclarationStatus({ ...verifiedRow(), verificationStatus: 'revoked' }, V2_HIGHER_THRESHOLD).status).toBe('revoked')
  })
})

describe('findValidSensitiveAggregationDeclarations (batch)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an empty map for an empty refs array without querying the DB', async () => {
    const result = await findValidSensitiveAggregationDeclarations({ organizationId: 'org-1', projectId: 'proj-1', refs: [] })
    expect(result.size).toBe(0)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('executes exactly ONE query regardless of how many refs are requested (no N+1)', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const refs = Array.from({ length: 100 }, (_, i) => ({
      entityType: 'outcome' as const,
      entityId: `outcome-${i}`,
      sensitiveCategory: 'minors' as const,
    }))
    await findValidSensitiveAggregationDeclarations({ organizationId: 'org-1', projectId: 'proj-1', refs })
    expect(mockSelect).toHaveBeenCalledTimes(1)
  })

  it('deduplicates identical refs before building the query', async () => {
    const chain = makeSelectChain([])
    mockSelect.mockReturnValue(chain)
    const refs = [
      { entityType: 'outcome' as const, entityId: 'o-1', sensitiveCategory: 'minors' as const },
      { entityType: 'outcome' as const, entityId: 'o-1', sensitiveCategory: 'minors' as const },
      { entityType: 'outcome' as const, entityId: 'o-1', sensitiveCategory: 'minors' as const },
    ]
    const result = await findValidSensitiveAggregationDeclarations({ organizationId: 'org-1', projectId: 'proj-1', refs })
    expect(result.size).toBe(1)
    expect(mockSelect).toHaveBeenCalledTimes(1)
  })

  it('resolves each ref to its matching declaration, keyed canonically', async () => {
    mockSelect.mockReturnValue(
      makeSelectChain([verifiedRow({ entityId: 'o-1', sensitiveCategory: 'minors' }), verifiedRow({ entityId: 'o-2', sensitiveCategory: 'health' })]),
    )
    const result = await findValidSensitiveAggregationDeclarations({
      organizationId: 'org-1',
      projectId: 'proj-1',
      refs: [
        { entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors' },
        { entityType: 'outcome', entityId: 'o-2', sensitiveCategory: 'health' },
        { entityType: 'outcome', entityId: 'o-3', sensitiveCategory: 'minors' }, // no matching row
      ],
    })
    expect(result.get(canonicalDeclarationKey({ entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors' }))).not.toBeNull()
    expect(result.get(canonicalDeclarationKey({ entityType: 'outcome', entityId: 'o-2', sensitiveCategory: 'health' }))).not.toBeNull()
    expect(result.get(canonicalDeclarationKey({ entityType: 'outcome', entityId: 'o-3', sensitiveCategory: 'minors' }))).toBeNull()
  })

  it('never returns a declaration below the current threshold, even in batch', async () => {
    mockSelect.mockReturnValue(makeSelectChain([verifiedRow({ entityId: 'o-1', groupSize: 5 })]))
    const result = await findValidSensitiveAggregationDeclarations({
      organizationId: 'org-1',
      projectId: 'proj-1',
      refs: [{ entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors' }],
    })
    expect(result.get(canonicalDeclarationKey({ entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors' }))).toBeNull()
  })

  it('caps at MAX_BATCH_ENTITIES rather than growing the query unbounded — refs beyond the cap are simply absent from the map (fail-closed: an absent key and a null value are treated identically by callers)', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const refs = Array.from({ length: 500 }, (_, i) => ({
      entityType: 'outcome' as const,
      entityId: `outcome-${i}`,
      sensitiveCategory: 'minors' as const,
    }))
    const result = await findValidSensitiveAggregationDeclarations({ organizationId: 'org-1', projectId: 'proj-1', refs })
    expect(result.size).toBeLessThanOrEqual(200)
    expect(mockSelect).toHaveBeenCalledTimes(1)
  })

  it('fails closed (all null) on a DB error, without throwing', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('connection lost')
    })
    const result = await findValidSensitiveAggregationDeclarations({
      organizationId: 'org-1',
      projectId: 'proj-1',
      refs: [{ entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors' }],
    })
    expect(result.get(canonicalDeclarationKey({ entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors' }))).toBeNull()
  })
})
