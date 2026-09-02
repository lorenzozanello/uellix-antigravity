// app/actions/grounding/__tests__/evidence-corpus-state.test.ts
// G-01 (product path) — the READ side of the governed corpus: the one query
// path that answers "what does the index actually hold for this project?"
//
// The derivation is NOT mocked: `deriveEvidenceCorpusState` and
// `classifyEvidenceIndexability` run for real, because restating their verdicts
// against a double would prove only that the double agrees with itself. The
// persisted repository is not mocked either — the real SQL is built and handed
// to a recording executor, so the scope predicates this action depends on are
// observed rather than assumed.
//
// What IS doubled is everything with a socket behind it: the session, the
// identity context and the drizzle handle.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const EVIDENCE_TXT = '55555555-5555-4555-8555-555555555555'
const EVIDENCE_PDF = '66666666-6666-4666-8666-666666666666'
const FOREIGN_EVIDENCE = '77777777-7777-4777-8777-777777777777'
const USER = '88888888-8888-4888-8888-888888888888'

/* -------------------------------------------------------------------------- */
/* Config — the real readiness API reads this                                 */
/* -------------------------------------------------------------------------- */

const mockStellaConfig = {
  geminiApiKey: '',
  isEnabled: true,
  isAdvisorEnabled: false,
  isValidatorEnabled: false,
  isComposerEnabled: false,
  isProxyReviewerEnabled: false,
  isEvidenceReviewerEnabled: false,
  isAuditAssistantEnabled: false,
  isDecisionsPersistenceEnabled: false,
  isGroundedQueryEnabled: true,
}
vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() {
    return mockStellaConfig
  },
}))

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const contextEvents: string[] = []
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: () => unknown) => {
    contextEvents.push('enter')
    try {
      const result = await cb()
      contextEvents.push('commit')
      return result
    } catch (error) {
      contextEvents.push('rollback')
      throw error
    }
  },
}))

/* -------------------------------------------------------------------------- */
/* Drizzle handle                                                             */
/* -------------------------------------------------------------------------- */

/** Rows the `select()` chain answers with, keyed by the table it was given. */
let projectRows: Record<string, unknown>[] = []
let evidenceRows: Record<string, unknown>[] = []
/** Every `sql` object handed to `execute`, in order. */
let executed: unknown[] = []
/** Answers for `execute`, chosen by what the statement names. */
let versionRows: Record<string, unknown>[] = []
let auditRows: Record<string, unknown>[] = []
let executeThrows = false

const mockSelect = vi.fn<(...args: unknown[]) => unknown>(() => ({
  from: (table: unknown) => {
    const name = tableName(table)
    const rows = name === 'projects' ? projectRows : evidenceRows
    const answer = {
      where: () => answer,
      orderBy: () => answer,
      limit: async () => rows,
      then: (resolve: (rows: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    }
    return answer
  },
}))

/**
 * The drizzle table's real SQL name, read off the symbol drizzle stamps on it.
 *
 * Reading the NAME rather than comparing object identity keeps this double
 * working if the action ever selects through an alias, and makes a failure say
 * which table was asked for.
 */
function tableName(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    s.description?.includes('Name'),
  )
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : 'unknown'
}

const mockExecute = vi.fn(async (query: unknown) => {
  executed.push(query)
  if (executeThrows) throw new Error('connection refused')
  return sqlTextOf(query).includes('audit_logs') ? auditRows : versionRows
})

vi.mock('@/db/client', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    execute: (query: unknown) => mockExecute(query),
  },
}))

/**
 * Every string and bound value inside a drizzle `sql` object, flattened.
 *
 * A TEXT-level guard, deliberately: with no database in this suite, "the
 * statement is bound to this scope" cannot be proved by running it. What CAN be
 * proved is that the organization and project the caller was authorized for are
 * present in the statement that was built — which is the mutation this file
 * exists to catch (dropping `project_id` from the predicate).
 */
function sqlTextOf(query: unknown): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === 'string' || typeof node === 'number') return void parts.push(String(node))
    if (typeof node !== 'object') return
    const chunks = (node as { queryChunks?: unknown }).queryChunks
    if (chunks !== undefined) return walk(chunks)
    const value = (node as { value?: unknown }).value
    if (value !== undefined) walk(value)
  }
  walk(query)
  return parts.join(' ')
}

import { readProjectCorpusStateForProject } from '@/app/actions/grounding/evidence-corpus-state'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function txtEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: EVIDENCE_TXT,
    projectId: PROJECT,
    organizationId: ORG,
    status: 'draft',
    type: 'file',
    title: 'Encuesta',
    description: null,
    filePath: `${PROJECT}/${EVIDENCE_TXT}/encuesta.txt`,
    fileSize: 42,
    mimeType: 'text/plain',
    contentHash: 'a'.repeat(64),
    ...overrides,
  }
}

