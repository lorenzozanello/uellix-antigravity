// app/actions/grounding/__tests__/ingest-evidence.test.ts
// G-01 — the server action that indexes one authorized evidence FILE into the
// governed grounding corpus.
//
// The resolver (G-02) is NOT mocked here. Its refusals are the action's
// refusals, and re-stating them against a double would prove only that the
// double was written to agree. What IS mocked is everything with a socket
// behind it: the session, the identity context, the drizzle handle, the
// storage reader and the ingestion orchestrator.
//
// The identity-context double records ENTER / COMMIT / ROLLBACK, because M-7
// makes "did the whole sequence share one transaction, and did it unwind?" a
// property this action must have rather than one the database happens to
// provide.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const OTHER_ORG = '44444444-4444-4444-8444-444444444444'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'
const USER = '66666666-6666-4666-8666-666666666666'

const CSV = 'nombre,edad\nAna,34\nLuis,29\n'
const CSV_BYTES = Buffer.from(CSV, 'utf8')
const CSV_HASH = crypto.createHash('sha256').update(CSV_BYTES).digest('hex')

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

/* -------------------------------------------------------------------------- */
/* Identity context — records the transaction's fate                          */
/* -------------------------------------------------------------------------- */

const contextEvents: string[] = []
vi.mock('@/lib/auth/database-context', () => ({
  withOrganizationDatabaseContext: async (cb: (ctx: unknown) => unknown) => {
    contextEvents.push('enter')
    try {
      const result = await cb(await mockRequireOrganizationAccess())
      contextEvents.push('commit')
      return result
    } catch (error) {
      // Drizzle rolls back exactly when the callback throws. Recording it here
      // is how a unit test can prove the action lets the failure escape the
      // context instead of swallowing it and committing a half-written version.
      contextEvents.push('rollback')
      throw error
    }
  },
}))

/* -------------------------------------------------------------------------- */
/* Drizzle handle — one evidence row lookup                                   */
/* -------------------------------------------------------------------------- */

let evidenceRows: Record<string, unknown>[] = []
/**
 * The predicate the evidence lookup was actually built with.
 *
 * Recorded because every case in this file sets `evidenceRows` BY HAND, which
 * makes the WHERE clause invisible: dropping `eq(evidenceItems.projectId, …)`
 * changed nothing any test could see. Found by mutation, 2026-08-15.
 */
let lookupPredicate: unknown = null
// The signature is declared on `vi.fn` rather than as a named parameter: the
// spread call site needs a rest type, and an unused `_args` binding would only
// trade a type error for a lint warning.
const mockSelect = vi.fn<(...args: unknown[]) => unknown>(() => ({
  from: () => ({
    where: (predicate: unknown) => {
      lookupPredicate = predicate
      return { limit: async () => evidenceRows }
    },
  }),
}))

/** Every value drizzle bound into a predicate, flattened. */
function boundValues(predicate: unknown): string[] {
  const values: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) return
    if (Array.isArray(node)) return node.forEach((child) => walk(child, depth + 1))
    if (typeof node === 'string') return void values.push(node)
    if (typeof node !== 'object') return
    const chunks = (node as { queryChunks?: unknown }).queryChunks
    if (chunks !== undefined) return walk(chunks, depth + 1)
    if ('value' in (node as object)) walk((node as { value: unknown }).value, depth + 1)
  }
  walk(predicate, 0)
  return values
}
vi.mock('@/db/client', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}))

/* -------------------------------------------------------------------------- */
/* Storage reader                                                             */
/* -------------------------------------------------------------------------- */

const mockRead = vi.fn<(filePath: string) => Promise<Buffer | null>>()
vi.mock('@/lib/supabase/evidence-object-reader', () => ({
  createEvidenceObjectReader: () => ({ id: 'supabase-evidence-storage-v1', read: mockRead }),
}))

/* -------------------------------------------------------------------------- */
/* Governed ingestion                                                         */
/* -------------------------------------------------------------------------- */

const mockCreateRepository = vi.fn<(...args: unknown[]) => { id: string }>(() => ({
  id: 'db-grounding-ingestion-v1',
}))
vi.mock('@/db/grounding/grounding-ingestion-repository', () => ({
  createPersistedGroundingIngestionRepository: (...args: unknown[]) => mockCreateRepository(...args),
}))

const mockIngest = vi.fn()
vi.mock('@/lib/grounding/ingest', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/grounding/ingest')>()
  return {
    ...original,
    ingestEvidenceDocument: (...args: unknown[]) => mockIngest(...args),
  }
})

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return {
    ...original,
    logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args),
  }
})

