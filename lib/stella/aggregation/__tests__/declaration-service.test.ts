// lib/stella/aggregation/__tests__/declaration-service.test.ts
// Etapa A2.3.1 (STL-A231-017) — no real DB, no real auth. Covers create/
// verify/revoke/supersede role checks, re-validation at verification time,
// and immutability (no function exists to edit group_size/category/
// dimensions/verifiedBy/verifiedAt once verified).

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
  chain.for = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

function makeUpdateChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  // .update().set().where() without .returning() also resolves (revoke doesn't call .returning())
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolvedValue).then(resolve)
  return chain
}

const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockUpdate = vi.fn()
// The real service wraps verify/revoke/supersede in db.transaction(async (tx) => ...)
// — the mock invokes the callback with a `tx` exposing the SAME mocked
// select/insert/update, so a test configuring mockSelect/mockInsert/mockUpdate
// works identically whether the real code calls them via `db.` or `tx.`.
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

import {
  createSensitiveAggregationDeclaration,
  verifySensitiveAggregationDeclaration,
  revokeSensitiveAggregationDeclaration,
  supersedeSensitiveAggregationDeclaration,
} from '../declaration-service'
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

describe('createSensitiveAggregationDeclaration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateEntityScope.mockResolvedValue({ valid: true })
  })

  it('rejects a viewer (not in CREATE_ROLES)', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput(), 'viewer')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('rejects a reviewer', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput(), 'reviewer')
    expect(result.ok).toBe(false)
  })

  it('allows an analyst to create (pending only)', async () => {
    mockInsert.mockReturnValue(makeInsertChain([{ id: 'decl-1' }]))
    const result = await createSensitiveAggregationDeclaration(validInput(), 'analyst')
    expect(result).toEqual({ ok: true, id: 'decl-1' })
  })

  it('allows an organization_admin to create', async () => {
    mockInsert.mockReturnValue(makeInsertChain([{ id: 'decl-1' }]))
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result.ok).toBe(true)
  })

  it('rejects a zero group size', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput({ groupSize: 0 }), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_GROUP_SIZE' })
  })

  it('rejects a negative group size', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput({ groupSize: -5 }), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_GROUP_SIZE' })
  })

  it('rejects a decimal group size', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput({ groupSize: 9.5 }), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_GROUP_SIZE' })
  })

  it('rejects a group size below 10 at CREATE time is still allowed structurally (verification is what enforces the threshold) — but a non-integer/non-positive value is always rejected', async () => {
    mockInsert.mockReturnValue(makeInsertChain([{ id: 'decl-1' }]))
    const result = await createSensitiveAggregationDeclaration(validInput({ groupSize: 5 }), 'organization_admin')
    expect(result.ok).toBe(true) // create allows a candidate below threshold; verify() is the enforcement point
  })

  it('rejects an invalid entity type', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput({ entityType: 'user' as never }), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_ENTITY_TYPE' })
  })

  it('rejects an invalid sensitive category', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput({ sensitiveCategory: 'other' as never }), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_CATEGORY' })
  })

  it('rejects an invalid count source type', async () => {
    const result = await createSensitiveAggregationDeclaration(validInput({ countSourceType: 'model_said_so' as never }), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_COUNT_SOURCE' })
  })

  it('rejects when the entity does not exist', async () => {
    mockValidateEntityScope.mockResolvedValue({ valid: false, reason: 'not_found' })
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ENTITY_NOT_FOUND' })
  })

  it('rejects when the entity belongs to a different organization', async () => {
    mockValidateEntityScope.mockResolvedValue({ valid: false, reason: 'organization_mismatch' })
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ENTITY_ORGANIZATION_MISMATCH' })
  })

  it('rejects when the entity belongs to a different project', async () => {
    mockValidateEntityScope.mockResolvedValue({ valid: false, reason: 'project_mismatch' })
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ENTITY_PROJECT_MISMATCH' })
  })

  it('maps a unique-constraint violation (23505) to ACTIVE_DECLARATION_EXISTS', async () => {
    const insertChain: Record<string, unknown> = {}
    insertChain.values = vi.fn().mockReturnValue(insertChain)
    insertChain.returning = vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }))
    mockInsert.mockReturnValue(insertChain)
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ACTIVE_DECLARATION_EXISTS' })
  })

  it('maps a unique-constraint violation wrapped in a DrizzleQueryError (real shape — code lives on .cause, not the top-level error) to ACTIVE_DECLARATION_EXISTS', async () => {
    // Regression test (Etapa A2.3.2): a real-database integration run
    // discovered that this Drizzle version wraps the driver's PostgresError
    // in its own error class, which does not forward `.code` — only
    // `.cause.code` carries it. A naive `Object.assign(new Error(), {code})`
    // mock (the test above) never reproduces this and would have hidden the
    // bug forever.
    const insertChain: Record<string, unknown> = {}
    insertChain.values = vi.fn().mockReturnValue(insertChain)
    const wrapped = new Error('Failed query: insert into ...')
    Object.assign(wrapped, { cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }) })
    insertChain.returning = vi.fn().mockRejectedValue(wrapped)
    mockInsert.mockReturnValue(insertChain)
    const result = await createSensitiveAggregationDeclaration(validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ACTIVE_DECLARATION_EXISTS' })
  })

  it('never persists a client-supplied policyVersion or groupSizeBucket (both are resolved server-side)', async () => {
    const insertChain = makeInsertChain([{ id: 'decl-1' }])
    mockInsert.mockReturnValue(insertChain)
    await createSensitiveAggregationDeclaration(validInput({ groupSize: 42 }), 'organization_admin')
    const valuesArg = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(valuesArg.groupSizeBucket).toBe('10_49')
    expect(valuesArg.policyVersion).toBe('v1')
    expect(valuesArg.verificationStatus).toBe('pending')
  })
})

