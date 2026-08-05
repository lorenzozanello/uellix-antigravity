// lib/grounding/ingest/orchestrate-ingestion.ts
// GROUNDING line — the single entry point for "index this evidence file".
//
//   raw bytes
//     -> claimActiveDocumentVersion   (history, under the ingestion lock)
//     -> ingestDocument               (extract -> normalize -> version ->
//                                      chunk -> scan; pure, from ./ingest-document)
//     -> registerDocumentVersion      (persist the version)
//     -> insertEvidenceChunks         (persist the chunks)
//     -> finalizeDocumentIngestion    (assert the count, or fail the write)
//
// This is a COMPOSITION ROOT, like `retrieve/orchestrate.ts`. It invents no
// pipeline stage: extraction, normalization, versioning, chunking and scanning
// all happen inside `ingestDocument`, unchanged. What this module adds is the
// ORDER, the history lookup that `ingestDocument` deliberately refuses to
// invent, and the failure vocabulary that makes a half-written index loud.
//
// ---------------------------------------------------------------------------
// NO SILENT PARTIAL PERSISTENCE
// ---------------------------------------------------------------------------
// The failure mode this module exists to prevent is an index that looks
// complete and is not: a chunk batch that lost its tail leaves a version whose
// retrieval simply never returns the missing passages, and the answer abstains
// or cites something else with no signal that the document was truncated.
//
// Three things prevent it, and none of them is a comment:
//
//   1. `finalize_document_ingestion` compares the stored canonical count to the
//      count this module produced, and fails the transaction otherwise.
//   2. Every returned failure names the STAGE it stopped at and what had
//      already been written when it did (see {@link IngestionRunFailure}).
//   3. There is no catch-all that turns a write failure into a `skipped`
//      status. Skipping is a statement about the DOCUMENT (unreadable format,
//      no text); a write failure is a statement about the SYSTEM, and the two
//      lead to different actions.
//
// PURE except through the injected repository. Zero imports from `db/**`, no
// fetch, no clock, no filesystem, no provider.

import {
  GroundingScopeViolationError,
  assertValidScope,
  deriveVersionId,
  hashBytes,
  type ContentHash,
  type GroundingScope,
  type SourceDocument,
} from '../contracts'
import { MAX_GROUNDING_INPUT_BYTES } from '../extract'
import { ingestDocument, type IngestOptions, type IngestionOutcome } from './ingest-document'
import {
  GroundingPersistenceError,
  buildEvidenceChunkPayload,
  currentPipelineIdentity,
  type ActiveDocumentVersionState,
  type DocumentVersionRef,
  type EvidenceChunkPayloadRow,
  type GroundingIngestionRepository,
} from './persistence'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** Where a run stopped. Also the order the stages run in. */
export type IngestionStage =
  | 'claim_history'
  | 'build_payload'
  | 'register_version'
  | 'persist_chunks'
  | 'finalize'

/**
 * What this ingestion was, relative to what was already stored.
 *
 * `identical_replay` is not a no-op and must not be reported as one: the same
 * bytes under the same pipeline are re-registered (idempotently), re-offered to
 * the chunk writer (which inserts only rows that are missing) and re-finalized
 * (which asserts the count). A replay is therefore the repair path for an
 * ingestion that died between the chunk write and the finalize, and reporting
 * it as "nothing to do" would remove the only route back from that state.
 */
export type ReingestionKind = 'first_ingestion' | 'identical_replay' | 'new_version'

export interface IngestionRunPersisted {
  readonly status: 'persisted'
  readonly stage: 'finalize'
  readonly ingestion: Extract<IngestionOutcome, { status: 'ingested' }>
  readonly reingestion: ReingestionKind
  readonly ref: DocumentVersionRef
  /** Rows the writer actually inserted. 0 on a complete replay. */
  readonly insertedChunkCount: number
  /** Canonical chunks this ingestion produced — what `finalize` was told. */
  readonly expectedChunkCount: number
  /** Suppressed occurrences offered to the writer, or 0 when not persisted. */
  readonly duplicateRowCount: number
  readonly repositoryId: string
}

