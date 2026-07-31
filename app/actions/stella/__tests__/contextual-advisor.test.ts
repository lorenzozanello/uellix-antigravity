// app/actions/stella/__tests__/contextual-advisor.test.ts
// Authorized contextual advisor server action — no real Gemini, no real DB,
// no real auth. Verifies that every guard applied by getStellaAdvisor
// (feature flag, auth, quota, project ownership, rate limit, audit) also
// applies to getStellaContextualAdvisor, and that organizationId is always
// server-derived rather than supplied by the caller.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StellaProjectContext } from '@/lib/stella/context/types'
import type { OrganizationContext } from '@/lib/auth/session'
import type { RateLimitResult } from '@/lib/stella/rate-limit'

// ---------------------------------------------------------------------------
// Mocks — must be at top level so vitest hoists them before imports
// ---------------------------------------------------------------------------

const mockStellaConfig = {
  isEnabled: true,
  isAdvisorEnabled: true,
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

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockBuildAdvisorContext = vi.fn()
vi.mock('@/lib/stella/context/build-advisor-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-advisor-context')>()
  return {
    ...original,
    buildAdvisorContext: (...args: unknown[]) => mockBuildAdvisorContext(...args),
  }
})

const mockAdapterGenerate = vi.fn()
const mockAdapter = {
  generate: (...args: unknown[]) => mockAdapterGenerate(...args),
  parseResponse: vi.fn(),
  isReady: vi.fn().mockReturnValue(true),
}
const mockGetGeminiAdapter = vi.fn().mockReturnValue(mockAdapter)
vi.mock('@/lib/stella/adapter/gemini-client', () => ({
  getGeminiAdapter: () => mockGetGeminiAdapter(),
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

// WS3b: audit trail writer mocked at the module boundary (keeps AUDIT_ACTIONS real)
const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return {
    ...original,
    logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args),
  }
})

// WS3b: Sentry-backed failure reporting mocked
const mockReportStellaFailure = vi.fn()
vi.mock('@/lib/stella/observability', () => ({
  reportStellaFailure: (...args: unknown[]) => mockReportStellaFailure(...args),
}))

// ---------------------------------------------------------------------------
// Import the action AFTER mocks are in place. runContextualAdvisor itself is
// NOT mocked — it is the pure, already-covered pipeline (see
// lib/stella/advisor/run-contextual-advisor.test.ts) and runs for real here
// against the mocked adapter, so canonicalization and decoding stay exercised
// end to end through the authorized entry point.
// ---------------------------------------------------------------------------
import * as advisorModule from '../advisor'
const { getStellaContextualAdvisor, getStellaAdvisor } = advisorModule

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function providerOutput(step: string, sourceRefIndexes: unknown[] = []) {
  return {
    step,
    responseType: 'review',
    summary: 'Resumen',
    findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceRefIndexes }],
    suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: [], sourceRefIndexes }],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true,
  }
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

function mockGenerateResolves(step: string, sourceRefIndexes: unknown[] = []) {
  mockAdapterGenerate.mockResolvedValue({
    role: 'advisor',
    rawOutput: JSON.stringify(providerOutput(step, sourceRefIndexes)),
    parsedOutput: null,
    modelUsed: 'gemini-2.5-flash',
    tokensUsed: 42,
    timestamp: new Date(),
  })
}

