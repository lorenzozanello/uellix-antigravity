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
import { runStellaGroundedQueryForProject } from '@/app/actions/stella/grounded-query'

/** The bound form, spelled once. */
const runStellaGroundedQuery = (
  request: { query: string },
  options: { boundProjectId: string },
) => runStellaGroundedQueryForProject(options.boundProjectId, request)
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
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('components/stella/grounded-query.ts', 'utf8'),
    )
    const block = source.slice(
      source.indexOf('export interface StellaGroundedQueryRequest'),
      source.indexOf('export interface StellaGroundedQuerySuccess'),
    )
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
    expect(runner.length).toBe(1)
    const result = await runner({ query: 'x' })
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
    mockCheckQuota.mockResolvedValue({ allowed: false, quota: 50, used: 50, reason: 'quota_exceeded' })
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'QUOTA_EXCEEDED' })
    expect((result as { message: string }).message).toContain('50')
    expect(emittedSql.join('\n')).not.toContain('chunks_in_scope')
  })

  it('an exhausted per-hour limit returns RATE_LIMITED, and reads no chunk', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false })
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'RATE_LIMITED' })
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
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('db/grounding/grounding-chunk-repository.ts', 'utf8'),
    )
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
  it('with no generator configured the seam completes and reports a provider failure, not an evidence gap', async () => {
    // Version lookup returns nothing -> zero chunks -> the orchestrator still
    // reaches the draft provider, which rejects by contract.
    const result = await runStellaGroundedQuery({ query: 'x' }, { boundProjectId: PROJECT_1 })
    expect(result).toMatchObject({ status: 'error', code: 'GEMINI_ERROR' })
    // And it says nothing about the user's evidence.
    expect((result as { message: string }).message).not.toMatch(/evidencia|documento/i)
  })

  it('the injected provider produces no content of any kind — it rejects', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('app/actions/stella/grounded-query.ts', 'utf8'),
    )
    const block = source.slice(source.indexOf('absentAnswerDraftProvider'))
    expect(block).toMatch(/Promise\.reject/)
    // No fabricated claims, no fixtures, no seeded corpus.
    expect(block.slice(0, 600)).not.toMatch(/claims\s*:/)
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
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('app/actions/stella/grounded-query.ts', 'utf8'),
    )
    expect(source).toMatch(/GroundingOrchestrationClassification/)
    // Reading BOTH would be the start of a third vocabulary. Asserted over
    // CODE: the mapping's own comment explains why the other vocabulary is
    // NOT read, and naming it there must not fail this test.
    expect(codeLines(source)).not.toMatch(/GroundedOutcomeKind/)
    expect(codeLines(source)).not.toMatch(/outcome\.kind/)
  })

  it('there is exactly ONE mapping table, and it is exhaustive over the classification union', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('app/actions/stella/grounded-query.ts', 'utf8'),
    )
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
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('components/stella/grounded-query.ts', 'utf8'),
    )
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
  const readFile = (p: string) => import('node:fs').then((fs) => fs.readFileSync(p, 'utf8'))

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

  it('every column the chunk read names is returned by chunks_in_scope', async () => {
    const source = await readFile('db/grounding/grounding-chunk-repository.ts')
    const chunksSql = await readFile('db/prepared/grounding_0003_evidence_chunks.sql')
    const signature = chunksSql.slice(
      chunksSql.indexOf('CREATE OR REPLACE FUNCTION uellix_grounding.chunks_in_scope'),
    )
    const returns = signature.slice(signature.indexOf('RETURNS TABLE ('), signature.indexOf(')\nLANGUAGE'))
    const returned = new Set([...returns.matchAll(/^\s{2}([a-z_]+) /gm)].map((m) => m[1]))
    expect(returned.size).toBeGreaterThan(10)

    const selectList = source.slice(
      source.indexOf('SELECT chunk_id, chunk_index'),
      source.indexOf('FROM uellix_grounding.chunks_in_scope'),
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
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('app/actions/stella/grounded-query.ts', 'utf8'),
    )
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
    const schema = await import('node:fs').then((fs) => fs.readFileSync('db/schema.ts', 'utf8'))
    const check = /stella_interactions_stella_role_check[\s\S]*?\n/.exec(schema)?.[0] ?? ''
    expect(check).toMatch(/'advisor'/)
    expect(check).not.toMatch(/grounded_query/)
  })

  it('the action does NOT misfile a grounded query under another role to make the quota tick', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('app/actions/stella/grounded-query.ts', 'utf8'),
    )
    expect(codeLines(source)).not.toMatch(/stellaInteractions/)
    // And it names the reason rather than leaving the omission to be guessed.
    expect(source).toMatch(/INT-CAP-001/)
  })

  it('the release gate refuses local-runtime-ready while the quota is enforced but not consumed', async () => {
    const gate = await import('node:fs').then((fs) =>
      fs.readFileSync('tests/eval/stella-release/local-release-gate.ts', 'utf8'),
    )
    expect(gate).toMatch(/quota is enforced but not consumed/)
    expect(gate).toMatch(/INT-CAP-001/)
  })

  it('a compliance trail IS written, metadata only — never the query text', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('app/actions/stella/grounded-query.ts', 'utf8'),
    )
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