describe('verifySensitiveAggregationDeclaration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseRow = {
    id: 'decl-1',
    organizationId: 'org-1',
    verificationStatus: 'pending',
    groupSize: 50,
    dimensions: [] as string[],
  }

  it('rejects a non-organization_admin (exact-match role check, no hierarchy)', async () => {
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'analyst')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
  })

  it('rejects super_admin without an explicit organization_admin membership row (caller must pass the ACTUAL membership role, not a hierarchy bypass)', async () => {
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'super_admin')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
  })

  it('returns NOT_FOUND for a missing declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('returns CROSS_ORG when the declaration belongs to a different organization', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, organizationId: 'org-OTHER' }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'CROSS_ORG' })
  })

  it('returns ALREADY_VERIFIED for a verified declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, verificationStatus: 'verified' }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ALREADY_VERIFIED' })
  })

  it('returns ALREADY_REVOKED for a revoked declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, verificationStatus: 'revoked' }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ALREADY_REVOKED' })
  })

  it('returns ALREADY_SUPERSEDED for a superseded declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, verificationStatus: 'superseded' }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ALREADY_SUPERSEDED' })
  })

  it('rejects a group size of 9 (below the minimum) even though it passed structural validation at create time', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, groupSize: 9 }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'GROUP_SIZE_BELOW_THRESHOLD' })
  })

  it('allows a group size of exactly 10', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, groupSize: 10 }]))
    mockUpdate.mockReturnValue(makeUpdateChain([{ ...baseRow, groupSize: 10, verificationStatus: 'verified', verifiedBy: 'user-1', verifiedAt: new Date(), minimumGroupSizeApplied: 10, policyVersion: 'v1', sensitiveCategory: 'minors', aggregationLevel: 'aggregate', groupSizeBucket: '10_49', countSourceType: 'indicator_measurement', countSourceId: null, countSourceNote: null, declaredBy: 'user-0', revokedBy: null, revokedAt: null, revocationReason: null, supersedesDeclarationId: null, supersededByDeclarationId: null, createdAt: new Date(), updatedAt: new Date(), entityType: 'outcome', entityId: 'o-1', projectId: 'proj-1' }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result.ok).toBe(true)
  })

  it('rejects more dimensions than MAX_AGGREGATION_DIMENSIONS', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, dimensions: ['age_band', 'gender', 'program_period'] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'TOO_MANY_DIMENSIONS' })
  })

  it('rejects a dimension outside the allowlist', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, dimensions: ['exact_school_name'] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_DIMENSIONS' })
  })

  it('rejects a high-risk dimension combination', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ ...baseRow, dimensions: ['gender', 'territory_level'] }]))
    const result = await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'HIGH_RISK_DIMENSIONS' })
  })

  it('sets minimumGroupSizeApplied and policyVersion from the SERVER constants, never from the row', async () => {
    mockSelect.mockReturnValue(makeSelectChain([baseRow]))
    const updateChain = makeUpdateChain([{ ...baseRow, verificationStatus: 'verified', verifiedBy: 'user-1', verifiedAt: new Date(), minimumGroupSizeApplied: 10, policyVersion: 'v1', sensitiveCategory: 'minors', aggregationLevel: 'aggregate', groupSizeBucket: '10_49', countSourceType: 'indicator_measurement', countSourceId: null, countSourceNote: null, declaredBy: 'user-0', revokedBy: null, revokedAt: null, revocationReason: null, supersedesDeclarationId: null, supersededByDeclarationId: null, createdAt: new Date(), updatedAt: new Date(), entityType: 'outcome', entityId: 'o-1', projectId: 'proj-1' }])
    mockUpdate.mockReturnValue(updateChain)
    await verifySensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', verifiedByUserId: 'user-1' }, 'organization_admin')
    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(setArg.minimumGroupSizeApplied).toBe(10)
    expect(setArg.verifiedBy).toBe('user-1')
  })
})

