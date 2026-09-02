// lib/grounding/ingest/ingest-document.ts
// GROUNDING line — the deterministic ingestion core.
//
//   bytes -> extract -> normalize -> version -> sections -> chunks -> provenance
//
// Pure and synchronous end to end: no network, no filesystem, no database, no
// clock. That is not an aesthetic preference — it is what makes the pipeline
// verifiable. Given the same bytes and the same version constants, this
// function returns byte-identical output on any machine at any time, so a
// third party holding the sealed evidence file can reproduce every chunk id
// and every citation anchor without access to this system.
//
// FAILURE IS A RETURNED STATUS, NEVER A THROW (except for a scope violation,
// which is a programming defect rather than a document problem). Evidence
// upload must not be blocked by a document the grounding layer cannot read:
// the file and its SHA-256 are the chain of custody, and the grounding index
// is derived and regenerable.

import { extractDocument, MAX_GROUNDING_INPUT_BYTES, type ExtractionResult } from '../extract'
import {
  EXTRACTOR_VERSION,
  NORMALIZATION_VERSION,
  assertValidScope,
  deriveVersionId,
  hashBytes,
  hashContent,
  textSpan,
  type ContentHash,
  type DeduplicationRecord,
  type DocumentSection,
  type DocumentVersion,
  type GroundingChunk,
  type NormalizedDocument,
  type SourceDocument,
} from '../contracts'
import { chunkNormalizedDocument, type ChunkDocumentOptions } from './chunk-document'
import { normalizeDocumentText } from './normalize'

/**
 * The two facts a predecessor contributes to a new version's history.
 *
 * Narrowed from a full {@link DocumentVersion} because the governed
 * `claim_active_document_version` returns seven columns and a whole
 * DocumentVersion is not among them — asking for one would force a caller to
 * fabricate `scope` and `rawContentHash` for a row it only knows partially,
 * which is exactly the invention `ordinal`/`supersedes` are nullable to
 * prevent. A full DocumentVersion still satisfies this type structurally, so
 * every existing caller keeps compiling.
 */
export type PreviousVersionRef = Pick<DocumentVersion, 'versionId' | 'ordinal'>

export interface IngestOptions extends ChunkDocumentOptions {
  /**
   * The version this ingestion supersedes, when the caller knows the history.
   * Supplying it fills `ordinal` and `supersedes`; omitting it leaves both
   * null rather than inventing a history that may be wrong.
   */
  readonly previousVersion?: PreviousVersionRef | null
}

export type IngestionSkipReason = 'unsupported_format' | 'empty_document'
export type IngestionRejectReason = 'input_too_large' | 'extraction_failed'

export interface IngestionIngested {
  readonly status: 'ingested'
  readonly document: NormalizedDocument
  readonly chunks: readonly GroundingChunk[]
  readonly duplicates: readonly DeduplicationRecord[]
  readonly warnings: readonly string[]
  readonly stats: {
    readonly rawBytes: number
    readonly rawChars: number
    readonly normalizedChars: number
    readonly chunkCount: number
    readonly duplicateCount: number
    readonly pageCount: number
    readonly truncated: boolean
    readonly stoppedAtChunkCap: boolean
  }
}

export interface IngestionSkipped {
  readonly status: 'skipped'
  readonly reason: IngestionSkipReason
  /** Known even when nothing could be extracted — the bytes still have a hash. */
  readonly rawContentHash: ContentHash
  readonly warnings: readonly string[]
}

export interface IngestionRejected {
  readonly status: 'rejected'
  readonly reason: IngestionRejectReason
  readonly rawContentHash: ContentHash | null
  readonly warnings: readonly string[]
}

export type IngestionOutcome = IngestionIngested | IngestionSkipped | IngestionRejected

/**
 * The separator used to hand extractor-supplied pages to the normalizer, which
 * already understands form feeds as page boundaries. Reusing that one code
 * path means paginated and unpaginated documents cannot drift apart in how
 * their pages are located.
 *
 * This inserts a structural marker derived from real extractor output; it
 * never invents document content.
 */
const PAGE_SEPARATOR = '\f'

/**
 * Ingest one evidence document.
 *
 * @param source metadata for the evidence item (identity, scope, MIME type)
 * @param bytes  the file exactly as uploaded — the same buffer the SHA-256 in
 *               lib/pipeline/evidence.ts is computed from
 */
