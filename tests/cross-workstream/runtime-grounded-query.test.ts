// tests/cross-workstream/runtime-grounded-query.test.ts
// INTEGRATION (Stella parallel train 3) — the RUNTIME seam, end to end.
//
// This is the only suite that exercises the whole journey the train set out to
// deliver:
//
//   authenticated query -> server-derived scope -> permission -> quota
//     -> repository adapter -> scoped retrieval -> grounded orchestration
//     -> citation validation -> presentation adaptation -> human review
//
// WHAT IS MOCKED, AND WHY THAT IS NOT "TESTING FIXTURES"
//
// Auth, the identity-context wrapper, quota, rate limit and the DRIVER are
// doubled — the same boundary `app/actions/stella/__tests__/decisions.test.ts`
// doubles, for the same reason: those components have their own suites against
// a live database, and re-proving them here would make this suite depend on a
// stack that train 3 is forbidden from starting.
//
// Everything the train actually built runs FOR REAL: the flag gate, the scope
// derivation, `createPersistedGroundingChunkRepository`, the SQL it emits,
// `orchestrateGroundedResponse`, `enforceRepositoryScope`, citation
// validation, `adaptGroundedAnswer`, and the single classification mapping.
// The double is a socket, not a substitute for the logic under test — and the
// assertions below are about WHAT SQL WAS EMITTED and WHAT CROSSED THE
// BOUNDARY, which a fixture cannot fake.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'
// FASE 9 (Train 4.2). Every structural assertion below reads its source through
// this reader, which normalizes CRLF -> LF. One of them — "a compliance trail
// IS written" — slices a function body at `'\n}\n'`, and under CRLF that
// `indexOf` returns -1, so `slice(start, -1)` silently handed the assertion
// almost the whole file instead of the function it was pointed at. A test that
// judges the wrong bytes is worse than one that fails.
import { readSourceText } from '@/tests/helpers/source-text'

/* -------------------------------------------------------------------------- */
/* Doubles — hoisted                                                          */
/* -------------------------------------------------------------------------- */

const mockStellaConfig = {
  isEnabled: true,
  isGroundedQueryEnabled: true,
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

/** Counts every time the action opens an identity-scoped database context. */
const contextOpens = vi.fn()
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: () => unknown) => {
    contextOpens()
    return cb()
  },
}))

const mockCheckQuota = vi.fn()
vi.mock('@/lib/stella/quota', () => ({
  checkStellaQuota: (...args: unknown[]) => mockCheckQuota(...args),
  nextQuotaResetIso: () => '2026-09-01T00:00:00.000Z',
  formatQuotaResetDate: () => '1 de septiembre de 2026',
}))

const mockRateLimit = vi.fn()
vi.mock('@/lib/stella/rate-limit', () => ({
  consumeStellaRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}))

/**
 * The operation-ticket adapter, doubled.
 *
 * Doubled at the ADAPTER rather than at the driver on purpose. The ticket
 * protocol's real behaviour is proven where it can be proven for real — against
 * a live disposable PostgreSQL, in `scripts/stella-ticket-e2e.sh`, with the
 * actual `stella_0014` package installed. Re-simulating `bind`/`complete`
 * inside a SQL-string matcher here would be a second, weaker model of the same
 * thing, and the assertions in this file would then be checking the model.
 *
 * What this file DOES check is the seam: that the runtime calls bind before it
 * works and complete after it, that it aborts on every failure path, and that
 * nothing reaches the client until the ledger has accounted for a unit.
 */
const mockIssueTicket = vi.fn()
const mockBindTicket = vi.fn()
const mockCompleteTicket = vi.fn()
const mockAbortTicket = vi.fn()
// TRAIN 4.2. `inspect` stopped being a verb nothing calls: the post-complete
// retry now READS the settled ticket's state under the execution project
// instead of inferring it from what `bind` returned. Recorded rather than
// stubbed anonymously, because section 10 asserts WHICH project it was given.
const mockInspectTicket = vi.fn()
vi.mock('@/db/stella/operation-tickets', () => ({
  issueOperationTicket: (...args: unknown[]) => mockIssueTicket(...args),
  bindOperationTicket: (...args: unknown[]) => mockBindTicket(...args),
  completeOperationTicket: (...args: unknown[]) => mockCompleteTicket(...args),
  abortOperationTicket: (...args: unknown[]) => mockAbortTicket(...args),
  inspectOperationTicket: (...args: unknown[]) => mockInspectTicket(...args),
  expireOperationTickets: vi.fn(),
  GROUNDED_QUERY_TICKET_CATEGORY: 'grounded_query',
}))

/** A syntactically valid ticket — 64 lowercase hex, the shape SQL enforces. */
const TICKET_A = 'a'.repeat(64)

/**
 * The driver double. It records EVERY statement, which is how the assertions
 * below can say "no SQL was emitted" and "the scope in the SQL is the session's",
 * rather than trusting the action's return value.
 */
