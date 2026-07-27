// app/actions/stella/__tests__/aggregation-declarations.test.ts
// Etapa A2.3.1 (STL-A231-018) — no real DB, no real auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockCreate = vi.fn()
const mockVerify = vi.fn()
const mockRevoke = vi.fn()
const mockSupersede = vi.fn()
vi.mock('@/lib/stella/aggregation/declaration-service', () => ({
  createSensitiveAggregationDeclaration: (...args: unknown[]) => mockCreate(...args),
  verifySensitiveAggregationDeclaration: (...args: unknown[]) => mockVerify(...args),
  revokeSensitiveAggregationDeclaration: (...args: unknown[]) => mockRevoke(...args),
  supersedeSensitiveAggregationDeclaration: (...args: unknown[]) => mockSupersede(...args),
}))

const mockListForEntity = vi.fn()
vi.mock('@/lib/stella/aggregation/declaration-query', () => ({
  listSensitiveAggregationDeclarationsForEntity: (...args: unknown[]) => mockListForEntity(...args),
}))

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...original, logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args) }
})

import {
  createAggregationDeclaration,
  verifyAggregationDeclaration,
  revokeAggregationDeclaration,
  supersedeAggregationDeclaration,
  listEntityAggregationDeclarations,
} from '../aggregation-declarations'

function makeCtx(role: string): OrganizationContext {
  return {
    user: { id: 'user-1', email: 't@example.com', fullName: 'T', avatarUrl: null, isSuperAdmin: role === 'super_admin' },
    membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: role as never, status: 'active' },
    organization: { id: 'org-1', name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' } as never,
  }
}

describe('createAggregationDeclaration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await createAggregationDeclaration({
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 50, dimensions: [], countSourceType: 'indicator_measurement',
    })
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('resolves organizationId/declaredByUserId from the session, never from client input', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockCreate.mockResolvedValue({ ok: true, id: 'decl-1' })
    await createAggregationDeclaration({
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 50, dimensions: [], countSourceType: 'indicator_measurement',
    })
    const [serviceInput, actorRole] = mockCreate.mock.calls[0]
    expect(serviceInput.organizationId).toBe('org-1')
    expect(serviceInput.declaredByUserId).toBe('user-1')
    expect(actorRole).toBe('organization_admin')
  })

  it('returns the service error and message on failure, without calling the audit log', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    mockCreate.mockResolvedValue({ ok: false, error: 'FORBIDDEN_ROLE' })
    const result = await createAggregationDeclaration({
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 50, dimensions: [], countSourceType: 'indicator_measurement',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('FORBIDDEN_ROLE')
    expect(mockLogAuditAction).not.toHaveBeenCalled()
  })

  it('logs a content-free audit entry on success (never the group size or dimensions values)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockCreate.mockResolvedValue({ ok: true, id: 'decl-1' })
    await createAggregationDeclaration({
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 50, dimensions: ['age_band'], countSourceType: 'indicator_measurement',
    })
    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stella_sensitive_aggregation.declared', entityId: 'decl-1' }),
    )
    const auditArg = mockLogAuditAction.mock.calls[0][0]
    expect(JSON.stringify(auditArg)).not.toContain('50')
  })
})

describe('verifyAggregationDeclaration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await verifyAggregationDeclaration('decl-1')
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' })
  })

  it('passes the actual membership role through, never assumes organization_admin', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('analyst'))
    mockVerify.mockResolvedValue({ ok: false, error: 'FORBIDDEN_ROLE' })
    await verifyAggregationDeclaration('decl-1')
    const [, actorRole] = mockVerify.mock.calls[0]
    expect(actorRole).toBe('analyst')
  })

  it('logs a content-free audit entry on success', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockVerify.mockResolvedValue({ ok: true, declaration: {} })
    const result = await verifyAggregationDeclaration('decl-1')
    expect(result).toEqual({ ok: true, id: 'decl-1' })
    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stella_sensitive_aggregation.verified', entityId: 'decl-1' }),
    )
  })
})

describe('revokeAggregationDeclaration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await revokeAggregationDeclaration('decl-1', 'no longer needed')
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' })
  })

  it('logs a content-free audit entry on success, including the reason (structural, never sensitive content by contract)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockRevoke.mockResolvedValue({ ok: true })
    const result = await revokeAggregationDeclaration('decl-1', 'data no longer applicable')
    expect(result).toEqual({ ok: true, id: 'decl-1' })
    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stella_sensitive_aggregation.revoked', reason: 'data no longer applicable' }),
    )
  })

  it('a broken audit log never masks an already-successful revoke (fail-safe)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockRevoke.mockResolvedValue({ ok: true })
    mockLogAuditAction.mockRejectedValue(new Error('audit_logs insert failed'))
    const result = await revokeAggregationDeclaration('decl-1', 'test')
    expect(result).toEqual({ ok: true, id: 'decl-1' })
  })
})

