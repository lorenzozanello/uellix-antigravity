// app/actions/stella/__tests__/reviewer.test.ts
// Etapa A2.1 (STL-A21-008) — no real Gemini, no real DB, no real auth.
// No action-level test file existed for reviewer.ts before this session;
// this one is scoped to what this session touched (the consent gate) plus
// the pre-existing feature-flag/auth/quota boundary, not a full retroactive
// suite for every branch of getStellaReviewer (out of scope for DR-005).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'
import type { RateLimitResult } from '@/lib/stella/rate-limit'

const mockStellaConfig = {
  isEnabled: true,
  isProxyReviewerEnabled: true,
  isEvidenceReviewerEnabled: true,
  isAuditAssistantEnabled: true,
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-2.5-flash',
  requestTimeoutMs: 15000,
  rateLimitPerHour: 100,
}
const mockStellaState = { canUseStella: true, missingApiKey: false }
vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() { return mockStellaConfig },
  get stellaState() { return mockStellaState },
}))

const mockGetStellaConsentStatus = vi.fn()
vi.mock('@/lib/stella/consent/consent-status', () => ({
  getStellaConsentStatus: (...args: unknown[]) => mockGetStellaConsentStatus(...args),
}))

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockBuildReviewerContext = vi.fn()
vi.mock('@/lib/stella/context/build-reviewer-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-reviewer-context')>()
  return {
    ...original,
    buildReviewerContext: (...args: unknown[]) => mockBuildReviewerContext(...args),
  }
})

vi.mock('@/lib/stella/prompts/reviewer-system', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/prompts/reviewer-system')>()
  return {
    ...original,
    buildReviewerSystemPrompt: vi.fn().mockReturnValue('mock system prompt'),
    buildReviewerUserMessage: vi.fn().mockReturnValue('mock user message'),
  }
})

const mockAdapterGenerate = vi.fn()
const mockAdapterParseResponse = vi.fn()
const mockAdapter = {
  generate: (...args: unknown[]) => mockAdapterGenerate(...args),
  parseResponse: (...args: unknown[]) => mockAdapterParseResponse(...args),
  isReady: vi.fn().mockReturnValue(true),
}
vi.mock('@/lib/stella/adapter/gemini-client', () => ({
  getGeminiAdapter: () => mockAdapter,
}))

const mockCheckStellaRateLimit = vi.fn()
vi.mock('@/lib/stella/rate-limit', () => ({
  consumeStellaRateLimit: (...args: unknown[]) => mockCheckStellaRateLimit(...args),
}))

const mockCheckStellaQuota = vi.fn()
vi.mock('@/lib/stella/quota', () => ({
  checkStellaQuota: (...args: unknown[]) => mockCheckStellaQuota(...args),
  nextQuotaResetIso: () => '2026-08-01T00:00:00.000Z',
  formatQuotaResetDate: () => '1 de agosto de 2026',
}))

const mockRecordStellaInteraction = vi.fn()
vi.mock('@/lib/stella/audit-log', () => ({
  recordStellaInteraction: (...args: unknown[]) => mockRecordStellaInteraction(...args),
}))

// Etapa A2.3 (STL-A23-007): logAuditAction (used for blocked sensitive-population
// attempts) goes through the real @/lib/audit/logger, which writes via
// @/db/client — mock that DB boundary so the "blocked" tests below never
// attempt a real connection.
const mockInsertValues = vi.fn().mockResolvedValue([])
const mockDbInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))

vi.mock('@/lib/stella/aggregation/declaration-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/aggregation/declaration-query')>()
  return { ...original, findValidSensitiveAggregationDeclarations: vi.fn().mockResolvedValue(new Map()) }
})

import { getStellaReviewer } from '../reviewer'

const MOCK_ORG_CONTEXT: OrganizationContext = {
  user: { id: 'user-1', email: 'test@example.com', fullName: 'Test User', avatarUrl: null, isSuperAdmin: false },
  membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'impact_manager', status: 'active' },
  organization: { id: 'org-1', name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' } as never,
}

const RATE_LIMIT_OK: RateLimitResult = { allowed: true, remaining: 99, limit: 100, resetAtHourUtc: '2026-01-01T01:00:00Z', reason: 'allowed' }

