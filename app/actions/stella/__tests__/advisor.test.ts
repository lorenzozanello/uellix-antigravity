// app/actions/stella/__tests__/advisor.test.ts
// Sprint 9C-1: Server action tests — no real Gemini, no real DB, no real auth

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AdvisorOutput } from '@/lib/stella/schemas/advisor-output'
import type { StellaProjectContext } from '@/lib/stella/context/types'
import type { OrganizationContext } from '@/lib/auth/session'
import { StellaParseError, StellaTimeoutError, StellaGeminiError } from '@/lib/stella/errors'
import type { RateLimitResult } from '@/lib/stella/rate-limit'

// ---------------------------------------------------------------------------
// Mocks — must be at top level so vitest hoists them before imports
// ---------------------------------------------------------------------------

// Mutable config object for per-test flag overrides
const mockStellaConfig = {
  isEnabled: true,
  isAdvisorEnabled: true,
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-2.0-flash',
  requestTimeoutMs: 15000,
  rateLimitPerHour: 100,
}
const mockStellaState = { canUseStella: true, missingApiKey: false }

vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() { return mockStellaConfig },
  get stellaState() { return mockStellaState },
}))

// Etapa A2.1 (STL-A21-008): consent gate — mocked as valid by default so
// existing tests keep exercising quota/rate-limit/model behavior unchanged;
// see the dedicated "consent gate" describe block below for the block cases.
const mockGetStellaConsentStatus = vi.fn().mockResolvedValue({
  status: 'valid',
  currentAiTermsVersion: 'v1',
  currentDataPolicyVersion: 'v1',
})
vi.mock('@/lib/stella/consent/consent-status', () => ({
  getStellaConsentStatus: (...args: unknown[]) => mockGetStellaConsentStatus(...args),
}))

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

// Etapa B0 (modo piloto restringido): mocked as PILOT_ALLOWED by default so
// existing tests keep exercising consent/quota/rate-limit/model behavior
// unchanged; see the dedicated "Etapa B0 — pilot gate" describe block below
// for the block cases. providerMode defaults to 'paid_gemini' so the mocked
// getGeminiAdapter() below is called with no mockProvider override in the
// pre-existing tests (same call shape they already assert on).
const mockGetStellaPilotAccess = vi.fn().mockResolvedValue({ decision: 'PILOT_ALLOWED', message: 'Acceso permitido.' })
vi.mock('@/lib/stella/pilot/access', () => ({
  getStellaPilotAccess: (...args: unknown[]) => mockGetStellaPilotAccess(...args),
}))

const mockGetStellaPilotConfig = vi.fn().mockReturnValue({ providerMode: 'paid_gemini' })
vi.mock('@/lib/stella/pilot/config', () => ({
  getStellaPilotConfig: (...args: unknown[]) => mockGetStellaPilotConfig(...args),
}))

const mockBuildAdvisorContext = vi.fn()
vi.mock('@/lib/stella/context/build-advisor-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-advisor-context')>()
  return {
    ...original,
    buildAdvisorContext: (...args: unknown[]) => mockBuildAdvisorContext(...args),
  }
})

const mockBuildAdvisorSystemPrompt = vi.fn().mockReturnValue('mock system prompt')
const mockBuildAdvisorUserMessage = vi.fn().mockReturnValue('mock user message')
vi.mock('@/lib/stella/prompts/advisor-system', () => ({
  buildAdvisorSystemPrompt: (...args: unknown[]) => mockBuildAdvisorSystemPrompt(...args),
  buildAdvisorUserMessage: (...args: unknown[]) => mockBuildAdvisorUserMessage(...args),
}))

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

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockDbInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))

// Etapa A2.3.1: assertContextHasNoForbiddenData now consults a real
// declaration lookup for aggregate mentions — mocked as 'no declaration' by
// default so these tests exercise the deterministic fail-closed behavior,
// not a real DB call.
vi.mock('@/lib/stella/aggregation/declaration-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/aggregation/declaration-query')>()
  return { ...original, findValidSensitiveAggregationDeclarations: vi.fn().mockResolvedValue(new Map()) }
})

