// app/actions/stella/__tests__/retention.test.ts
// Etapa A2.4 (DR-004 aprobado) — no real DB, no real auth. Confirms
// organization/actor are always resolved from the session (never from a
// client-supplied parameter) and that role/error mapping matches the
// service layer's contract.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockGetEffectiveRetentionSettings = vi.fn()
const mockUpdateSettings = vi.fn()
const mockPreviewImpact = vi.fn()
vi.mock('@/lib/stella/retention/settings-service', () => ({
  getEffectiveRetentionSettings: (...args: unknown[]) => mockGetEffectiveRetentionSettings(...args),
  updateOrganizationRetentionSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  previewRetentionSettingsImpact: (...args: unknown[]) => mockPreviewImpact(...args),
}))

const mockCreateHold = vi.fn()
const mockReleaseHold = vi.fn()
vi.mock('@/lib/stella/retention/hold-service', () => ({
  createRetentionHold: (...args: unknown[]) => mockCreateHold(...args),
  releaseRetentionHold: (...args: unknown[]) => mockReleaseHold(...args),
}))

const mockPreviewPurge = vi.fn()
const mockExecutePurge = vi.fn()
const mockResumePurge = vi.fn()
const mockGetRunStatus = vi.fn()
vi.mock('@/lib/stella/retention/purge-service', () => ({
  previewStellaRetentionPurge: (...args: unknown[]) => mockPreviewPurge(...args),
  executeStellaRetentionPurge: (...args: unknown[]) => mockExecutePurge(...args),
  resumeStellaRetentionPurge: (...args: unknown[]) => mockResumePurge(...args),
  getPurgeRunStatus: (...args: unknown[]) => mockGetRunStatus(...args),
}))

const mockDbSelect = vi.fn()
vi.mock('@/db/client', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}))

import {
  getStellaRetentionOverview,
  previewRetentionSettingsImpactAction,
  updateRetentionSettingsAction,
  createRetentionHoldAction,
  releaseRetentionHoldAction,
  previewStellaRetentionPurgeAction,
  executeStellaRetentionPurgeAction,
  resumeStellaRetentionPurgeAction,
  canManageStellaRetention,
} from '../retention'

function makeCtx(role: string): OrganizationContext {
  return {
    user: { id: 'user-1', email: 't@example.com', fullName: 'T', avatarUrl: null, isSuperAdmin: role === 'super_admin' },
    membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: role as never, status: 'active' },
    organization: { id: 'org-1', name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' } as never,
  }
}

describe('getStellaRetentionOverview', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await getStellaRetentionOverview()
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED' })
  })

  it('resolves organizationId from the session, never from client input', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    mockGetEffectiveRetentionSettings.mockResolvedValue({ organizationId: 'org-1', responseRetentionMonths: 24, policyVersion: 'v1', configuredBy: null, configuredAt: null, isDefault: true })
    await getStellaRetentionOverview()
    expect(mockGetEffectiveRetentionSettings).toHaveBeenCalledWith('org-1')
  })

  it('canManage is true only for organization_admin (exact match, not hierarchy)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('super_admin'))
    mockGetEffectiveRetentionSettings.mockResolvedValue({ organizationId: 'org-1', responseRetentionMonths: 24, policyVersion: 'v1', configuredBy: null, configuredAt: null, isDefault: true })
    const result = await getStellaRetentionOverview()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.canManage).toBe(false) // super_admin without exact organization_admin membership does not manage
  })
})

describe('previewRetentionSettingsImpactAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a non-organization_admin actor before calling the service', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('analyst'))
    const result = await previewRetentionSettingsImpactAction(12)
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    expect(mockPreviewImpact).not.toHaveBeenCalled()
  })

  it('passes organizationId from the session and the proposed value through', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockPreviewImpact.mockResolvedValue({ newlyEligibleCount: 4 })
    const result = await previewRetentionSettingsImpactAction(12)
    expect(result).toEqual({ ok: true, newlyEligibleCount: 4 })
    expect(mockPreviewImpact).toHaveBeenCalledWith('org-1', 12)
  })
})

describe('updateRetentionSettingsAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves organizationId/configuredByUserId from the session', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockUpdateSettings.mockResolvedValue({ ok: true })
    await updateRetentionSettingsAction(18)
    const [input, actorRole] = mockUpdateSettings.mock.calls[0]
    expect(input.organizationId).toBe('org-1')
    expect(input.configuredByUserId).toBe('user-1')
    expect(actorRole).toBe('organization_admin')
  })

  it('surfaces a non-leaky message for INVALID_MONTHS', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockUpdateSettings.mockResolvedValue({ ok: false, error: 'INVALID_MONTHS' })
    const result = await updateRetentionSettingsAction(0)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/entre/i)
  })
})

describe('createRetentionHoldAction / releaseRetentionHoldAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createRetentionHoldAction resolves organizationId/createdByUserId from the session', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockCreateHold.mockResolvedValue({ ok: true, id: 'hold-1' })
    await createRetentionHoldAction({ holdType: 'legal_hold', reasonCode: 'pending_legal_review' })
    const [input] = mockCreateHold.mock.calls[0]
    expect(input.organizationId).toBe('org-1')
    expect(input.createdByUserId).toBe('user-1')
  })

  it('releaseRetentionHoldAction resolves organizationId/releasedByUserId from the session', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockReleaseHold.mockResolvedValue({ ok: true })
    await releaseRetentionHoldAction('hold-1')
    const [input] = mockReleaseHold.mock.calls[0]
    expect(input.organizationId).toBe('org-1')
    expect(input.releasedByUserId).toBe('user-1')
  })
})

describe('purge actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('previewStellaRetentionPurgeAction resolves organization/actor from the session', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockPreviewPurge.mockResolvedValue({ ok: true, run: { id: 'run-1' } })
    await previewStellaRetentionPurgeAction()
    expect(mockPreviewPurge).toHaveBeenCalledWith('org-1', 'user-1', 'organization_admin')
  })

  it('executeStellaRetentionPurgeAction passes previewRunId through and generates an idempotencyKey when none is supplied', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockExecutePurge.mockResolvedValue({ ok: true, run: { id: 'run-2' }, alreadyExisted: false })
    await executeStellaRetentionPurgeAction('run-1')
    const [, , , options] = mockExecutePurge.mock.calls[0]
    expect(options.previewRunId).toBe('run-1')
    expect(typeof options.idempotencyKey).toBe('string')
    expect(options.idempotencyKey.length).toBeGreaterThan(0)
  })

  it('executeStellaRetentionPurgeAction surfaces POLICY_CHANGED_SINCE_PREVIEW with its non-leaky message', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockExecutePurge.mockResolvedValue({ ok: false, error: 'POLICY_CHANGED_SINCE_PREVIEW' })
    const result = await executeStellaRetentionPurgeAction('run-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/nuevo dry-run/i)
  })

  it('resumeStellaRetentionPurgeAction resolves organization/actor from the session', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    mockResumePurge.mockResolvedValue({ ok: true, run: { id: 'run-1' } })
    await resumeStellaRetentionPurgeAction('run-1')
    expect(mockResumePurge).toHaveBeenCalledWith('run-1', 'org-1', 'organization_admin')
  })
})

describe('canManageStellaRetention', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns false when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    expect(await canManageStellaRetention()).toBe(false)
  })

  it('returns true only for an EXACT organization_admin role, not super_admin', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('super_admin'))
    expect(await canManageStellaRetention()).toBe(false)
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    expect(await canManageStellaRetention()).toBe(true)
  })
})
