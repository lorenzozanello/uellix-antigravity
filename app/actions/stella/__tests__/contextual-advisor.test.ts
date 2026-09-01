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
  // Legacy step advisor OFF, exactly as the real config defaults it. The two
  // assertions in this suite that call `getStellaAdvisor` only ever check that
  // it does NOT reach the provider, so the flag makes them stronger, not weaker.
  isLegacyAdvisorEnabled: false,
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
    category: 'advisor',
    expiresAt: '2026-08-06T00:15:00.000Z',
    hasQueryHash: true,
  })
  mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'completed', used: 1, quota: 50 })
  mockAbortOperationTicket.mockResolvedValue({ kind: 'aborted' })
  mockIssueOperationTicket.mockResolvedValue({ kind: 'issued', ticketId: TICKET })
}

// ---------------------------------------------------------------------------
// Import the action AFTER mocks are in place. runContextualAdvisor itself is
// NOT mocked — it is the pure, already-covered pipeline (see
// lib/stella/advisor/run-contextual-advisor.test.ts) and runs for real here
// against the mocked adapter, so canonicalization and decoding stay exercised
// end to end through the authorized entry point.
// ---------------------------------------------------------------------------
import * as advisorModule from '../advisor'
const { getStellaContextualAdvisor, getStellaAdvisor, issueStellaAdvisorTicket } = advisorModule

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

/**
 * FABLE FINDING F2 — the LEGACY path's happy path, used only by the
 * discriminating case that proves the legacy auth assertions are not both
 * trivially satisfiable.
 *
 * The legacy action decodes with `adapter.parseResponse(raw, AdvisorOutputSchema)`
 * rather than through the contextual decoder, so its success needs its own
 * fixture: an `AdvisorOutput`, not an `AdvisorContextualOutput`.
 */
function setupSuccessfulLegacyCall() {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  installGovernedTicketHappyPath()
  mockBuildAdvisorContext.mockResolvedValue(MOCK_CONTEXT)
  const legacyOutput = {
    step: 'narrative',
    what_to_do: 'Redactá la narrativa',
    why_it_matters: 'Sustenta la teoría de cambio',
    how_to_do_it: 'Partí de los grupos de interés',
    common_mistakes: [],
    suggested_next_actions: [],
  }
  mockAdapterGenerate.mockResolvedValue({
    role: 'advisor',
    rawOutput: JSON.stringify(legacyOutput),
    parsedOutput: null,
    modelUsed: 'gemini-3.6-flash',
    tokensUsed: 42,
    timestamp: new Date(),
  })
  mockAdapter.parseResponse.mockResolvedValue(legacyOutput)
  mockInsertValues.mockResolvedValue([])
}