export function ingestDocument(
  source: SourceDocument,
  bytes: Buffer,
  options: IngestOptions = {},
): IngestionOutcome {
  // A malformed scope is a caller bug, not a document problem: fail loudly
  // rather than producing records that cannot be isolated.
  assertValidScope(source.scope)

  if (bytes.length > MAX_GROUNDING_INPUT_BYTES) {
    return {
      status: 'rejected',
      reason: 'input_too_large',
      // Not hashed: hashing a buffer past the cap is the cost the cap exists
      // to avoid, and the upload layer has already sealed the file anyway.
      rawContentHash: null,
      warnings: [
        `File is ${bytes.length} bytes, above the ${MAX_GROUNDING_INPUT_BYTES}-byte grounding input cap`,
      ],
    }
  }

  const rawContentHash = hashBytes(bytes)
  const extraction = extractDocument(bytes, source.mimeType)

  if (extraction.status === 'unsupported') {
    return { status: 'skipped', reason: 'unsupported_format', rawContentHash, warnings: extraction.warnings }
  }
  if (extraction.status === 'error') {
    return { status: 'rejected', reason: 'extraction_failed', rawContentHash, warnings: extraction.warnings }
  }

  const normalized = normalizeDocumentText(rawTextOf(extraction))

  if (normalized.text.trim() === '') {
    return {
      status: 'skipped',
      reason: 'empty_document',
      rawContentHash,
      warnings: [...extraction.warnings, 'Document contains no extractable text after normalization'],
    }
  }

  const normalizedContentHash = hashContent(normalized.text)
  const versionId = deriveVersionId(source.evidenceId, rawContentHash)

  const version: DocumentVersion = {
    versionId,
    evidenceId: source.evidenceId,
    scope: source.scope,
    rawContentHash,
    normalizedContentHash,
    normalizationVersion: NORMALIZATION_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    ordinal: options.previousVersion ? (options.previousVersion.ordinal ?? 0) + 1 : null,
    supersedes: options.previousVersion ? options.previousVersion.versionId : null,
  }

  const sections = buildPageSections(normalized.text, normalized.pageBreakOffsets)

  const document: NormalizedDocument = {
    version,
    source,
    text: normalized.text,
    sections,
    steps: normalized.steps,
    rawSignals: normalized.rawSignals,
    meta: {
      rawChars: normalized.rawChars,
      normalizedChars: normalized.text.length,
      truncated: normalized.truncated || extraction.meta.truncated,
    },
  }

  const { chunks, duplicates, stoppedAtChunkCap } = chunkNormalizedDocument(document, options)

  const warnings = [...extraction.warnings]
  if (stoppedAtChunkCap) {
    warnings.push('Chunk cap reached; the tail of this document is not indexed and must be reingested with a larger cap')
  }

  return {
    status: 'ingested',
    document,
    chunks,
    duplicates,
    warnings,
    stats: {
      rawBytes: bytes.length,
      rawChars: normalized.rawChars,
      normalizedChars: normalized.text.length,
      chunkCount: chunks.length,
      duplicateCount: duplicates.length,
      pageCount: sections.length,
      truncated: document.meta.truncated,
      stoppedAtChunkCap,
    },
  }
}

/**
 * The text handed to the normalizer.
 *
 * When the extractor reports native pages, they are joined with a form feed so
 * the normalizer's existing page-boundary handling locates them; otherwise the
 * flat text is used as-is. No extractor in the tree emits pages today (PDF is
 * gated on the G5 dependency decision), so this branch is dormant — but it is
 * the seam that keeps a future PDF extractor from needing a second pagination
 * code path.
 */
function rawTextOf(extraction: ExtractionResult): string {
  if (extraction.pages.length === 0) return extraction.text
  return extraction.pages.map((page) => page.text).join(PAGE_SEPARATOR)
}

/**
 * Turn recorded page-break offsets into sections.
 *
 * `label` stays null: a form feed says "a page starts here" and nothing more.
 * Deriving a title from the following line would be inventing structure the
 * document did not state, which is exactly what a provenance layer must not do.
 * The UI can render "página N" from `page` when it wants a caption.
 */
function buildPageSections(text: string, breaks: readonly number[]): DocumentSection[] {
  if (breaks.length === 0) return []

  const boundaries = [0, ...breaks].filter((offset, i, all) => i === 0 || offset > all[i - 1])
  return boundaries.map((start, i) => ({
    index: i,
    kind: 'page' as const,
    page: i + 1,
    label: null,
    span: textSpan(start, i + 1 < boundaries.length ? boundaries[i + 1] : text.length),
  }))
}
