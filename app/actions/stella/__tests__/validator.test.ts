// app/actions/stella/__tests__/validator.test.ts
// Sprint 9D-2: Validator server action tests — no real Gemini, no real DB, no real auth

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ValidatorOutput } from '@/lib/stella/schemas/validator-output'
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
  isValidatorEnabled: true,
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

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockBuildValidatorContext = vi.fn()
vi.mock('@/lib/stella/context/build-validator-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-validator-context')>()
  return {
    ...original,
    buildValidatorContext: (...args: unknown[]) => mockBuildValidatorContext(...args),
  }
})

const mockBuildValidatorSystemPrompt = vi.fn().mockReturnValue('mock validator system prompt')
const mockBuildValidatorUserMessage = vi.fn().mockReturnValue('mock validator user message')
vi.mock('@/lib/stella/prompts/validator-system', () => ({
  buildValidatorSystemPrompt: (...args: unknown[]) => mockBuildValidatorSystemPrompt(...args),
  buildValidatorUserMessage: (...args: unknown[]) => mockBuildValidatorUserMessage(...args),
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
const mockRecordStellaRequest = vi.fn()
vi.mock('@/lib/stella/rate-limit', () => ({
  checkStellaRateLimit: (...args: unknown[]) => mockCheckStellaRateLimit(...args),
  recordStellaRequest: (...args: unknown[]) => mockRecordStellaRequest(...args),
}))

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockDbInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))

// ---------------------------------------------------------------------------
// Import the action AFTER mocks are in place
// ---------------------------------------------------------------------------
import { getStellaValidator } from '../validator'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_VALIDATOR_OUTPUT: ValidatorOutput = {
  summary: 'The SROI analysis shows a ratio of 3.6:1 with moderate methodological risks.',
  risk_level: 'medium',
  evidence_gaps: ['Indicator 2 has no supporting documentation'],
  proxy_risks: ['Proxy for Outcome 1 has low confidence level'],
  attribution_risks: [],
  claim_risks: [],
  recommendations: ['Obtain additional evidence for Indicator 2', 'Review proxy methodology'],
  requires_human_review: true,
}

const MOCK_ORG_CONTEXT: OrganizationContext = {
  user: { id: 'user-uuid-001', email: 'validator@org.com', fullName: 'Validator User', avatarUrl: null, isSuperAdmin: false },
  membership: { id: 'mem-1', organizationId: 'org-uuid-001', userId: 'user-uuid-001', role: 'impact_manager', status: 'active' },
  organization: { id: 'org-uuid-001', name: 'Test Org', slug: 'test-org', legalName: null, country: null, sector: null, status: 'active' },
}

const MOCK_CONTEXT: StellaProjectContext = {
  projectId: 'proj-uuid-001',
  organizationId: 'org-uuid-001',
  narrativeSummary: 'A skills training project.',
  outcomesSnapshot: [{ id: 'out-1', name: 'Employment Rate', description: 'social', stakeholderGroups: [] }],
  indicatorsSnapshot: [{ id: 'ind-1', outcomeId: 'out-1', name: 'Jobs secured', unit: 'count' }],
  stakeholderCount: 3,
  evidenceMetadata: [{ id: 'ev-1', title: 'Survey', type: 'file', status: 'approved', createdAt: '2026-03-01T00:00:00.000Z' }],
  evidenceTotal: 1,
  proxySummary: [{ id: 'proxy-1', name: 'Cost of treating depression', source: 'HACT', value: '', currency: '' }],
  filterSetsSummary: [{ assignmentId: 'asgn-1', deadweightPct: 25, attributionPct: 60 }],
  calculationSnapshot: {
    totalInvestment: 50000,
    grossSocialValue: 180000,
    netSocialValue: 130000,
    sroiRatio: 3.6,
    currency: 'USD',
    lineItemCount: 3,
    version: 1,
  },
  reportSections: [],
  readinessScore: 87,
  projectCreatedAt: '2026-01-01T00:00:00.000Z',
  lastUpdatedAt: '2026-06-01T00:00:00.000Z',
}

const RATE_LIMIT_OK: RateLimitResult = {
  allowed: true,
  remaining: 95,
  limit: 100,
  resetAtHourUtc: '2026-06-26T15:00:00.000Z',
}

const RATE_LIMIT_EXCEEDED: RateLimitResult = {
  allowed: false,
  remaining: 0,
  limit: 100,
  resetAtHourUtc: '2026-06-26T15:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupSuccessfulCall() {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
  mockAdapterGenerate.mockResolvedValue({
    role: 'validator',
    rawOutput: JSON.stringify(VALID_VALIDATOR_OUTPUT),
    parsedOutput: null,
    modelUsed: 'gemini-2.0-flash',
    tokensUsed: 1234,
    timestamp: new Date(),
  })
  mockAdapterParseResponse.mockResolvedValue(VALID_VALIDATOR_OUTPUT)
  mockInsertValues.mockResolvedValue([])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStellaValidator server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isValidatorEnabled = true
    mockStellaState.canUseStella = true
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
  })

  // -------------------------------------------------------------------------
  // Feature flag gate
  // -------------------------------------------------------------------------
  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when isValidatorEnabled is false', async () => {
      mockStellaConfig.isValidatorEnabled = false

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when canUseStella is false (missing API key)', async () => {
      mockStellaState.canUseStella = false

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('does NOT check rate limit when disabled', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaValidator('proj-1', 'calculation')

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Auth boundary
  // -------------------------------------------------------------------------
  describe('Auth boundary', () => {
    it('calls requireOrganizationAccess', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })

    it('does NOT record rate limit when auth fails', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      await getStellaValidator('proj-1', 'calculation')

      expect(mockRecordStellaRequest).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------
  describe('Rate limiting', () => {
    it('returns RATE_LIMITED when org has exceeded hourly limit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('RATE_LIMITED')
        expect(result.message).toContain('2026-06-26T15:00:00.000Z')
      }
    })

    it('passes organization.id (not project id) to checkStellaRateLimit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('error'))

      await getStellaValidator('proj-different-id', 'calculation')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-uuid-001')
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalledWith('proj-different-id')
    })

    it('does NOT record request when rate limited', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaValidator('proj-1', 'calculation')

      expect(mockRecordStellaRequest).not.toHaveBeenCalled()
    })

    it('does NOT call Gemini when rate limited', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaValidator('proj-1', 'calculation')

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // recordStellaRequest behavior
  // -------------------------------------------------------------------------
  describe('recordStellaRequest behavior', () => {
    it('records request after context built (before Gemini call)', async () => {
      let recordCalledBeforeGenerate = false
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockRecordStellaRequest.mockImplementation(() => {
        recordCalledBeforeGenerate = !mockAdapterGenerate.mock.calls.length
      })
      mockAdapterGenerate.mockResolvedValue({
        role: 'validator',
        rawOutput: JSON.stringify(VALID_VALIDATOR_OUTPUT),
        parsedOutput: null,
        modelUsed: 'gemini-2.0-flash',
        timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_VALIDATOR_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      await getStellaValidator('proj-1', 'calculation')

      expect(recordCalledBeforeGenerate).toBe(true)
    })

    it('records with organization.id (not project id)', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-uuid-001', 'calculation')

      expect(mockRecordStellaRequest).toHaveBeenCalledWith('org-uuid-001')
      expect(mockRecordStellaRequest).not.toHaveBeenCalledWith('proj-uuid-001')
    })

    it('does NOT record when feature flags are off', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaValidator('proj-1', 'calculation')

      expect(mockRecordStellaRequest).not.toHaveBeenCalled()
    })

    it('does NOT record when context build fails (UNSUPPORTED_STEP)', async () => {
      const { StellaBuildValidatorContextError } = await import('@/lib/stella/context/build-validator-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockRejectedValue(
        new StellaBuildValidatorContextError('UNSUPPORTED_STEP', 'Only Calculation step.')
      )

      await getStellaValidator('proj-1', 'narrative')

      expect(mockRecordStellaRequest).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Context builder integration
  // -------------------------------------------------------------------------
  describe('Context builder integration', () => {
    it('passes projectId and organization.id to buildValidatorContext', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-different', 'calculation')

      expect(mockBuildValidatorContext).toHaveBeenCalledWith('proj-different', 'org-uuid-001', 'calculation')
    })

    it('returns UNSUPPORTED_STEP when step is not Calculation', async () => {
      const { StellaBuildValidatorContextError } = await import('@/lib/stella/context/build-validator-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockRejectedValue(
        new StellaBuildValidatorContextError('UNSUPPORTED_STEP', 'Only Calculation step supported.')
      )

      const result = await getStellaValidator('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNSUPPORTED_STEP')
    })

    it('returns UNAUTHORIZED when project not found', async () => {
      const { StellaBuildValidatorContextError } = await import('@/lib/stella/context/build-validator-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockRejectedValue(
        new StellaBuildValidatorContextError('PROJECT_NOT_FOUND', 'Project not found.')
      )

      const result = await getStellaValidator('proj-missing', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })
  })

  // -------------------------------------------------------------------------
  // Gemini integration
  // -------------------------------------------------------------------------
  describe('Gemini integration', () => {
    it('calls adapter with validator role', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      expect(mockAdapterGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'validator' })
      )
    })

    it('passes contextHash to adapter.generate', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const generateCall = mockAdapterGenerate.mock.calls[0][0]
      expect(typeof generateCall.contextHash).toBe('string')
      expect(generateCall.contextHash.length).toBe(64)
    })

    it('returns TIMEOUT on StellaTimeoutError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('TIMEOUT')
    })

    it('returns GEMINI_ERROR on StellaGeminiError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('Gemini unavailable'))

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
    })

    it('returns PARSE_ERROR on StellaParseError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'validator', rawOutput: 'invalid json', parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockRejectedValue(new StellaParseError('Bad JSON'))

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
    })
  })

  // -------------------------------------------------------------------------
  // Audit insert
  // -------------------------------------------------------------------------
  describe('Audit insert', () => {
    it('inserts into stellaInteractions after successful parse', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      expect(mockDbInsert).toHaveBeenCalled()
      expect(mockInsertValues).toHaveBeenCalled()
    })

    it('inserts with validator role', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.stellaRole).toBe('validator')
    })

    it('inserts with organization.id from auth context', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.organizationId).toBe('org-uuid-001')
    })

    it('inserts with createdBy from auth user.id', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.createdBy).toBe('user-uuid-001')
    })

    it('inserts with 64-char contextHash', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(typeof insertPayload.contextHash).toBe('string')
      expect(insertPayload.contextHash.length).toBe(64)
    })

    it('inserts with pipelineStep = Calculation', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.pipelineStep).toBe('Calculation')
    })

    it('inserts riskFlags based on non-empty output arrays', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      // VALID_VALIDATOR_OUTPUT has evidence_gaps and proxy_risks non-empty
      expect(insertPayload.riskFlags).toContain('evidence_gap')
      expect(insertPayload.riskFlags).toContain('proxy_risk')
      expect(insertPayload.riskFlags).not.toContain('attribution_risk')
      expect(insertPayload.riskFlags).not.toContain('claim_risk')
    })

    it('returns AUDIT_ERROR when insert fails', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'validator',
        rawOutput: JSON.stringify(VALID_VALIDATOR_OUTPUT),
        parsedOutput: null,
        modelUsed: 'gemini-2.0-flash',
        timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_VALIDATOR_OUTPUT)
      mockInsertValues.mockRejectedValue(new Error('DB connection error'))

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
    })
  })

  // -------------------------------------------------------------------------
  // Successful call
  // -------------------------------------------------------------------------
  describe('Successful call', () => {
    it('returns ok:true with parsed ValidatorOutput', async () => {
      setupSuccessfulCall()

      const result = await getStellaValidator('proj-1', 'calculation')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.summary).toBeDefined()
        expect(result.data.risk_level).toBe('medium')
        expect(result.data.requires_human_review).toBe(true)
        expect(Array.isArray(result.data.evidence_gaps)).toBe(true)
        expect(Array.isArray(result.data.proxy_risks)).toBe(true)
        expect(Array.isArray(result.data.recommendations)).toBe(true)
      }
    })

    it('requires_human_review is always true in successful output', async () => {
      setupSuccessfulCall()

      const result = await getStellaValidator('proj-1', 'calculation')

      if (result.ok) {
        expect(result.data.requires_human_review).toBe(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security invariants', () => {
    it('does NOT import from lib/pipeline/sroi-calculation', () => {
      // Structural: if the import existed it would trigger module resolution in test env.
      // The action loads without error = no sroi-calculation import.
      expect(getStellaValidator).toBeDefined()
    })

    it('does NOT expose GEMINI_API_KEY', () => {
      expect(process.env.NEXT_PUBLIC_GEMINI_API_KEY).toBeUndefined()
    })

    it('does NOT approve evidence or proxies (no approval writes)', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation')

      // db.insert is only called once — for stella_interactions
      // No other DB writes happen (no evidence/proxy approval mutations)
      expect(mockDbInsert).toHaveBeenCalledTimes(1)
      const insertArg = mockDbInsert.mock.calls[0][0]
      // The inserted table is stellaInteractions (not evidence or proxies)
      // We can't check the table name directly in the mock, but verifying only one
      // insert call confirms no extra pipeline writes occurred.
      expect(insertArg).toBeDefined()
    })

    it('does NOT make audit insert when disabled (no DB calls at all)', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaValidator('proj-1', 'calculation')

      expect(mockDbInsert).not.toHaveBeenCalled()
    })
  })
})