/**
 * The document could not be indexed, and NOTHING was written.
 *
 * Carries the original `ingestDocument` outcome verbatim so the reason
 * (`unsupported_format`, `empty_document`, `input_too_large`,
 * `extraction_failed`) keeps its existing vocabulary rather than gaining a
 * second one here.
 */
export interface IngestionRunNotIndexed {
  readonly status: 'not_indexed'
  readonly ingestion: Exclude<IngestionOutcome, { status: 'ingested' }>
  readonly repositoryId: string
}

/**
 * A write failed. `written` is the honest account of what survives in the
 * database — never an assumption that a failed step wrote nothing.
 */
export interface IngestionRunFailure {
  readonly status: 'failed'
  readonly stage: IngestionStage
  readonly failure: GroundingPersistenceError
  /** Null when the run failed before extraction produced anything. */
  readonly ingestion: Extract<IngestionOutcome, { status: 'ingested' }> | null
  readonly written: {
    /** Non-null once the version row exists — it does even if chunks failed. */
    readonly ref: DocumentVersionRef | null
    /** Non-null once the chunk writer returned; null means it never did. */
    readonly insertedChunkCount: number | null
    readonly expectedChunkCount: number | null
  }
  readonly repositoryId: string
}

export type IngestionRunOutcome = IngestionRunPersisted | IngestionRunNotIndexed | IngestionRunFailure