describe('getStellaReviewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isProxyReviewerEnabled = true
    mockStellaState.canUseStella = true
    mockGetStellaConsentStatus.mockResolvedValue({
      status: 'valid',
      currentAiTermsVersion: 'v1',
      currentDataPolicyVersion: 'v1',
    })
    mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
    mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
    mockBuildReviewerContext.mockResolvedValue({
      projectId: 'proj-1',
      organizationId: 'org-1',
      narrativeSummary: '',
      outcomesSnapshot: [],
      indicatorsSnapshot: [],
      stakeholderCount: 0,
      evidenceMetadata: [],
      evidenceTotal: 0,
      proxySummary: [],
      filterSetsSummary: [],
      calculationSnapshot: null,
      reportSections: [],
      projectCreatedAt: '2026-01-01T00:00:00Z',
      lastUpdatedAt: '2026-01-01T00:00:00Z',
    })
    mockAdapterGenerate.mockResolvedValue({ rawOutput: '{}', modelUsed: 'gemini-2.5-flash', tokensUsed: 10 })
    mockAdapterParseResponse.mockResolvedValue({
      summary: 'ok',
      risk_level: 'low',
      findings: [],
      recommendations: [],
      requires_human_review: true,
    })
    mockRecordStellaInteraction.mockResolvedValue(undefined)
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when the role flag is off', async () => {
      mockStellaConfig.isProxyReviewerEnabled = false
      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })
  })

  describe('Auth boundary', () => {
    it('returns UNAUTHORIZED when not authenticated', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })
  })

  describe('Consent gate (Etapa A2.1, STL-A21-008)', () => {
    it('returns CONSENT_REQUIRED and never checks quota when consent is missing', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaConsentStatus.mockResolvedValue({
        status: 'missing',
        currentAiTermsVersion: 'v1',
        currentDataPolicyVersion: 'v1',
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('CONSENT_REQUIRED')
      expect(mockCheckStellaQuota).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('returns CONSENT_REVOKED when consent was revoked', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaConsentStatus.mockResolvedValue({
        status: 'revoked',
        currentAiTermsVersion: 'v1',
        currentDataPolicyVersion: 'v1',
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('CONSENT_REVOKED')
    })

    it('returns CONSENT_OUTDATED when the accepted version is no longer current', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaConsentStatus.mockResolvedValue({
        status: 'outdated',
        currentAiTermsVersion: 'v2',
        currentDataPolicyVersion: 'v1',
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('CONSENT_OUTDATED')
    })

    it('proceeds to quota/model when consent is valid', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(mockCheckStellaQuota).toHaveBeenCalledTimes(1)
      expect(result.ok).toBe(true)
    })
  })

  describe('Quota enforcement', () => {
    it('returns QUOTA_EXCEEDED when org has no quota assigned', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 0, quota: 0, reason: 'no_quota' })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
    })
  })

  describe('Sensitive-population guardrail (Etapa A2.3, DR-002/DR-003)', () => {
    it('returns SENSITIVE_GROUP_SIZE_REQUIRED for an aggregate mention with no verified group size, and never calls the model', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildReviewerContext.mockResolvedValue({
        projectId: 'proj-1',
        organizationId: 'org-1',
        narrativeSummary: 'The program served 50 niños in the last quarter.',
        outcomesSnapshot: [],
        indicatorsSnapshot: [],
        stakeholderCount: 0,
        evidenceMetadata: [],
        evidenceTotal: 0,
        proxySummary: [],
        filterSetsSummary: [],
        calculationSnapshot: null,
        reportSections: [],
        projectCreatedAt: '2026-01-01T00:00:00Z',
        lastUpdatedAt: '2026-01-01T00:00:00Z',
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('SENSITIVE_GROUP_SIZE_REQUIRED')
        expect(result.message).not.toContain('niños')
      }
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('records a content-free audit entry for a blocked sensitive-population attempt', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildReviewerContext.mockResolvedValue({
        projectId: 'proj-1',
        organizationId: 'org-1',
        narrativeSummary: 'The program served 50 niños in the last quarter.',
        outcomesSnapshot: [],
        indicatorsSnapshot: [],
        stakeholderCount: 0,
        evidenceMetadata: [],
        evidenceTotal: 0,
        proxySummary: [],
        filterSetsSummary: [],
        calculationSnapshot: null,
        reportSections: [],
        projectCreatedAt: '2026-01-01T00:00:00Z',
        lastUpdatedAt: '2026-01-01T00:00:00Z',
      })

      await getStellaReviewer('proj-1', 'proxy_reviewer')

      const auditPayload = mockInsertValues.mock.calls[0][0]
      expect(auditPayload.action).toBe('stella_sensitive_data.blocked')
      expect(auditPayload.reason).toBe('SENSITIVE_GROUP_SIZE_REQUIRED')
      expect(JSON.stringify(auditPayload)).not.toContain('niños')
    })
  })
})
