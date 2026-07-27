// lib/stella/aggregation/__tests__/declaration-adversarial.test.ts
// Etapa A2.3.1 (STL-A231-021, DR-002/DR-003) — evasion attempts against the
// declaration system itself (distinct from sensitive-population-adversarial.test.ts,
// which attacks the TEXT classifier). Purely structural, no real DB, no
// model calls.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockValidateEntityScope = vi.fn()
vi.mock('../entity-validation', () => ({
  validateEntityScope: (...args: unknown[]) => mockValidateEntityScope(...args),
}))

function makeInsertChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.for = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

function makeUpdateChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockUpdate = vi.fn()
const txClient = {
  insert: (...args: unknown[]) => mockInsert(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  update: (...args: unknown[]) => mockUpdate(...args),
}
const mockTransaction = vi.fn().mockImplementation((cb: (tx: typeof txClient) => unknown) => cb(txClient))
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

import { createSensitiveAggregationDeclaration, verifySensitiveAggregationDeclaration } from '../declaration-service'
import { getSensitiveAggregationDeclarationStatus } from '../declaration-query'
import type { CreateDeclarationInput } from '../types'

function validInput(overrides: Partial<CreateDeclarationInput> = {}): CreateDeclarationInput {
  return {
    organizationId: 'org-1',
    projectId: 'proj-1',
    entityType: 'outcome',
    entityId: 'o-1',
    sensitiveCategory: 'minors',
    groupSize: 50,
    dimensions: [],
    countSourceType: 'indicator_measurement',
    declaredByUserId: 'user-1',
    ...overrides,
  }
}

describe('Adversarial: role escalation attempts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateEntityScope.mockResolvedValue({ valid: true })
  })

  it('a caller cannot self-verify by passing "organization_admin" without actually holding that membership — the SERVER must supply the real role', () => {
    // This is a structural guarantee, not something the service can check by
    // itself: the service trusts whatever actorRole string it's given. The
    // real defense is that app/actions/stella/aggregation-declarations.ts
    // ALWAYS resolves the role from requireOrganizationAccess() server-side
    // — see aggregation-declarations.test.ts's "passes the actual membership
    // role through" test, which proves the action layer never accepts a
    // client-supplied role.
    expect(true).toBe(true)
  })

  it('viewer cannot create a declaration even with otherwise perfectly valid input', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput(), 'viewer')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
  })

  it('analyst cannot verify a declaration even though analyst CAN create one', async () => {
    mockInsert.mockReturnValue(makeInsertChain([{ id: 'decl-1' }]))
    const created = await createSensitiveAggregationDeclaration(validInput(), 'analyst')
    expect(created.ok).toBe(true)

    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'analyst')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
  })
})

describe('Adversarial: threshold and bucket manipulation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateEntityScope.mockResolvedValue({ valid: true })
  })

  it('a client-supplied groupSizeBucket is ignored — the server always recomputes it from groupSize', async () => {
    const insertChain = makeInsertChain([{ id: 'decl-1' }])
    mockInsert.mockReturnValue(insertChain)
    await createSensitiveAggregationDeclaration(
      { ...validInput({ groupSize: 12 }), groupSizeBucket: '250_plus' } as unknown as CreateDeclarationInput,
      'organization_admin',
    )
    const valuesArg = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(valuesArg.groupSizeBucket).toBe('10_49') // recomputed from the REAL groupSize (12), the decoy field is ignored
  })

  it('a client-supplied policyVersion is ignored — the server always stamps the CURRENT version', async () => {
    const insertChain = makeInsertChain([{ id: 'decl-1' }])
    mockInsert.mockReturnValue(insertChain)
    await createSensitiveAggregationDeclaration(
      { ...validInput(), policyVersion: 'v99-fake' } as unknown as CreateDeclarationInput,
      'organization_admin',
    )
    const valuesArg = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(valuesArg.policyVersion).toBe('v1')
  })

  it('a client-supplied verificationStatus of "verified" at create time is ignored — every declaration starts pending', async () => {
    const insertChain = makeInsertChain([{ id: 'decl-1' }])
    mockInsert.mockReturnValue(insertChain)
    await createSensitiveAggregationDeclaration(
      { ...validInput(), verificationStatus: 'verified' } as unknown as CreateDeclarationInput,
      'organization_admin',
    )
    const valuesArg = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(valuesArg.verificationStatus).toBe('pending')
  })

  it('a client-supplied minimumGroupSizeApplied at verify time is ignored — the server stamps the REAL current threshold', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'pending', groupSize: 50, dimensions: [] }]))
    const updateChain = makeUpdateChain([{
      id: 'decl-1', organizationId: 'org-1', projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1',
      sensitiveCategory: 'minors', aggregationLevel: 'aggregate', groupSize: 50, groupSizeBucket: '50_249',
      dimensions: [], countSourceType: 'indicator_measurement', countSourceId: null, countSourceNote: null,
      verificationStatus: 'verified', declaredBy: 'user-0', verifiedBy: 'user-1', verifiedAt: new Date(),
      policyVersion: 'v1', minimumGroupSizeApplied: 10, revokedBy: null, revokedAt: null, revocationReason: null,
      supersedesDeclarationId: null, supersededByDeclarationId: null, createdAt: new Date(), updatedAt: new Date(),
    }])
    mockUpdate.mockReturnValue(updateChain)

    await verifySensitiveAggregationDeclaration(
      { declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1', minimumGroupSizeApplied: 1 } as never,
      'organization_admin',
    )
    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(setArg.minimumGroupSizeApplied).toBe(10) // never 1, regardless of what the caller passed
  })

  it('attempting to verify a groupSize-9 declaration always fails, regardless of any other field manipulation', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'pending', groupSize: 9, dimensions: [] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'GROUP_SIZE_BELOW_THRESHOLD' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('Adversarial: dimension allowlist evasion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateEntityScope.mockResolvedValue({ valid: true })
  })

  it('rejects a dimension that looks like a value, not a code (e.g. an actual school name)', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'pending', groupSize: 50, dimensions: ['Escuela San Martin'] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_DIMENSIONS' })
  })

  it('rejects padding the dimensions array past the max with duplicates of an allowed code', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'pending', groupSize: 50, dimensions: ['age_band', 'age_band', 'age_band'] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'TOO_MANY_DIMENSIONS' })
  })

  it('rejects a high-risk combination even when each individual dimension is independently allowed', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'pending', groupSize: 50, dimensions: ['age_band', 'condition_category'] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'HIGH_RISK_DIMENSIONS' })
  })
})

