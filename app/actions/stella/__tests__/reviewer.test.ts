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