const emittedSql: string[] = []
const mockExecute = vi.fn()
const mockSelectChain = vi.fn()
vi.mock('@/db/client', () => ({
  db: {
    execute: (query: unknown) => {
      emittedSql.push(renderSql(query))
      return mockExecute(query)
    },
    select: (...args: unknown[]) => mockSelectChain(...args),
  },
}))

/**
 * A source file with its comments removed.
 *
 * Several assertions below are of the form "this identifier must not appear",
 * and the modules under test DOCUMENT the boundary by naming exactly the thing
 * they do not use ("Not `service_role`", "never reads `GroundedOutcomeKind`").
 * A regex over the raw text would punish the documentation and reward silence,
 * so the assertions run over code only.
 */
function codeLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function renderSql(query: unknown): string {
  const q = query as { queryChunks?: unknown[] } | undefined
  if (!q?.queryChunks) return String(query)
  return q.queryChunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value
        return Array.isArray(value) ? value.join('') : String(value)
      }
      return JSON.stringify(chunk)
    })
    .join(' ')
}

// Only ONE endpoint is exported, deliberately: every export of a `'use server'`
// module is an independently invocable server action, so the two-argument form
// is module-private and the tests drive the same surface a client can reach.
import {
  issueStellaGroundedQueryTicketForProject,
  runStellaGroundedQueryForProject,
} from '@/app/actions/stella/grounded-query'

/** The bound form, spelled once. */
const runStellaGroundedQuery = (
  request: { query: string },
  options: { boundProjectId: string; ticket?: string },
) =>
  runStellaGroundedQueryForProject(
    options.boundProjectId,
    request,
    // Train 4.1: the ticket is a SEPARATE argument, never a field of the
    // request. A syntactically valid but never-issued digest is the right
    // default for these tests — the ones that reach `bind` are asserting that
    // an unissued ticket is refused, and the ones that stop earlier (flag,
    // auth, scope) never present it at all.
    options.ticket ?? 'f'.repeat(64),
  )
import { createPersistedGroundingChunkRepository } from '@/db/grounding/grounding-chunk-repository'
import { buildChunkQuery } from '@/lib/grounding/retrieve/repository'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const PROJECT_1 = '33333333-3333-4333-8333-333333333333'
const PROJECT_2 = '44444444-4444-4444-8444-444444444444'
const EVIDENCE_1 = '55555555-5555-4555-8555-555555555555'

function organizationContext(role = 'analyst'): OrganizationContext {
  return {
    user: { id: 'user-1', email: 'a@b.c', fullName: null, avatarUrl: null, isSuperAdmin: false },
    organization: { id: ORG_A, name: 'A', slug: 'a', legalName: null, country: null, sector: null, status: 'active' },
    membership: { id: 'm-1', organizationId: ORG_A, userId: 'user-1', role, status: 'active' },
  } as unknown as OrganizationContext
}

/** Drizzle's fluent select, doubled to a fixed row set. */
function selectReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  }
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  emittedSql.length = 0
  mockStellaConfig.isEnabled = true
  mockStellaConfig.isGroundedQueryEnabled = true
  mockStellaState.canUseStella = true
  mockRequireOrganizationAccess.mockResolvedValue(organizationContext())
  mockCheckQuota.mockResolvedValue({ allowed: true, quota: 100, used: 1, reason: null })
  mockRateLimit.mockResolvedValue({ allowed: true })
  // Healthy default: the reservation is taken, and the settlement charges one
  // unit. Individual tests override to exercise refusal and failure.
  mockIssueTicket.mockResolvedValue({ kind: 'issued', ticketId: TICKET_A })
  mockBindTicket.mockResolvedValue({ kind: 'bound', used: 1, quota: 100 })
  mockCompleteTicket.mockResolvedValue({ kind: 'completed', used: 2, quota: 100 })
  mockAbortTicket.mockResolvedValue({ kind: 'aborted' })
  mockInspectTicket.mockResolvedValue({
    status: 'completed',
    category: 'grounded_query',
    expiresAt: '2026-08-06T00:00:00.000Z',
    hasQueryHash: true,
  })
  // Project belongs; one evidence item.
  mockSelectChain
    .mockReturnValueOnce(selectReturning([{ id: PROJECT_1 }]))
    .mockReturnValueOnce(selectReturning([{ id: EVIDENCE_1 }]))
  mockExecute.mockResolvedValue([])
})