describe('revokeSensitiveAggregationDeclaration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a non-organization_admin', async () => {
    const result = await revokeSensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', revokedByUserId: 'user-1' }, 'analyst')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
  })

  it('returns NOT_FOUND for a missing declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const result = await revokeSensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', revokedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('returns CROSS_ORG for a different organization', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-OTHER', verificationStatus: 'verified' }]))
    const result = await revokeSensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', revokedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'CROSS_ORG' })
  })

  it('returns ALREADY_REVOKED for an already-revoked declaration', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'revoked' }]))
    const result = await revokeSensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', revokedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ALREADY_REVOKED' })
  })

  it('revokes a verified declaration and preserves the row (update, never delete)', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-1', organizationId: 'org-1', verificationStatus: 'verified' }]))
    mockUpdate.mockReturnValue(makeUpdateChain(undefined))
    const result = await revokeSensitiveAggregationDeclaration({ declarationId: 'decl-1', organizationId: 'org-1', revokedByUserId: 'user-1', reason: 'no longer applicable' }, 'organization_admin')
    expect(result).toEqual({ ok: true })
    expect(mockUpdate).toHaveBeenCalled()
  })
})

describe('supersedeSensitiveAggregationDeclaration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateEntityScope.mockResolvedValue({ valid: true })
  })

  it('rejects a viewer/analyst-forbidden role before touching the DB', async () => {
    const result = await supersedeSensitiveAggregationDeclaration('decl-old', validInput(), 'viewer')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('rejects when the previous declaration does not exist', async () => {
    mockSelect.mockReturnValue(makeSelectChain([]))
    const result = await supersedeSensitiveAggregationDeclaration('decl-old', validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'PREVIOUS_NOT_FOUND' })
  })

  it('rejects when the previous declaration is cross-org', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-old', organizationId: 'org-OTHER', verificationStatus: 'verified' }]))
    const result = await supersedeSensitiveAggregationDeclaration('decl-old', validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'PREVIOUS_CROSS_ORG' })
  })

  it('rejects when the previous declaration was already revoked', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-old', organizationId: 'org-1', verificationStatus: 'revoked' }]))
    const result = await supersedeSensitiveAggregationDeclaration('decl-old', validInput(), 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'PREVIOUS_ALREADY_REVOKED' })
  })

  it('creates the new declaration with supersedesDeclarationId set, and marks the previous one superseded (two UPDATEs: status first, then the link once the new id is known)', async () => {
    mockSelect.mockReturnValue(makeSelectChain([{ id: 'decl-old', organizationId: 'org-1', verificationStatus: 'verified' }]))
    const insertChain = makeInsertChain([{ id: 'decl-new' }])
    mockInsert.mockReturnValue(insertChain)
    const updateChain = makeUpdateChain(undefined)
    mockUpdate.mockReturnValue(updateChain)

    const result = await supersedeSensitiveAggregationDeclaration('decl-old', validInput(), 'organization_admin')

    expect(result).toEqual({ ok: true, id: 'decl-new' })
    const valuesArg = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(valuesArg.supersedesDeclarationId).toBe('decl-old')

    // The same mocked `.set` fires twice (both db.update() calls return the
    // same chain here): first marks 'superseded' BEFORE the insert (see
    // declaration-service.ts for why this order matters — it prevents the
    // new row's INSERT from colliding with the previous row's own
    // still-active unique-index entry when both target the same
    // entity+category), then links supersededByDeclarationId once the new
    // row's id is known.
    const setMock = updateChain.set as ReturnType<typeof vi.fn>
    expect(setMock).toHaveBeenCalledTimes(2)
    expect(setMock.mock.calls[0][0].verificationStatus).toBe('superseded')
    expect(setMock.mock.calls[1][0].supersededByDeclarationId).toBe('decl-new')
  })
})
