// app/actions/stella/__tests__/composer.test.ts
// Composer server action tests — no real Gemini, no real DB, no real auth

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComposerOutput } from '@/lib/stella/schemas/composer-output'
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
  isComposerEnabled: true,
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

const mockBuildComposerContext = vi.fn()
vi.mock('@/lib/stella/context/build-composer-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-composer-context')>()
  return {
    ...original,
    buildComposerContext: (...args: unknown[]) => mockBuildComposerContext(...args),
  }
})

const mockBuildComposerSystemPrompt = vi.fn().mockReturnValue('mock composer system prompt')
const mockBuildComposerUserMessage = vi.fn().mockReturnValue('mock composer user message')
vi.mock('@/lib/stella/prompts/composer-system', () => ({
  buildComposerSystemPrompt: (...args: unknown[]) => mockBuildComposerSystemPrompt(...args),
  buildComposerUserMessage: (...args: unknown[]) => mockBuildComposerUserMessage(...args),
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

// ---------------------------------------------------------------------------
// Import the action AFTER mocks are in place
// ---------------------------------------------------------------------------
import { getStellaComposer } from '../composer'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_COMPOSER_OUTPUT: ComposerOutput = {
  section_key: 'executive_summary',
  draft_title: 'Resumen Ejecutivo',
  draft_content: 'Este proyecto generó un retorno social de 3.6x la inversión...',
  assumptions: ['Se asume que los beneficiarios reportados completaron el programa'],
  limitations: ['Datos de seguimiento a 12 meses aún no disponibles'],
  evidence_references: [{ evidenceId: 'ev-1', title: 'Encuesta de seguimiento', context: 'Fuente de la tasa de empleo' }],
  proxy_references: [{ proxyId: 'proxy-1', name: 'Costo de tratar depresión', context: 'Usado para valorar el outcome de salud mental' }],
}

const MOCK_ORG_CONTEXT: OrganizationContext = {
  user: { id: 'user-uuid-001', email: 'composer@org.com', fullName: 'Composer User', avatarUrl: null, isSuperAdmin: false },
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
  reason: 'allowed',
}

const RATE_LIMIT_EXCEEDED: RateLimitResult = {
  allowed: false,
  remaining: 0,
  limit: 100,
  resetAtHourUtc: '2026-06-26T15:00:00.000Z',
  reason: 'limit',
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupSuccessfulCall() {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 2, quota: 50 })
  mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
  mockAdapterGenerate.mockResolvedValue({
    role: 'composer',
    rawOutput: JSON.stringify(VALID_COMPOSER_OUTPUT),
    parsedOutput: null,
    modelUsed: 'gemini-2.0-flash',
    tokensUsed: 1234,
    timestamp: new Date(),
  })
  mockAdapterParseResponse.mockResolvedValue(VALID_COMPOSER_OUTPUT)
  mockInsertValues.mockResolvedValue([])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStellaComposer server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isComposerEnabled = true
    mockStellaState.canUseStella = true
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
    // Default: quota allowed, so tests unrelated to quota don't need to set it up.
    // Tests in the "Quota enforcement" describe block override this per-case.
    mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
  })

  // -------------------------------------------------------------------------
  // Feature flag gate
  // -------------------------------------------------------------------------
  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when isComposerEnabled is false', async () => {
      mockStellaConfig.isComposerEnabled = false

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when canUseStella is false (missing API key)', async () => {
      mockStellaState.canUseStella = false

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('does NOT check rate limit when disabled', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Auth boundary
  // -------------------------------------------------------------------------
  describe('Auth boundary', () => {
    it('calls requireOrganizationAccess', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })

    it('does NOT record rate limit when auth fails', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------
  describe('Rate limiting', () => {
    it('returns RATE_LIMITED when org has exceeded hourly limit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('RATE_LIMITED')
        expect(result.message).toContain('2026-06-26T15:00:00.000Z')
      }
    })

    it('passes organization.id (not project id) to consumeStellaRateLimit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('error'))

      await getStellaComposer('proj-different-id', 'report-1', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-uuid-001')
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalledWith('proj-different-id')
    })

    it('consumes only once when rate limited', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledOnce()
    })

    it('does NOT call Gemini when rate limited', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Quota enforcement
  // -------------------------------------------------------------------------
  describe('Quota enforcement', () => {
    it('returns QUOTA_EXCEEDED when org has no quota assigned', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 0, quota: 0, reason: 'no_quota' })

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
    })

    it('returns QUOTA_EXCEEDED when org used up its monthly quota', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

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

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('checks quota with organization.id', async () => {
      setupSuccessfulCall()
      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')
      expect(mockCheckStellaQuota).toHaveBeenCalledWith(MOCK_ORG_CONTEXT.organization.id)
    })

    it('allows unlimited orgs (quota: null) through', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: null })
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'composer', rawOutput: JSON.stringify(VALID_COMPOSER_OUTPUT), parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_COMPOSER_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // consumeStellaRateLimit behavior
  // -------------------------------------------------------------------------
  describe('consumeStellaRateLimit behavior', () => {
    it('consumes after context is built and before Gemini', async () => {
      let consumedBeforeGenerate = false
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockCheckStellaRateLimit.mockImplementation(() => {
        consumedBeforeGenerate = !mockAdapterGenerate.mock.calls.length
        return RATE_LIMIT_OK
      })
      mockAdapterGenerate.mockResolvedValue({
        role: 'composer',
        rawOutput: JSON.stringify(VALID_COMPOSER_OUTPUT),
        parsedOutput: null,
        modelUsed: 'gemini-2.0-flash',
        timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_COMPOSER_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(consumedBeforeGenerate).toBe(true)
      expect(mockBuildComposerContext.mock.invocationCallOrder[0]).toBeLessThan(
        mockCheckStellaRateLimit.mock.invocationCallOrder[0]
      )
    })

    it('consumes with organization.id (not project id)', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-uuid-001', 'report-1', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-uuid-001')
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalledWith('proj-uuid-001')
    })

    it('does NOT record when feature flags are off', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })

    it('does NOT record when context build fails', async () => {
      const { StellaBuildComposerContextError } = await import('@/lib/stella/context/build-composer-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockRejectedValue(
        new StellaBuildComposerContextError('NOT_FOUND', 'Report not found.')
      )

      await getStellaComposer('proj-1', 'report-missing', 'section-1', 'executive_summary')

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Context builder integration
  // -------------------------------------------------------------------------
  describe('Context builder integration', () => {
    it('passes projectId, organization.id, and reportId to buildComposerContext', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-different', 'report-different', 'section-1', 'executive_summary')

      expect(mockBuildComposerContext).toHaveBeenCalledWith('proj-different', 'org-uuid-001', 'report-different')
    })

    it('returns UNAUTHORIZED when report not found', async () => {
      const { StellaBuildComposerContextError } = await import('@/lib/stella/context/build-composer-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockRejectedValue(
        new StellaBuildComposerContextError('NOT_FOUND', 'Report not found.')
      )

      const result = await getStellaComposer('proj-1', 'report-missing', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })

    it('returns UNAUTHORIZED when project/report access denied', async () => {
      const { StellaBuildComposerContextError } = await import('@/lib/stella/context/build-composer-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockRejectedValue(
        new StellaBuildComposerContextError('UNAUTHORIZED', 'Report does not belong to this project/organization')
      )

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })
  })

  // -------------------------------------------------------------------------
  // Gemini integration
  // -------------------------------------------------------------------------
  describe('Gemini integration', () => {
    it('calls adapter with composer role', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockAdapterGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'composer' })
      )
    })

    it('returns TIMEOUT on StellaTimeoutError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('TIMEOUT')
    })

    it('returns GEMINI_ERROR on StellaGeminiError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('Gemini unavailable'))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
    })

    it('returns PARSE_ERROR on StellaParseError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'composer', rawOutput: 'invalid json', parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockRejectedValue(new StellaParseError('Bad JSON'))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

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

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockDbInsert).toHaveBeenCalled()
      expect(mockInsertValues).toHaveBeenCalled()
    })

    it('inserts with composer role', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.stellaRole).toBe('composer')
    })

    it('inserts with pipelineStep = sectionType', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'methodology')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.pipelineStep).toBe('methodology')
    })

    it('inserts with organization.id from auth context', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.organizationId).toBe('org-uuid-001')
    })

    it('inserts with createdBy from auth user.id', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.createdBy).toBe('user-uuid-001')
    })

    it('inserts a populated 64-char SHA-256 contextHash (not empty)', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.contextHash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('returns AUDIT_ERROR when insert fails', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'composer',
        rawOutput: JSON.stringify(VALID_COMPOSER_OUTPUT),
        parsedOutput: null,
        modelUsed: 'gemini-2.0-flash',
        timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_COMPOSER_OUTPUT)
      mockInsertValues.mockRejectedValue(new Error('DB connection error'))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
    })
  })

  // -------------------------------------------------------------------------
  // Successful call
  // -------------------------------------------------------------------------
  describe('Successful call', () => {
    it('returns ok:true with parsed ComposerOutput', async () => {
      setupSuccessfulCall()

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.section_key).toBe('executive_summary')
        expect(result.data.draft_title).toBeDefined()
        expect(result.data.draft_content).toBeDefined()
        expect(Array.isArray(result.data.assumptions)).toBe(true)
        expect(Array.isArray(result.data.limitations)).toBe(true)
        expect(Array.isArray(result.data.evidence_references)).toBe(true)
        expect(Array.isArray(result.data.proxy_references)).toBe(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security invariants', () => {
    it('does NOT expose GEMINI_API_KEY', () => {
      expect(process.env.NEXT_PUBLIC_GEMINI_API_KEY).toBeUndefined()
    })

    it('does NOT save draft automatically (exactly one DB insert on success)', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      // db.insert is only called once — for stella_interactions.
      // No sroi_report_sections write happens (draft is returned, not saved).
      expect(mockDbInsert).toHaveBeenCalledTimes(1)
      const insertArg = mockDbInsert.mock.calls[0][0]
      expect(insertArg).toBeDefined()
    })

    it('does NOT make audit insert when disabled (no DB calls at all)', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary')

      expect(mockDbInsert).not.toHaveBeenCalled()
    })
  })
})