/* -------------------------------------------------------------------------- */
/* 1. The client payload                                                      */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: the client payload carries the query and nothing else', () => {
  it('StellaGroundedQueryRequest has exactly one property in the published contract', async () => {
    const source = readSourceText('components/stella/grounded-query.ts')
    // Bounded by the interface's OWN closing brace, not by whatever
    // declaration happens to follow it. Train 4 added
    // `AnswerStrategyDescriptor` between the two anchors this used to slice
    // on, and the check then read that type's fields as if they were the
    // request's — a false failure produced by declaration order rather than by
    // the contract widening.
    const start = source.indexOf('export interface StellaGroundedQueryRequest')
    const block = source.slice(start, source.indexOf('\n}', start))
    const fields = block.match(/readonly\s+(\w+)\s*:/g) ?? []
    expect(fields).toEqual(['readonly query:'])
  })

  it('a payload smuggling organizationId/projectId/scope is IGNORED: they have no reader, and the SQL still carries the session scope', async () => {
    const hostile = {
      query: '¿cuántos beneficiarios?',
      organizationId: ORG_B,
      projectId: PROJECT_2,
      scope: { organizationId: ORG_B, projectId: PROJECT_2 },
    } as unknown as { query: string }

    await runStellaGroundedQuery(hostile, { boundProjectId: PROJECT_1 })

    const allSql = emittedSql.join('\n')
    expect(allSql).toContain(ORG_A)
    expect(allSql).toContain(PROJECT_1)
    // The attacker's values reached no statement.
    expect(allSql).not.toContain(ORG_B)
    expect(allSql).not.toContain(PROJECT_2)
  })

  it('the bindable form seals projectId on the server: the runner signature has no scope parameter', async () => {
    const runner = runStellaGroundedQueryForProject.bind(null, PROJECT_1)
    // Two parameters: the functional request, and the operation ticket. Still
    // no parameter for a scope — which is what this test pins.
    expect(runner.length).toBe(2)
    const result = await runner({ query: 'x' }, 'f'.repeat(64))
    expect(result.status === 'ok' || result.status === 'error').toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Fail-closed: the flag is checked before anything                        */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: flag false is fail-closed — before auth, before the database, before observability', () => {
  it('returns DISABLED and opens no database context, emits no SQL, and never authenticates', async () => {
    mockStellaConfig.isGroundedQueryEnabled = false

    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })

    expect(result).toEqual({ status: 'error', code: 'DISABLED', message: expect.any(String) })
    expect(contextOpens).not.toHaveBeenCalled()
    expect(emittedSql).toEqual([])
    expect(mockExecute).not.toHaveBeenCalled()
    expect(mockSelectChain).not.toHaveBeenCalled()
    expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
    expect(mockCheckQuota).not.toHaveBeenCalled()
    expect(mockRateLimit).not.toHaveBeenCalled()
  })

  it('the master STELLA_ENABLED flag alone is enough to close it', async () => {
    mockStellaConfig.isEnabled = false
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'DISABLED' })
    expect(emittedSql).toEqual([])
  })

  it('there is no simulated answer behind the flag: DISABLED never carries an `answer`', async () => {
    mockStellaConfig.isGroundedQueryEnabled = false
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).not.toHaveProperty('answer')
    expect(result).not.toHaveProperty('answerId')
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Permission and quota                                                    */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: permission and quota gates run before any chunk is read', () => {
  it('a viewer is refused, and no chunk statement is emitted', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(organizationContext('viewer'))
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'UNAUTHORIZED' })
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
  })

  it('an exhausted quota returns QUOTA_EXCEEDED with the SERVER message intact, and reads no chunk', async () => {
    // Train 4.1: the monthly quota is decided by `bind`, under the same
    // per-organization advisory lock the charge takes — not by a separate,
    // unlocked pre-read whose answer could be overtaken before the charge.
    mockBindTicket.mockResolvedValue({ kind: 'quota_exceeded', used: 50, quota: 50 })
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'QUOTA_EXCEEDED' })
    expect((result as { message: string }).message).toContain('50')
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
    // Refused BEFORE the work ran — nothing settled, nothing charged.
    expect(mockCompleteTicket).not.toHaveBeenCalled()
    // And the ticket is left alone: aborting here would release a reservation
    // that was never taken, burning a ticket the caller could still use once
    // headroom frees up.
    expect(mockAbortTicket).not.toHaveBeenCalled()
  })

  it('an exhausted per-hour limit returns RATE_LIMITED at ISSUANCE, and reads no chunk', async () => {
    // Train 4.1 — the hourly limit moved from execution to issuance, so it
    // counts OPERATIONS rather than deliveries: minting is bounded, and a
    // retry of an already-counted operation does not spend the budget twice.
    // Asserted on the surface that now owns it.
    mockRateLimit.mockResolvedValue({ allowed: false })
    const issue = await issueStellaGroundedQueryTicketForProject(PROJECT_1)
    expect(issue).toMatchObject({ status: 'error', code: 'RATE_LIMITED' })
    expect(mockIssueTicket).not.toHaveBeenCalled()
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
  })

  it('a project that does not belong to the session is refused with the SAME message as one that does not exist', async () => {
    // `mockReset`, not `clearAllMocks`: the latter clears recorded calls but
    // KEEPS queued `mockReturnValueOnce` implementations, so beforeEach's
    // "project found" answer would survive and this test would silently
    // assert the wrong path.
    mockSelectChain.mockReset()
    mockSelectChain.mockReturnValue(selectReturning([]))
    const notMine = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_2 })
    expect(notMine).toMatchObject({ status: 'error', code: 'UNAUTHORIZED' })
    // No tenancy oracle: the message must not distinguish the two cases.
    expect((notMine as { message: string }).message).not.toMatch(/no existe|not found|otra organización/i)
  })
})

