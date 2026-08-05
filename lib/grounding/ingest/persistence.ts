// lib/grounding/ingest/persistence.ts
// GROUNDING line — the pure boundary between ingestion and storage.
//
// This file is to ingestion what `retrieve/repository.ts` is to retrieval: it
// defines WHAT must be persisted and in what order, and knows nothing about
// WHERE. It imports nothing from `db/**`, opens no connection, holds no SQL.
//
// ---------------------------------------------------------------------------
// WHY THE PORT HAS EXACTLY FOUR OPERATIONS
// ---------------------------------------------------------------------------
// Not because four is a nice number, but because the governed SQL surface of
// `db/prepared/grounding_0002` + `grounding_0003` exposes exactly four entry
// points into the ingestion path, and a port with a fifth operation would be a
// port that cannot be implemented without writing ungoverned SQL:
//
//   claimActiveDocumentVersion  <- uellix_grounding.claim_active_document_version
//   registerDocumentVersion     <- uellix_grounding.register_document_version
//   insertEvidenceChunks        <- uellix_grounding.insert_evidence_chunks
//   finalizeDocumentIngestion   <- uellix_grounding.finalize_document_ingestion
//
// The mapping is one-to-one on purpose. An adapter that needs to compose two
// governed calls to satisfy one port operation is an adapter that has invented
// a transaction boundary the package did not define.
//
// ---------------------------------------------------------------------------
// SCOPE IS AN EXPECTATION HERE, NEVER AN ARGUMENT THERE
// ---------------------------------------------------------------------------
// `register_document_version` DERIVES organization and project from the
// evidence row and refuses to accept them — a caller that could state its own
// scope could file a version of another tenant's document under its own
// organization, and no predicate over the arguments could tell that apart from
// a legitimate call (grounding_0002 §8a).
//
// So `RegisterDocumentVersionRequest.scope` is the scope the CALLER BELIEVES it
// is writing into. It exists so an adapter can re-impose that belief locally
// and so a failure message can name the boundary. An adapter MUST NOT forward
// it as a function argument: there is no argument to forward it to, and adding
// one would undo the derivation.
//
// ---------------------------------------------------------------------------
// FAILURE IS TYPED, AND THE TYPE IS THE PACKAGE'S OWN VOCABULARY
// ---------------------------------------------------------------------------
// The governed functions raise five distinct SQLSTATEs, and they lead to five
// different actions. An adapter that collapsed them into one "database error"
// would make "you re-ingested under a new extractor" indistinguishable from
// "the connection dropped" — the first is a decision a human must make, the
// second is a retry. {@link GroundingPersistenceError} carries the distinction
// across the boundary without carrying any driver text.

import {
  CHUNKER_VERSION,
  EXTRACTOR_VERSION,
  INJECTION_SCANNER_VERSION,
  NORMALIZATION_VERSION,
  deriveChunkId,
  type ContentHash,
  type DeduplicationRecord,
  type GroundingChunk,
  type GroundingScope,
  type PromptInjectionSignal,
} from '../contracts'

// ---------------------------------------------------------------------------
// Typed failure
// ---------------------------------------------------------------------------

/** Which port operation failed. Named so a partial ingestion says WHERE it stopped. */
export type GroundingPersistenceOperation =
  | 'claim_active_document_version'
  | 'register_document_version'
  | 'insert_evidence_chunks'
  | 'finalize_document_ingestion'
  | 'build_chunk_payload'

/**
 * Why it failed, in the vocabulary the governed package already speaks.
 *
 * The SQLSTATE column is the ADAPTER'S mapping table — it is documented here
 * rather than in the adapter so the two halves of the boundary cannot drift:
 *
 *   U0100  invalid_request           malformed argument or payload
 *   U0101  pipeline_version_conflict same version_id, different pipeline
 *   U0102  evidence_not_found        absent, or outside the caller's orgs
 *   U0103  incomplete_ingestion      stored chunk count != expected
 *   U0104  chunk_identity_rejected   chunk_id does not derive from its triple
 *   (any)  unavailable               connection, timeout, package not applied
 *
 * `evidence_not_found` deliberately covers "not yours" as well: the package
 * raises the same code for both, because telling them apart is a tenancy
 * oracle. This type must not "improve" on that by splitting them.
 */
export type GroundingPersistenceFailureKind =
  | 'invalid_request'
  | 'pipeline_version_conflict'
  | 'evidence_not_found'
  | 'incomplete_ingestion'
  | 'chunk_identity_rejected'
  | 'unavailable'

export class GroundingPersistenceError extends Error {
  constructor(
    readonly kind: GroundingPersistenceFailureKind,
    readonly operation: GroundingPersistenceOperation,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'GroundingPersistenceError'
  }
}

