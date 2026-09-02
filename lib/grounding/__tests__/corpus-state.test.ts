// lib/grounding/__tests__/corpus-state.test.ts
// G-01 (product path) — the derivation that turns DURABLE facts into the state
// a reviewer is shown.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS DURABLE HERE, AND WHY THE LIST IS SHORT
// ---------------------------------------------------------------------------
// Three facts, and no fourth:
//
//   1. the evidence ROW (kind, MIME type, path, hash) — decides whether the
//      pipeline could ever accept it;
//   2. the ACTIVE `evidence_document_versions` row and its canonical chunk
//      count — the only positive proof that content reached the corpus;
//   3. the LAST `evidence_item.indexed` audit row — the only durable record of
//      an attempt that wrote nothing, because a failed ingestion unwinds its
//      own transaction and leaves no version behind. The audit write is a
//      SEPARATE short transaction for exactly this reason.
//
// There is deliberately NO "indexing in progress" fact. An in-flight ingestion
// holds an uncommitted transaction and is unreadable by anyone else, so a
// durable INDEXING state cannot be derived — and inventing one from React state
// would be a claim about the system made by the browser. Progress is therefore
// the pending state of the action the user just submitted, and nothing else.
//
// ---------------------------------------------------------------------------
// PRECEDENCE IS THE POINT
// ---------------------------------------------------------------------------
// A version row OUTRANKS a failed attempt: an ingestion that succeeded and was
// then retried into a failure has content in the corpus, and telling the
// reviewer "failed" would be false about what a citation can reach. The tests
// below pin that order, because it is the one a later edit is most likely to
// reverse.

import { describe, expect, it } from 'vitest'

import {
  deriveEvidenceCorpusState,
  type ActiveVersionFact,
  type EvidenceRowFact,
  type IndexingAttemptFact,
} from '@/lib/grounding/corpus-state'
import { currentPipelineIdentity } from '@/lib/grounding/ingest'

const EVIDENCE = '55555555-5555-4555-8555-555555555555'
const PIPELINE = currentPipelineIdentity()

function row(overrides: Partial<EvidenceRowFact> = {}): EvidenceRowFact {
  return {
    id: EVIDENCE,
    status: 'draft',
    type: 'file',
    description: null,
    filePath: 'p/e/encuesta.txt',
    fileSize: 42,
    mimeType: 'text/plain',
    contentHash: 'a'.repeat(64),
    ...overrides,
  }
}

function version(overrides: Partial<ActiveVersionFact> = {}): ActiveVersionFact {
  return {
    evidenceId: EVIDENCE,
    ordinal: 1,
    chunkCount: 7,
    createdAt: '2026-08-15T10:00:00.000Z',
    normalizationVersion: PIPELINE.normalizationVersion,
    extractorVersion: PIPELINE.extractorVersion,
    chunkerVersion: PIPELINE.chunkerVersion,
    ...overrides,
  }
}

function attempt(overrides: Partial<IndexingAttemptFact> = {}): IndexingAttemptFact {
  return {
    evidenceId: EVIDENCE,
    at: '2026-08-15T09:00:00.000Z',
    stage: 'finalize',
    refusalReason: null,
    notIndexedReason: null,
    rolledBack: false,
    ...overrides,
  }
}

const MANAGER = { mayManage: true }
const VIEWER = { mayManage: false }

/* -------------------------------------------------------------------------- */
/* Indexed                                                                    */
/* -------------------------------------------------------------------------- */

