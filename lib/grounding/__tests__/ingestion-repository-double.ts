// lib/grounding/__tests__/ingestion-repository-double.ts
// GROUNDING line — an in-memory stand-in for the GOVERNED SQL surface.
//
// This is a double for the DATABASE, not for the code under test. It lives in
// __tests__ and is imported by nothing in `lib/grounding/**` runtime, which is
// the line that matters: the ingestion orchestrator is exercised by running it
// for real against a store that behaves like `grounding_0002` +
// `grounding_0003`, never by handing it a pre-built answer.
//
// Every behaviour below mirrors a specific guarantee of the prepared packages,
// and the point of mirroring them is that a test which passes here would pass
// there:
//
//   register_document_version   idempotent on (evidence_id, version_id);
//                               raises U0101 when the same version is
//                               re-registered under a different pipeline;
//                               derives the ordinal and the supersedes link.
//   claim_active_document_version  returns max(ordinal), or nothing.
//   insert_evidence_chunks      RE-DERIVES chunk_id from
//                               (version_id, chunk_index, content_hash) and
//                               raises U0104 on disagreement; inserts with
//                               ON CONFLICT DO NOTHING; returns the row count.
//   finalize_document_ingestion compares stored canonical rows against the
//                               expected count and raises U0103 otherwise.
//
// What it deliberately does NOT model: RLS, roles, advisory locks, and scope
// derivation from `evidence_items`. Those are enforced by the database and
// cannot be re-created in TypeScript; a double that pretended to enforce them
// would let a test assert an isolation guarantee this layer does not provide.

import { deriveChunkId, type ContentHash } from '../contracts'
import {
  GroundingPersistenceError,
  parseDocumentVersionRef,
  type ActiveDocumentVersionState,
  type DocumentVersionRef,
  type EvidenceChunkPayloadRow,
  type FinalizeDocumentIngestionRequest,
  type GroundingIngestionRepository,
  type InsertEvidenceChunksRequest,
  type RegisterDocumentVersionRequest,
} from '../ingest/persistence'

export interface StoredDocumentVersion {
  readonly ref: DocumentVersionRef
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly rawContentHash: ContentHash
  readonly normalizedContentHash: ContentHash
  readonly normalizationVersion: string
  readonly extractorVersion: string
  readonly chunkerVersion: string
  readonly mimeType: string
  readonly ordinal: number
  readonly supersedes: ContentHash | null
}

/** Where a run can be told to fail, to exercise the partial-persistence paths. */
export type InjectedFailurePoint = 'claim' | 'register' | 'insert' | 'finalize'

export interface IngestionRepositoryDoubleOptions {
  readonly id?: string
  readonly failAt?: InjectedFailurePoint
  readonly failure?: GroundingPersistenceError
  /**
   * Drop this many rows from the END of every chunk batch before storing them,
   * without telling the caller. This is the truncated-batch scenario the
   * finalize step exists to catch — the writer reports what it was given, the
   * store keeps less, and only the count assertion notices.
   */
  readonly dropTrailingChunks?: number
}

export class IngestionRepositoryDouble implements GroundingIngestionRepository {
  readonly id: string

  private readonly versions: StoredDocumentVersion[] = []
  private readonly chunks = new Map<string, EvidenceChunkPayloadRow>()
  private sequence = 0

  /** Call counts, so a test can assert a stage was NOT reached. */
  readonly calls = { claim: 0, register: 0, insert: 0, finalize: 0 }

  constructor(private readonly options: IngestionRepositoryDoubleOptions = {}) {
    this.id = options.id ?? 'test-ingestion-repository-double'
  }

  /** Seed a version as though a previous ingestion had stored it. */
  seedVersion(
    version: Omit<StoredDocumentVersion, 'ref' | 'ordinal' | 'supersedes'> & {
      ordinal?: number
      supersedes?: ContentHash | null
    },
  ): StoredDocumentVersion {
    const stored: StoredDocumentVersion = {
      ...version,
      supersedes: version.supersedes ?? null,
      ref: parseDocumentVersionRef(`version-${++this.sequence}`),
      ordinal: version.ordinal ?? this.versions.filter((v) => v.evidenceId === version.evidenceId).length + 1,
    }
    this.versions.push(stored)
    return stored
  }

  storedVersions(): readonly StoredDocumentVersion[] {
    return this.versions
  }

  canonicalChunkCount(ref: DocumentVersionRef): number {
    let count = 0
    for (const [key, row] of this.chunks) {
      if (key.startsWith(`${ref}\n`) && row.canonical_chunk_id === null) count++
    }
    return count
  }

  storedChunkIds(ref: DocumentVersionRef): readonly string[] {
    const ids: string[] = []
    for (const [key, row] of this.chunks) {
      if (key.startsWith(`${ref}\n`)) ids.push(row.chunk_id)
    }
    return ids.sort()
  }

