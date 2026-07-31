// lib/grounding/chunk.ts
// WS5 (document grounding): deterministic chunker with reconstructible
// citation anchors.
//
// Anchor contract (docs/19_DOCUMENT_GROUNDING_SPEC.md §5):
//   normalizeForAnchors(sourceText).slice(anchor.charStart, anchor.charEnd) === chunk.text
//
// Normalization is exactly CRLF|CR -> LF (nothing else: no trim, no Unicode
// normalization), so anchors survive line-ending differences between the
// uploaded file and any later re-download, while remaining byte-verifiable
// against the SHA-256-sealed original. For page-aware extractions, offsets are
// relative to that page's normalized text; for unpaged text, relative to the
// whole normalized document.

import type { ExtractionResult } from './extract'

export interface ChunkAnchor {
  evidenceId: string
  page: number | null
  charStart: number
  charEnd: number
}

export interface ChunkMeta {
  /** Documented normalization applied before offsets were computed. */
  normalization: 'crlf-to-lf'
  /** Length of the normalized source text the offsets refer to. */
  sourceChars: number
}

export interface DocumentChunk {
  chunkIndex: number
  text: string
  anchor: ChunkAnchor
  meta: ChunkMeta
}

export interface ChunkTextOptions {
  evidenceId: string
  page?: number | null
  targetChars?: number
  overlapChars?: number
  chunkIndexOffset?: number
}

export const DEFAULT_TARGET_CHARS = 1000
export const DEFAULT_OVERLAP_CHARS = 150

/** CRLF and lone CR become LF. The only normalization anchors are subject to. */
export function normalizeForAnchors(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Pick the chunk end within (start, hardEnd]: prefer the last paragraph break,
 * then the last line break, then the last space — each only if the resulting
 * chunk is at least half the target size — otherwise hard-split at hardEnd.
 * The boundary characters stay inside the chunk so that consecutive slices
 * remain contiguous (full-coverage invariant).
 */
function findBreakEnd(norm: string, start: number, hardEnd: number, minLen: number): number {
  const window = norm.slice(start, hardEnd)
  const para = window.lastIndexOf('\n\n')
  if (para >= minLen) return start + para + 2
  const line = window.lastIndexOf('\n')
  if (line >= minLen) return start + line + 1
  const space = window.lastIndexOf(' ')
  if (space >= minLen) return start + space + 1
  return hardEnd
}

/**
 * Deterministically chunk a text into overlapping windows (~targetChars, with
 * ~overlapChars of context carried into the next chunk), breaking on
 * paragraph/row boundaries where possible. Whitespace-only chunks are dropped;
 * the union of anchors still covers every non-whitespace character.
 */
export function chunkText(text: string, options: ChunkTextOptions): DocumentChunk[] {
  const {
    evidenceId,
    page = null,
    targetChars = DEFAULT_TARGET_CHARS,
    overlapChars = DEFAULT_OVERLAP_CHARS,
    chunkIndexOffset = 0,
  } = options
  if (targetChars <= 0) throw new Error('targetChars must be positive')
  if (overlapChars < 0 || overlapChars >= targetChars) {
    throw new Error('overlapChars must be in [0, targetChars)')
  }

  const norm = normalizeForAnchors(text)
  if (norm.trim() === '') return []

  const meta: ChunkMeta = { normalization: 'crlf-to-lf', sourceChars: norm.length }
  const minBreakLen = Math.floor(targetChars / 2)
  const chunks: DocumentChunk[] = []
  let chunkIndex = chunkIndexOffset
  let start = 0

  while (start < norm.length) {
    const hardEnd = Math.min(start + targetChars, norm.length)
    const end = hardEnd < norm.length ? findBreakEnd(norm, start, hardEnd, minBreakLen) : hardEnd
    const slice = norm.slice(start, end)
    if (slice.trim() !== '') {
      chunks.push({
        chunkIndex: chunkIndex++,
        text: slice,
        anchor: { evidenceId, page, charStart: start, charEnd: end },
        meta,
      })
    }
    if (end >= norm.length) break
    const next = end - overlapChars
    start = next > start ? next : end
  }

  return chunks
}

/**
 * Chunk a full ExtractionResult. Page-aware extractions are chunked per page
 * (anchors carry the page number; offsets are page-scoped); unpaged text is
 * chunked as a whole with page: null. chunkIndex stays continuous across the
 * document. Unsupported/error extractions yield no chunks.
 */
export function chunkExtraction(
  extraction: ExtractionResult,
  evidenceId: string,
  options?: Pick<ChunkTextOptions, 'targetChars' | 'overlapChars'>,
): DocumentChunk[] {
  if (extraction.status !== 'extracted') return []

  if (extraction.pages.length > 0) {
    const chunks: DocumentChunk[] = []
    for (const page of extraction.pages) {
      chunks.push(
        ...chunkText(page.text, {
          ...options,
          evidenceId,
          page: page.page,
          chunkIndexOffset: chunks.length,
        }),
      )
    }
    return chunks
  }

  return chunkText(extraction.text, { ...options, evidenceId, page: null })
}
