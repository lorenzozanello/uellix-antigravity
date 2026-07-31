// app/actions/stella/__tests__/reviewer.test.ts
// WS3 (Fable Moonshot): reviewer server-action tests — no real Gemini, DB or auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StellaProjectContext } from '@/lib/stella/context/types'
import type { OrganizationContext } from '@/lib/auth/session'
import type { RateLimitResult } from '@/lib/stella/rate-limit'

// ---------------------------------------------------------------------------
// Mocks — top level so vitest hoists them before imports
// ---------------------------------------------------------------------------

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
// Import the action AFTER mocks are in place
// ---------------------------------------------------------------------------
import { getStellaReviewer } from '../reviewer'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_REVIEWER_OUTPUT = {
  summary: 'Revisión con brechas',
  risk_level: 'medium' as const,
  findings: ['Proxy sin fuente verificable'],
  recommendations: ['Documentar la fuente'],
  requires_human_review: true,
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

function setupSuccessfulCall() {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 2, quota: 50 })
  mockBuildReviewerContext.mockResolvedValue(MOCK_CONTEXT)
  mockAdapterGenerate.mockResolvedValue({
    role: 'proxy_reviewer',
    rawOutput: JSON.stringify(VALID_REVIEWER_OUTPUT),
    parsedOutput: null,
    modelUsed: 'gemini-2.5-flash',
    tokensUsed: 42,
    timestamp: new Date(),
  })
  mockAdapterParseResponse.mockResolvedValue(VALID_REVIEWER_OUTPUT)
  mockInsertValues.mockResolvedValue([])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStellaReviewer server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStellaConfig.isEnabled = true
    mockStellaConfig.isProxyReviewerEnabled = true
    mockStellaState.canUseStella = true
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
    mockCheckStellaQuota.mockResolvedValue({ allowed: true, used: 0, quota: 50 })
    mockLogAuditAction.mockResolvedValue(undefined)
  })

  describe('Audit trail + observability (WS3b)', () => {
    it('logs STELLA_INVOKED with the reviewer role and its pipeline step, metadata only', async () => {
      setupSuccessfulCall()

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked).toBeDefined()
      expect(invoked.organizationId).toBe('org-1')
      expect(invoked.actorUserId).toBe('user-1')
      expect(invoked.entityId).toBe('proj-1')
      expect(invoked.afterJson.stellaRole).toBe('proxy_reviewer')
      expect(invoked.afterJson.tokensUsed).toBe(42)
      expect(typeof invoked.afterJson.pipelineStep).toBe('string')
      // WS3c U1 (RK-08): the flag defaults to false with empty categories.
      expect(invoked.afterJson.sensitivePopulations).toBe(false)
      expect(invoked.afterJson.sensitivePopulationCategories).toEqual([])
      const serialized = JSON.stringify(mockLogAuditAction.mock.calls)
      expect(serialized).not.toContain(VALID_REVIEWER_OUTPUT.summary)
      expect(serialized).not.toContain('Proxy sin fuente verificable')
    })

    // WS3c U1 (RK-08): audit metadata carries the sensitive-populations flag.
    it('logs sensitivePopulations metadata when the context detected them', async () => {
      setupSuccessfulCall()
      mockBuildReviewerContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        reviewerRole: 'proxy_reviewer',
        sensitivePopulations: { detected: true, categories: ['refugees_displaced'] },
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.sensitivePopulations).toBe(true)
      expect(invoked.afterJson.sensitivePopulationCategories).toEqual(['refugees_displaced'])
    })

    it('logs STELLA_DENIED with ROLE_DENIED for a viewer, tagged with the requested reviewer role', async () => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role: 'viewer' },
      })

      await getStellaReviewer('proj-1', 'evidence_reviewer')

      const denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied.afterJson).toEqual({ stellaRole: 'evidence_reviewer', reason: 'ROLE_DENIED', membershipRole: 'viewer' })
    })

    it('denial result is unchanged when the audit write throws (fire-and-forget)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setupSuccessfulCall()
      mockCheckStellaQuota.mockResolvedValue({ allowed: false, used: 50, quota: 50, reason: 'quota_exceeded' })
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })

    it('reports AUDIT_ERROR to observability with the reviewer role when the insert fails', async () => {
      setupSuccessfulCall()
      mockInsertValues.mockRejectedValue(new Error('DB down'))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('AUDIT_ERROR')
      expect(mockReportStellaFailure).toHaveBeenCalledWith(
        'proxy_reviewer', 'AUDIT_ERROR', expect.anything(), expect.objectContaining({ projectId: 'proj-1' }),
      )
    })
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when the per-role flag is false', async () => {
      mockStellaConfig.isProxyReviewerEnabled = false

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })
  })

  describe('Role gate (canUseStella)', () => {
    it.each(['viewer'] as const)('returns UNAUTHORIZED for role %s without touching quota, rate limit or Gemini', async (role) => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role },
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockCheckStellaQuota).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it.each(['analyst', 'reviewer', 'organization_admin'] as const)('allows role %s through the gate', async (role) => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role },
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(true)
    })
  })

  describe('Successful call', () => {
    it('returns ok:true with the parsed reviewer output and audits it', async () => {
      setupSuccessfulCall()

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.requires_human_review).toBe(true)
      expect(mockDbInsert).toHaveBeenCalledTimes(1)
      const insertPayload = mockInsertValues.mock.calls[0][0]
      expect(insertPayload.stellaRole).toBe('proxy_reviewer')
      expect(insertPayload.organizationId).toBe('org-1')
    })
  })

  describe('Payload cap', () => {
    it('returns PAYLOAD_TOO_LARGE on StellaPayloadTooLargeError from the adapter', async () => {
      setupSuccessfulCall()
      const { StellaPayloadTooLargeError } = await import('@/lib/stella/security/payload-limits')
      mockAdapterGenerate.mockRejectedValue(new StellaPayloadTooLargeError(150000, 120000))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PAYLOAD_TOO_LARGE')
    })
  })

  describe('Auth boundary', () => {
    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })
  })
})