  async claimActiveDocumentVersion(evidenceId: string): Promise<ActiveDocumentVersionState | null> {
    this.calls.claim++
    this.failIfInjected('claim', 'claim_active_document_version')

    const rows = this.versions.filter((version) => version.evidenceId === evidenceId)
    if (rows.length === 0) return null

    const active = rows.reduce((best, row) => (row.ordinal > best.ordinal ? row : best))
    // The seven columns the governed function returns, and no more. Adding a
    // scope here would let a test rely on a field production does not have.
    return {
      ref: active.ref,
      versionId: active.versionId,
      ordinal: active.ordinal,
      normalizedContentHash: active.normalizedContentHash,
      normalizationVersion: active.normalizationVersion,
      extractorVersion: active.extractorVersion,
      chunkerVersion: active.chunkerVersion,
    }
  }

  async registerDocumentVersion(request: RegisterDocumentVersionRequest): Promise<DocumentVersionRef> {
    this.calls.register++
    this.failIfInjected('register', 'register_document_version')

    const existing = this.versions.find(
      (version) => version.evidenceId === request.evidenceId && version.versionId === request.versionId,
    )
    if (existing) {
      // U0101 — same bytes, different pipeline. Idempotent is not permissive.
      if (
        existing.normalizedContentHash !== request.normalizedContentHash ||
        existing.normalizationVersion !== request.normalizationVersion ||
        existing.extractorVersion !== request.extractorVersion ||
        existing.chunkerVersion !== request.chunkerVersion
      ) {
        throw new GroundingPersistenceError(
          'pipeline_version_conflict',
          'register_document_version',
          'this version is already registered under a different pipeline',
        )
      }
      return existing.ref
    }

    const previous = this.versions
      .filter((version) => version.evidenceId === request.evidenceId)
      .reduce<StoredDocumentVersion | null>((best, row) => (best === null || row.ordinal > best.ordinal ? row : best), null)

    const stored: StoredDocumentVersion = {
      ref: parseDocumentVersionRef(`version-${++this.sequence}`),
      evidenceId: request.evidenceId,
      versionId: request.versionId,
      rawContentHash: request.rawContentHash,
      normalizedContentHash: request.normalizedContentHash,
      normalizationVersion: request.normalizationVersion,
      extractorVersion: request.extractorVersion,
      chunkerVersion: request.chunkerVersion,
      mimeType: request.mimeType,
      ordinal: (previous?.ordinal ?? 0) + 1,
      supersedes: previous?.versionId ?? null,
    }
    this.versions.push(stored)
    return stored.ref
  }

  async insertEvidenceChunks(request: InsertEvidenceChunksRequest): Promise<number> {
    this.calls.insert++
    this.failIfInjected('insert', 'insert_evidence_chunks')

    const version = this.versions.find((row) => row.ref === request.ref)
    if (!version) {
      throw new GroundingPersistenceError('evidence_not_found', 'insert_evidence_chunks', 'document version not found')
    }

    // U0104 — the server derives chunk_id and refuses a caller's disagreement.
    for (const row of request.chunks) {
      const derived = deriveChunkId(version.versionId, row.chunk_index, row.content_hash as ContentHash)
      if (derived !== row.chunk_id) {
        throw new GroundingPersistenceError(
          'chunk_identity_rejected',
          'insert_evidence_chunks',
          'a chunk_id does not derive from (version_id, chunk_index, content_hash)',
        )
      }
    }

    const drop = this.options.dropTrailingChunks ?? 0
    const admitted = drop > 0 ? request.chunks.slice(0, Math.max(0, request.chunks.length - drop)) : request.chunks

    let inserted = 0
    for (const row of admitted) {
      const key = `${request.ref}\n${row.chunk_id}`
      if (this.chunks.has(key)) continue // ON CONFLICT (chunk_id) DO NOTHING
      this.chunks.set(key, row)
      inserted++
    }
    return inserted
  }

  async finalizeDocumentIngestion(request: FinalizeDocumentIngestionRequest): Promise<void> {
    this.calls.finalize++
    this.failIfInjected('finalize', 'finalize_document_ingestion')

    const actual = this.canonicalChunkCount(request.ref)
    if (actual !== request.expectedChunkCount) {
      throw new GroundingPersistenceError(
        'incomplete_ingestion',
        'finalize_document_ingestion',
        `ingestion incomplete — ${actual} canonical chunk(s) stored, ${request.expectedChunkCount} expected`,
      )
    }
  }

  private failIfInjected(
    point: InjectedFailurePoint,
    operation: GroundingPersistenceError['operation'],
  ): void {
    if (this.options.failAt !== point) return
    throw (
      this.options.failure ??
      // An untyped rejection on purpose: the orchestrator must admit it into
      // the typed vocabulary as `unavailable` rather than let it escape.
      new Error(`connection refused during ${operation}`)
    )
  }
}
