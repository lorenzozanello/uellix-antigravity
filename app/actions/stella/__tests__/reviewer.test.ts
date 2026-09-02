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
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

// The identity-context wrappers are pass-throughs HERE, and only here: this
// suite is about the action's own feature-flag, role, quota and audit guards.
// The wrappers themselves — nesting, organisation validation, rollback, pool
// isolation — are proved against a live database in
// tests/authenticated-database-context.test.ts.
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
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
  // TRAIN 4.3: `checkStellaQuota` is GONE from lib/stella/quota.ts. The action
  // no longer authorizes against an unlocked count; `bind` is the only quota
  // check and it runs under the per-organization advisory lock. The mock name
  // survives only so the fixture below can assert it is never reached.
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
// TRAIN 4.3 — the governed ticket adapter, mocked at the DATABASE boundary.
// ---------------------------------------------------------------------------
// Deliberately NOT `runGovernedStellaOperation`. Mocking the driver would make
// every assertion below vacuous about the property this train exists to
// establish: that bind happens BEFORE the provider is called, complete BEFORE
// the answer is returned, and abort on every other exit. The driver therefore
// runs FOR REAL here and only the five SQL round trips are doubles.
const mockBindOperationTicket = vi.fn()
const mockCompleteStellaInteractionTicket = vi.fn()
const mockAbortOperationTicket = vi.fn()
const mockInspectOperationTicket = vi.fn()
const mockIssueOperationTicket = vi.fn()
vi.mock('@/db/stella/operation-tickets', () => ({
  bindOperationTicket: (...args: unknown[]) => mockBindOperationTicket(...args),
  completeStellaInteractionTicket: (...args: unknown[]) => mockCompleteStellaInteractionTicket(...args),
  abortOperationTicket: (...args: unknown[]) => mockAbortOperationTicket(...args),
  inspectOperationTicket: (...args: unknown[]) => mockInspectOperationTicket(...args),
  issueOperationTicket: (...args: unknown[]) => mockIssueOperationTicket(...args),
}))

/** 64 lowercase hex — the shape every ticket verb enforces in SQL. */
const TICKET = 'a'.repeat(64)

/**
 * The category the mocked ticket carries. The reviewer action is the one
 * surface that acts as three capabilities, so its tests have to be able to
 * present a ticket of a DIFFERENT category than the run — which is the
 * cross-category attack `runGovernedStellaOperation` refuses.
 */
const mockTicketCategory = 'proxy_reviewer'

/**
 * The happy-path ticket lifecycle: a live reservation, a matching category, a
 * settlement that charges exactly one unit.
 *
 * `beforeEach` installs it, so a test that says nothing about tickets exercises
 * the ordinary governed path; a test about quota, retry or a cross-category
 * presentation overrides exactly the one verb it is about.
 */
function installGovernedTicketHappyPath() {
  mockBindOperationTicket.mockResolvedValue({ kind: 'bound', used: 0, quota: 50 })
  mockInspectOperationTicket.mockResolvedValue({
    status: 'bound',
    category: mockTicketCategory,
    expiresAt: '2026-08-06T00:15:00.000Z',
    hasQueryHash: true,
  })
  mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'completed', used: 1, quota: 50 })
  mockAbortOperationTicket.mockResolvedValue({ kind: 'aborted' })
  mockIssueOperationTicket.mockResolvedValue({ kind: 'issued', ticketId: TICKET })
}

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
  installGovernedTicketHappyPath()
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
    installGovernedTicketHappyPath()
    mockLogAuditAction.mockResolvedValue(undefined)
  })

  describe('Audit trail + observability (WS3b)', () => {
    it('logs STELLA_INVOKED with the reviewer role and its pipeline step, metadata only', async () => {
      setupSuccessfulCall()

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked).toBeDefined()
      expect(invoked.organizationId).toBe('org-1')
      expect(invoked.actorUserId).toBe('user-1')
      expect(invoked.entityId).toBe('proj-1')
      expect(invoked.afterJson.stellaRole).toBe('proxy_reviewer')
      // TRAIN 4.3: `tokensUsed` moved to the ledger row the governed completion
      // verb files; duplicating it here would be two places for one number.
      expect(mockCompleteStellaInteractionTicket.mock.calls[0][3].tokensUsed).toBe(42)
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

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

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

      await getStellaReviewer('proj-1', 'evidence_reviewer', TICKET)

      const denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied.afterJson).toEqual({ stellaRole: 'evidence_reviewer', reason: 'ROLE_DENIED', membershipRole: 'viewer' })
    })

    it('denial result is unchanged when the audit write throws (fire-and-forget)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setupSuccessfulCall()
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })

    it('reports AUDIT_ERROR to observability with the reviewer role when the insert fails', async () => {
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'rejected', reason: 'unavailable' })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNKNOWN_ERROR')
      // TRAIN 4.3: a settlement rejection is the ledger declining, not an
      // application fault. Nothing is filed to Sentry.
      expect(mockReportStellaFailure).not.toHaveBeenCalled()
    })
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when the per-role flag is false', async () => {
      mockStellaConfig.isProxyReviewerEnabled = false

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

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

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockBindOperationTicket).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it.each(['analyst', 'reviewer', 'organization_admin'] as const)('allows role %s through the gate', async (role) => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role },
      })

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(true)
    })
  })

  describe('Successful call', () => {
    it('returns ok:true with the parsed reviewer output and audits it', async () => {
      setupSuccessfulCall()

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.requires_human_review).toBe(true)
      expect(mockCompleteStellaInteractionTicket).toHaveBeenCalledTimes(1)
      // TRAIN 4.3. The category and the organization are read off the TICKET
      // ROW inside SQL and have no parameter here — which is why the payload
      // does not carry them and why a caller cannot move the charge.
      const [ticketId, projectId, digest, payload] =
        mockCompleteStellaInteractionTicket.mock.calls[0]
      expect(ticketId).toBe(TICKET)
      expect(projectId).toBe('proj-1')
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(payload).not.toHaveProperty('stellaRole')
      expect(payload).not.toHaveProperty('organizationId')
    })
  })

  describe('Payload cap', () => {
    it('returns PAYLOAD_TOO_LARGE on StellaPayloadTooLargeError from the adapter', async () => {
      setupSuccessfulCall()
      const { StellaPayloadTooLargeError } = await import('@/lib/stella/security/payload-limits')
      mockAdapterGenerate.mockRejectedValue(new StellaPayloadTooLargeError(150000, 120000))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PAYLOAD_TOO_LARGE')
    })
  })

  describe('Auth boundary', () => {
    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaReviewer('proj-1', 'proxy_reviewer', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })
  })
})
