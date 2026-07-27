// app/actions/stella/__tests__/consent.test.ts
// Etapa A2.1 (STL-A21-006/007) — no real DB, no real auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockGetStellaConsentStatus = vi.fn()
vi.mock('@/lib/stella/consent/consent-status', () => ({
  getStellaConsentStatus: (...args: unknown[]) => mockGetStellaConsentStatus(...args),
}))

const mockRecordConsentEvent = vi.fn()
vi.mock('@/lib/stella/consent/consent-log', () => ({
  recordConsentEvent: (...args: unknown[]) => mockRecordConsentEvent(...args),
}))

const mockLogAuditAction = vi.fn()
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return {
    ...original,
    logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args),
  }
})

import { acceptStellaConsent, revokeStellaConsent } from '../consent'
import { STELLA_AI_TERMS_VERSION, STELLA_DATA_POLICY_VERSION } from '@/lib/stella/consent/versions'

function makeCtx(role: string, orgId = 'org-1', userId = 'user-1'): OrganizationContext {
  return {
    user: { id: userId, email: 'test@example.com', fullName: 'Test User', avatarUrl: null, isSuperAdmin: role === 'super_admin' },
    membership: { id: 'mem-1', organizationId: orgId, userId, role: role as never, status: 'active' },
    organization: { id: orgId, name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' } as never,
  }
}

describe('acceptStellaConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStellaConsentStatus.mockResolvedValue({
      status: 'valid',
      currentAiTermsVersion: STELLA_AI_TERMS_VERSION,
      currentDataPolicyVersion: STELLA_DATA_POLICY_VERSION,
    })
    mockRecordConsentEvent.mockResolvedValue({ id: 'event-1' })
  })

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await acceptStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
  })

  it('rejects a viewer', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    const result = await acceptStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('FORBIDDEN_NOT_ORG_ADMIN')
    expect(mockRecordConsentEvent).not.toHaveBeenCalled()
  })

  it('rejects an analyst', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('analyst'))
    const result = await acceptStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('FORBIDDEN_NOT_ORG_ADMIN')
  })

  it('rejects a global super_admin whose membership role for this org is not organization_admin', async () => {
    // A super_admin whose per-org membership role is e.g. "viewer" (or none)
    // must NOT be able to accept on behalf of this organization — only an
    // explicit organization_admin membership row qualifies.
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    const result = await acceptStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('FORBIDDEN_NOT_ORG_ADMIN')
  })

  it('allows an organization_admin to accept', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    const result = await acceptStellaConsent()
    expect(result.ok).toBe(true)
    expect(mockRecordConsentEvent).toHaveBeenCalledTimes(1)
    const input = mockRecordConsentEvent.mock.calls[0][0] as Record<string, unknown>
    expect(input.eventType).toBe('accepted')
    expect(input.aiTermsVersion).toBe(STELLA_AI_TERMS_VERSION)
    expect(input.dataPolicyVersion).toBe(STELLA_DATA_POLICY_VERSION)
  })

  it('resolves versions from the server registry, never from client input (the function takes no version args)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    // acceptStellaConsent() takes no arguments at all — there is no
    // parameter through which a caller could supply an arbitrary version.
    expect(acceptStellaConsent.length).toBe(0)
    await acceptStellaConsent()
    const input = mockRecordConsentEvent.mock.calls[0][0] as Record<string, unknown>
    expect(input.aiTermsVersion).toBe(STELLA_AI_TERMS_VERSION)
  })

  it('creates an audit log entry on successful acceptance', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    await acceptStellaConsent()
    expect(mockLogAuditAction).toHaveBeenCalledTimes(1)
    const entry = mockLogAuditAction.mock.calls[0][0] as Record<string, unknown>
    expect(entry.action).toBe('stella_ai_consent.accepted')
  })
})

describe('revokeStellaConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStellaConsentStatus.mockResolvedValue({
      status: 'valid',
      consentEventId: 'event-1',
      currentAiTermsVersion: STELLA_AI_TERMS_VERSION,
      currentDataPolicyVersion: STELLA_DATA_POLICY_VERSION,
    })
    mockRecordConsentEvent.mockResolvedValue({ id: 'event-2' })
  })

  it('rejects a viewer', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    const result = await revokeStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('FORBIDDEN_NOT_ORG_ADMIN')
  })

  it('rejects an analyst', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('analyst'))
    const result = await revokeStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('FORBIDDEN_NOT_ORG_ADMIN')
  })

  it('allows an organization_admin to revoke an active consent', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    const result = await revokeStellaConsent('No longer needed')
    expect(result.ok).toBe(true)
    const input = mockRecordConsentEvent.mock.calls[0][0] as Record<string, unknown>
    expect(input.eventType).toBe('revoked')
    expect(input.reason).toBe('No longer needed')
    expect(input.supersedesEventId).toBe('event-1')
  })

  it('does not touch quota, plan, or flags (recordConsentEvent input has no such fields)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    await revokeStellaConsent()
    const input = mockRecordConsentEvent.mock.calls[0][0] as Record<string, unknown>
    expect(input).not.toHaveProperty('quota')
    expect(input).not.toHaveProperty('plan')
    expect(input).not.toHaveProperty('flags')
  })

  it('rejects revocation when there is no active consent', async () => {
    mockGetStellaConsentStatus.mockResolvedValue({
      status: 'missing',
      currentAiTermsVersion: STELLA_AI_TERMS_VERSION,
      currentDataPolicyVersion: STELLA_DATA_POLICY_VERSION,
    })
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    const result = await revokeStellaConsent()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('NO_ACTIVE_CONSENT_TO_REVOKE')
    expect(mockRecordConsentEvent).not.toHaveBeenCalled()
  })

  it('creates an audit log entry on successful revocation', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('organization_admin'))
    await revokeStellaConsent('reason text')
    expect(mockLogAuditAction).toHaveBeenCalledTimes(1)
    const entry = mockLogAuditAction.mock.calls[0][0] as Record<string, unknown>
    expect(entry.action).toBe('stella_ai_consent.revoked')
  })
})