function pdfEvidence(overrides: Record<string, unknown> = {}) {
  return txtEvidence({
    id: EVIDENCE_PDF,
    title: 'Informe',
    filePath: `${PROJECT}/${EVIDENCE_PDF}/informe.pdf`,
    mimeType: 'application/pdf',
    ...overrides,
  })
}

const PIPELINE_VERSIONS = {
  normalization_version: 'norm-current',
  extractor_version: 'extract-current',
  chunker_version: 'chunk-current',
}

beforeEach(async () => {
  vi.clearAllMocks()
  contextEvents.length = 0
  executed = []
  projectRows = [{ id: PROJECT, organizationId: ORG }]
  evidenceRows = [txtEvidence(), pdfEvidence()]
  versionRows = []
  auditRows = []
  executeThrows = false
  Object.assign(mockStellaConfig, { isEnabled: true, isGroundedQueryEnabled: true })
  mockRequireOrganizationAccess.mockResolvedValue({
    user: { id: USER },
    organization: { id: ORG },
    membership: { role: 'analyst' },
  })

  // The drift comparison is against the REAL pipeline constants, so the
  // "healthy" fixture has to carry them. Read once, here, rather than hardcoded
  // — a version bump must not turn every indexed fixture stale.
  const { currentPipelineIdentity } = await import('@/lib/grounding/ingest')
  const identity = currentPipelineIdentity()
  PIPELINE_VERSIONS.normalization_version = identity.normalizationVersion
  PIPELINE_VERSIONS.extractor_version = identity.extractorVersion
  PIPELINE_VERSIONS.chunker_version = identity.chunkerVersion
})

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

describe('the capability gate', () => {
  it('reports disabled without authenticating or reading anything', () => {
    mockStellaConfig.isGroundedQueryEnabled = false
    return readProjectCorpusStateForProject(PROJECT).then((result) => {
      expect(result).toEqual({ status: 'disabled' })
      expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
      expect(mockSelect).not.toHaveBeenCalled()
      expect(mockExecute).not.toHaveBeenCalled()
    })
  })

  it('the master switch still refuses even with the capability flag on', async () => {
    mockStellaConfig.isEnabled = false
    await expect(readProjectCorpusStateForProject(PROJECT)).resolves.toEqual({ status: 'disabled' })
  })
})

/* -------------------------------------------------------------------------- */
/* Authorization and isolation                                                */
/* -------------------------------------------------------------------------- */