function setupSuccessfulCall(step: string = 'narrative') {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 2, quota: 50 })
  mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
  mockGenerateResolves(step)
  mockInsertValues.mockResolvedValue([])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStellaContextualAdvisor server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isAdvisorEnabled = true
    mockStellaState.canUseStella = true
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
    mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
    mockLogAuditAction.mockResolvedValue(undefined)
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false, without reaching the adapter', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  describe('Role gate (canUseStella)', () => {
    it.each(['viewer'] as const)('returns UNAUTHORIZED for role %s without touching quota, rate limit or the adapter', async (role) => {
      setupSuccessfulCall('narrative')
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role },
      })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockCheckStellaQuota).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockBuildAdvisorContext).not.toHaveBeenCalled()
    })

    it.each(['analyst', 'reviewer'] as const)('allows role %s through the gate', async (role) => {
      setupSuccessfulCall('narrative')
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role },
      })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
    })
  })

  describe('A. Unauthenticated caller', () => {
    it('never reaches the adapter when requireOrganizationAccess throws', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockBuildAdvisorContext).not.toHaveBeenCalled()
    })
  })

  describe('B. Organization access failure', () => {
    it('never reaches the adapter when the project does not belong to the caller org', async () => {
      const { StellaBuildContextError } = await import('@/lib/stella/context/build-advisor-context')
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockRejectedValue(new StellaBuildContextError('UNAUTHORIZED', 'Project does not belong to your organization'))

      const result = await getStellaContextualAdvisor('proj-other-org', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  describe('C. Quota exhausted', () => {
    it('never reaches the adapter when the org has no quota', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 0, quota: 0, reason: 'no_quota' })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockBuildAdvisorContext).not.toHaveBeenCalled()
    })
  })

  describe('D. Rate limit blocked', () => {
    it('never reaches the adapter when the org has exceeded the hourly limit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
      mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('RATE_LIMITED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  describe('E. organizationId is server-derived, not client-supplied', () => {
    it('calls buildAdvisorContext with the session organization id, never a client-controlled value', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-different', 'narrative')

      expect(mockBuildAdvisorContext).toHaveBeenCalledWith('proj-different', 'org-1', 'narrative')
    })

    it('has no parameter through which a caller could supply organizationId', () => {
      // Structural: the function signature is (projectId, step) — organizationId
      // cannot be passed by a caller at all, only derived from the session.
      expect(getStellaContextualAdvisor.length).toBe(2)
    })

    it('checks quota and rate limit with the session organization id, not the project id', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-different-id', 'narrative')

      expect(mockCheckStellaQuota).toHaveBeenCalledWith('org-1')
      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-1')
      expect(mockCheckStellaQuota).not.toHaveBeenCalledWith('proj-different-id')
    })
  })

  describe('F. Mandatory audit insert', () => {
    it('inserts into stellaInteractions after a successful call', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(mockDbInsert).toHaveBeenCalled()
      expect(mockInsertValues).toHaveBeenCalled()
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.stellaRole).toBe('advisor')
      expect(insertPayload.organizationId).toBe('org-1')
      expect(insertPayload.pipelineStep).toBe('narrative')
    })

    it('returns AUDIT_ERROR when the insert fails, after a successful model call', async () => {
      setupSuccessfulCall()
      mockInsertValues.mockRejectedValue(new Error('DB connection error'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
    })
  })

  describe('G. Exactly one adapter call per valid request', () => {
    it('calls the adapter exactly once on a successful request', async () => {
      setupSuccessfulCall()

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      expect(mockAdapterGenerate).toHaveBeenCalledTimes(1)
    })
  })

  describe('H. Trusted step reaches the decoder', () => {
    it('canonicalizes a provider-translated step against the requested step', async () => {
      setupSuccessfulCall()
      mockGenerateResolves('Narrativa')

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.step).toBe('narrative')
    })
  })

  describe('J. Out-of-range indices fail closed', () => {
    it('returns PARSE_ERROR and does not retry when the provider cites an out-of-range index', async () => {
      setupSuccessfulCall()
      mockGenerateResolves('narrative', [999])

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
      expect(mockAdapterGenerate).toHaveBeenCalledTimes(1)
      expect(mockDbInsert).not.toHaveBeenCalled()
    })
  })

  describe('K. Anti-regression — no unguarded export reaches the adapter', () => {
    it('exports exactly the known, authorized async functions from advisor.ts', () => {
      // Enumerates the actual module exports at runtime — fails the moment a
      // new export is added, forcing whoever adds it to extend this test
      // (and the guard coverage below) rather than silently shipping a
      // third, unaudited path to Gemini.
      const exportedFunctionNames = Object.keys(advisorModule).filter(
        (key) => typeof (advisorModule as Record<string, unknown>)[key] === 'function',
      )
      expect(exportedFunctionNames.sort()).toEqual(['getStellaAdvisor', 'getStellaContextualAdvisor'])
    })

    it('every exported Gemini-reaching function refuses to call the adapter without organization access', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      await getStellaContextualAdvisor('proj-1', 'narrative')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()

      await getStellaAdvisor('proj-1', 'narrative')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  describe('L. No real provider', () => {
    it('only ever calls the mocked getGeminiAdapter, never a real client', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(mockGetGeminiAdapter).toHaveBeenCalled()
      expect(process.env.GEMINI_API_KEY).toBeUndefined()
    })
  })

  describe('M. Audit trail + observability (WS3b)', () => {
    it('logs STELLA_INVOKED after a successful contextual call, metadata only', async () => {
      setupSuccessfulCall()

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked).toBeDefined()
      expect(invoked.organizationId).toBe('org-1')
      expect(invoked.actorUserId).toBe('user-1')
      expect(invoked.entityId).toBe('proj-1')
      expect(invoked.afterJson).toEqual({
        stellaRole: 'advisor',
        pipelineStep: 'narrative',
        tokensUsed: 42,
        sensitivePopulations: false,
        sensitivePopulationCategories: [],
      })
      // NO prompt/context/response content in any audit payload
      const serialized = JSON.stringify(mockLogAuditAction.mock.calls)
      expect(serialized).not.toContain('Resumen')
      expect(serialized).not.toContain('community wellbeing')
    })

    // WS3c U2 (RK-19): provider step mismatches are observable — warned and audited.
    it('warns and audits stepMismatch when the provider returned a different step', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setupSuccessfulCall()
      // Requested step 'narrative'; provider answers the Spanish label.
      mockGenerateResolves('narrativa')

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith('[stella] provider step mismatch', { step: 'narrative' })
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.stepMismatch).toBe(true)
      warnSpy.mockRestore()
    })

    it('does not warn nor audit stepMismatch when the provider step matches', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setupSuccessfulCall()

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      expect(warnSpy).not.toHaveBeenCalledWith('[stella] provider step mismatch', expect.anything())
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson).not.toHaveProperty('stepMismatch')
      warnSpy.mockRestore()
    })

    // WS3c U1 (RK-08): audit metadata carries the sensitive-populations flag.
    it('logs sensitivePopulations metadata (flag + categories) when the context detected them', async () => {
      setupSuccessfulCall()
      mockBuildAdvisorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        sensitivePopulations: { detected: true, categories: ['minors', 'violence_victims'] },
      })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.sensitivePopulations).toBe(true)
      expect(invoked.afterJson.sensitivePopulationCategories).toEqual(['minors', 'violence_victims'])
    })

    it('logs STELLA_DENIED with QUOTA_EXCEEDED and result is unchanged when the audit write throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })

    it('logs STELLA_DENIED with RATE_LIMITED when the limiter blocks', async () => {
      setupSuccessfulCall()
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaContextualAdvisor('proj-1', 'narrative')

      const denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied.afterJson.reason).toBe('RATE_LIMITED')
    })

    it('reports AUDIT_ERROR to observability when the interactions insert fails', async () => {
      setupSuccessfulCall()
      mockInsertValues.mockRejectedValue(new Error('DB down'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
      expect(mockReportStellaFailure).toHaveBeenCalledWith(
        'advisor', 'AUDIT_ERROR', expect.anything(),
        expect.objectContaining({ projectId: 'proj-1', contextual: true }),
      )
    })

    it('reports typed model failures (GEMINI_ERROR) surfaced by runContextualAdvisor', async () => {
      setupSuccessfulCall()
      const { StellaGeminiError } = await import('@/lib/stella/errors')
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
      expect(mockReportStellaFailure).toHaveBeenCalledWith(
        'advisor', 'GEMINI_ERROR', expect.anything(),
        expect.objectContaining({ projectId: 'proj-1', step: 'narrative', contextual: true }),
      )
    })
  })
})