export interface IngestEvidenceOptions extends IngestOptions {
  /**
   * Whether suppressed duplicate occurrences are stored alongside the canonical
   * chunks. Default true: `DeduplicationRecord` exists so a reviewer asking
   * "where else does this sentence appear?" gets a real answer, and dropping
   * the rows at the persistence boundary would silently make that unanswerable.
   *
   * `finalize_document_ingestion` counts canonical rows only, so this choice
   * never affects whether an ingestion is judged complete.
   */
  readonly persistDuplicates?: boolean
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Ingest one evidence document and persist it through the governed surface.
 *
 * @param repository the persistence port; wrap the real adapter, never `db/**`
 * @param source     evidence identity, scope and MIME type
 * @param bytes      the file exactly as uploaded — the buffer whose SHA-256
 *                   `lib/pipeline/evidence.ts` sealed at upload
 *
 * THROWS only on a scope violation, which is a caller defect rather than a
 * document or a storage problem. Every other failure is a returned
 * {@link IngestionRunFailure} carrying a typed
 * {@link GroundingPersistenceError} — the same choice `ingestDocument` makes,
 * for the same reason: evidence upload must not be blocked by the grounding
 * index, which is derived and regenerable.
 */
export async function ingestEvidenceDocument(
  repository: GroundingIngestionRepository,
  source: SourceDocument,
  bytes: Buffer,
  options: IngestEvidenceOptions = {},
): Promise<IngestionRunOutcome> {
  assertValidScope(source.scope)

  // --- history -------------------------------------------------------------
  let active: ActiveDocumentVersionState | null
  try {
    active = await repository.claimActiveDocumentVersion(source.evidenceId)
  } catch (error) {
    return failure('claim_history', asPersistenceError(error, 'claim_active_document_version'), repository.id, {
      ingestion: null,
      ref: null,
      insertedChunkCount: null,
      expectedChunkCount: null,
    })
  }

  // The version identity is derived BEFORE ingestion so `previousVersion` can
  // be decided correctly. Without it, a replay of already-stored bytes would be
  // handed its own row as its predecessor and the resulting DocumentVersion
  // would claim to supersede itself — a false history in the ingestion record,
  // even though `register_document_version` computes the stored ordinal and
  // supersedes link server-side and would never see it.
  //
  // Cost: the buffer is hashed twice, here and inside `ingestDocument`. That is
  // the price of `ingestDocument` staying a pure function of (source, bytes)
  // with its own size-cap branch, rather than this module reimplementing the
  // branch to share a hash.
  const derivedVersionId = withinSizeCap(bytes) ? deriveVersionId(source.evidenceId, hashBytes(bytes)) : null
  const isReplay = active !== null && derivedVersionId !== null && active.versionId === derivedVersionId

  const ingestion = ingestDocument(source, bytes, {
    ...options,
    previousVersion: isReplay ? null : active,
  })

  if (ingestion.status !== 'ingested') {
    return { status: 'not_indexed', ingestion, repositoryId: repository.id }
  }

  const version = ingestion.document.version
  assertScopeUnchanged(source.scope, version.scope)

  const reingestion: ReingestionKind = active === null ? 'first_ingestion' : isReplay ? 'identical_replay' : 'new_version'

  // --- pipeline drift, detected before it becomes an opaque U0101 ----------
  if (isReplay && active !== null) {
    const drift = describePipelineDrift(active, version.normalizedContentHash)
    if (drift !== null) {
      return failure(
        'register_version',
        new GroundingPersistenceError('pipeline_version_conflict', 'register_document_version', drift),
        repository.id,
        { ingestion, ref: null, insertedChunkCount: null, expectedChunkCount: ingestion.chunks.length },
      )
    }
  }

  // --- payload -------------------------------------------------------------
  const persistDuplicates = options.persistDuplicates ?? true
  let payload: readonly EvidenceChunkPayloadRow[]
  try {
    payload = buildEvidenceChunkPayload(
      version.versionId,
      ingestion.chunks,
      persistDuplicates ? ingestion.duplicates : [],
    )
  } catch (error) {
    return failure('build_payload', asPersistenceError(error, 'build_chunk_payload'), repository.id, {
      ingestion,
      ref: null,
      insertedChunkCount: null,
      expectedChunkCount: ingestion.chunks.length,
    })
  }

  // --- register ------------------------------------------------------------
  let ref: DocumentVersionRef
  try {
    ref = await repository.registerDocumentVersion({
      scope: source.scope,
      evidenceId: source.evidenceId,
      versionId: version.versionId,
      rawContentHash: version.rawContentHash,
      normalizedContentHash: version.normalizedContentHash,
      normalizationVersion: version.normalizationVersion,
      extractorVersion: version.extractorVersion,
      chunkerVersion: ingestion.chunks[0]?.provenance.chunkerVersion ?? currentPipelineIdentity().chunkerVersion,
      mimeType: source.mimeType,
    })
  } catch (error) {
    return failure('register_version', asPersistenceError(error, 'register_document_version'), repository.id, {
      ingestion,
      ref: null,
      insertedChunkCount: null,
      expectedChunkCount: ingestion.chunks.length,
    })
  }

  // --- chunks --------------------------------------------------------------
  let insertedChunkCount: number
  try {
    insertedChunkCount = await repository.insertEvidenceChunks({ ref, chunks: payload })
  } catch (error) {
    // The version row exists and is append-only. Reporting `ref: null` here
    // would describe a database this run did not leave behind.
    return failure('persist_chunks', asPersistenceError(error, 'insert_evidence_chunks'), repository.id, {
      ingestion,
      ref,
      insertedChunkCount: null,
      expectedChunkCount: ingestion.chunks.length,
    })
  }

  // --- finalize ------------------------------------------------------------
  try {
    await repository.finalizeDocumentIngestion({ ref, expectedChunkCount: ingestion.chunks.length })
  } catch (error) {
    return failure('finalize', asPersistenceError(error, 'finalize_document_ingestion'), repository.id, {
      ingestion,
      ref,
      insertedChunkCount,
      expectedChunkCount: ingestion.chunks.length,
    })
  }

  return {
    status: 'persisted',
    stage: 'finalize',
    ingestion,
    reingestion,
    ref,
    insertedChunkCount,
    expectedChunkCount: ingestion.chunks.length,
    duplicateRowCount: persistDuplicates ? ingestion.duplicates.length : 0,
    repositoryId: repository.id,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withinSizeCap(bytes: Buffer): boolean {
  return bytes.length <= MAX_GROUNDING_INPUT_BYTES
}

/**
 * Which pipeline facts of an already-stored version disagree with this run.
 *
 * Detected HERE rather than left to the database because
 * `register_document_version` raises U0101 with a message that names no field —
 * deliberately, since an error string echoed to an untrusted caller is an
 * oracle. On this side of the boundary there is no such constraint and the
 * operator needs to know WHICH fact changed: a normalization bump invalidates
 * every stored offset, an extractor bump invalidates the text but not the
 * coordinate space, and the two are repaired differently.
 *
 * Returns null when nothing drifted.
 */
function describePipelineDrift(
  stored: ActiveDocumentVersionState,
  normalizedContentHash: ContentHash,
): string | null {
  const current = currentPipelineIdentity()
  const drifted: string[] = []

  if (stored.normalizationVersion !== current.normalizationVersion) {
    drifted.push(`normalization ${stored.normalizationVersion} -> ${current.normalizationVersion}`)
  }
  if (stored.extractorVersion !== current.extractorVersion) {
    drifted.push(`extractor ${stored.extractorVersion} -> ${current.extractorVersion}`)
  }
  if (stored.chunkerVersion !== current.chunkerVersion) {
    drifted.push(`chunker ${stored.chunkerVersion} -> ${current.chunkerVersion}`)
  }
  // Checked last and reported alongside the versions: identical constants with
  // a different normalized hash means the pipeline changed WITHOUT a version
  // bump, which is worse than a declared bump and must not look milder.
  if (stored.normalizedContentHash !== normalizedContentHash) {
    drifted.push(
      drifted.length === 0
        ? 'normalized content hash changed while every pipeline version stayed the same — a pipeline changed without a version bump'
        : 'normalized content hash',
    )
  }

  if (drifted.length === 0) return null
  return `Version ${stored.versionId} is already stored under a different pipeline (${drifted.join('; ')}); every offset recorded for it would stop resolving`
}

/**
 * The scope on the produced version must be the scope that was asked for.
 *
 * `ingestDocument` copies it from `source`, so this can only fire if that
 * copy is ever replaced by a derivation — which is exactly when a loud failure
 * is worth having. It throws rather than returning a failure because a scope
 * mismatch is a programming defect, not a storage condition.
 */
function assertScopeUnchanged(expected: GroundingScope, actual: GroundingScope): void {
  if (expected.organizationId !== actual.organizationId || expected.projectId !== actual.projectId) {
    throw new GroundingScopeViolationError(expected, actual, 'the document version produced by ingestion')
  }
}

/**
 * Admit an unknown rejection into the typed vocabulary.
 *
 * An adapter that already speaks {@link GroundingPersistenceError} is passed
 * through untouched — its SQLSTATE mapping is authoritative and this function
 * must not overwrite it. Anything else becomes `unavailable`, which is the only
 * honest classification for a rejection whose cause this layer cannot read: a
 * connection refused, a package that was never applied, a driver throwing a
 * string. The original is kept as `cause`, never interpolated into the message,
 * so driver text cannot travel to a caller that sanitizes on the assumption
 * that it does not.
 */
function asPersistenceError(
  error: unknown,
  operation: GroundingPersistenceError['operation'],
): GroundingPersistenceError {
  if (error instanceof GroundingPersistenceError) return error
  if (error instanceof GroundingScopeViolationError) throw error
  return new GroundingPersistenceError(
    'unavailable',
    operation,
    `The grounding persistence layer did not complete ${operation}`,
    { cause: error },
  )
}

function failure(
  stage: IngestionStage,
  error: GroundingPersistenceError,
  repositoryId: string,
  written: {
    ingestion: Extract<IngestionOutcome, { status: 'ingested' }> | null
    ref: DocumentVersionRef | null
    insertedChunkCount: number | null
    expectedChunkCount: number | null
  },
): IngestionRunFailure {
  return {
    status: 'failed',
    stage,
    failure: error,
    ingestion: written.ingestion,
    written: {
      ref: written.ref,
      insertedChunkCount: written.insertedChunkCount,
      expectedChunkCount: written.expectedChunkCount,
    },
    repositoryId,
  }
}