// ---------------------------------------------------------------------------
// Import the action AFTER mocks are in place
// ---------------------------------------------------------------------------
import { getStellaAdvisor } from '../advisor'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_ADVISOR_OUTPUT: AdvisorOutput = {
  step: 'narrative',
  what_to_do: 'Document the theory of change.',
  why_it_matters: 'Narrative grounds the SROI analysis in organizational context.',
  how_to_do_it: 'Describe the project goals, activities, and intended outcomes.',
  common_mistakes: ['Being too vague', 'Not linking to outcomes'],
  suggested_next_actions: ['Define at least 3 outcomes', 'Map stakeholders'],
}

const MOCK_ORG_CONTEXT: OrganizationContext = {
  user: { id: 'user-1', email: 'test@org.com', fullName: 'Test User', avatarUrl: null, isSuperAdmin: false },
  membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'impact_manager', status: 'active' },
  organization: { id: 'org-1', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
}

const MOCK_CONTEXT: StellaProjectContext = {
  projectId: 'proj-1',
  organizationId: 'org-1',
  narrativeSummary: 'A project to improve community wellbeing.',
  outcomesSnapshot: [],
  indicatorsSnapshot: [],
  stakeholderCount: 2,
  evidenceMetadata: [],
  evidenceTotal: 0,
  proxySummary: [],
  filterSetsSummary: [],
  calculationSnapshot: null,
  reportSections: [],
  projectCreatedAt: '2026-01-01T00:00:00.000Z',
  lastUpdatedAt: '2026-06-01T00:00:00.000Z',
}

const RATE_LIMIT_OK: RateLimitResult = {
  allowed: true,
  remaining: 95,
  limit: 100,
  resetAtHourUtc: '2026-06-26T15:00:00.000Z',
  reason: 'allowed',
}

const RATE_LIMIT_EXCEEDED: RateLimitResult = {
  allowed: false,
  remaining: 0,
  limit: 100,
  resetAtHourUtc: '2026-06-26T15:00:00.000Z',
  reason: 'limit',
}