describe('authorization', () => {
  it('refuses an unauthenticated caller before any read', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('no session'))
    await expect(readProjectCorpusStateForProject(PROJECT)).resolves.toEqual({
      status: 'unauthorized',
    })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('refuses a project that is not in the session organization', async () => {
    // The project lookup is scoped by the SESSION's organization, so a project
    // of another tenant simply is not there. The answer is the same one an
    // absent project gets — telling them apart would be a tenancy oracle.
    projectRows = []
    await expect(readProjectCorpusStateForProject(OTHER_PROJECT)).resolves.toEqual({
      status: 'unauthorized',
    })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('refuses a blank project id without touching the database', async () => {
    await expect(readProjectCorpusStateForProject('   ')).resolves.toEqual({ status: 'unauthorized' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('binds every corpus statement to the session organization AND the project', async () => {
    versionRows = []
    await readProjectCorpusStateForProject(PROJECT)

    expect(executed.length).toBeGreaterThan(0)
    for (const query of executed) {
      const text = sqlTextOf(query)
      expect(text, 'a corpus statement was built without the organization').toContain(ORG)
    }
    const versionStatement = executed.map(sqlTextOf).find((t) => t.includes('evidence_document_versions'))
    expect(versionStatement).toBeDefined()
    // The PREDICATE, not merely the value. FOUND BY MUTATION: deleting
    // `AND v.project_id = …` from the CTE left `toContain(PROJECT)` passing,
    // because the same id is bound again as an argument to
    // `chunks_in_scope_attested`. The version row would then be selected on the
    // organization alone — and `evidence_document_versions_select` is org-
    // scoped, so RLS would not have stopped it either.
    expect(versionStatement, 'the version lookup dropped its project predicate').toMatch(
      /v\.project_id\s*=/,
    )
    expect(versionStatement).toContain(PROJECT)
  })

  it('never names an evidence item outside the project in the audit lookup', async () => {
    // `audit_logs` has no project column — `logAuditAction` discards the one it
    // is given. The project boundary on this read is therefore the evidence-id
    // set, which is resolved from a project-scoped query and never from input.
    await readProjectCorpusStateForProject(PROJECT)
    const auditStatement = executed.map(sqlTextOf).find((t) => t.includes('audit_logs'))
    expect(auditStatement).toBeDefined()
    expect(auditStatement).toContain(EVIDENCE_TXT)
    expect(auditStatement).not.toContain(FOREIGN_EVIDENCE)
  })

  it('cannot render a version row for an evidence item the project does not own', async () => {
    // The boundary is the JOIN, not a filter: states are derived one per
    // evidence row of the project and each looks its corpus record up by its
    // OWN id, so a record for anything else has nothing to attach to. Feeding
    // one in is how that claim is checked — an earlier version of this action
    // also ran a redundant `authorized.has(...)` filter, and mutation testing
    // showed deleting it changed no output, which is what "unreachable" means.
    versionRows = [
      { evidence_id: FOREIGN_EVIDENCE, ordinal: 1, chunk_count: '9', created_at: '2026-08-15T10:00:00.000Z', ...PIPELINE_VERSIONS },
    ]
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.states.map((s) => s.evidenceId)).toEqual([EVIDENCE_TXT, EVIDENCE_PDF])
    expect(result.states.every((s) => s.chunkCount === null)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* The states                                                                 */
/* -------------------------------------------------------------------------- */

describe('the state it reports', () => {
  it('reports an indexed row with its canonical chunk count', async () => {
    versionRows = [
      { evidence_id: EVIDENCE_TXT, ordinal: 2, chunk_count: '12', created_at: '2026-08-15T10:00:00.000Z', ...PIPELINE_VERSIONS },
    ]
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')

    expect(result.states[0]).toMatchObject({
      evidenceId: EVIDENCE_TXT,
      phase: 'indexed',
      chunkCount: 12,
      versionOrdinal: 2,
    })
  })

  it('reports the PDF as not indexable, from the row and not from an attempt', async () => {
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')

    expect(result.states[1]).toMatchObject({
      evidenceId: EVIDENCE_PDF,
      phase: 'not_indexable',
      reason: 'unsupported_format',
      canRetry: false,
    })
  })

  it('reports a rolled-back attempt as retryable', async () => {
    auditRows = [
      {
        entity_id: EVIDENCE_TXT,
        created_at: '2026-08-15T09:00:00.000Z',
        after_json: { stage: 'persist_chunks', rolledBack: true },
      },
    ]
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')

    expect(result.states[0]).toMatchObject({
      phase: 'failed_retryable',
      reason: 'write_failed',
      canRetry: true,
    })
  })

  it('reads the not-indexed reason off the trail so a skip is not called a crash', async () => {
    auditRows = [
      {
        entity_id: EVIDENCE_TXT,
        created_at: '2026-08-15T09:00:00.000Z',
        after_json: { stage: 'not_indexed', notIndexedReason: 'empty_document' },
      },
    ]
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')

    expect(result.states[0]).toMatchObject({
      phase: 'failed_terminal',
      reason: 'empty_document',
      canRetry: false,
    })
  })

  it('survives an audit payload written by an older build', async () => {
    // The trail is append-only and outlives the code that wrote it. A row with
    // no recognisable fields must degrade to "nothing known", never throw
    // during a page render.
    auditRows = [{ entity_id: EVIDENCE_TXT, created_at: '2026-01-01T00:00:00.000Z', after_json: null }]
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.states[0].phase).toBe('ready_to_index')
  })

  it('withholds the retry offer from a role that may not manage evidence', async () => {
    mockRequireOrganizationAccess.mockResolvedValue({
      user: { id: USER },
      organization: { id: ORG },
      membership: { role: 'viewer' },
    })
    const result = await readProjectCorpusStateForProject(PROJECT)
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.states.every((state) => state.canRetry === false)).toBe(true)
  })

  it('reads nothing from the corpus when the project has no evidence', async () => {
    evidenceRows = []
    const result = await readProjectCorpusStateForProject(PROJECT)
    expect(result).toEqual({ status: 'ready', states: [] })
    // An `IN ()` over an empty set is a syntax error, not an empty result.
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

describe('when the database will not answer', () => {
  it('reports an error rather than an empty, confident corpus', async () => {
    // The dangerous failure here is silence: returning `ready` with every row
    // "not indexed" would tell a reviewer the corpus is empty when the truth is
    // that it could not be read.
    executeThrows = true
    const result = await readProjectCorpusStateForProject(PROJECT)
    expect(result.status).toBe('error')
  })
})