describe('supersedeAggregationDeclaration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await supersedeAggregationDeclaration('decl-old', {
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 50, dimensions: [], countSourceType: 'indicator_measurement',
    })
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' })
    expect(mockSupersede).not.toHaveBeenCalled()
  })

  it('resolves organizationId/declaredByUserId from the session and passes the previous declaration id through', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockSupersede.mockResolvedValue({ ok: true, id: 'decl-new' })
    await supersedeAggregationDeclaration('decl-old', {
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 80, dimensions: [], countSourceType: 'indicator_measurement',
    })
    const [previousId, serviceInput, actorRole] = mockSupersede.mock.calls[0]
    expect(previousId).toBe('decl-old')
    expect(serviceInput.organizationId).toBe('org-1')
    expect(serviceInput.declaredByUserId).toBe('user-1')
    expect(actorRole).toBe('organization_admin')
  })

  it('returns the service error and message on failure (e.g. previous already revoked)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockSupersede.mockResolvedValue({ ok: false, error: 'PREVIOUS_ALREADY_REVOKED' })
    const result = await supersedeAggregationDeclaration('decl-old', {
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 80, dimensions: [], countSourceType: 'indicator_measurement',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('PREVIOUS_ALREADY_REVOKED')
  })

  it('logs a content-free audit entry referencing the superseded declaration on success', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockSupersede.mockResolvedValue({ ok: true, id: 'decl-new' })
    await supersedeAggregationDeclaration('decl-old', {
      projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1', sensitiveCategory: 'minors',
      groupSize: 80, dimensions: [], countSourceType: 'indicator_measurement',
    })
    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'decl-new', reason: 'supersedes:decl-old' }),
    )
  })
})

describe('listEntityAggregationDeclarations', () => {
  beforeEach(() => vi.clearAllMocks())

  const FULL_RECORD = {
    id: 'decl-1', organizationId: 'org-1', projectId: 'proj-1', entityType: 'outcome', entityId: 'o-1',
    sensitiveCategory: 'minors', aggregationLevel: 'aggregate', groupSize: 50, groupSizeBucket: '10_49',
    dimensions: [], countSourceType: 'indicator_measurement', countSourceId: null, countSourceNote: null,
    verificationStatus: 'verified', declaredBy: 'user-declarer', verifiedBy: 'user-verifier', verifiedAt: new Date(),
    policyVersion: 'v1', minimumGroupSizeApplied: 10, revokedBy: null, revokedAt: null, revocationReason: null,
    supersedesDeclarationId: null, supersededByDeclarationId: null, createdAt: new Date(), updatedAt: new Date(),
  }

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await listEntityAggregationDeclarations('proj-1', 'outcome', 'o-1')
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' })
  })

  it('returns the full record (including actor fields) for organization_admin', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockListForEntity.mockResolvedValue([FULL_RECORD])
    const result = await listEntityAggregationDeclarations('proj-1', 'outcome', 'o-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.items[0]).toHaveProperty('declaredBy', 'user-declarer')
      expect(result.items[0]).toHaveProperty('verifiedBy', 'user-verifier')
    }
  })

  it('returns the full record for analyst too', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('analyst'))
    mockListForEntity.mockResolvedValue([FULL_RECORD])
    const result = await listEntityAggregationDeclarations('proj-1', 'outcome', 'o-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.items[0]).toHaveProperty('declaredBy')
  })

  it('strips actor/reason fields for viewer', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    mockListForEntity.mockResolvedValue([FULL_RECORD])
    const result = await listEntityAggregationDeclarations('proj-1', 'outcome', 'o-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.items[0]).not.toHaveProperty('declaredBy')
      expect(result.items[0]).not.toHaveProperty('verifiedBy')
      expect(result.items[0]).not.toHaveProperty('revokedBy')
      expect(result.items[0]).not.toHaveProperty('revocationReason')
      // Status/category/bucket remain visible — only actor/reason fields are stripped.
      expect(result.items[0]).toHaveProperty('verificationStatus', 'verified')
      expect(result.items[0]).toHaveProperty('groupSizeBucket', '10_49')
    }
  })

  it('strips actor/reason fields for reviewer (below analyst in the hierarchy)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('reviewer'))
    mockListForEntity.mockResolvedValue([FULL_RECORD])
    const result = await listEntityAggregationDeclarations('proj-1', 'outcome', 'o-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.items[0]).not.toHaveProperty('declaredBy')
  })

  it('resolves organizationId from the session, never from client input', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockListForEntity.mockResolvedValue([])
    await listEntityAggregationDeclarations('proj-1', 'outcome', 'o-1')
    const [queryArgs] = mockListForEntity.mock.calls[0]
    expect(queryArgs.organizationId).toBe('org-1')
  })
})