describe('a committed version row is the positive proof of indexing', () => {
  it('reports INDEXED with the chunk count the corpus actually holds', () => {
    const state = deriveEvidenceCorpusState(row(), version(), null, MANAGER)
    expect(state).toMatchObject({
      evidenceId: EVIDENCE,
      phase: 'indexed',
      chunkCount: 7,
      versionOrdinal: 1,
      indexedAt: '2026-08-15T10:00:00.000Z',
      reason: null,
    })
  })

  it('does not offer a retry for a healthy indexed row', () => {
    // Re-ingesting identical bytes is a safe replay, but offering it on every
    // healthy row turns the one action that matters — repairing a failure —
    // into noise.
    expect(deriveEvidenceCorpusState(row(), version(), null, MANAGER).canRetry).toBe(false)
  })

  it('a version row OUTRANKS a later failed attempt', () => {
    // The corpus holds citable content. Reporting "failed" here would be false
    // about what a grounded answer can reach.
    const state = deriveEvidenceCorpusState(
      row(),
      version(),
      attempt({ stage: 'persist_chunks', rolledBack: true }),
      MANAGER,
    )
    expect(state.phase).toBe('indexed')
  })

  it('a version row OUTRANKS an unsupported-format verdict on the row', () => {
    // Content was indexed under some earlier pipeline. Denying it because the
    // extractor table changed would hide chunks a citation still resolves to.
    const state = deriveEvidenceCorpusState(row({ mimeType: 'application/pdf' }), version(), null, MANAGER)
    expect(state.phase).toBe('indexed')
  })
})

/* -------------------------------------------------------------------------- */
/* Incomplete and stale — the two ways an indexed row is not healthy          */
/* -------------------------------------------------------------------------- */

describe('a version row that is present but not usable', () => {
  it('reports INCOMPLETE when the active version holds no canonical chunks', () => {
    // The M-7 hazard made visible: `claim_active_document_version` selects the
    // highest ordinal with NO finalized-state predicate, so an empty version
    // becomes the active one and hides the last good content. Nothing else in
    // the product can see that; this is where it surfaces.
    const state = deriveEvidenceCorpusState(row(), version({ chunkCount: 0 }), null, MANAGER)
    expect(state).toMatchObject({ phase: 'incomplete', reason: 'no_chunks', chunkCount: 0 })
    expect(state.canRetry).toBe(true)
  })

  it('reports INDEXED_STALE when the stored version predates a pipeline bump', () => {
    // A normalization bump invalidates every stored offset: the chunks are
    // there and their anchors no longer address the text they were cut from.
    const state = deriveEvidenceCorpusState(
      row(),
      version({ normalizationVersion: 'norm-0' }),
      null,
      MANAGER,
    )
    expect(state).toMatchObject({ phase: 'indexed_stale', reason: 'pipeline_drift' })
    expect(state.canRetry).toBe(true)
  })

  it.each([['extractorVersion'], ['chunkerVersion']])(
    'a %s bump is drift too — not only normalization',
    (field) => {
      const state = deriveEvidenceCorpusState(
        row(),
        version({ [field]: 'stale-1' } as Partial<ActiveVersionFact>),
        null,
        MANAGER,
      )
      expect(state.phase).toBe('indexed_stale')
    },
  )

  it('an empty version is reported as INCOMPLETE even when it is also stale', () => {
    // Zero chunks is the more actionable of the two and the one that hides
    // content; reporting drift would send the operator to the version table.
    const state = deriveEvidenceCorpusState(
      row(),
      version({ chunkCount: 0, extractorVersion: 'stale-1' }),
      null,
      MANAGER,
    )
    expect(state.phase).toBe('incomplete')
  })
})

/* -------------------------------------------------------------------------- */
/* Not indexable — stored evidence that is not corpus material                */
/* -------------------------------------------------------------------------- */

describe('rows the pipeline can never accept', () => {
  it('reports NOT_INDEXABLE for a PDF, carrying the format blocker', () => {
    const state = deriveEvidenceCorpusState(row({ mimeType: 'application/pdf' }), null, null, MANAGER)
    expect(state).toMatchObject({ phase: 'not_indexable', reason: 'unsupported_format' })
    expect(state.detail).toBeTruthy()
  })

  it('never offers a retry for something that cannot succeed', () => {
    const state = deriveEvidenceCorpusState(row({ type: 'url' }), null, null, MANAGER)
    expect(state).toMatchObject({ phase: 'not_indexable', reason: 'unsupported_kind', canRetry: false })
  })

  it('the row verdict OUTRANKS a stale attempt record', () => {
    // A PDF that was attempted once is still a PDF. Reporting the attempt's
    // outcome would make the cause look transient.
    const state = deriveEvidenceCorpusState(
      row({ mimeType: 'application/pdf' }),
      null,
      attempt({ stage: 'persist_chunks', rolledBack: true }),
      MANAGER,
    )
    expect(state.phase).toBe('not_indexable')
  })
})