import { ingestProjectEvidenceForProject } from '@/app/actions/grounding/ingest-evidence'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function session(role: string) {
  return {
    user: { id: USER, isSuperAdmin: false },
    organization: { id: ORG },
    membership: { role },
  }
}

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'file',
    title: 'padron.csv',
    description: 'Padrón de participantes',
    filePath: `${PROJECT}/${EVIDENCE}/padron.csv`,
    fileSize: CSV_BYTES.length,
    mimeType: 'text/csv',
    contentHash: CSV_HASH,
    ...overrides,
  }
}

const VERSION_REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** Shaped as `IngestionRunPersisted` actually is — `ref` is the version row id. */
const persisted = {
  status: 'persisted',
  stage: 'finalize',
  reingestion: 'first_ingestion',
  ref: VERSION_REF,
  ingestion: { status: 'ingested', chunks: [1, 2, 3], warnings: [] },
  insertedChunkCount: 3,
  expectedChunkCount: 3,
  duplicateRowCount: 0,
  repositoryId: 'db-grounding-ingestion-v1',
}

/** Shaped as `IngestionRunFailure` actually is — the writes are under `written`. */
function failedRun(stage: string, insertedChunkCount: number | null) {
  return {
    status: 'failed',
    stage,
    failure: { operation: stage === 'finalize' ? 'finalize_document_ingestion' : 'insert_evidence_chunks' },
    ingestion: { status: 'ingested', chunks: [1, 2, 3], warnings: [] },
    written: { ref: VERSION_REF, insertedChunkCount, expectedChunkCount: 3 },
    repositoryId: 'db-grounding-ingestion-v1',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  contextEvents.length = 0
  mockStellaConfig.isEnabled = true
  mockStellaConfig.isGroundedQueryEnabled = true
  mockStellaConfig.geminiApiKey = ''
  mockRequireOrganizationAccess.mockResolvedValue(session('analyst'))
  evidenceRows = [fileRow()]
  mockRead.mockResolvedValue(CSV_BYTES)
  mockIngest.mockResolvedValue(persisted)
  mockCreateRepository.mockReturnValue({ id: 'db-grounding-ingestion-v1' })
})

/* -------------------------------------------------------------------------- */

describe('1. analyst or higher indexes a file', () => {
  it('reaches the governed ingestion and reports the version it wrote', async () => {
    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({
      status: 'indexed',
      versionId: VERSION_REF,
      chunkCount: 3,
      reingestion: 'first_ingestion',
    })
  })

  it('accepts impact_manager, above the evidence-management threshold', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(session('impact_manager'))

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result.status).toBe('indexed')
  })
})

describe('2. insufficient evidence-management role', () => {
  it('refuses a viewer before any storage read or database read', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(session('viewer'))

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'unauthorized' })
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockRead).not.toHaveBeenCalled()
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('refuses a reviewer, which ranks below analyst in the hierarchy', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(session('reviewer'))

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'unauthorized' })
  })
})

describe('3-5. tenancy', () => {
  it('looks the row up by evidence AND project AND organization, together', async () => {
    // THE PREDICATE ITSELF, not its result. Every other case here sets
    // `evidenceRows` by hand, so removing `eq(evidenceItems.projectId, …)` left
    // all of them passing — the boundary a retry re-establishes could be
    // deleted in silence.
    //
    // It matters most on the RETRY path: `indexEvidence.action.ts` forwards a
    // (projectId, evidenceId) pair straight from a form, and this is the
    // statement that refuses to answer for a pair the session does not own.
    // Without the project half, an evidence id from a SIBLING project of the
    // same organization would be selected — and the resolver's second check
    // would then answer `refused: scope_mismatch`, which is observably
    // different from `unauthorized` and therefore tells the caller the row
    // exists somewhere else.
    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    const bound = boundValues(lookupPredicate)
    expect(bound).toContain(EVIDENCE)
    expect(bound, 'the lookup lost its project predicate').toContain(PROJECT)
    expect(bound, 'the lookup lost its organization predicate').toContain(ORG)
  })

  it('wrong organization — the row is not returned by the scoped SELECT', async () => {
    // The action filters on (id, projectId, organizationId); a row of another
    // organization is simply not selected.
    evidenceRows = []

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'unauthorized' })
    expect(mockRead).not.toHaveBeenCalled()
  })

  it('wrong project — same outward answer as a missing evidence id', async () => {
    evidenceRows = []
    const missing = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    evidenceRows = []
    const outOfScope = await ingestProjectEvidenceForProject(OTHER_PROJECT, {
      evidenceId: EVIDENCE,
    })

    expect(outOfScope).toEqual(missing)
  })

  it('a row whose scope disagrees with the session is refused and never read', async () => {
    // Belt and braces: even if the SELECT were wrong, the resolver re-checks.
    evidenceRows = [fileRow({ organizationId: OTHER_ORG })]

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'refused', reason: 'scope_mismatch' })
    expect(mockRead).not.toHaveBeenCalled()
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('an evidence id from another project does not invoke the storage reader', async () => {
    evidenceRows = [fileRow({ projectId: OTHER_PROJECT })]

    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(mockRead).not.toHaveBeenCalled()
  })
})

