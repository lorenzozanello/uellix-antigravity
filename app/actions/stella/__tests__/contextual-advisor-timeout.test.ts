// app/actions/stella/__tests__/contextual-advisor-timeout.test.ts
//
// G1-B PRECONDITIONS — P1: WHAT A TIMEOUT ACTUALLY COSTS.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS AND WHY IT CHANGES NO TIMEOUT
// ---------------------------------------------------------------------------
// `stellaConfig.requestTimeoutMs` is 15000. G1-A measured ONE instrumented live
// call at 11,970 ms — 80% of the budget, on a single sample, on a model whose
// default thinking level is `medium`. That is enough to make the timeout a
// question and NOT enough to answer it, so the number is deliberately
// untouched here. What this suite establishes is the thing a number cannot: the
// PRICE of hitting it.
//
// The audit question G1-B needs answered before it can decide KEEP_15S vs
// CHANGE_TIMEOUT is not "is 15s enough?" — it is "if 15s is not enough, what
// does the organization pay?". A timeout that charges a quota unit, or leaves a
// half-settled ticket, is an expensive question to leave open; one that charges
// nothing is a cheap one.
//
// ---------------------------------------------------------------------------
// WHAT IS PINNED HERE
// ---------------------------------------------------------------------------
//   1. The abort surfaces as `StellaTimeoutError`, and the timer wraps the
//      WHOLE provider round trip — including the dynamic `@google/genai`
//      import, which happens after the timer is armed.
//   2. Through the governed protocol a timeout ABORTS the ticket with
//      `no_result` and NEVER completes it: nothing is charged, no ledger row is
//      filed, no audit event is written, and the reservation is released before
//      the action returns.
//   3. The user-facing code is `TIMEOUT`, and it is reported to observability
//      (a timeout that nobody can see is indistinguishable from a slow user).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'
import { StellaTimeoutError } from '@/lib/stella/errors'

const mockStellaConfig = {
  isEnabled: true,
  isAdvisorEnabled: true,
  isLegacyAdvisorEnabled: false,
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-3.6-flash',
  requestTimeoutMs: 15000,
  maxOutputTokens: 4096,
  maxPromptChars: 120000,
  rateLimitPerHour: 100,
}
vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() { return mockStellaConfig },
  get stellaState() { return { canUseStella: true, missingApiKey: false } },
  STELLA_DEFAULT_GEMINI_MODEL: 'gemini-3.6-flash',
}))

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...a: unknown[]) => mockRequireOrganizationAccess(...a),
  runWithOrganizationAccess: async (cb: (c: unknown) => unknown) => cb(await mockRequireOrganizationAccess()),
}))
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: (c: unknown) => unknown) => cb(await mockRequireOrganizationAccess()),
}))

const mockBuildAdvisorContext = vi.fn()
vi.mock('@/lib/stella/context/build-advisor-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/stella/context/build-advisor-context')>()
  return { ...original, buildAdvisorContext: (...a: unknown[]) => mockBuildAdvisorContext(...a) }
})

const mockAdapterGenerate = vi.fn()
// The factory captures its ARGUMENTS, which is what the last case asserts on:
// the action must build its adapter with no configuration override, so the
// budget it runs under is the one `stellaConfig` publishes.
const mockGetGeminiAdapter = vi.fn(() => ({
  generate: (...a: unknown[]) => mockAdapterGenerate(...a),
  parseResponse: vi.fn(),
  isReady: () => true,
}))
vi.mock('@/lib/stella/adapter/gemini-client', () => ({
  getGeminiAdapter: (...a: unknown[]) => mockGetGeminiAdapter(...(a as [])),
}))

vi.mock('@/lib/stella/rate-limit', () => ({
  consumeStellaRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, reason: 'allowed' }),
}))
vi.mock('@/lib/stella/quota', () => ({
  nextQuotaResetIso: () => '2026-09-01T00:00:00.000Z',
  formatQuotaResetDate: () => '1 de septiembre de 2026',
}))
vi.mock('@/db/client', () => ({ db: { insert: vi.fn(), select: vi.fn() } }))

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...original, logAuditAction: (...a: unknown[]) => mockLogAuditAction(...a) }
})

const mockReportStellaFailure = vi.fn()
vi.mock('@/lib/stella/observability', () => ({
  reportStellaFailure: (...a: unknown[]) => mockReportStellaFailure(...a),
}))

const mockBind = vi.fn()
const mockComplete = vi.fn()
const mockAbort = vi.fn()
const mockInspect = vi.fn()
vi.mock('@/db/stella/operation-tickets', () => ({
  bindOperationTicket: (...a: unknown[]) => mockBind(...a),
  completeStellaInteractionTicket: (...a: unknown[]) => mockComplete(...a),
  abortOperationTicket: (...a: unknown[]) => mockAbort(...a),
  inspectOperationTicket: (...a: unknown[]) => mockInspect(...a),
  issueOperationTicket: vi.fn(),
}))

import { getStellaContextualAdvisor } from '../advisor'

const TICKET = 'b'.repeat(64)
const PROJECT = '9d8c0412-2782-4d2e-a1df-e2dfa1e0b3aa'

const CTX = {
  user: { id: 'user-1' },
  organization: { id: 'org-1' },
  membership: { role: 'analyst' },
} as unknown as OrganizationContext

function minimalContext() {
  return {
    projectId: PROJECT,
    organizationId: 'org-1',
    projectName: 'Proyecto',
    narrativeSummary: 'Resumen',
    outcomesSnapshot: [],
    indicatorsSnapshot: [],
    stakeholderCount: 0,
    stakeholdersSnapshot: [],
    activitiesSummary: [],
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    reportSections: [],
    projectCreatedAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-06-01T00:00:00.000Z',
  }
}