/* -------------------------------------------------------------------------- */
/* 4. The repository adapter                                                  */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: the repository adapter reads the governed surface, scoped, and never falls back', () => {
  it('the chunk read goes through uellix_grounding.chunks_in_scope, with the derived scope', async () => {
    await runStellaGroundedQuery({ query: 'beneficiarios' }, { boundProjectId: PROJECT_1 })
    const chunkStatements = emittedSql.filter((s) => s.includes('chunks_in_scope'))
    // The version lookup ran; the chunk read is the governed function only.
    expect(emittedSql.some((s) => s.includes('evidence_document_versions'))).toBe(true)
    // With no version rows, the adapter correctly reads no chunks at all —
    // which is the fail-closed behaviour, not a fallback.
    expect(chunkStatements.length).toBe(0)
  })

  it('there is no broad SELECT over evidence_chunks anywhere in the adapter', async () => {
    const source = readSourceText('db/grounding/grounding-chunk-repository.ts')
    expect(source).not.toMatch(/FROM\s+public\.evidence_chunks/i)
    expect(source).toMatch(/uellix_grounding\.chunks_in_scope/)
    // No elevated identity, ever — asserted over CODE, not prose. The module
    // header names `service_role` to say it is not used; a regex over the
    // whole file would make documenting the boundary break the test.
    expect(codeLines(source)).not.toMatch(/service_role/)
    expect(codeLines(source)).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('"any evidence within scope" is REFUSED rather than approximated — the governed surface cannot enumerate', async () => {
    const repo = createPersistedGroundingChunkRepository({ organizationId: ORG_A, projectId: PROJECT_1 })
    const query = buildChunkQuery({ organizationId: ORG_A, projectId: PROJECT_1 }, 'x')
    expect(query.evidenceIds).toEqual([])
    await expect(repo.fetchCandidates(query)).rejects.toThrow(/non-empty/)
    expect(emittedSql).toEqual([])
  })

  it('a repository built for one scope refuses a query for another', async () => {
    const repo = createPersistedGroundingChunkRepository({ organizationId: ORG_A, projectId: PROJECT_1 })
    const foreign = buildChunkQuery({ organizationId: ORG_B, projectId: PROJECT_2 }, 'x', {
      evidenceIds: [EVIDENCE_1],
    })
    await expect(repo.fetchCandidates(foreign)).rejects.toThrow(/different scope/)
    expect(emittedSql).toEqual([])
  })

  it('a driver failure is SANITIZED: no SQLSTATE, no table name, no ids cross the boundary', async () => {
    mockExecute.mockRejectedValue(
      Object.assign(new Error('relation "public.evidence_document_versions" does not exist'), {
        code: '42P01',
        name: 'PostgresError',
      }),
    )

    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })

    expect(result.status).toBe('error')
    const message = (result as { message: string }).message
    expect(message).not.toMatch(/42P01/)
    expect(message).not.toMatch(/evidence_document_versions/)
    expect(message).not.toMatch(/relation/)
    expect(message).not.toContain(ORG_A)
    expect(message).not.toContain(PROJECT_1)
  })

  it('the SQL packages being unapplied produces NO fallback data — the result carries no fabricated answer', async () => {
    mockExecute.mockRejectedValue(
      Object.assign(new Error('schema "uellix_grounding" does not exist'), { code: '3F000', name: 'PostgresError' }),
    )
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result.status).toBe('error')
    expect(result).not.toHaveProperty('answer')
  })
})