describe('6-9. kinds and bytes', () => {
  it('text evidence is refused — this path does not index text (M-6)', async () => {
    evidenceRows = [
      fileRow({ type: 'text', filePath: null, mimeType: null, description: 'un resumen' }),
    ]

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result.status).toBe('refused')
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('url evidence is refused and no remote address is fetched', async () => {
    evidenceRows = [fileRow({ type: 'url', filePath: null })]
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'refused', reason: 'unsupported_kind' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('a file the reader cannot produce is refused', async () => {
    mockRead.mockResolvedValue(null)

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'refused', reason: 'missing_bytes' })
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('bytes that do not reproduce the row hash are refused', async () => {
    mockRead.mockResolvedValue(Buffer.from('otra cosa', 'utf8'))

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'refused', reason: 'content_hash_mismatch' })
    expect(mockIngest).not.toHaveBeenCalled()
  })
})

describe('10. the governed repository is the one that is used', () => {
  it('builds the persisted ingestion repository for the derived scope', async () => {
    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(mockCreateRepository).toHaveBeenCalledTimes(1)
    expect(mockCreateRepository.mock.calls[0][0]).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
    })
  })

  it('hands the resolved source and bytes to ingestEvidenceDocument', async () => {
    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(mockIngest).toHaveBeenCalledTimes(1)
    const [repository, source, bytes] = mockIngest.mock.calls[0]
    expect((repository as { id: string }).id).toBe('db-grounding-ingestion-v1')
    expect(source).toEqual({
      evidenceId: EVIDENCE,
      scope: { organizationId: ORG, projectId: PROJECT },
      kind: 'file',
      label: 'padron.csv',
      mimeType: 'text/csv',
      byteSize: CSV_BYTES.length,
    })
    expect(bytes).toEqual(CSV_BYTES)
  })
})

describe('11-12. idempotency comes from the contract, not from this action', () => {
  it('reports identical_replay verbatim', async () => {
    mockIngest.mockResolvedValue({ ...persisted, reingestion: 'identical_replay' })

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toMatchObject({ status: 'indexed', reingestion: 'identical_replay' })
  })

  it('reports new_version verbatim', async () => {
    mockIngest.mockResolvedValue({ ...persisted, reingestion: 'new_version' })

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toMatchObject({ status: 'indexed', reingestion: 'new_version' })
  })

  it('mints no idempotency key of its own', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'app/actions/grounding/ingest-evidence.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/randomUUID|idempotencyKey|idempotency_key/)
  })
})

describe('13-14. M-7 — a failed ingestion unwinds the whole transaction', () => {
  it('rolls back when chunk persistence fails after the version was registered', async () => {
    mockIngest.mockResolvedValue(failedRun('persist_chunks', null))

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'error', stage: 'persist_chunks' })
    // The INGESTION context must have unwound. A 'commit' in its place would
    // mean the registered version row survived and became the active one,
    // masking the previously valid version — the defect M-7 names.
    //
    // Positional, not a count: the audit write opens a third context of its
    // own and commits, so counting commits would pass even if the ingestion
    // had committed too.
    expect(contextEvents.slice(0, 4)).toEqual(['enter', 'commit', 'enter', 'rollback'])
  })

  it('rolls back when finalize rejects the chunk count', async () => {
    mockIngest.mockResolvedValue(failedRun('finalize', 2))

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'error', stage: 'finalize' })
    expect(contextEvents).toContain('rollback')
  })

  it('reports a document the pipeline cannot index without calling it a failure', async () => {
    mockIngest.mockResolvedValue({
      status: 'not_indexed',
      ingestion: { status: 'skipped', reason: 'unsupported_format', warnings: [] },
      repositoryId: 'db-grounding-ingestion-v1',
    })

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'not_indexed', reason: 'unsupported_format' })
    // Nothing was written, so there is nothing to unwind.
    expect(contextEvents).not.toContain('rollback')
  })

  it('records WHY the document was not indexed, not merely that it was not', async () => {
    // The trail is the only durable record of an attempt that wrote nothing:
    // the version and its chunks unwind, the audit row is a separate short
    // transaction and survives. A row saying "not_indexed" with no reason
    // cannot tell "this format has no extractor" (terminal — never offer a
    // retry) from "the document normalized to nothing" — and the evidence
    // screen has to make exactly that distinction.
    //
    // The reason is a VOCABULARY WORD from `IngestionSkipReason` /
    // `IngestionRejectReason`. No passage, no path, no hash.
    mockIngest.mockResolvedValue({
      status: 'not_indexed',
      ingestion: { status: 'skipped', reason: 'empty_document', warnings: [] },
      repositoryId: 'db-grounding-ingestion-v1',
    })

    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({
          stage: 'not_indexed',
          notIndexedReason: 'empty_document',
        }),
      }),
    )
  })

  it('does not roll back a successful ingestion', async () => {
    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(contextEvents).not.toContain('rollback')
  })

  it('runs register, insert and finalize inside ONE context — not three', async () => {
    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    // The scoped evidence lookup, then the ingestion, then the audit write —
    // three contexts, and the orchestrator is called exactly once, inside the
    // second. If register/insert/finalize each opened their own, the
    // orchestrator would still be called once but the ingestion context would
    // not be a single enter/commit pair.
    expect(contextEvents.slice(0, 4)).toEqual(['enter', 'commit', 'enter', 'commit'])
    expect(mockIngest).toHaveBeenCalledTimes(1)
  })

  it('does not hold a transaction open across the storage read', async () => {
    const order: string[] = []
    mockRead.mockImplementation(async () => {
      order.push(`read:${contextEvents.filter((e) => e === 'enter').length}`)
      return CSV_BYTES
    })

    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    // One context has been entered and left; the second has not opened yet.
    expect(order).toEqual(['read:1'])
    expect(contextEvents.slice(0, 2)).toEqual(['enter', 'commit'])
  })
})