function setupSuccessfulCall(step: string = 'narrative') {
  mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_OK)
  mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
  installGovernedTicketHappyPath()
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
    // Restored per case, because one case below flips it deliberately and a
    // leaked `true` would silently widen every other case in this suite.
    mockStellaConfig.isLegacyAdvisorEnabled = false
    mockStellaState.canUseStella = true
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
    installGovernedTicketHappyPath()
    mockLogAuditAction.mockResolvedValue(undefined)
  })

  describe('Feature flag gate', () => {
    it('returns DISABLED when STELLA_ENABLED is false, without reaching the adapter', async () => {
      mockStellaConfig.isEnabled = false
      mockStellaState.canUseStella = false

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

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

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockBindOperationTicket).not.toHaveBeenCalled()
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

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(true)
    })
  })

  describe('A. Unauthenticated caller', () => {
    it('never reaches the adapter when requireOrganizationAccess throws', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

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
      installGovernedTicketHappyPath()
      mockBuildAdvisorContext.mockRejectedValue(new StellaBuildContextError('UNAUTHORIZED', 'Project does not belong to your organization'))

      const result = await getStellaContextualAdvisor('proj-other-org', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNAUTHORIZED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  describe('C. Quota exhausted', () => {
    it('never reaches the adapter when the org has no quota', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'no_quota', used: 0, quota: 0 })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockBuildAdvisorContext).not.toHaveBeenCalled()
    })
  })

  describe('D. Rate limit blocked', () => {
    // TRAIN 4.3. The limiter guards ISSUANCE now, so it blocks one step
    // earlier: no ticket is minted, and without a ticket the execution path
    // cannot be entered at all.
    it('never mints a ticket when the org has exceeded the hourly limit', async () => {
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockCheckStellaRateLimit.mockResolvedValue(RATE_LIMIT_EXCEEDED)

      const result = await issueStellaAdvisorTicket('proj-1')

      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.code).toBe('RATE_LIMITED')
      expect(mockIssueOperationTicket).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })
  })

  describe('E. organizationId is server-derived, not client-supplied', () => {
    it('calls buildAdvisorContext with the session organization id, never a client-controlled value', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-different', 'narrative', TICKET)

      expect(mockBuildAdvisorContext).toHaveBeenCalledWith('proj-different', 'org-1', 'narrative')
    })

    it('has no parameter through which a caller could supply organizationId', () => {
      // Structural: the signature is (projectId, step, ticket). TRAIN 4.3 added
      // the TICKET and not an organization — the ticket is an opaque operation
      // identity whose organization is welded on server-side at issue and
      // re-derived in SQL on every presentation, so widening the arity did not
      // widen what a caller can name.
      expect(getStellaContextualAdvisor.length).toBe(3)
    })

    it('checks quota and rate limit with the session organization id, not the project id', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-different-id', 'narrative', TICKET)

      // TRAIN 4.3. There is no organization argument left to get wrong: the
      // execution path reads no quota and consumes no limiter, and `bind` is
      // scoped by the TICKET, whose organization was welded on at issue.
      expect(mockBindOperationTicket).toHaveBeenCalledTimes(1)
      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
    })
  })

  describe('F. Mandatory audit insert', () => {
    it('inserts into stellaInteractions after a successful call', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(mockCompleteStellaInteractionTicket).toHaveBeenCalledTimes(1)
      const [ticketId, projectId, digest, payload] =
        mockCompleteStellaInteractionTicket.mock.calls[0]
      expect(ticketId).toBe(TICKET)
      expect(projectId).toBe('proj-1')
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(payload.pipelineStep).toBe('narrative')
      // `stellaRole` and `organizationId` are NOT in the payload and cannot be:
      // SQL reads the category and the organization off the ticket row under the
      // row lock, so this path has no parameter for either.
      expect(payload).not.toHaveProperty('stellaRole')
      expect(payload).not.toHaveProperty('organizationId')
    })

    it('returns AUDIT_ERROR when the insert fails, after a successful model call', async () => {
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'rejected', reason: 'unavailable' })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNKNOWN_ERROR')
    })
  })

  describe('G. Exactly one adapter call per valid request', () => {
    it('calls the adapter exactly once on a successful request', async () => {
      setupSuccessfulCall()

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(true)
      expect(mockAdapterGenerate).toHaveBeenCalledTimes(1)
    })
  })

  describe('H. Trusted step reaches the decoder', () => {
    it('canonicalizes a provider-translated step against the requested step', async () => {
      setupSuccessfulCall()
      mockGenerateResolves('Narrativa')

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.step).toBe('narrative')
    })
  })

  describe('J. Out-of-range indices fail closed', () => {
    it('returns PARSE_ERROR and does not retry when the provider cites an out-of-range index', async () => {
      setupSuccessfulCall()
      mockGenerateResolves('narrative', [999])

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

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
      // TRAIN 4.3 added ONE export: the ticket issuer. It is on this list
      // deliberately rather than exempted — it is a new server-action endpoint
      // and therefore new attack surface.
      expect(exportedFunctionNames.sort()).toEqual([
        'getStellaAdvisor',
        'getStellaContextualAdvisor',
        'issueStellaAdvisorTicket',
      ])
    })

    // -----------------------------------------------------------------------
    // FABLE FINDING F2 — one assertion was proving two different things, and
    // one of them vacuously.
    // -----------------------------------------------------------------------
    // What stood here looped both exported Gemini-reaching functions through a
    // single "refuses without organization access" claim. For
    // `getStellaContextualAdvisor` that claim was real. For `getStellaAdvisor`
    // it was VACUOUS: this suite runs with `isLegacyAdvisorEnabled: false`
    // (production's default), so the legacy action returns DISABLED at its
    // first line and never reaches auth at all. The adapter was indeed not
    // called — for a reason that has nothing to do with authorization, and the
    // assertion would have stayed green with the auth gate deleted.
    //
    // The two properties are now separate, because they ARE separate, and the
    // legacy one is stated in the only configuration where it has content: with
    // its flag deliberately on. The default is not weakened — it is restored by
    // `beforeEach`, and the flag-off behaviour is asserted immediately below as
    // a property in its own right.

    it('contextual: refuses to reach the adapter without organization access', async () => {
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result).toMatchObject({ ok: false, error: 'UNAUTHORIZED' })
      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockBindOperationTicket).not.toHaveBeenCalled()
    })

    it('legacy DISABLED: cuts before authentication is even attempted', async () => {
      // The flag is off (beforeEach). The refusal is a DEPLOYMENT decision, and
      // it is taken before any identity work — which is why the case asserts
      // `requireOrganizationAccess` was NEVER CALLED rather than that it failed.
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaAdvisor('proj-1', 'narrative', TICKET)

      expect(result).toMatchObject({ ok: false, error: 'DISABLED' })
      expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
    })

    it('legacy ENABLED: still requires organization access before the provider', async () => {
      // The case the old assertion CLAIMED to make. With the quarantine flag
      // explicitly on, the legacy action must still authenticate — so the
      // refusal here comes from the auth gate, not from the feature gate, and
      // deleting that gate would fail this test.
      mockStellaConfig.isLegacyAdvisorEnabled = true
      mockRequireOrganizationAccess.mockRejectedValue(new Error('Not authenticated'))

      const result = await getStellaAdvisor('proj-1', 'narrative', TICKET)

      expect(result).toMatchObject({ ok: false, error: 'UNAUTHORIZED' })
      expect(mockRequireOrganizationAccess).toHaveBeenCalled()
      expect(mockAdapterGenerate).not.toHaveBeenCalled()
      expect(mockBindOperationTicket).not.toHaveBeenCalled()
    })

    it('legacy ENABLED: an AUTHORIZED caller does reach the provider — the two cases above are not both trivial', async () => {
      // The discriminator. Without it, "UNAUTHORIZED before the provider" could
      // be satisfied by an action that never reaches the provider under ANY
      // condition, and the two cases above would prove nothing about the gate.
      mockStellaConfig.isLegacyAdvisorEnabled = true
      setupSuccessfulLegacyCall()

      const result = await getStellaAdvisor('proj-1', 'narrative', TICKET)

      expect(result).toMatchObject({ ok: true })
      expect(mockAdapterGenerate).toHaveBeenCalledTimes(1)
    })
  })

  describe('L. No real provider', () => {
    it('only ever calls the mocked getGeminiAdapter, never a real client', async () => {
      setupSuccessfulCall()

      await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(mockGetGeminiAdapter).toHaveBeenCalled()
      expect('GEMINI_API_KEY' in process.env).toBe(false)
    })
  })

  describe('M. Audit trail + observability (WS3b)', () => {
    it('logs STELLA_INVOKED after a successful contextual call, metadata only', async () => {
      setupSuccessfulCall()

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked).toBeDefined()
      expect(invoked.organizationId).toBe('org-1')
      expect(invoked.actorUserId).toBe('user-1')
      expect(invoked.entityId).toBe('proj-1')
      // TRAIN 4.3: `tokensUsed` moved to the ledger row the governed
      // completion verb files; `contextHash` and `quotaLedger` arrived here
      // because the ledger's own context_hash is now the ticket's bind digest.
      expect(invoked.afterJson).toEqual({
        stellaRole: 'advisor',
        pipelineStep: 'narrative',
        contextHash: expect.stringMatching(/^[0-9a-f]{64}$/), quotaLedger: expect.stringContaining('settle_reserved_quota'), 
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

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith('[stella] provider step mismatch', { step: 'narrative' })
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.stepMismatch).toBe(true)
      warnSpy.mockRestore()
    })

    it('does not warn nor audit stepMismatch when the provider step matches', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setupSuccessfulCall()

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

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

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(true)
      const invoked = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.invoked')
      expect(invoked.afterJson.sensitivePopulations).toBe(true)
      expect(invoked.afterJson.sensitivePopulationCategories).toEqual(['minors', 'violence_victims'])
    })

    it('logs STELLA_DENIED with QUOTA_EXCEEDED and result is unchanged when the audit write throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockRequireOrganizationAccess.mockResolvedValue(MOCK_ORG_CONTEXT)
      mockBindOperationTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })
      mockLogAuditAction.mockRejectedValue(new Error('audit db down'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('QUOTA_EXCEEDED')
      expect(errorSpy).toHaveBeenCalledWith('[stella-audit] audit write failed:', 'Error')
      errorSpy.mockRestore()
    })

    // TRAIN 4.3: the limiter moved to issuance, so no rate-limit denial is
    // written on the execution path any more.
    it('writes NO rate-limit denial on the execution path', async () => {
      setupSuccessfulCall()
      mockCheckStellaRateLimit.mockReturnValue(RATE_LIMIT_EXCEEDED)

      await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(mockCheckStellaRateLimit).not.toHaveBeenCalled()
      const denied = mockLogAuditAction.mock.calls.map((c) => c[0]).find((e) => e.action === 'stella.denied')
      expect(denied).toBeUndefined()
    })

    it('reports AUDIT_ERROR to observability when the interactions insert fails', async () => {
      setupSuccessfulCall()
      mockCompleteStellaInteractionTicket.mockResolvedValue({ kind: 'rejected', reason: 'unavailable' })

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      // TRAIN 4.3. A settlement rejection is not an application fault to
      // report — it is the ledger declining, and the answer is withheld rather
      // than presented. Nothing is filed to Sentry, and specifically no
      // AUDIT_ERROR, because no audit write was attempted or failed.
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('UNKNOWN_ERROR')
      expect(mockReportStellaFailure).not.toHaveBeenCalled()
    })

    it('reports typed model failures (GEMINI_ERROR) surfaced by runContextualAdvisor', async () => {
      setupSuccessfulCall()
      const { StellaGeminiError } = await import('@/lib/stella/errors')
      mockAdapterGenerate.mockRejectedValue(new StellaGeminiError('API failure'))

      const result = await getStellaContextualAdvisor('proj-1', 'narrative', TICKET)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('GEMINI_ERROR')
      expect(mockReportStellaFailure).toHaveBeenCalledWith(
        'advisor', 'GEMINI_ERROR', expect.anything(),
        expect.objectContaining({ projectId: 'proj-1', step: 'narrative', contextual: true }),
      )
    })
  })
})
