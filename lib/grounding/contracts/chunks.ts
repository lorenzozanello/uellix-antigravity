// lib/grounding/contracts/chunks.ts
// GROUNDING line — the unit of retrieval and the unit of provenance.
//
// A GroundingChunk is the smallest thing Stella is allowed to cite. Everything
// needed to VERIFY a citation without trusting this process travels with it:
// the raw bytes' hash, the normalized text's hash, the pipeline versions, and
// a span in a named coordinate space. Given the sealed original file, a third
// party can re-run normalization at the stated version, slice the stated span,
// hash the result, and get `contentHash` back. That chain — and not any
// database row — is what makes a citation auditable.
//
// No timestamps appear in this file. Chunk identity must be a pure function of
// content, or "the same document produces the same chunks" stops being true
// the moment a clock is involved.

import type { ContentHash, GroundingScope, TextSpan } from './core'
import { hashContent } from './core'
import type { PromptInjectionSignal } from './safety'

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * Where a chunk sits inside its document.
 *
 * `coordinateSpace` is the normalized text's hash. It is what stops an anchor
 * produced under one normalization version from being silently resolved
 * against text produced under another — the spans would still be integers in
 * range, and the quoted passage would be wrong.
 */
export interface ChunkLocation {
  readonly span: TextSpan
  readonly coordinateSpace: ContentHash
  /** 1-based page when the source paginates, else null. */
  readonly page: number | null
  /** Index into NormalizedDocument.sections, when the chunk sits in one. */
  readonly sectionIndex: number | null
  readonly sectionLabel: string | null
  /**
   * 1-based line range within the normalized text, for humans. Derived, not
   * authoritative — the span is the authority.
   */
  readonly lineStart: number
  readonly lineEnd: number
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The verification chain for one chunk: original bytes → normalized text →
 * span → chunk text. Every field is needed to re-derive the chunk from the
 * sealed original; none of them is a convenience copy.
 */
export interface ProvenanceRecord {
  readonly evidenceId: string
  readonly scope: GroundingScope
  readonly versionId: ContentHash
  /** SHA-256 of the original bytes, as sealed at upload. */
  readonly rawContentHash: ContentHash
  /** SHA-256 of the normalized text the span indexes. */
  readonly normalizedContentHash: ContentHash
  readonly normalizationVersion: string
  readonly chunkerVersion: string
  readonly injectionScannerVersion: string
  /** Untrusted display label of the source (filename/URL) — never a path. */
  readonly sourceLabel: string
  readonly mimeType: string
}

// ---------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------

export interface GroundingChunk {
  /** Content-addressed identity; see {@link deriveChunkId}. */
  readonly chunkId: ContentHash
  readonly scope: GroundingScope
  readonly evidenceId: string
  readonly versionId: ContentHash
  /**
   * 0-based, in document order. NOT contiguous: indexes are assigned before
   * deduplication and kept afterwards, so a gap says "the chunk that would
   * have sat here duplicated an earlier one" — see {@link DeduplicationRecord}.
   * Renumbering after dedup would make a chunk's id depend on what else the
   * document happened to contain.
   */
  readonly chunkIndex: number
  readonly text: string
  /** SHA-256 of `text` — the dedupe key within a version. */
  readonly contentHash: ContentHash
  readonly location: ChunkLocation
  readonly provenance: ProvenanceRecord
  /**
   * Structural signals found in THIS chunk's text. Always present (possibly
   * empty) so a consumer cannot mistake "not scanned" for "clean".
   */
  readonly signals: readonly PromptInjectionSignal[]
}

/**
 * Chunk identity, derived from (versionId, chunkIndex, contentHash).
 *
 * chunkIndex is in the preimage on purpose: two chunks of a document can hold
 * identical text (a repeated header on every page), and collapsing them into
 * one id would make the second occurrence uncitable. Deduplication is a
 * separate, explicit decision — see {@link DeduplicationRecord} — not an
 * accident of how ids are computed.
 */
export function deriveChunkId(
  versionId: ContentHash,
  chunkIndex: number,
  contentHash: ContentHash,
): ContentHash {
  return hashContent(`grounding/chunk/v1\n${versionId}\n${chunkIndex}\n${contentHash}`)
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * A chunk that was suppressed because an earlier chunk in the same version had
 * identical text.
 *
 * Deduplication removes the chunk from the retrieval index — indexing the same
 * boilerplate forty times crowds out real content — but it must NOT remove the
 * fact that the passage occurs at those places. So the suppressed location is
 * kept here and points at the surviving chunk. A reviewer asking "where else
 * does this sentence appear?" gets a real answer; a citation never silently
 * relocates to a different page.
 */
export interface DeduplicationRecord {
  readonly contentHash: ContentHash
  /** chunkId of the chunk that was kept. */
  readonly canonicalChunkId: ContentHash
  /** Where the suppressed occurrence sat. */
  readonly suppressedLocation: ChunkLocation
  /** chunkIndex the suppressed occurrence would have had. */
  readonly suppressedChunkIndex: number
}

/** 1-based line numbers for a span, for the human-facing part of a location. */
export function lineRangeForSpan(text: string, span: TextSpan): { lineStart: number; lineEnd: number } {
  let line = 1
  let lineStart = 1
  for (let i = 0; i < span.start && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  lineStart = line
  for (let i = span.start; i < span.end && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  // A span ending exactly on a newline should not claim the following line.
  const lineEnd = span.end > span.start && text[span.end - 1] === '\n' ? Math.max(lineStart, line - 1) : line
  return { lineStart, lineEnd }
}