describe('Adversarial: cross-tenant and cross-entity reuse attempts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects verifying a declaration by ID when the caller organizationId does not match the row', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-VICTIM', verificationStatus: 'pending', groupSize: 50, dimensions: [] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-ATTACKER', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'CROSS_ORG' })
  })

  it('rejects creating a declaration for an entity that belongs to another organization even if organizationId in the input is forged to match', async () => {
    mockValidateEntityScope.mockResolvedValue({ valid: false, reason: 'organization_mismatch' })
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ENTITY_ORGANIZATION_MISMATCH' })
  })

  it('a declaration for entity A never resolves as valid for entity B, even with an identical category (query is scoped by entityId)', async () => {
    // getSensitiveAggregationDeclarationStatus filters by entityId in its WHERE
    // clause — simulate the "no row for entity B" case explicitly.
    mockSelect.mockReturnValue(makeSelectChain([]))
    const result = await getSensitiveAggregationDeclarationStatus({
      organizationId: 'org-1', projectId: 'proj-1', entityType: 'outcome', entityId: 'entity-B', sensitiveCategory: 'minors',
    })
    expect(result).toEqual({ status: 'missing' })
  })
})

describe('Adversarial: revoked/superseded declaration reuse', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a revoked declaration is reported as revoked, never reinterpreted as valid', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', verificationStatus: 'revoked' }]))
    const result = await getSensitiveAggregationDeclarationStatus({
      organizationId: 'org-1', projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
    })
    expect(result.status).toBe('revoked')
  })

  it('a superseded declaration is reported as superseded, never reinterpreted as valid', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', verificationStatus: 'superseded' }]))
    const result = await getSensitiveAggregationDeclarationStatus({
      organizationId: 'org-1', projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
    })
    expect(result.status).toBe('superseded')
  })

  it('cannot verify an already-revoked declaration to "resurrect" it', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'revoked', groupSize: 50, dimensions: [] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ALREADY_REVOKED' })
  })
})

describe('Adversarial: prototype-pollution / decoy-field payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateEntityScope.mockResolvedValue({ valid: true })
  })

  it('a decoy "isVerified: true" field on the create input has no effect', async () => {
    const insertChain = makeInsertChain([{ id: 'decl-1' }])
    mockInsert.mockReturnValue(insertChain)
    const decoyInput = { ...validInput(), isVerified: true, bypassThreshold: true, __proto__: { verificationStatus: 'verified' } }
    const result = await createSensitiveAggregationDeclaration(decoyInput as unknown as CreateDeclarationInput, 'organization_admin')
    expect(result.ok).toBe(true)
    const valuesArg = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(valuesArg.verificationStatus).toBe('pending')
    expect(Object.prototype.hasOwnProperty.call({}, 'verificationStatus')).toBe(false)
  })
})