/* -------------------------------------------------------------------------- */
/* Failure, from the only durable record of it                                */
/* -------------------------------------------------------------------------- */

describe('an attempt that wrote nothing', () => {
  it('reports FAILED_RETRYABLE when the last attempt rolled its transaction back', () => {
    const state = deriveEvidenceCorpusState(
      row(),
      null,
      attempt({ stage: 'persist_chunks', rolledBack: true }),
      MANAGER,
    )
    expect(state).toMatchObject({ phase: 'failed_retryable', reason: 'write_failed', canRetry: true })
    expect(state.detail).toContain('persist_chunks')
  })

  it('reports FAILED_RETRYABLE when the stored object could not be read', () => {
    // `missing_bytes` is the one refusal that is about storage RIGHT NOW rather
    // than about the evidence, so it is the one worth retrying.
    const state = deriveEvidenceCorpusState(
      row(),
      null,
      attempt({ stage: 'resolve', refusalReason: 'missing_bytes' }),
      MANAGER,
    )
    expect(state).toMatchObject({ phase: 'failed_retryable', reason: 'missing_bytes', canRetry: true })
  })

  it('reports FAILED_TERMINAL when the stored bytes do not reproduce the row hash', () => {
    // Retrying re-reads the same object and re-computes the same digest. An
    // offer to retry would be an offer to fail again.
    const state = deriveEvidenceCorpusState(
      row(),
      null,
      attempt({ stage: 'resolve', refusalReason: 'content_hash_mismatch' }),
      MANAGER,
    )
    expect(state).toMatchObject({
      phase: 'failed_terminal',
      reason: 'content_hash_mismatch',
      canRetry: false,
    })
  })

  it.each([
    ['unsupported_format'],
    ['empty_document'],
    ['extraction_failed'],
    ['input_too_large'],
  ])('reports FAILED_TERMINAL for the not-indexed reason %s', (reason) => {
    const state = deriveEvidenceCorpusState(
      row(),
      null,
      attempt({ stage: 'not_indexed', notIndexedReason: reason }),
      MANAGER,
    )
    expect(state).toMatchObject({ phase: 'failed_terminal', reason, canRetry: false })
  })

  it('a SUCCESSFUL attempt record with no version row is not treated as success', () => {
    // The audit row is written outside the ingestion transaction and is never
    // awaited, so "finalize was reached" is not proof the version survived.
    // Only the version row is.
    const state = deriveEvidenceCorpusState(row(), null, attempt({ stage: 'finalize' }), MANAGER)
    expect(state.phase).toBe('ready_to_index')
  })
})

/* -------------------------------------------------------------------------- */
/* Ready, and who may act                                                     */
/* -------------------------------------------------------------------------- */

describe('ready to index', () => {
  it('reports READY_TO_INDEX for a supported row with no history', () => {
    const state = deriveEvidenceCorpusState(row(), null, null, MANAGER)
    expect(state).toMatchObject({
      phase: 'ready_to_index',
      reason: null,
      chunkCount: null,
      versionOrdinal: null,
      indexedAt: null,
      canRetry: true,
    })
  })

  it('withholds the action from a caller who may not manage evidence', () => {
    // The read model must not render an action the server action would refuse.
    expect(deriveEvidenceCorpusState(row(), null, null, VIEWER).canRetry).toBe(false)
    expect(
      deriveEvidenceCorpusState(row(), null, attempt({ rolledBack: true }), VIEWER).canRetry,
    ).toBe(false)
  })

  it('withholds the action on archived evidence', () => {
    // Archived evidence is excluded from every grounded answer by an allowlist
    // on the query side. Indexing it would spend a write on content no citation
    // can reach.
    const state = deriveEvidenceCorpusState(row({ status: 'archived' }), null, null, MANAGER)
    expect(state).toMatchObject({ phase: 'ready_to_index', canRetry: false })
  })
})