describe('a provider timeout on the governed contextual path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireOrganizationAccess.mockResolvedValue(CTX)
    mockBuildAdvisorContext.mockResolvedValue(minimalContext())
    mockBind.mockResolvedValue({ kind: 'bound', used: 0, quota: 50 })
    mockInspect.mockResolvedValue({
      status: 'bound', category: 'advisor', expiresAt: '2026-08-17T00:15:00.000Z', hasQueryHash: true,
    })
    mockAbort.mockResolvedValue({ kind: 'aborted' })
    mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())
  })

  it('returns TIMEOUT to the caller', async () => {
    const result = await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    expect(result).toEqual({ ok: false, error: 'TIMEOUT', message: expect.any(String) })
  })

  it('CHARGES NOTHING — the ticket is never completed', async () => {
    await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('releases the reservation before returning, as no_result', async () => {
    await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    expect(mockAbort).toHaveBeenCalledTimes(1)
    // `no_result`, not `execution_failed`: the pipeline RAN and returned a typed
    // refusal. Both charge zero; the distinction is what an operator reading
    // `operation_tickets` uses to tell a broken run from a slow one.
    expect(mockAbort).toHaveBeenCalledWith(TICKET, PROJECT, 'no_result')
  })

  it('files NO ledger row and NO audit event', async () => {
    await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    expect(mockComplete).not.toHaveBeenCalled()
    expect(mockLogAuditAction).not.toHaveBeenCalled()
  })

  it('reports the timeout to observability with codes only', async () => {
    await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    expect(mockReportStellaFailure).toHaveBeenCalledWith(
      'advisor',
      'TIMEOUT',
      expect.any(Error),
      expect.objectContaining({ projectId: PROJECT, step: 'narrative', contextual: true }),
    )
  })

  it('leaves the ticket reusable — a retry is the SAME operation, not a second charge', async () => {
    await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    mockAdapterGenerate.mockResolvedValue({
      role: 'advisor',
      rawOutput: JSON.stringify({
        step: 'narrative', responseType: 'review', summary: 'ok',
        findings: [], suggestions: [], clarifyingQuestions: [], limitations: [],
        requiresHumanReview: true,
      }),
      parsedOutput: null,
      modelUsed: 'gemini-3.6-flash',
      tokensUsed: 10,
      timestamp: new Date(),
    })
    mockComplete.mockResolvedValue({ kind: 'completed', used: 1, quota: 50 })

    const retry = await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)
    expect(retry).toMatchObject({ ok: true })
    // ONE completion across both attempts. The first cost nothing.
    expect(mockComplete).toHaveBeenCalledTimes(1)
  })
})

describe('the adapter timeout budget covers the WHOLE provider round trip', () => {
  it('arms the abort timer before the dynamic @google/genai import', async () => {
    // Source-level, because the property is about ORDER inside one function and
    // there is no seam to observe it from: the timer must be armed before the
    // dynamic import, or a slow cold-start module load would sit OUTSIDE the
    // budget and a "15s timeout" would mean 15s plus however long the import
    // took. Read the two positions and compare them.
    const { readFileSync } = await import('node:fs')
    const path = (await import('node:path')).default
    const source = readFileSync(
      path.join(process.cwd(), 'lib/stella/adapter/gemini-client.ts'),
      'utf8'
    )
    const body = source.slice(source.indexOf('private async generateWithTimeout'))
    const armedAt = body.indexOf('setTimeout(() => controller.abort(), timeoutMs)')
    const importAt = body.indexOf("await import('@google/genai')")
    const callAt = body.indexOf('ai.models.generateContent')
    expect(armedAt).toBeGreaterThanOrEqual(0)
    expect(importAt).toBeGreaterThan(armedAt)
    expect(callAt).toBeGreaterThan(importAt)
    // And the signal actually reaches the request.
    expect(body).toContain('abortSignal: controller.signal')
  })

  it('maps both AbortError shapes to StellaTimeoutError', async () => {
    const source = (await import('node:fs')).readFileSync(
      (await import('node:path')).default.join(process.cwd(), 'lib/stella/adapter/gemini-client.ts'),
      'utf8'
    )
    // A DOMException and a plain Error named AbortError are both real: the
    // undici/Node fetch stack has produced each of them across versions, and a
    // branch that only knows one turns a timeout into GEMINI_ERROR.
    expect(source).toContain("error instanceof DOMException && error.name === 'AbortError'")
    expect(source).toContain("error instanceof Error && error.name === 'AbortError'")
  })

  it('the action does not shadow the configured budget with one of its own', async () => {
    // FABLE FINDING F1. What stood here was
    // `expect(mockStellaConfig.requestTimeoutMs).toBe(15000)` — a literal
    // compared against a constant this same file declared, which stays green
    // however the adapter behaves.
    //
    // The property worth pinning at THIS layer is narrow and real: the action
    // must obtain its adapter through `getGeminiAdapter()` with NO argument, so
    // the budget in force is `stellaConfig.requestTimeoutMs` and not a value
    // the call site injected. That the adapter then HONOURS that budget is
    // measured behaviourally, against the real config and with no mocked
    // config module, in lib/stella/adapter/gemini-client.test.ts.
    mockAdapterGenerate.mockRejectedValue(new StellaTimeoutError())
    await getStellaContextualAdvisor(PROJECT, 'narrative', TICKET)

    expect(mockGetGeminiAdapter).toHaveBeenCalled()
    for (const call of mockGetGeminiAdapter.mock.calls) {
      expect(call, 'the action passed a config override to getGeminiAdapter').toEqual([])
    }
  })
})
