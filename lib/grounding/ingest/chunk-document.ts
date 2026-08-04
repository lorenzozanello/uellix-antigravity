// lib/grounding/ingest/chunk-document.ts
// GROUNDING line — turn a normalized document into citable, provenanced chunks.
//
// The boundary-finding itself is NOT reimplemented here: it delegates to
// lib/grounding/chunk.ts, whose anchor-reconstruction and full-coverage
// properties are already pinned by tests. That module normalizes CRLF->LF
// before computing offsets, which is a no-op on text that has already been
// through normalize.ts — so its offsets land exactly in our coordinate space.
//
// What this module adds is everything a citation needs beyond a substring:
// one coordinate space for the whole document (not per page), the provenance
// chain, page/section location, structural signals, and deduplication that
// removes redundancy from the index without removing it from the record.

import { chunkText, DEFAULT_OVERLAP_CHARS, DEFAULT_TARGET_CHARS } from '../chunk'
import {
  CHUNKER_VERSION,
  INJECTION_SCANNER_VERSION,
  deriveChunkId,
  hashContent,
  lineRangeForSpan,
  textSpan,
  type ChunkLocation,
  type ContentHash,
  type DeduplicationRecord,
  type DocumentSection,
  type GroundingChunk,
  type NormalizedDocument,
  type ProvenanceRecord,
} from '../contracts'
import { scanNormalizedText } from './injection-scan'

/**
 * Backstop against a pathological targetChars turning a 1 MB document into
 * hundreds of thousands of rows. At the default target this is roughly ten
 * times what the character cap can produce, so it never fires in normal use —
 * and when it does fire, it is reported, never silent.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 10_000

export interface ChunkDocumentOptions {
  readonly targetChars?: number
  readonly overlapChars?: number
  readonly maxChunks?: number
}

export interface ChunkDocumentOutput {
  readonly chunks: readonly GroundingChunk[]
  readonly duplicates: readonly DeduplicationRecord[]
  /** True when the chunk cap stopped the walk before the document ended. */
  readonly stoppedAtChunkCap: boolean
}

/** The document, or each of its pages, as a region to chunk independently. */
interface Segment {
  readonly start: number
  readonly end: number
  readonly page: number | null
  readonly sectionIndex: number | null
  readonly sectionLabel: string | null
}

function segmentsFor(document: NormalizedDocument): Segment[] {
  if (document.sections.length === 0) {
    return [{ start: 0, end: document.text.length, page: null, sectionIndex: null, sectionLabel: null }]
  }
  return document.sections.map((section: DocumentSection) => ({
    start: section.span.start,
    end: section.span.end,
    page: section.page,
    sectionIndex: section.index,
    sectionLabel: section.label,
  }))
}

/**
 * Chunk a normalized document.
 *
 * Chunking runs per segment so a chunk never straddles a page boundary — a
 * citation that spans two pages cannot be located on either. Offsets are then
 * translated to be DOCUMENT-absolute: one coordinate space per document means
 * a verifier re-normalizes once and slices once, instead of having to
 * reconstruct the page split first.
 */
export function chunkNormalizedDocument(
  document: NormalizedDocument,
  options: ChunkDocumentOptions = {},
): ChunkDocumentOutput {
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS
  const maxChunks = options.maxChunks ?? MAX_CHUNKS_PER_DOCUMENT

  const provenance: ProvenanceRecord = {
    evidenceId: document.source.evidenceId,
    scope: document.source.scope,
    versionId: document.version.versionId,
    rawContentHash: document.version.rawContentHash,
    normalizedContentHash: document.version.normalizedContentHash,
    normalizationVersion: document.version.normalizationVersion,
    chunkerVersion: CHUNKER_VERSION,
    injectionScannerVersion: INJECTION_SCANNER_VERSION,
    sourceLabel: document.source.label,
    mimeType: document.source.mimeType,
  }

  const chunks: GroundingChunk[] = []
  const duplicates: DeduplicationRecord[] = []
  // contentHash -> chunkId of the first occurrence. Deduplication is scoped to
  // one document version: identical boilerplate in two different evidence
  // items must stay separately citable, because they are separate evidence.
  const seen = new Map<ContentHash, ContentHash>()

  let chunkIndex = 0
  let stoppedAtChunkCap = false

  for (const segment of segmentsFor(document)) {
    if (stoppedAtChunkCap) break
    const segmentText = document.text.slice(segment.start, segment.end)
    const local = chunkText(segmentText, {
      evidenceId: document.source.evidenceId,
      page: segment.page,
      targetChars,
      overlapChars,
    })

    for (const piece of local) {
      if (chunkIndex >= maxChunks) {
        stoppedAtChunkCap = true
        break
      }
      const span = widenPastSurrogatePairs(
        document.text,
        segment.start + piece.anchor.charStart,
        segment.start + piece.anchor.charEnd,
      )
      // Derived from the span, not copied from the chunker: this makes the
      // reconstruction invariant true by construction rather than by
      // agreement between two pieces of code.
      const chunkContent = document.text.slice(span.start, span.end)
      const { lineStart, lineEnd } = lineRangeForSpan(document.text, span)
      const location: ChunkLocation = {
        span,
        coordinateSpace: document.version.normalizedContentHash,
        page: segment.page,
        sectionIndex: segment.sectionIndex,
        sectionLabel: segment.sectionLabel,
        lineStart,
        lineEnd,
      }

      const contentHash = hashContent(chunkContent)
      const index = chunkIndex++

      const canonical = seen.get(contentHash)
      if (canonical !== undefined) {
        // Suppressed from the index, preserved in the record: a reviewer asking
        // "where else does this appear?" still gets a real answer, and no
        // citation silently relocates to a different page.
        duplicates.push({
          contentHash,
          canonicalChunkId: canonical,
          suppressedLocation: location,
          suppressedChunkIndex: index,
        })
        continue
      }

      const chunkId = deriveChunkId(document.version.versionId, index, contentHash)
      seen.set(contentHash, chunkId)

      chunks.push({
        chunkId,
        scope: document.source.scope,
        evidenceId: document.source.evidenceId,
        versionId: document.version.versionId,
        chunkIndex: index,
        text: chunkContent,
        contentHash,
        location,
        provenance,
        // Document-absolute offsets, so a signal can be pointed at the passage
        // in the same coordinate space as every citation.
        signals: scanNormalizedText(chunkContent, span.start),
      })
    }
  }

  return { chunks, duplicates, stoppedAtChunkCap }
}

/**
 * Nudge a span outward so neither edge falls between the halves of a UTF-16
 * surrogate pair.
 *
 * The underlying chunker measures in code units, so a hard split inside
 * emoji-dense or CJK-extension text can leave a lone surrogate at a boundary.
 * A lone surrogate is not valid UTF-8: Postgres rejects it on insert, and any
 * hash computed over it describes a string that can never be stored. Widening
 * (never narrowing) keeps full coverage intact — adjacent chunks simply
 * overlap by one more code unit, which they already do by design.
 */
function widenPastSurrogatePairs(text: string, start: number, end: number) {
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

  let from = start
  let to = end
  if (from > 0 && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from -= 1
  if (to < text.length && isHigh(text.charCodeAt(to - 1)) && isLow(text.charCodeAt(to))) to += 1
  return textSpan(from, to)
}