/**
 * Whether a failure can be retried with the same input and a different outcome.
 *
 * Only `unavailable` can. The other four are statements about the request or
 * about stored state, and retrying them produces the same failure plus a second
 * audit entry — which is how a retry loop turns one problem into a log full of
 * them.
 */
export function isRetryablePersistenceFailure(error: GroundingPersistenceError): boolean {
  return error.kind === 'unavailable'
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/**
 * An opaque handle to a persisted document version row.
 *
 * A branded string rather than `string`: `insert_evidence_chunks` and
 * `finalize_document_ingestion` both take this and NOT `version_id`, and the
 * two are both 30-ish character strings in every log. Confusing them would
 * write chunks against the wrong row or assert a count against it.
 */
declare const documentVersionRefBrand: unique symbol
export type DocumentVersionRef = string & { readonly [documentVersionRefBrand]: 'evidence_document_versions.id' }

export function parseDocumentVersionRef(value: string): DocumentVersionRef {
  if (value.trim() === '') {
    throw new GroundingPersistenceError(
      'invalid_request',
      'register_document_version',
      'A document version reference must be a non-empty identifier',
    )
  }
  return value as DocumentVersionRef
}

/**
 * The pipeline state of the version currently at the head of a document's
 * history, exactly as `claim_active_document_version` returns it.
 *
 * NO SCOPE FIELD. The governed function returns seven columns and neither
 * `organization_id` nor `project_id` is among them, so a scope here could only
 * be restated by the adapter from the query — the same tautology INT-GR-004
 * describes on the read path. It is left absent rather than fabricated; see
 * {@link ChunkScopeProvenance} in `../retrieve/repository.ts` for the shape
 * this will take once the columns are returned.
 */
export interface ActiveDocumentVersionState {
  readonly ref: DocumentVersionRef
  readonly versionId: ContentHash
  readonly ordinal: number | null
  readonly normalizedContentHash: ContentHash
  readonly normalizationVersion: string
  readonly extractorVersion: string
  readonly chunkerVersion: string
}

export interface RegisterDocumentVersionRequest {
  /**
   * What the caller believes it is writing into. NEVER forwarded to the
   * governed function, which derives scope from `evidence_items` — see the
   * module header.
   */
  readonly scope: GroundingScope
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly rawContentHash: ContentHash
  readonly normalizedContentHash: ContentHash
  readonly normalizationVersion: string
  readonly extractorVersion: string
  readonly chunkerVersion: string
  readonly mimeType: string
}

export interface InsertEvidenceChunksRequest {
  readonly ref: DocumentVersionRef
  readonly chunks: readonly EvidenceChunkPayloadRow[]
}

export interface FinalizeDocumentIngestionRequest {
  readonly ref: DocumentVersionRef
  /** Canonical chunks only — suppressed occurrences are optional storage. */
  readonly expectedChunkCount: number
}

/**
 * One row of the `p_chunks` JSON array.
 *
 * SNAKE_CASE, deliberately. This is not a domain type wearing the wrong
 * convention: it is the literal shape `insert_evidence_chunks` destructures
 * with `jsonb_to_recordset(...) AS c(chunk_id char(64), chunk_index integer,
 * ...)`, which binds BY NAME. Spelling a field `chunkIndex` here would produce
 * a NULL column and a U0100 whose message names an argument the TypeScript
 * caller never wrote. Keeping the wire shape visible in the type is what makes
 * that class of bug a compile error instead of a runtime one.
 */
export interface EvidenceChunkPayloadRow {
  readonly chunk_id: string
  readonly chunk_index: number
  /** Present iff canonical — the table enforces the biconditional. */
  readonly content: string | null
  readonly content_hash: string
  readonly char_start: number
  readonly char_end: number
  readonly page: number | null
  readonly section_index: number | null
  readonly signals: readonly PromptInjectionSignal[]
  readonly canonical_chunk_id: string | null
  readonly embedding_provider_id: string | null
  readonly injection_scanner_version: string
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Where ingestion output goes.
 *
 * Async for the same reason `GroundingChunkRepository.fetchCandidates` is: the
 * implementation that matters is a database round trip.
 *
 * Every method REJECTS with {@link GroundingPersistenceError} on failure.
 * `claimActiveDocumentVersion` resolving to `null` is not a failure — it is the
 * answer "this document has no versions yet", which is the ordinary state of a
 * first ingestion.
 */
export interface GroundingIngestionRepository {
  /** Versioned identity, recorded in the ingestion record. */
  readonly id: string

  claimActiveDocumentVersion(evidenceId: string): Promise<ActiveDocumentVersionState | null>

  registerDocumentVersion(request: RegisterDocumentVersionRequest): Promise<DocumentVersionRef>

  /** Returns how many rows were actually inserted (0 on a full replay). */
  insertEvidenceChunks(request: InsertEvidenceChunksRequest): Promise<number>

  finalizeDocumentIngestion(request: FinalizeDocumentIngestionRequest): Promise<void>
}

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

/**
 * Build the `p_chunks` array for one document version.
 *
 * Two properties are load-bearing:
 *
 * 1. `chunk_id` is computed with {@link deriveChunkId} — the contract's own
 *    function — and NOT copied from anywhere else. `insert_evidence_chunks`
 *    re-derives it server-side from the same preimage
 *    ("grounding/chunk/v1\n<version_id>\n<chunk_index>\n<content_hash>") and
 *    raises U0104 on any disagreement. Using the contract function is therefore
 *    the only construction that can round-trip; a hand-written template string
 *    would compile and fail at the database.
 *
 * 2. Suppressed occurrences are emitted as duplicate rows with `content: null`
 *    and `canonical_chunk_id` set. Their `signals` are EMPTY rather than copied
 *    from the canonical chunk: the two occurrences hold identical text but sit
 *    at different offsets, and re-anchoring the canonical's spans here would
 *    assert a scan that never ran at those coordinates.
 *
 * Validation happens here, before any row leaves the process, and throws a
 * typed error. The database would reject the same payload with U0100, but as
 * one aggregate count over the batch — so a caller could not tell which chunk
 * was malformed without re-deriving the check anyway.
 */
export function buildEvidenceChunkPayload(
  versionId: ContentHash,
  chunks: readonly GroundingChunk[],
  duplicates: readonly DeduplicationRecord[] = [],
): readonly EvidenceChunkPayloadRow[] {
  const rows: EvidenceChunkPayloadRow[] = []

  for (const chunk of chunks) {
    if (chunk.versionId !== versionId) {
      throw new GroundingPersistenceError(
        'invalid_request',
        'build_chunk_payload',
        `Chunk ${chunk.chunkId} belongs to version ${chunk.versionId}, not to the version being persisted`,
      )
    }
    assertStorableSpan('build_chunk_payload', chunk.chunkId, chunk.location.span.start, chunk.location.span.end)

    rows.push({
      chunk_id: deriveChunkId(versionId, chunk.chunkIndex, chunk.contentHash),
      chunk_index: chunk.chunkIndex,
      content: chunk.text,
      content_hash: chunk.contentHash,
      char_start: chunk.location.span.start,
      char_end: chunk.location.span.end,
      page: chunk.location.page,
      section_index: chunk.location.sectionIndex,
      signals: chunk.signals,
      canonical_chunk_id: null,
      // No embeddings in this train; the column is nullable and a fabricated
      // provider id would claim vectors exist for rows that have none.
      embedding_provider_id: null,
      injection_scanner_version: INJECTION_SCANNER_VERSION,
    })
  }

  for (const duplicate of duplicates) {
    const span = duplicate.suppressedLocation.span
    assertStorableSpan('build_chunk_payload', duplicate.canonicalChunkId, span.start, span.end)

    rows.push({
      chunk_id: deriveChunkId(versionId, duplicate.suppressedChunkIndex, duplicate.contentHash),
      chunk_index: duplicate.suppressedChunkIndex,
      content: null,
      content_hash: duplicate.contentHash,
      char_start: span.start,
      char_end: span.end,
      page: duplicate.suppressedLocation.page,
      section_index: duplicate.suppressedLocation.sectionIndex,
      signals: [],
      canonical_chunk_id: duplicate.canonicalChunkId,
      embedding_provider_id: null,
      injection_scanner_version: INJECTION_SCANNER_VERSION,
    })
  }

  return rows
}

/**
 * `evidence_chunks_span_check` requires `char_end > char_start` strictly, so a
 * zero-length chunk is not merely useless — it is unstorable. Catching it here
 * names the chunk; the database would name only a count.
 */
function assertStorableSpan(
  operation: GroundingPersistenceOperation,
  chunkId: string,
  start: number,
  end: number,
): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new GroundingPersistenceError(
      'invalid_request',
      operation,
      `Chunk ${chunkId} occupies [${start}, ${end}), which is not a storable half-open span (0 <= start < end)`,
    )
  }
}

// ---------------------------------------------------------------------------
// Pipeline identity
// ---------------------------------------------------------------------------

/**
 * The four version constants a stored row must agree with, as one value.
 *
 * Published as a function rather than a constant object so a caller cannot hold
 * a stale reference across a version bump in a long-lived module scope, and so
 * the shape reads the same at every call site that compares against a row.
 */
export function currentPipelineIdentity(): {
  readonly normalizationVersion: string
  readonly extractorVersion: string
  readonly chunkerVersion: string
  readonly injectionScannerVersion: string
} {
  return {
    normalizationVersion: NORMALIZATION_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    injectionScannerVersion: INJECTION_SCANNER_VERSION,
  }
}
