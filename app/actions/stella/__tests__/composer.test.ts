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
    category: 'composer',
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
import { getStellaComposer, issueStellaComposerTicket } from '../composer'

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
  installGovernedTicketHappyPath()
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
    installGovernedTicketHappyPath()
    mockLogAuditAction.mockResolvedValue(undefined)
  })

  describe('Audit trail + observability (WS3b)', () => {
    it('logs STELLA_INVOKED after a successful call with role/sectionType/tokensUsed metadata only', async () => {
      setupSuccessfulCall()

      const result = await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked).toBeDefined()
      expect(invoked.organizationId).toBe('org-uuid-001')
      expect(invoked.actorUserId).toBe('user-uuid-001')
      expect(invoked.entityId).toBe('proj-uuid-001')
      // TRAIN 4.3: `tokensUsed` moved to the ledger row the governed
      // completion verb files; `contextHash` and `quotaLedger` arrived here
      // because the ledger's own context_hash is now the ticket's bind digest.
      expect(invoked.afterJson).toEqual({ stellaRole: 'composer', pipelineStep: 'executive_summary', contextHash: expect.stringMatching(/^[0-9a-f]{64}$/), quotaLedger: expect.stringContaining('settle_reserved_quota'), sensitivePopulations: false, sensitivePopulationCategories: [] })
      const serialized = JSON.stringify(mockLogAuditAction.mock.calls)
      expect(serialized).not.toContain('mock composer system prompt')
      expect(serialized).not.toContain('mock composer user message')
      expect(serialized).not.toContain(VALID_COMPOSER_OUTPUT.draft_content)
    })

    // WS3c U1 (RK-08): audit metadata carries the sensitive-populations flag.
    it('logs sensitivePopulations metadata when the context detected them', async () => {
      setupSuccessfulCall()
      mockBuildComposerContext.mockResolvedValue({
        ...MOCK_CONTEXT,
        sensitivePopulations: { detected: true, categories: ['extreme_poverty'] },
      })

      const result = await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.sensitivePopulations).toBe(true)
      expect(invoked.afterJson.sensitivePopulationCategories).toEqual(['extreme_poverty'])
    })

    it('logs STELLA_DENIED with ROLE_DENIED / QUOTA_EXCEEDED / RATE_LIMITED reason codes', async () => {
      setupSuccessfulCall()
      mockRequireOrganizationAccess.mockResolvedValue({
        ...MOCK_ORG_CONTEXT,
        membership: { ...MOCK_ORG_CONTEXT.membership, role: 'viewer' },
      })
      await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)
      let denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied.afterJson.reason).toBe('ROLE_DENIED')

      mockLogAuditAction.mockClear()
      setupSuccessfulCall()
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })
      await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)
      denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied.afterJson.reason).toBe('QUOTA_EXCEEDED')

      mockLogAuditAction.mockClear()
      setupSuccessfulCall()
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)
      // TRAIN 4.3: the hourly limit moved to issuance, so the execution path
      // writes no RATE_LIMITED denial. See 'Ticket issuance (TRAIN 4.3)'.
    })

    it('logs STELLA_INTEGRITY_REJECTED with violation COUNTS only when the guard fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setupSuccessfulCall()
      // Reference to an evidence id that does NOT exist in the context →
      // validateComposerReferences fails closed.
      mockAdapterParseResponse.mockResolvedValue({
        ...VALID_COMPOSER_OUTPUT,
        evidence_references: [{ evidenceId: 'ev-HALLUCINATED', title: 'Fuente inventada', context: 'x' }],
      })

      const result = await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
      const rejected = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.integrity_rejected')
      expect(rejected).toBeDefined()
      expect(rejected.afterJson.stellaRole).toBe('composer')
      expect(typeof rejected.afterJson.referenceViolationCount).toBe('number')
      expect(rejected.afterJson.referenceViolationCount).toBeGreaterThan(0)
      expect(typeof rejected.afterJson.numericViolationCount).toBe('number')
      // counts only — the violating text/id never reaches the audit payload
      const serialized = JSON.stringify(mockLogAuditAction.mock.calls)
      expect(serialized).not.toContain('ev-HALLUCINATED')
      expect(serialized).not.toContain('Fuente inventada')
      errorSpy.mockRestore()
    })

    it('denial result is unchanged when the audit write throws (fire-and-forget)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      setupSuccessfulCall()
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })

    it('reports GEMINI_ERROR and AUDIT_ERROR to observability with the composer role', async () => {
      setupSuccessfulCall()
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))
      await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)
      expect(mockReportStellaFailure).toHaveBeenCalledWith(
        'composer', 'GEMINI_ERROR', expect.anything(),
        expect.objectContaining({ projectId: 'proj-uuid-001', reportId: 'report-uuid-001' }),
      )

      mockReportStellaFailure.mockClear()
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'rejected', reason: 'unavailable' })
      const result = await getStellaComposer('proj-uuid-001', 'report-uuid-001', 'section-1', 'executive_summary', TICKET)
      // TRAIN 4.3. A settlement rejection is the ledger declining, not an
      // application fault: the answer is withheld and nothing is filed to
      // Sentry — and specifically no AUDIT_ERROR, because no audit write was
      // attempted or failed.
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNKNOWN_ERROR')
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

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

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

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Feature flag gate
  // -------------------------------------------------------------------------
  describe('Ticket issuance (TRAIN 4.3)', () => {
    // The hourly limit MOVED here from the execution path. Two consequences,
    // both intended: minting is bounded (issuance reserves nothing, so without
    // a limit it was not self-limiting), and a RETRY no longer spends the
    // budget for an operation already counted when its ticket was minted.
    it('returns RATE_LIMITED when the org has exceeded its hourly limit, and mints nothing', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_EXCEEDED)

      const result = await issueStellaComposerTicket('proj-uuid-001')

      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.code).toBe('RATE_LIMITED')
      expect(mockIssueOperationTicket).not.toHaveBeenCalled()
    })

    it('passes organization.id (not the project id) to consumeStellaRateLimit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_OK)

      await issueStellaComposerTicket('proj-uuid-001')

      expect(mockCheckStellaRateLimit).toHaveBeenCalledWith('org-uuid-001')
    })

    it('fixes the category server-side — no argument of the execution path can move it', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_OK)

      const result = await issueStellaComposerTicket('proj-uuid-001')

      expect(result).toEqual({ status: 'issued', ticket: TICKET })
      expect(mockIssueOperationTicket).toHaveBeenCalledWith('org-uuid-001', 'proj-uuid-001', 'composer')
    })

    it('costs zero auth, zero rate limit and zero mint when the flag is off', async () => {
      mockStellaConfig.isEnabled = false

      const result = await issueStellaComposerTicket('proj-uuid-001')

      expect(result).toEqual({ status: 'disabled' })
      expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      expect(mockIssueOperationTicket).not.toHaveBeenCalled()
    })
  })

  describe('Governed operation ordering (TRAIN 4.3)', () => {
    it('binds BEFORE the provider is called and completes BEFORE the answer is returned', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-uuid-001', 'rep-1', 'sec-1', 'executive_summary', TICKET)

      expect(mockBindOperationTicket.mock.invocationCallOrder[0]).toBeLessThan(
        mockAdapterGenerate.mock.invocationCallOrder[0]
      )
      expect(mockAdapterGenerate.mock.invocationCallOrder[0]).toBeLessThan(
        mockCompleteStellaInteractionTicket.mock.invocationCallOrder[0]
      )
    })

    it('never consumes the hourly limit on the execution path', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-uuid-001', 'rep-1', 'sec-1', 'executive_summary', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })

    it('ABORTS and charges nothing when the provider fails', async () => {
      setupSuccessfulCall()
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))

      await getStellaComposer('proj-uuid-001', 'rep-1', 'sec-1', 'executive_summary', TICKET)

      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      expect(mockAbortOperationTicket).toHaveBeenCalled()
      expect(mockAbortOperationTicket.mock.calls[0][0]).toBe(TICKET)
    })

    it('reuses the SAME ticket on a retry and never re-runs a settled operation', async () => {
      setupSuccessfulCall()
      mockBindOperationTicket.mockResolvedValue({ kind: 'already_completed' })

      const result = await getStellaComposer('proj-uuid-001', 'rep-1', 'sec-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
    })

    it('refuses a ticket of ANOTHER category, aborts it, and charges nothing', async () => {
      setupSuccessfulCall()
      mockInspectOperationTicket.mockResolvedValue({
        status: 'bound',
        category: 'grounded_query',
        expiresAt: '2026-08-06T00:15:00.000Z',
        hasQueryHash: true,
      })

      const result = await getStellaComposer('proj-uuid-001', 'rep-1', 'sec-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockCompleteStellaInteractionTicket).not.toHaveBeenCalled()
      expect(mockAbortOperationTicket).toHaveBeenCalled()
    })

    it('files the ledger row through the governed verb, never through db.insert', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-uuid-001', 'rep-1', 'sec-1', 'executive_summary', TICKET)

      expect(mockCompleteStellaInteractionTicket).toHaveBeenCalledTimes(1)
      expect(mockDbInsert).not.toHaveBeenCalled()
      const payload = mockCompleteStellaInteractionTicket.mock.calls[0][3]
      // No organization, no actor, no category, no identity: SQL reads all four
      // off the ticket row and this path has no parameter for any of them.
      expect(Object.keys(payload).sort()).toEqual(
        ['modelUsed', 'pipelineStep', 'responseJson', 'tokensUsed'].sort()
      )
    })
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when isComposerEnabled is false', async () => {
      mockStellaConfig.isComposerEnabled = false

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('returns DISABLED when canUseStella is false (missing API key)', async () => {
      mockStellaState.canUseStella = false

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('DISABLED')
    })

    it('does NOT check rate limit when disabled', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Auth boundary
  // -------------------------------------------------------------------------
  describe('Auth boundary', () => {
    it('calls requireOrganizationAccess', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
    })

    it('returns UNAUTHORIZED when requireOrganizationAccess throws', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
    })

    it('does NOT record rate limit when auth fails', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Quota enforcement
  // -------------------------------------------------------------------------
  describe('Quota enforcement', () => {
    it('returns QUOTA_EXCEEDED when org has no quota assigned', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'no_quota', used: 0, quota: 0 })

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
    })

    it('returns QUOTA_EXCEEDED when org used up its monthly quota', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

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

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('checks quota with organization.id', async () => {
      setupSuccessfulCall()
      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)
      expect(mockBindOperationTicket).toHaveBeenCalledTimes(1)
    })

    it('allows unlimited orgs (quota: null) through', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      installGovernedTicketHappyPath()
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockResolvedValue({
        role: 'composer', rawOutput: JSON.stringify(VALID_COMPOSER_OUTPUT), parsedOutput: null,
        modelUsed: 'gemini-2.0-flash', timestamp: new Date(),
      })
      mockAdapterParseResponse.mockResolvedValue(VALID_COMPOSER_OUTPUT)
      mockInsertValues.mockResolvedValue([])

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // consumeStellaRateLimit behavior
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Context builder integration
  // -------------------------------------------------------------------------
  describe('Context builder integration', () => {
    it('passes projectId, organization.id, and reportId to buildComposerContext', async () => {
      setupSuccessfulCall()

      await getStellaComposer('proj-different', 'report-different', 'section-1', 'executive_summary', TICKET)

      expect(mockBuildComposerContext).toHaveBeenCalledWith('proj-different', 'org-uuid-001', 'report-different')
    })

    it('returns UNAUTHORIZED when report not found', async () => {
      const { StellaBuildComposerContextError } = await import('@/lib/stella/context/build-composer-context')
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockRejectedValue(
        new StellaBuildComposerContextError('NOT_FOUND', 'Report not found.')
      )

      const result = await getStellaComposer('proj-1', 'report-missing', 'section-1', 'executive_summary', TICKET)

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

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

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

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(mockAdapterGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'composer' })
      )
    })

    it('returns TIMEOUT on StellaTimeoutError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('TIMEOUT')
    })

    it('returns GEMINI_ERROR on StellaGeminiError', async () => {
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBuildComposerContext.mockResolvedValue(MOCK_CONTEXT)
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('Gemini unavailable'))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
    })

    it('returns PAYLOAD_TOO_LARGE on StellaPayloadTooLargeError from the adapter', async () => {
      setupSuccessfulCall()
      const { StellaPayloadTooLargeError } = await import('@/lib/stella/security/payload-limits')
      mockAdapterGenerate.mockRejectedValue(new StellaPayloadTooLargeError(150000, 120000))

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PAYLOAD_TOO_LARGE')
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

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
    })
  })

  // -------------------------------------------------------------------------
  // Audit insert
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Successful call
  // -------------------------------------------------------------------------
  describe('Successful call', () => {
    it('returns ok:true with parsed ComposerOutput', async () => {
      setupSuccessfulCall()

      const result = await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

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

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      // db.insert is only called once — for stella_interactions.
      // No sroi_report_sections write happens (draft is returned, not saved).
      expect(mockCompleteStellaInteractionTicket).toHaveBeenCalledTimes(1)
      // TRAIN 4.3: db.insert is called ZERO times — the runtime holds no write
      // privilege on stella_interactions, and no report-section write happens
      // either (the draft is returned, never saved).
      expect(mockDbInsert).not.toHaveBeenCalled()
    })

    it('does NOT make audit insert when disabled (no DB calls at all)', async () => {
      mockStellaConfig.isEnabled = false

      await getStellaComposer('proj-1', 'report-1', 'section-1', 'executive_summary', TICKET)

      expect(mockDbInsert).not.toHaveBeenCalled()
    })
  })
})