describe('15-16. the action reaches the corpus only through governed surfaces', () => {
  // CODE, not prose. The header explains why finalize does not activate a
  // version and why no service role appears, so a raw-source match would fail
  // on the very comments that document the property. Same line filter
  // tests/cross-workstream/grounding-product-to-release.test.ts uses.
  const source = readFileSync(
    path.join(process.cwd(), 'app/actions/grounding/ingest-evidence.ts'),
    'utf8',
  )
    .split('\n')
    .filter((l) => {
      const t = l.trimStart()
      // `/*` covers a single-line `/** ... */`, which the two-token filter the
      // sibling suites use would leave in as if it were code.
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  it('writes no grounding table directly', () => {
    expect(source).not.toMatch(/evidence_chunks|evidence_document_versions/)
    expect(source).not.toMatch(/db\.insert\(|db\.update\(|db\.delete\(/)
  })

  it('invokes no governed function by name — the repository owns that', () => {
    expect(source).not.toMatch(
      /register_document_version|insert_evidence_chunks|finalize_document_ingestion/,
    )
  })

  it('names no privileged principal or service role', () => {
    expect(source).not.toMatch(/supabase_admin|SERVICE_ROLE|service_role|createAdminClient/)
  })

  it('reads exactly one property off the request', () => {
    expect(source).not.toMatch(/request\.(organizationId|projectId|filePath|mimeType|bytes)/)
  })
})

describe('17-18. audit and disclosure', () => {
  it('writes metadata only — no bytes, no path, no content', async () => {
    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(mockLogAuditAction).toHaveBeenCalledTimes(1)
    const entry = mockLogAuditAction.mock.calls[0][0] as {
      afterJson: Record<string, unknown>
      entityId: string
    }
    expect(entry.entityId).toBe(EVIDENCE)
    const serialized = JSON.stringify(entry.afterJson)
    expect(serialized).not.toContain(CSV)
    expect(serialized).not.toContain('padron.csv')
    expect(serialized).not.toContain(CSV_HASH)
    expect(Object.keys(entry.afterJson).sort()).toEqual([
      'chunkCount',
      'expectedChunkCount',
      'readerId',
      'reingestion',
      'repositoryId',
      'stage',
    ])
  })

  it('audits a refusal by reason, without the row that caused it', async () => {
    mockRead.mockResolvedValue(null)

    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    const entry = mockLogAuditAction.mock.calls[0][0] as { afterJson: Record<string, unknown> }
    expect(entry.afterJson).toMatchObject({ refusalReason: 'missing_bytes' })
    expect(JSON.stringify(entry.afterJson)).not.toContain('padron.csv')
  })

  it('writes no audit row when the caller was never entitled to the evidence', async () => {
    evidenceRows = []

    await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    // An audit row keyed to an evidence id the caller may not see would make
    // the trail itself the oracle the response refuses to be.
    expect(mockLogAuditAction).not.toHaveBeenCalled()
  })

  it('the disabled answer costs no authentication and no read', async () => {
    mockStellaConfig.isGroundedQueryEnabled = false

    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: EVIDENCE })

    expect(result).toEqual({ status: 'disabled' })
    expect(mockRequireOrganizationAccess).not.toHaveBeenCalled()
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('an empty evidence id is refused without a lookup', async () => {
    const result = await ingestProjectEvidenceForProject(PROJECT, { evidenceId: '   ' })

    expect(result).toEqual({ status: 'unauthorized' })
    expect(mockSelect).not.toHaveBeenCalled()
  })
})
