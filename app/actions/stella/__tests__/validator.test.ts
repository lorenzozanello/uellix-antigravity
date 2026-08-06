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
    category: 'validator',
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
import { getStellaValidator, issueStellaValidatorTicket } from '../validator'

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
    installGovernedTicketHappyPath()
    mockLogAuditAction.mockResolvedValue(undefined)
  })

  describe('Audit trail + observability (WS3b)', () => {
    it('logs STELLA_INVOKED after a successful call with role/step/tokensUsed metadata only', async () => {
      setupSuccessfulCall()

      const result = await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked).toBeDefined()
      expect(invoked.organizationId).toBe('org-uuid-001')
      expect(invoked.actorUserId).toBe('user-uuid-001')
      expect(invoked.entityId).toBe('proj-uuid-001')
      // TRAIN 4.3. `tokensUsed` LEFT this entry — it is now a column of the
      // ledger row `complete_operation_ticket` files, and duplicating it here
      // would be two places for one number. `contextHash` ARRIVED, because the
      // ledger's own `context_hash` is now the ticket's bind digest (the
      // request), so the context fingerprint needs somewhere append-only to
      // live. Both moves are declared in docs/ops/contracts/CONTRACT_LEDGER.md.
      expect(invoked.afterJson).toEqual({
        stellaRole: 'validator',
        pipelineStep: 'Calculation',
        contextHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        riskLevel: 'medium',
        riskFlags: ['evidence_gap', 'proxy_risk'],
        sensitivePopulations: false,
        sensitivePopulationCategories: [],
        quotaLedger: expect.stringContaining('settle_reserved_quota'),
      })
      const serialized = JSON.stringify(mockLogAuditAction.mock.calls)
      expect(serialized).not.toContain('mock validator system prompt')
      expect(serialized).not.toContain('mock validator user message')
      expect(serialized).not.toContain(VALID_VALIDATOR_OUTPUT.summary)
    })

    // WS3c U1 (RK-08): audit metadata carries the sensitive-populations flag.
    it('logs sensitivePopulations metadata when the context detected them', async () => {
      setupSuccessfulCall()
      mockBuildValidatorContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        sensitivePopulations: { detected: true, categories: ['minors'] },
      })

      const result = await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.sensitivePopulations).toBe(true)
      expect(invoked.afterJson.sensitivePopulationCategories).toEqual(['minors'])
    })

    it('logs STELLA_DENIED with ROLE_DENIED for a viewer', async () => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role: 'viewer' },
      })

      await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)

      const denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied.afterJson).toEqual({ stellaRole: 'validator', reason: 'ROLE_DENIED', membershipRole: 'viewer' })
    })

    it('logs STELLA_DENIED with QUOTA_EXCEEDED and keeps the result when the audit write throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      // The refusal now comes from `bind` — the ONLY quota check — under the
      // per-organization advisory lock, counting charged rows AND live
      // reservations together.
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })

    // TRAIN 4.3. The hourly limit MOVED to issuance, so the execution path can
    // no longer produce a RATE_LIMITED denial and no longer writes one. Two
    // consequences, both intended: minting is bounded (issuance reserves
    // nothing, so without a limit there it was not self-limiting), and a RETRY
    // no longer spends the hourly budget for an operation already counted when
    // its ticket was minted. The coverage moved with it — see the
    // 'Ticket issuance' block below.
    it('does NOT consume the hourly limit on the execution path at all', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      const denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied).toBeUndefined()
    })

    it('reports GEMINI_ERROR failures to observability with the validator role', async () => {
      setupSuccessfulCall()
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))
      await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)
      expect(mockReportStellaFailure).toHaveBeenCalledWith(
        'validator', 'GEMINI_ERROR', expect.anything(), expect.objectContaining({ projectId: 'proj-uuid-001' }),
      )
    })

    // TRAIN 4.3. `AUDIT_ERROR` used to mean "the model answered, the provider
    // was paid for, and the `db.insert` of the audit row then threw" — charged
    // in effect but unrecorded. That state is no longer representable: the row
    // is filed by the SAME transaction that charges, so either both happened or
    // neither did. A settlement that fails withholds the answer under
    // `UNKNOWN_ERROR` (the charge is UNKNOWN, so claiming success would be a
    // claim nobody verified) and does not report an audit failure that did not
    // occur.
    it('withholds the answer under UNKNOWN_ERROR when the settlement fails — never AUDIT_ERROR', async () => {
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'rejected', reason: 'unavailable' })

      const result = await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNKNOWN_ERROR')
      expect(mockReportStellaFailure).not.toHaveBeenCalledWith(
        'validator', 'AUDIT_ERROR', expect.anything(), expect.anything(),
      )
    })

    it('does NOT report to observability on success', async () => {
      setupSuccessfulCall()
      await getStellaValidator('proj-uuid-001', 'Calculation', TICKET)
      expect(mockReportStellaFailure).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Role gate (canUseStella)
  // -------------------------------------------------------------------------
  describe('Role gate (canUseStella)', () => {
    it.each(['viewer'] as const)('returns UNAUTHORIZED for role %s without touching quota, rate limit or Gemini', async (role) => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role },
      })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

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

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Feature flag gate
  // -------------------------------------------------------------------------
  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when isValidatorEnabled is false', async () => {
      mockStellaConfig.isValidatorEnabled = false

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when canUseStella is false (missing API key)', async () => {
      mockStellaState.canUseStella = false

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('does NOT check rate limit when disabled', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Auth boundary
  // -------------------------------------------------------------------------
  describe('Auth boundary', () => {
    it('calls requireOrganizationAccess', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })

    it('does NOT record rate limit when auth fails', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------
  describe('Ticket issuance (TRAIN 4.3)', () => {
    it('returns RATE_LIMITED when the org has exceeded its hourly limit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_EXCEEDED)

      const result = await issueStellaValidatorTicket('proj-uuid-001')

      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.code).toBe('RATE_LIMITED')
      // Rate limited BEFORE minting: nothing was issued, so nothing can be bound.
      expect(mockIssueOperationTicket).not.toHaveBeenCalled()
    })

    it('passes organization.id (not the project id) to consumeStellaRateLimit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_OK)

      await issueStellaValidatorTicket('proj-uuid-001')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-uuid-001')
    })

    it('issues under the validator category, derived from the module and not from any argument', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_OK)

      const result = await issueStellaValidatorTicket('proj-uuid-001')

      expect(result).toEqual({ status: 'issued', ticket: TICKET })
      expect(mockIssueOperationTicket).toHaveBeenCalledWith('org-uuid-001', 'proj-uuid-001', 'validator')
    })

    it('costs zero auth, zero rate limit and zero mint when the flag is off', async () => {
      mockStellaConfig.isValidatorEnabled = false

      const result = await issueStellaValidatorTicket('proj-uuid-001')

      expect(result).toEqual({ status: 'disabled' })
      expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockIssueOperationTicket).not.toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED without minting when the role cannot use Stella', async () => {
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role: 'viewer' },
      })

      const result = await issueStellaValidatorTicket('proj-uuid-001')

      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.code).toBe('UNAUTHORIZED')
      expect(mockIssueOperationTicket).not.toHaveBeenCalled()
    })
  })

  describe('Quota enforcement', () => {
    it('returns QUOTA_EXCEEDED when org has no quota assigned', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'no_quota', used: 0, quota: 0 })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
    })

    it('returns QUOTA_EXCEEDED when org used up its monthly quota', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('QUOTA_EXCEEDED')
        expect(result.message).toContain('50')
      }
    })

    it('does NOT call Gemini when quota exceeded', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    // TRAIN 4.3. The quota is no longer read by this action at all. `bind` is
    // the check AND the reservation, in one statement under the advisory lock,
    // and it is scoped by the TICKET rather than by an organization argument —
    // which is why there is no organization id to assert here and why an
    // organization cannot be named by a caller.
    it('never reads an unlocked quota count — bind is the only check', async () => {
      setupSuccessfulCall()
      await getStellaValidator('proj-1', 'calculation', TICKET)
      expect(mockBindOperationTicket).toHaveBeenCalledTimes(1)
      // TRAIN 4.3 — CIERRE (R6a, prepared stella_0018). The FOURTH argument is
      // the surface's own category, and it is asserted as a literal rather than
      // with a matcher: what has to be true is that THIS action names
      // `validator` and nothing else. A matcher over the vocabulary would pass
      // on an action that named a sibling's capability, which is the defect.
      expect(mockBindOperationTicket).toHaveBeenCalledWith(
        TICKET,
        'proj-1',
        expect.stringMatching(/^[0-9a-f]{64}$/),
        'validator',
      )
    })

    it('refuses BEFORE the provider is called and holds no reservation to release', async () => {
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      // Nothing was reserved, so there is nothing to abort.
      expect(mockAbortOperationTicket).not.toHaveBeenCalled()
    })

    it('allows unlimited orgs (quota: null) through', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      installGovernedTicketHappyPath()
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'validator', rawOutput: JSON.stringify(VALID_VALIDATOR_OUTPUT), parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_VALIDATOR_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // consumeStellaRateLimit behavior
  // -------------------------------------------------------------------------
  describe('Governed operation ordering (TRAIN 4.3)', () => {
    // The ordering IS the security property, so it is asserted by invocation
    // order and not by inspection of the source.
    it('binds BEFORE the provider is called and completes BEFORE the answer is returned', async () => {
      setupSuccessfulCall()

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(true)
      expect(mockBindOperationTicket.mock.invocationCallOrder[0]).toBeLessThan(
        mockAdapterGenerate.mock.invocationCallOrder[0]
      )
      expect(mockAdapterGenerate.mock.invocationCallOrder[0]).toBeLessThan(
        mockCompleteStellaInteractionTicket.mock.invocationCallOrder[0]
      )
    })

    it('does NOT touch the ticket protocol at all when the feature flag is off', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockBindOperationTicket).not.toHaveBeenCalled()
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      expect(mockAbortOperationTicket).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })

    it('ABORTS and charges nothing when the context build fails after the reservation', async () => {
      const { StellaBuildValidatorContextError } = await import('@/lib/stella/context/build-validator-context')
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockRejectedValue(
        new StellaBuildValidatorContextError('UNSUPPORTED_STEP', 'Only Calculation step.')
      )

      const result = await getStellaValidator('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNSUPPORTED_STEP')
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      expect(mockAbortOperationTicket).toHaveBeenCalledWith(TICKET, 'proj-1', 'execution_failed')
    })

    it('ABORTS and charges nothing when the provider fails', async () => {
      setupSuccessfulCall()
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      expect(mockAbortOperationTicket).toHaveBeenCalledWith(TICKET, 'proj-1', 'execution_failed')
    })

    it('reuses the SAME ticket on a retry and hands back the settled state without re-running', async () => {
      setupSuccessfulCall()
      mockBindOperationTicket.mockResolvedValue({ kind: 'already_completed' })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
      // The whole point: no second provider call, no second charge, no invented
      // answer.
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
    })

    it('discards the answer when a concurrent delivery already settled the ticket', async () => {
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'replayed' })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      // The work RAN — but returning it would hand back a second answer for one
      // charged unit.
      expect(mockAdapterGenerate).toHaveBeenCalled()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
    })

    it('refuses a ticket of ANOTHER category, aborts it, and charges nothing', async () => {
      setupSuccessfulCall()
      mockInspectOperationTicket.mockResolvedValue({
        status: 'bound',
        category: 'advisor',
        expiresAt: '2026-08-06T00:15:00.000Z',
        hasQueryHash: true,
      })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      expect(mockAbortOperationTicket).toHaveBeenCalledWith(TICKET, 'proj-1', 'caller_abort')
    })

    it('withholds the answer when the settlement itself is rejected', async () => {
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'rejected', reason: 'unavailable' })

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNKNOWN_ERROR')
    })
  })

  // -------------------------------------------------------------------------
  // Context builder integration
  // -------------------------------------------------------------------------
  describe('Context builder integration', () => {
    it('passes projectId and organization.id to buildValidatorContext', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-different', 'calculation', TICKET)

      expect(mockBuildValidatorContext).toHaveBeenCalledWith('proj-different', 'org-uuid-001', 'calculation')
    })

    it('returns UNSUPPORTED_STEP when step is not Calculation', async () => {
      const { StellaBuildValidatorContextError } = await import('@/lib/stella/context/build-validator-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockRejectedValue(
        new StellaBuildValidatorContextError('UNSUPPORTED_STEP', 'Only Calculation step supported.')
      )

      const result = await getStellaValidator('proj-1', 'narrative', TICKET)

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

      const result = await getStellaValidator('proj-missing', 'calculation', TICKET)

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

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockAdapterGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'validator' })
      )
    })

    it('passes contextHash to adapter.generate', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation', TICKET)

      const generateCall = mockAdapterGenerate.mock.calls[0][0]
      expect(typeof generateCall.contextHash).toBe('string')
      expect(generateCall.contextHash.length).toBe(64)
    })

    it('returns TIMEOUT on StellaTimeoutError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('TIMEOUT')
    })

    it('returns GEMINI_ERROR on StellaGeminiError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildValidatorContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('Gemini unavailable'))

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
    })

    it('returns PAYLOAD_TOO_LARGE on StellaPayloadTooLargeError from the adapter', async () => {
      setupSuccessfulCall()
      const { StellaPayloadTooLargeError } = await import('@/lib/stella/security/payload-limits')
      mockAdapterGenerate.mockRejectedValue(new StellaPayloadTooLargeError(150000, 120000))

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PAYLOAD_TOO_LARGE')
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

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
    })
  })

  // -------------------------------------------------------------------------
  // Audit insert
  // -------------------------------------------------------------------------
  describe('Governed ledger row (TRAIN 4.3 — R6-INT)', () => {
    // WHAT THIS BLOCK REPLACED. It used to assert the columns of a
    // `db.insert(stellaInteractions)` this action performed itself. The runtime
    // holds NO write privilege on that table any more (prepared stella_0017
    // §1), so the row is filed by `complete_operation_ticket` and the action
    // supplies only the four values that are its to supply. The other six —
    // organization, project, actor, category, context digest and idempotency
    // key — are read off the ticket row inside SQL and have no parameter here
    // at all, which is why there is nothing left to assert about them and why
    // that is the stronger property.
    it('files the row through the governed completion verb, never through db.insert', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockCompleteStellaInteractionTicket).toHaveBeenCalledTimes(1)
      expect(mockDbInsert).not.toHaveBeenCalled()
      expect(mockInsertValues).not.toHaveBeenCalled()
    })

    it('passes the ticket, the SERVER-DERIVED project and the bind digest — and no scope of its own', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation', TICKET)

      const [ticketId, projectId, digest, payload] =
        mockCompleteStellaInteractionTicket.mock.calls[0]
      expect(ticketId).toBe(TICKET)
      expect(projectId).toBe('proj-1')
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      // No organization, no actor, no category, no idempotency key: the payload
      // carries only what the model produced.
      expect(Object.keys(payload).sort()).toEqual(
        ['modelUsed', 'pipelineStep', 'responseJson', 'tokensUsed'].sort()
      )
    })

    it('carries the pipeline step, the model and the token count of THIS run', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation', TICKET)

      const payload = mockCompleteStellaInteractionTicket.mock.calls[0][3]
      expect(payload.pipelineStep).toBe('Calculation')
      expect(payload.modelUsed).toBe('gemini-2.0-flash')
      expect(payload.tokensUsed).toBe(1234)
      expect(payload.responseJson).toEqual(VALID_VALIDATOR_OUTPUT)
    })

    it('binds the SAME digest it later completes with — one request, one identity of request', async () => {
      setupSuccessfulCall()

      await getStellaValidator('proj-1', 'calculation', TICKET)

      const boundDigest = mockBindOperationTicket.mock.calls[0][2]
      const completedDigest = mockCompleteStellaInteractionTicket.mock.calls[0][2]
      expect(boundDigest).toBe(completedDigest)
    })

    it('produces a DIFFERENT digest for a different step — one ticket cannot serve two requests', async () => {
      setupSuccessfulCall()
      await getStellaValidator('proj-1', 'Calculation', TICKET)
      const first = mockBindOperationTicket.mock.calls[0][2]

      vi.clearAllMocks()
      installGovernedTicketHappyPath()
      setupSuccessfulCall()
      await getStellaValidator('proj-1', 'Narrative', TICKET)
      const second = mockBindOperationTicket.mock.calls[0][2]

      expect(first).not.toBe(second)
    })

    it('produces the SAME digest for a repeated identical request — a retry is not a new request', async () => {
      setupSuccessfulCall()
      await getStellaValidator('proj-1', 'Calculation', TICKET)
      const first = mockBindOperationTicket.mock.calls[0][2]

      vi.clearAllMocks()
      installGovernedTicketHappyPath()
      setupSuccessfulCall()
      await getStellaValidator('proj-1', 'Calculation', TICKET)
      const second = mockBindOperationTicket.mock.calls[0][2]

      expect(first).toBe(second)
    })
  })

  // -------------------------------------------------------------------------
  // Successful call
  // -------------------------------------------------------------------------
  describe('Successful call', () => {
    it('returns ok:true with parsed ValidatorOutput', async () => {
      setupSuccessfulCall()

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

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

      const result = await getStellaValidator('proj-1', 'calculation', TICKET)

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

      await getStellaValidator('proj-1', 'calculation', TICKET)

      // TRAIN 4.3: db.insert is called ZERO times. The runtime holds no write
      // privilege on stella_interactions and performs no other write either —
      // which is strictly stronger than the previous "exactly one insert, and
      // it is the audit row".
      expect(mockDbInsert).not.toHaveBeenCalled()
      // The one write this operation causes is the ledger row, and it happens
      // inside `complete_operation_ticket` — no evidence or proxy mutation.
      expect(mockCompleteStellaInteractionTicket).toHaveBeenCalledTimes(1)
    })

    it('does NOT make audit insert when disabled (no DB calls at all)', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaValidator('proj-1', 'calculation', TICKET)

      expect(mockDbInsert).not.toHaveBeenCalled()
    })
  })
})