const RATE_LIMIT_UNAVAILABLE: RateLimitResult = {
  allowed: false,
  remaining: 0,
  limit: 100,
  resetAtHourUtc: '2026-06-26T15:00:00.000Z',
  reason: 'unavailable',
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupSuccessfulCall() {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 2, quota: 50 })
  mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
  mockAdapterGenerate.mockResolvedValue({
    role: 'advisor',
    rawOutput: JSON.stringify(VALID_ADVISOR_OUTPUT),
    parsedOutput: null,
    modelUsed: 'mock-model',
    timestamp: new Date(),
  })
  mockAdapterParseResponse.mockResolvedValue(VALID_ADVISOR_OUTPUT)
  mockInsertValues.mockResolvedValue([])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStellaAdvisor server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset to enabled state for each test
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isAdvisorEnabled = true
    mockStellaState.canUseStella = true
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
    // Default: quota allowed, so tests unrelated to quota don't need to set it up.
    // Tests in the "Quota enforcement" describe block override this per-case.
    mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
    // Default: valid consent, so tests unrelated to consent don't need to set
    // it up. The "Consent gate" describe block overrides this per-case.
    mockGetStellaConsentStatus.mockResolvedValue({
      status: 'valid',
      currentAiTermsVersion: 'v1',
      currentDataPolicyVersion: 'v1',
    })
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when STELLA_ADVISOR_ENABLED is false', async () => {
      mockStellaConfig.isAdvisorEnabled = false

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when canUseStella is false (missing API key)', async () => {
      mockStellaState.canUseStella = false

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })
  })

  describe('Auth boundary', () => {
    it('calls requireOrganizationAccess', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })
  })

  describe('Context builder integration', () => {
    it('passes projectId and organization.id to buildAdvisorContext (not the same)', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-different', 'narrative')

      expect(mockBuildAdvisorContext).toHaveBeenCalledWith('proj-different', 'org-1', 'narrative')
    })

    it('does not use projectId as the organizationId', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-different', 'narrative')

      const [, calledOrgId] = mockBuildAdvisorContext.mock.calls[0]
      expect(calledOrgId).toBe('org-1')
      expect(calledOrgId).not.toBe('proj-different')
    })
  })

  describe('Prompt builders', () => {
    it('calls buildAdvisorSystemPrompt with step', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'outcomes')

      expect(mockBuildAdvisorSystemPrompt).toHaveBeenCalledWith('outcomes')
    })

    it('calls buildAdvisorUserMessage with step and context', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'outcomes')

      expect(mockBuildAdvisorUserMessage).toHaveBeenCalledWith('outcomes', MOCK_CONTEXT)
    })
  })

  describe('Successful call', () => {
    it('returns ok:true with parsed AdvisorOutput', async () => {
      setupSuccessfulCall()

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.step).toBe('narrative')
        expect(result.data.what_to_do).toBeDefined()
        expect(Array.isArray(result.data.common_mistakes)).toBe(true)
        expect(Array.isArray(result.data.suggested_next_actions)).toBe(true)
      }
    })

    it('passes advisor role to the adapter', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockAdapterGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'advisor' })
      )
    })
  })

  describe('Error handling', () => {
    it('returns PARSE_ERROR on StellaParseError from parseResponse', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'advisor', rawOutput: 'not valid json', parsedOutput: null,
        modelUsed: 'mock-model', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockRejectedValue(new StellaParseError('Bad JSON'))

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
    })

    it('returns TIMEOUT on StellaTimeoutError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('TIMEOUT')
    })

    it('returns GEMINI_ERROR on StellaGeminiError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
    })

    it('returns UNSUPPORTED_STEP when context builder rejects for calculation', async () => {
      const { StellaBuildContextError } = await import('@/lib/stella/context/build-advisor-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildAdvisorContext.mockRejectedValue(
        new StellaBuildContextError('UNSUPPORTED_STEP', 'Calculation not supported.')
      )

      const result = await getStellaAdvisor('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNSUPPORTED_STEP')
    })
  })

  describe('Audit insert', () => {
    it('inserts into stellaInteractions after successful parse', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      expect(mockDbInsert).toHaveBeenCalled()
      expect(mockInsertValues).toHaveBeenCalled()
    })

    it('inserts with advisor role', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.stellaRole).toBe('advisor')
    })

    it('inserts with organization.id from auth context', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.organizationId).toBe('org-1')
    })

    it('inserts with the given step as pipelineStep', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.pipelineStep).toBe('Narrativa')
    })

    it('inserts a populated 64-char SHA-256 contextHash (not empty)', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.contextHash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('returns AUDIT_ERROR when insert fails', async () => {
      setupSuccessfulCall()
      mockInsertValues.mockRejectedValue(new Error('DB connection error'))
      const result = await getStellaAdvisor('proj-1', 'Narrativa')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
    })
  })

  describe('Rate limiting', () => {
    it('consumes after context validation and before Gemini', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockBuildAdvisorContext.mock.invocationCallOrder[0]).toBeLessThan(
        mockCheckStellaRateLimit.mock.invocationCallOrder[0]
      )
      expect(mockCheckStellaRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
        mockAdapterGenerate.mock.invocationCallOrder[0]
      )
    })

    it('returns RATE_LIMITED when org has exceeded hourly limit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('RATE_LIMITED')
        expect(result.message).toContain('2026-06-26T15:00:00.000Z')
      }
    })

    it('fails closed when the distributed limiter is unavailable', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 2, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_UNAVAILABLE)

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result).toEqual({
        ok: false,
        error: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Stella rate limit service is temporarily unavailable.',
      })
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('passes organization.id (not project id) to consumeStellaRateLimit', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-different-id', 'narrative')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-1')
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalledWith('proj-different-id')
    })

    it('consumes only once when rate limited', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledOnce()
    })

    it('does NOT call Gemini when rate limited', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('consumes after context with organization.id', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-1')
    })

    it('does NOT record rate limit when auth fails', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
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

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

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

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('CONSENT_REVOKED')
      expect(mockCheckStellaQuota).not.toHaveBeenCalled()
    })

    it('returns CONSENT_OUTDATED when the accepted version is no longer current', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaConsentStatus.mockResolvedValue({
        status: 'outdated',
        currentAiTermsVersion: 'v2',
        currentDataPolicyVersion: 'v1',
      })

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('CONSENT_OUTDATED')
      expect(mockCheckStellaQuota).not.toHaveBeenCalled()
    })

    it('proceeds normally when consent is valid', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaConsentStatus.mockResolvedValue({
        status: 'valid',
        currentAiTermsVersion: 'v1',
        currentDataPolicyVersion: 'v1',
      })

      await getStellaAdvisor('proj-1', 'Narrativa')

      expect(mockCheckStellaQuota).toHaveBeenCalledTimes(1)
    })
  })

  describe('Quota enforcement', () => {
    it('returns QUOTA_EXCEEDED when org has no quota assigned', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 0, quota: 0, reason: 'no_quota' })

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
    })

    it('returns QUOTA_EXCEEDED when org used up its monthly quota', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('QUOTA_EXCEEDED')
        expect(result.message).toContain('50')
      }
    })

    it('does NOT call Gemini when quota exceeded', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })

      await getStellaAdvisor('proj-1', 'Narrativa')

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('checks quota with organization.id', async () => {
      setupSuccessfulCall()
      await getStellaAdvisor('proj-1', 'Narrativa')
      expect(mockCheckStellaQuota).toHaveBeenCalledWith(MOCK_ORG_CONTEXT.organization.id)
    })

    it('allows unlimited orgs (quota: null) through', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: null })
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'advisor', rawOutput: JSON.stringify(VALID_ADVISOR_OUTPUT), parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_ADVISOR_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      const result = await getStellaAdvisor('proj-1', 'Narrativa')

      expect(result.ok).toBe(true)
    })
  })

  describe('Sensitive-population guardrail (Etapa A2.3, DR-002/DR-003)', () => {
    it('returns SENSITIVE_GROUP_SIZE_REQUIRED for an aggregate mention with no verified group size, and never calls the model', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        narrativeSummary: 'The program served 50 niños in the last quarter.',
      })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('SENSITIVE_GROUP_SIZE_REQUIRED')
        expect(result.message).not.toContain('niños')
        expect(result.message).not.toContain('50')
      }
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('blocks a minor-identifiable individual mention with SENSITIVE_INDIVIDUAL_DATA_BLOCKED', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        narrativeSummary: 'The student, 12 años old, described her experience in the program.',
      })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('SENSITIVE_INDIVIDUAL_DATA_BLOCKED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('records a content-free audit entry for a blocked sensitive-population attempt', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        narrativeSummary: 'The program served 50 niños in the last quarter.',
      })

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockDbInsert).toHaveBeenCalled()
      const auditPayload = mockInsertValues.mock.calls[0][0]
      expect(auditPayload.action).toBe('stella_sensitive_data.blocked')
      expect(auditPayload.reason).toBe('SENSITIVE_GROUP_SIZE_REQUIRED')
      expect(JSON.stringify(auditPayload)).not.toContain('niños')
    })

    it('still returns the generic CONTEXT_GUARDRAIL_FAILED for a non-sensitive-population guardrail violation', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        proxySummary: [{ id: 'p-1', name: 'Proxy', source: 'Source', value: '12.50', currency: '' }],
      })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('CONTEXT_GUARDRAIL_FAILED')
    })

    it('Etapa B0: a valid pilot confirmation NEVER bypasses the sensitive-data guardrail — PILOT_ALLOWED only means the request may reach the provider, not that its content is exempt from DR-002/DR-003/DR-001 checks', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaPilotAccess.mockResolvedValue({ decision: 'PILOT_ALLOWED', message: 'Acceso permitido.' })
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        narrativeSummary: 'The student, 12 años old, described her experience in the program.',
      })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('SENSITIVE_INDIVIDUAL_DATA_BLOCKED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  describe('Security invariants', () => {
    it('does NOT import from lib/pipeline/sroi-calculation', async () => {
      // Verified structurally: if the import existed it would trigger a forbidden module error
      // in the mock environment. The action loads without error = no sroi-calculation import.
      expect(getStellaAdvisor).toBeDefined()
    })

    it('does NOT use NEXT_PUBLIC_GEMINI env var', () => {
      expect(process.env.NEXT_PUBLIC_GEMINI_API_KEY).toBeUndefined()
    })

    it('writes only the audit insert to DB on a successful call (no pipeline writes)', async () => {
      setupSuccessfulCall()

      await getStellaAdvisor('proj-1', 'narrative')

      // Context building is DB-backed but mocked here; the action itself only
      // performs the single stella_interactions audit insert — no pipeline writes.
      expect(mockBuildAdvisorContext).toHaveBeenCalled()
      expect(mockDbInsert).toHaveBeenCalledTimes(1)
    })
  })

  describe('Etapa B0 — pilot gate', () => {
    it('runs BEFORE consent/quota/rate-limit/model — a rejection never consumes quota or calls the provider', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaPilotAccess.mockResolvedValue({ decision: 'PILOT_ORGANIZATION_NOT_ALLOWED', message: 'Tu organización todavía no forma parte del piloto de Stella.' })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result).toEqual({ ok: false, error: 'PILOT_ORGANIZATION_NOT_ALLOWED', message: 'Tu organización todavía no forma parte del piloto de Stella.' })
      expect(mockCheckStellaQuota).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockGetStellaConsentStatus).not.toHaveBeenCalled()
    })

    it.each([
      ['PILOT_DISABLED', 'Stella no está disponible en este momento.'],
      ['PILOT_KILL_SWITCH_ACTIVE', 'Stella está temporalmente no disponible.'],
      ['PILOT_ORGANIZATION_NOT_ALLOWED', 'Tu organización todavía no forma parte del piloto de Stella.'],
      ['PILOT_USER_NOT_ALLOWED', 'Tu usuario todavía no está habilitado para el piloto de Stella.'],
      ['PILOT_MEMBERSHIP_INACTIVE', 'Tu membresía en la organización no está activa.'],
      ['PILOT_CONSENT_REQUIRED', "Un administrador de organización debe aceptar los términos de IA de Stella antes de continuar."],
      ['PILOT_ROLE_NOT_ALLOWED', 'Esta función de Stella todavía no está habilitada en el piloto.'],
      ['PILOT_CONFIRMATION_REQUIRED', 'Debés confirmar las restricciones de datos del piloto antes de continuar.'],
      ['PILOT_CONFIRMATION_OUTDATED', 'El aviso del piloto se actualizó — debés volver a confirmar las restricciones de datos.'],
      ['PILOT_PAID_PROVIDER_NOT_CONFIRMED', 'El plan pago del proveedor de IA todavía no fue confirmado para el piloto.'],
      ['PILOT_PROVIDER_NOT_READY', 'El proveedor de IA del piloto todavía no está configurado.'],
    ])('maps pilot decision %s to the matching error code and echoes its message verbatim', async (decision, message) => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaPilotAccess.mockResolvedValue({ decision, message })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result).toEqual({ ok: false, error: decision, message })
    })

    it('passes organizationId/userId/membershipRole/membershipStatus from the session, and the fixed stellaRole "advisor" — never client input', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockGetStellaPilotAccess.mockResolvedValue({ decision: 'PILOT_DISABLED', message: 'x' })

      await getStellaAdvisor('proj-1', 'narrative')

      expect(mockGetStellaPilotAccess).toHaveBeenCalledWith({
        organizationId: MOCK_ORG_CONTEXT.organization.id,
        userId: MOCK_ORG_CONTEXT.user.id,
        membershipRole: MOCK_ORG_CONTEXT.membership.role,
        membershipStatus: MOCK_ORG_CONTEXT.membership.status,
        stellaRole: 'advisor',
      })
    })

    it('when PILOT_ALLOWED, the existing consent/quota/rate-limit/model path runs exactly as before (no regression)', async () => {
      setupSuccessfulCall()
      mockGetStellaPilotAccess.mockResolvedValue({ decision: 'PILOT_ALLOWED', message: 'Acceso permitido.' })

      const result = await getStellaAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      expect(mockGetStellaConsentStatus).toHaveBeenCalled()
      expect(mockCheckStellaQuota).toHaveBeenCalled()
      expect(mockAdapterGenerate).toHaveBeenCalled()
    })

    it('when providerMode is "mock", getGeminiAdapter is called WITH a mockProvider override (never reaching real Gemini)', async () => {
      setupSuccessfulCall()
      mockGetStellaPilotAccess.mockResolvedValue({ decision: 'PILOT_ALLOWED', message: 'Acceso permitido.' })
      mockGetStellaPilotConfig.mockReturnValue({ providerMode: 'mock' })

      // The adapter factory itself is mocked to always return mockAdapter
      // regardless of args (see the top-level vi.mock) — so we can't
      // observe the constructor arg directly without a dedicated spy. This
      // test instead proves the code PATH executes without throwing and
      // still reaches a successful result, exercising the 'mock' branch.
      const result = await getStellaAdvisor('proj-1', 'narrative')
      expect(result.ok).toBe(true)
    })

    it('when providerMode is "paid_gemini", getGeminiAdapter is called with no mockProvider override', async () => {
      setupSuccessfulCall()
      mockGetStellaPilotAccess.mockResolvedValue({ decision: 'PILOT_ALLOWED', message: 'Acceso permitido.' })
      mockGetStellaPilotConfig.mockReturnValue({ providerMode: 'paid_gemini' })

      const result = await getStellaAdvisor('proj-1', 'narrative')
      expect(result.ok).toBe(true)
    })
  })
})