/* -------------------------------------------------------------------------- */
/* 5. provider_unavailable stays separate from "no evidence"                  */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: provider unavailability is a claim about the system, never about the evidence', () => {
  it('a real generator IS configured now, and it is named rather than defaulted to', async () => {
    // TRAIN 4 REPLACES THIS ASSERTION, and the replacement is the point.
    //
    // Through train 3 the action injected `absentAnswerDraftProvider`, whose
    // whole job was to REJECT: there was no generator, and reporting that as
    // `provider_unavailable` was the honest description of a system with no
    // generation step. That placeholder is gone. `createExtractiveAnswerProvider()`
    // is a real component that answers by quoting retrieved passages, offline
    // and deterministically.
    //
    // So the old test's expectation — "the seam completes and reports a
    // provider failure" — now describes a REGRESSION rather than the contract,
    // and keeping it would have pinned the placeholder in place.
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    expect(source).not.toMatch(/absentAnswerDraftProvider/)
    expect(source).toMatch(/generator: createExtractiveAnswerProvider\(\)/)
  })

  it('the generator is a STRATEGY, never a fallback — nothing reaches for it on failure', async () => {
    // The property that survived the replacement, and the one that matters:
    // an extractive answer produced BECAUSE a database was down would present
    // a system fault as an evidence finding. There must be no `catch` and no
    // `??` that arrives at the generator.
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    expect(source).not.toMatch(/catch[\s\S]{0,200}createExtractiveAnswerProvider/)
    expect(source).not.toMatch(/\?\?\s*createExtractiveAnswerProvider/)
  })

  it('zero retrieved chunks now ABSTAINS instead of reporting a provider failure', async () => {
    // A behaviour change train 4 introduced, and the right one.
    //
    // Through train 3 this path produced `GEMINI_ERROR`, but only as an
    // artefact: the version lookup returned nothing, retrieval returned zero
    // candidates, and the orchestrator still reached the placeholder provider,
    // which rejected — so "no evidence matched" was reported as "the system
    // failed". Those are different claims and a reviewer acts on them
    // differently.
    //
    // With a real generator the same input produces what R6 specifies: an
    // ABSTENTION, carried through as a presentable answer with its own reason
    // code, and `inspected.total` is what separates "nothing was indexed" from
    // "passages existed and none got grounded".
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'ok' })
    const answer = (result as { answer: { abstention: unknown; status: string } }).answer
    expect(answer.abstention, 'an empty retrieval must produce a stated abstention').toBeTruthy()

    // The claim that did NOT change: provider unavailability is still a
    // separate outcome and is still reachable — it is what a THROWN repository
    // failure maps to, not what an empty result maps to.
    const actionSource = readSourceText('app/actions/stella/grounded-query.ts')
    expect(actionSource).toMatch(/provider_unavailable: false/)
  })

  it('a project with zero evidence is reported as itself, not as a provider failure', async () => {
    mockSelectChain.mockReset()
    mockSelectChain
      .mockReturnValueOnce(selectReturning([{ id: PROJECT_1 }]))
      .mockReturnValueOnce(selectReturning([]))

    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'UNSUPPORTED_STEP' })
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
  })
})

/* -------------------------------------------------------------------------- */
/* 6. R8 — one vocabulary, one mapping                                        */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: R8 — exactly one classification vocabulary crosses the boundary', () => {
  it('the server action reads GroundingOrchestrationClassification and never GroundedOutcomeKind', async () => {
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    expect(source).toMatch(/GroundingOrchestrationClassification/)
    // Reading BOTH would be the start of a third vocabulary. Asserted over
    // CODE: the mapping's own comment explains why the other vocabulary is
    // NOT read, and naming it there must not fail this test.
    expect(codeLines(source)).not.toMatch(/GroundedOutcomeKind/)
    expect(codeLines(source)).not.toMatch(/outcome\.kind/)
  })

  it('there is exactly ONE mapping table, and it is exhaustive over the classification union', async () => {
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    const tables = source.match(/Record<GroundingOrchestrationClassification,/g) ?? []
    expect(tables).toHaveLength(1)
    // `Record<Union, …>` is exhaustive by construction — tsc rejects a missing
    // key — so the six members are pinned by the compiler, not by this regex.
    for (const member of [
      'grounded', 'partially_grounded', 'contradictory',
      'insufficient_evidence', 'abstention', 'provider_unavailable',
    ]) {
      expect(source).toContain(`${member}:`)
    }
  })

  it('Product never learns either grounding vocabulary: the result union is status + code', async () => {
    const source = readSourceText('components/stella/grounded-query.ts')
    expect(source).not.toMatch(/GroundingOrchestrationClassification|GroundedOutcomeKind/)
  })
})

/* -------------------------------------------------------------------------- */
/* 7. The adapter's SQL agrees with the schema CAPABILITIES actually ships     */
/* -------------------------------------------------------------------------- */
//
// ADVERSARIAL REVIEW, TRAIN 3 (reviewer A, F1). The first version of this
// adapter selected `v.source_label`, a column `evidence_document_versions` does
// not have and deliberately never will. Every grounded query would have thrown
// 42703 — and the sanitizer would have laundered it into the SAME
// `provider_unavailable` the module header says to expect while the packages
// are unapplied. A wrong column was therefore indistinguishable from the
// expected state, and no amount of driver mocking could reveal it.
//
// These tests close that class of defect by reconciling the adapter's SQL
// against the DDL itself, which is the only thing that knows the truth.

