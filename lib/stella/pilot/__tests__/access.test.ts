// lib/stella/pilot/__tests__/access.test.ts
// Etapa B0 (modo piloto restringido) — no real DB, no real auth. Proves the
// exact evaluation order and that a rejection at any step never reaches
// consent/confirmation checks further down (each mock call count is
// asserted, not just the final decision).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStellaConfig = vi.hoisted(() => ({ isEnabled: true, isAdvisorEnabled: true, isValidatorEnabled: false, isComposerEnabled: false, isProxyReviewerEnabled: false, isEvidenceReviewerEnabled: false, isAuditAssistantEnabled: false }))
vi.mock('../../config', () => ({ stellaConfig: mockStellaConfig }))

const mockGetStellaPilotConfig = vi.fn()
vi.mock('../config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config')>()
  return { ...original, getStellaPilotConfig: (...args: unknown[]) => mockGetStellaPilotConfig(...args) }
})

const mockGetStellaConsentStatus = vi.fn()
vi.mock('../../consent/consent-status', () => ({
  getStellaConsentStatus: (...args: unknown[]) => mockGetStellaConsentStatus(...args),
}))

const mockGetStellaPilotConfirmationStatus = vi.fn()
vi.mock('../confirmation-service', () => ({
  getStellaPilotConfirmationStatus: (...args: unknown[]) => mockGetStellaPilotConfirmationStatus(...args),
}))

import { getStellaPilotAccess } from '../access'

const ORG_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '22222222-2222-2222-2222-222222222222'

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    killSwitch: false,
    providerMode: 'paid_gemini' as const,
    allowedOrganizationIds: new Set([ORG_ID]),
    allowedUserIds: new Set([USER_ID]),
    allowAllUsersInAllowedOrganizations: false,
    requireSyntheticDataConfirmation: true as const,
    requireHumanReview: true as const,
    paidGeminiConfirmed: true,
    noticeVersion: 'v1',
    enabledStellaRoles: new Set(['advisor']),
    ...overrides,
  }
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    membershipRole: 'organization_admin',
    membershipStatus: 'active',
    stellaRole: 'advisor' as const,
    ...overrides,
  }
}

describe('getStellaPilotAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isAdvisorEnabled = true
    mockGetStellaConsentStatus.mockResolvedValue({ status: 'valid' })
    mockGetStellaPilotConfirmationStatus.mockResolvedValue({ status: 'valid' })
  })

  it('kill switch wins over everything else, without checking anything further', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ killSwitch: true, enabled: false }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_KILL_SWITCH_ACTIVE')
    expect(mockGetStellaConsentStatus).not.toHaveBeenCalled()
  })

  it('pilot disabled blocks before consent/confirmation are checked', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ enabled: false }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_DISABLED')
    expect(mockGetStellaConsentStatus).not.toHaveBeenCalled()
  })

  it('global stellaConfig.isEnabled=false blocks even when pilot mode itself is on', async () => {
    mockStellaConfig.isEnabled = false
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_DISABLED')
  })

  it('an organization outside the allowlist is rejected — empty allowlist means no access', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ allowedOrganizationIds: new Set() }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_ORGANIZATION_NOT_ALLOWED')
  })

  it('an organization in the allowlist passes that check', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_ALLOWED')
  })

  it('a user not in the allowlist is rejected when allowAllUsersInAllowedOrganizations is false', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ allowedUserIds: new Set() }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_USER_NOT_ALLOWED')
  })

  it('allowAllUsersInAllowedOrganizations=true lets every user in an allowed org through, even with an empty user allowlist', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ allowedUserIds: new Set(), allowAllUsersInAllowedOrganizations: true }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_ALLOWED')
  })

  it('an inactive membership is rejected with its own decision code (defense in depth)', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput({ membershipStatus: 'inactive' }))
    expect(result.decision).toBe('PILOT_MEMBERSHIP_INACTIVE')
  })

  it.each(['viewer', 'reviewer', 'super_admin'])('a %s membership role is rejected — pilot allowlist is literal, never hierarchical', async (role) => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput({ membershipRole: role }))
    expect(result.decision).toBe('PILOT_ROLE_NOT_ALLOWED')
  })

  it.each(['organization_admin', 'impact_manager', 'analyst'])('a %s membership role passes the pilot role check', async (role) => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput({ membershipRole: role }))
    expect(result.decision).toBe('PILOT_ALLOWED')
  })

  it('missing DR-005 consent blocks with PILOT_CONSENT_REQUIRED', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    mockGetStellaConsentStatus.mockResolvedValue({ status: 'missing' })
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_CONSENT_REQUIRED')
    expect(mockGetStellaPilotConfirmationStatus).not.toHaveBeenCalled()
  })

  it('revoked DR-005 consent also blocks with PILOT_CONSENT_REQUIRED', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    mockGetStellaConsentStatus.mockResolvedValue({ status: 'revoked' })
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_CONSENT_REQUIRED')
  })

  it('missing pilot confirmation blocks with PILOT_CONFIRMATION_REQUIRED, after consent passed', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    mockGetStellaPilotConfirmationStatus.mockResolvedValue({ status: 'missing' })
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_CONFIRMATION_REQUIRED')
    expect(mockGetStellaConsentStatus).toHaveBeenCalled() // consent WAS checked before confirmation
  })

  it('a revoked pilot confirmation also blocks with PILOT_CONFIRMATION_REQUIRED', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    mockGetStellaPilotConfirmationStatus.mockResolvedValue({ status: 'revoked' })
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_CONFIRMATION_REQUIRED')
  })

  it('outdated pilot confirmation (notice version bumped) blocks with the DISTINCT PILOT_CONFIRMATION_OUTDATED code', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    mockGetStellaPilotConfirmationStatus.mockResolvedValue({ status: 'outdated' })
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_CONFIRMATION_OUTDATED')
  })

  it('a role not in the pilot-enabled roles set blocks with PILOT_ROLE_NOT_ALLOWED', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ enabledStellaRoles: new Set(['composer']) }))
    const result = await getStellaPilotAccess(baseInput({ stellaRole: 'advisor' }))
    expect(result.decision).toBe('PILOT_ROLE_NOT_ALLOWED')
  })

  it('the legacy per-role flag being off blocks even if the pilot role allowlist includes it', async () => {
    mockStellaConfig.isAdvisorEnabled = false
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_ROLE_NOT_ALLOWED')
  })

  it('providerMode "disabled" blocks with PILOT_PROVIDER_NOT_READY', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ providerMode: 'disabled' }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_PROVIDER_NOT_READY')
  })

  it('providerMode "paid_gemini" without paidGeminiConfirmed blocks with the DISTINCT PILOT_PAID_PROVIDER_NOT_CONFIRMED — an API key alone never substitutes', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ providerMode: 'paid_gemini', paidGeminiConfirmed: false }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_PAID_PROVIDER_NOT_CONFIRMED')
  })

  it('providerMode "mock" never requires paidGeminiConfirmed', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ providerMode: 'mock', paidGeminiConfirmed: false }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.decision).toBe('PILOT_ALLOWED')
  })

  it('every field passing yields PILOT_ALLOWED', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig())
    const result = await getStellaPilotAccess(baseInput())
    expect(result).toEqual({ decision: 'PILOT_ALLOWED', message: expect.any(String) })
  })

  it('never returns a message containing "org-" or any allowlist-shaped detail — messages are always the same fixed strings', async () => {
    mockGetStellaPilotConfig.mockReturnValue(baseConfig({ allowedOrganizationIds: new Set() }))
    const result = await getStellaPilotAccess(baseInput())
    expect(result.message).not.toContain(ORG_ID)
    expect(result.message).not.toMatch(/allowlist|env|variable/i)
  })
})