describe('RUNTIME: every column the adapter reads exists in the shipped DDL', () => {
  const readFile = (p: string) => readSourceText(p)

  /** Column names of one CREATE TABLE body in a prepared package. */
  async function columnsOf(sqlPath: string, table: string): Promise<Set<string>> {
    const sql = await readFile(sqlPath)
    const open = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`)
    expect(open, `no CREATE TABLE for ${table}`).toBeGreaterThan(-1)
    const body = sql.slice(open, sql.indexOf('\n);', open))
    return new Set(
      body
        .split('\n')
        .map((line) => /^ {2}([a-z_]+) /.exec(line)?.[1])
        .filter((name): name is string => Boolean(name)),
    )
  }

  it('every `v.<column>` the version lookup selects is a real column of evidence_document_versions', async () => {
    const source = await readFile('db/grounding/grounding-chunk-repository.ts')
    const columns = await columnsOf('db/prepared/grounding_0002_document_versions.sql', 'evidence_document_versions')

    const referenced = [...source.matchAll(/\bv\.([a-z_]+)\b/g)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(5)
    for (const column of new Set(referenced)) {
      expect(columns.has(column), `adapter reads v.${column}, which evidence_document_versions does not have`).toBe(true)
    }
  })

  it('every `e.<column>` it joins is a real column of evidence_items', async () => {
    const source = await readFile('db/grounding/grounding-chunk-repository.ts')
    const schema = await readFile('db/schema.ts')
    const block = schema.slice(
      schema.indexOf("export const evidenceItems = pgTable('evidence_items'"),
      schema.indexOf('}, (table) =>', schema.indexOf("pgTable('evidence_items'")),
    )
    const columns = new Set([...block.matchAll(/\('([a-z_]+)'/g)].map((m) => m[1]))

    for (const column of new Set([...source.matchAll(/\be\.([a-z_]+)\b/g)].map((m) => m[1]))) {
      expect(columns.has(column), `adapter reads e.${column}, which evidence_items does not have`).toBe(true)
    }
  })

  it('source_label is joined from evidence_items, because the version table deliberately does not store it', async () => {
    const source = await readFile('db/grounding/grounding-chunk-repository.ts')
    expect(source).not.toMatch(/v\.source_label/)
    expect(source).toMatch(/e\.title\s+AS source_label/)
    const versions = await readFile('db/prepared/grounding_0002_document_versions.sql')
    expect(versions).not.toMatch(/^\s{2}source_label\s/m)
  })

  it('every column the chunk read names is returned by chunks_in_scope_attested', async () => {
    // TRAIN 4: the adapter moved to the ATTESTED reader, so the DDL this
    // checks against moved with it — from grounding_0003's 13-column function
    // to grounding_0004's 17-column one. Pointing it at the old package would
    // make the four attestation columns read as columns the function does not
    // return.
    const source = await readFile('db/grounding/grounding-chunk-repository.ts')
    const chunksSql = await readFile('db/prepared/grounding_0004_runtime_attestation.sql')
    const signature = chunksSql.slice(
      chunksSql.indexOf('CREATE OR REPLACE FUNCTION uellix_grounding.chunks_in_scope_attested'),
    )
    const returns = signature.slice(signature.indexOf('RETURNS TABLE ('), signature.indexOf(')\nLANGUAGE'))
    const returned = new Set([...returns.matchAll(/^\s{2}([a-z_]+) /gm)].map((m) => m[1]))
    expect(returned.size).toBeGreaterThan(10)

    const selectList = source.slice(
      source.indexOf('SELECT chunk_id, chunk_index'),
      source.indexOf('FROM uellix_grounding.chunks_in_scope_attested'),
    )
    for (const column of selectList.replace('SELECT', '').split(',').map((c) => c.trim()).filter(Boolean)) {
      expect(returned.has(column), `the chunk read selects ${column}, which chunks_in_scope does not return`).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 8. Boundary breaks rethrow; they are never degraded to "we could not look"  */
/* -------------------------------------------------------------------------- */

describe('RUNTIME: a repository contract violation is a boundary break, not an outage', () => {
  it('GroundingRepositoryContractError is in the rethrown family, so the orchestrator cannot swallow it', async () => {
    const { GroundingRepositoryContractError } = await import('@/db/grounding/grounding-chunk-repository')
    const { RepositoryContractViolationError } = await import('@/lib/grounding/retrieve/repository')
    // orchestrate.ts rethrows exactly two families and degrades everything
    // else to provider_unavailable. Inheritance is what puts this one in the
    // rethrown family — a plain Error subclass would have been reported as an
    // outage a caller might retry.
    expect(new GroundingRepositoryContractError('x')).toBeInstanceOf(RepositoryContractViolationError)
  })

  it('no code path can turn a contract violation into a successful answer', async () => {
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    const block = source.slice(source.indexOf('} catch (error) {', source.indexOf('orchestrateGroundedResponse')))
    expect(block).toMatch(/GroundingRepositoryContractError/)
    expect(block).toMatch(/return failure\('UNKNOWN_ERROR'/)
  })
})

/* -------------------------------------------------------------------------- */
/* 9. Quota and the compliance trail                                          */
/* -------------------------------------------------------------------------- */
//
// ADVERSARIAL REVIEW, TRAIN 3 (reviewer B, #9). Every sibling Stella action
// inserts a `stella_interactions` row after a successful call, and
// `checkStellaQuota` counts exactly those rows — so an action that reads the
// quota without writing one enforces a budget it never spends.
//
// This action cannot write that row: `stella_interactions_stella_role_check`
// admits six roles and `grounded_query` is not among them. The two local
// "fixes" are both worse than the gap (misfile it as `advisor`, or widen a
// CAPABILITIES-owned CHECK unilaterally), so the gap is made EXPLICIT and
// gated instead of quietly carried.

describe('RUNTIME: the quota ledger gap is stated and gated, not hidden', () => {
  it('grounded_query is genuinely absent from the stella_interactions role CHECK', async () => {
    const schema = readSourceText('db/schema.ts')
    const check = /stella_interactions_stella_role_check[\s\S]*?\n/.exec(schema)?.[0] ?? ''
    expect(check).toMatch(/'advisor'/)
    expect(check).not.toMatch(/grounded_query/)
  })

  it('the action does NOT misfile a grounded query under another role to make the quota tick', async () => {
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    expect(codeLines(source)).not.toMatch(/stellaInteractions/)
    // And it names the reason rather than leaving the omission to be guessed.
    expect(source).toMatch(/INT-CAP-001/)
  })

  it('the release gate refuses local-runtime-ready while the quota is enforced but not consumed', async () => {
    const gate = readSourceText('tests/eval/stella-release/local-release-gate.ts')
    expect(gate).toMatch(/quota is enforced but not consumed/)
    expect(gate).toMatch(/INT-CAP-001/)
  })

  it('a compliance trail IS written, metadata only — never the query text', async () => {
    const source = readSourceText('app/actions/stella/grounded-query.ts')
    const start = source.indexOf('async function auditGroundedQuery')
    // The function body only — a slice running past its closing brace would
    // read the next declaration's prose and assert on the wrong text.
    const audit = source.slice(start, source.indexOf('\n}\n', start))
    expect(audit).toMatch(/AUDIT_ACTIONS\.STELLA_INVOKED/)
    // The audit payload must not carry the question or any passage.
    expect(audit).not.toMatch(/queryText/)
    expect(audit).not.toMatch(/\banswer\b/)
  })
})

/* -------------------------------------------------------------------------- */
/* 10. R2-INT — the execution project reaches all four ticket verbs           */
/* -------------------------------------------------------------------------- */
//
// TRAIN 4.2. These are BEHAVIOURAL, not structural: the adapter is doubled, so
// what is measured is the ARGUMENTS the runtime actually passed, in the
// positions it passed them. A structural test over the source could be
// satisfied by a call that names the right variable in the wrong slot; a
// recorded call cannot.
//
// The invariant under test:
//
//     ticket.project_id = derivedProjectId = Grounding scope.projectId
//                                          = charge.project_id
//
// The last equality is SQL's to keep (`complete_operation_ticket` charges under
// the ticket's own column, having proven it equal to the argument), and it is
// measured for real in tests/e2e/stella-ticket-journey.e2e.test.ts against a
// live database. What this suite proves is every equality to its left.

/** Argument slot 2 — where the execution project sits in all four verbs. */
const PROJECT_SLOT = 1

describe('RUNTIME: R2-INT — one derived project, delivered to every governed verb', () => {
  it('bind receives the SERVER-BOUND project in the SQL argument position, not the ticket and not the payload', async () => {
    await runStellaGroundedQuery({ query: 'beneficiarios' }, { boundProjectId: PROJECT_1, ticket: TICKET_A })

    expect(mockBindTicket).toHaveBeenCalledTimes(1)
    const args = mockBindTicket.mock.calls[0]!
    expect(args[0]).toBe(TICKET_A)
    // Slot 2, mirroring uellix_stella_ops.bind_operation_ticket(ticket, project,
    // hash). Asserted by POSITION because a transposition of two `string`
    // parameters is invisible to tsc and would send the digest where the
    // project belongs — which SQL would reject as U0100, i.e. as a malformed
    // input rather than as the wiring bug it is.
    expect(args[PROJECT_SLOT]).toBe(PROJECT_1)
    expect(args[2]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('complete receives the SAME project bind did — it does not inherit the verdict and does not re-derive', async () => {
    await runStellaGroundedQuery({ query: 'beneficiarios' }, { boundProjectId: PROJECT_1, ticket: TICKET_A })

    expect(mockCompleteTicket).toHaveBeenCalledTimes(1)
    const bind = mockBindTicket.mock.calls[0]!
    const complete = mockCompleteTicket.mock.calls[0]!
    expect(complete[PROJECT_SLOT]).toBe(PROJECT_1)
    // The equality itself, stated as one assertion rather than two checks that
    // happen to agree. bind and complete run in DIFFERENT database
    // transactions; this value is the only thing that ties them together.
    expect(complete[PROJECT_SLOT]).toBe(bind[PROJECT_SLOT])
  })

  it('abort receives it too, so one surface cannot release another project reservation', async () => {
    // A failure AFTER the reservation. A project with no evidence is the
    // cheapest way to reach the release path without faking an exception.
    mockSelectChain.mockReset()
    mockSelectChain
      .mockReturnValueOnce(selectReturning([{ id: PROJECT_1 }]))
      .mockReturnValueOnce(selectReturning([]))

    await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1, ticket: TICKET_A })

    expect(mockAbortTicket).toHaveBeenCalledTimes(1)
    const args = mockAbortTicket.mock.calls[0]!
    expect(args[0]).toBe(TICKET_A)
    expect(args[PROJECT_SLOT]).toBe(PROJECT_1)
    expect(args[2]).toBe('no_result')
  })

  it('inspect receives it on the post-complete retry — the one path that reads a settled ticket', async () => {
    mockBindTicket.mockResolvedValue({ kind: 'already_completed' })

    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1, ticket: TICKET_A })

    expect(result).toMatchObject({ status: 'error', code: 'ALREADY_COMPLETED_RESULT_UNAVAILABLE' })
    expect(mockInspectTicket).toHaveBeenCalledTimes(1)
    const args = mockInspectTicket.mock.calls[0]!
    expect(args[0]).toBe(TICKET_A)
    expect(args[PROJECT_SLOT]).toBe(PROJECT_1)
    // And nothing was re-run or re-charged for it.
    expect(mockCompleteTicket).not.toHaveBeenCalled()
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
  })

  it('the project the REPOSITORY reads under is the same one bind was given — no ticket/work divergence', async () => {
    await runStellaGroundedQuery({ query: 'beneficiarios' }, { boundProjectId: PROJECT_1, ticket: TICKET_A })

    // Measured on the SQL the driver actually received, not on a value the
    // action returned about itself.
    expect(emittedSql.filter((s) => s.includes(PROJECT_1)).length).toBeGreaterThan(0)
    // And no statement anywhere in the journey named the OTHER project.
    expect(emittedSql.join('\n')).not.toContain(PROJECT_2)
    expect(mockBindTicket.mock.calls[0]![PROJECT_SLOT]).toBe(PROJECT_1)
  })

  it('a project-mismatched ticket (U0110 -> out_of_scope) stops before any usable answer and charges nothing', async () => {
    // What the adapter returns for U0110: the SQLSTATE stays distinct in the
    // database log and collapses to `out_of_scope` here, so a caller cannot
    // probe which kind of scope failure it hit.
    mockBindTicket.mockResolvedValue({ kind: 'rejected', reason: 'out_of_scope' })

    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1, ticket: TICKET_A })

    expect(result).toMatchObject({ status: 'error', code: 'UNAUTHORIZED' })
    // NOT a provider error. `GEMINI_ERROR` names a service this path never
    // calls AND renders as retryable, so a scope refusal shown that way is a
    // misattribution the reviewer cannot see through.
    expect((result as { code: string }).code).not.toBe('GEMINI_ERROR')
    // Zero work, zero settlement, and no reservation to release.
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
    expect(mockCompleteTicket).not.toHaveBeenCalled()
    expect(mockAbortTicket).not.toHaveBeenCalled()
  })

  it('the four verbs are reached through ONE factory, so no call site can name a different project', () => {
    const source = codeLines(readSourceText('app/actions/stella/grounded-query.ts'))
    // Exactly one call to each adapter verb in the whole module. A second call
    // site is how two projects drift apart again, so the COUNT is the
    // assertion — not merely that the right identifier appears somewhere.
    for (const verb of [
      'bindOperationTicket',
      'completeOperationTicket',
      'abortOperationTicket',
      'inspectOperationTicket',
    ]) {
      const calls = source.match(new RegExp(`${verb}\\s*\\(`, 'g')) ?? []
      expect(calls, `${verb} must be invoked exactly once, inside executionProject`).toHaveLength(1)
    }
    const open = source.indexOf('function executionProject(')
    expect(open, 'executionProject is gone — the factory IS the invariant').toBeGreaterThan(-1)
    const factory = source.slice(open, source.indexOf('\n}', open))
    for (const verb of [
      'bindOperationTicket',
      'completeOperationTicket',
      'abortOperationTicket',
      'inspectOperationTicket',
    ]) {
      expect(factory, `${verb} is invoked outside executionProject`).toContain(verb)
    }
  })

  it('the project is never recovered from the ticket, from the payload, or from a component', () => {
    const source = codeLines(readSourceText('app/actions/stella/grounded-query.ts'))
    // The three substitutions R2-INT is about, asserted over comment-stripped
    // source so the module may keep explaining what it refuses to do.
    expect(source).not.toMatch(/ticket\.project_id|ticket\.projectId/)
    expect(source).not.toMatch(/request\.projectId|request\?\.projectId/)
    expect(source).not.toMatch(/options\.projectId/)
    // Exactly ONE cast mints an ExecutionProjectId. A second one is a second
    // way for an unvetted string to become an execution project.
    const casts = source.match(/as ExecutionProjectId/g) ?? []
    expect(casts).toHaveLength(1)
  })
})
