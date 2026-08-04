// lib/grounding/contracts/documents.ts
// GROUNDING line — the document side of the grounding contracts.
//
// Three levels, deliberately distinct:
//
//   SourceDocument     the thing a human uploaded. Stable across edits.
//   DocumentVersion    one immutable byte-state of that thing. Its identity is
//                      DERIVED FROM CONTENT, not from a clock or a counter, so
//                      re-ingesting identical bytes yields the same version id
//                      and a one-character edit yields a different one.
//   NormalizedDocument the text that anchors actually address, plus a record
//                      of every transformation applied to get there.
//
// The separation exists so provenance can answer "which exact bytes support
// this citation?" without depending on any mutable row. `evidence_items` in
// the current schema has no version column — see the contract request in
// docs/ops/contracts/ — so the version identity is computed here and can be
// persisted later without changing this contract.

import type { ContentHash, GroundingScope, TextSpan } from './core'
import { hashContent } from './core'
import type { PromptInjectionSignal } from './safety'

// ---------------------------------------------------------------------------
// Source document
// ---------------------------------------------------------------------------

/** How the content reached the platform. Mirrors `evidence_items.type`. */
export type SourceDocumentKind = 'file' | 'url' | 'text'

/**
 * The uploaded artefact, independent of its content. `evidenceId` is the
 * existing `evidence_items.id`: this contract deliberately reuses the
 * platform's identity rather than minting a parallel one.
 */
export interface SourceDocument {
  readonly evidenceId: string
  readonly scope: GroundingScope
  readonly kind: SourceDocumentKind
  /** Original filename or URL, as supplied. Untrusted; never used as a path. */
  readonly label: string
  /** Normalized MIME type ("text/csv"), parameters already stripped. */
  readonly mimeType: string
  readonly byteSize: number
}

// ---------------------------------------------------------------------------
// Document version
// ---------------------------------------------------------------------------

/**
 * One immutable content state of a {@link SourceDocument}.
 *
 * `versionId` is a pure function of (evidenceId, rawContentHash). Two
 * consequences that the tests pin down:
 *   - ingesting the same bytes twice produces the same versionId, so
 *     re-ingestion is idempotent and never forks history;
 *   - changing a single character changes rawContentHash and therefore
 *     versionId, so "minimal change → new version" needs no change detection
 *     logic anywhere else.
 *
 * `ordinal` and `supersedes` are the HISTORY view, which only a caller holding
 * the prior versions can fill in. They are nullable precisely so a caller that
 * does not have that history cannot be tempted to invent one.
 */
export interface DocumentVersion {
  readonly versionId: ContentHash
  readonly evidenceId: string
  readonly scope: GroundingScope
  /** SHA-256 of the original bytes — the same digest evidence upload seals. */
  readonly rawContentHash: ContentHash
  /** SHA-256 of the normalized text these anchors address. */
  readonly normalizedContentHash: ContentHash
  /** Normalization contract version the normalized hash was produced under. */
  readonly normalizationVersion: string
  /** 1-based position in this document's history, when the caller knows it. */
  readonly ordinal: number | null
  /** versionId of the version this one replaces, when the caller knows it. */
  readonly supersedes: ContentHash | null
}

/**
 * Derive the content-addressed version identity. Kept separate from the
 * DocumentVersion factory so callers can compute "is this the version I
 * already have?" before doing any normalization work.
 */
export function deriveVersionId(evidenceId: string, rawContentHash: ContentHash): ContentHash {
  // The evidenceId is part of the preimage so that two different documents
  // holding identical bytes remain distinct versions of distinct documents —
  // otherwise a shared boilerplate annex would collapse two evidence items
  // into one version and the provenance chain would name the wrong upload.
  return hashContent(`grounding/version/v1\n${evidenceId}\n${rawContentHash}`)
}

// ---------------------------------------------------------------------------
// Normalized document
// ---------------------------------------------------------------------------

/**
 * One transformation the normalizer applied, and how much it changed.
 *
 * "Controlled noise removal" means exactly this: nothing is removed silently.
 * Each step names what it did and how many characters it touched, so an
 * auditor can see that (say) 4 200 characters vanished from a document and ask
 * why — rather than discovering it by diffing two hashes.
 */
export interface NormalizationStep {
  readonly id: NormalizationStepId
  readonly description: string
  /** Characters removed by this step (0 for pure substitutions). */
  readonly charsRemoved: number
  /** Characters replaced in place by this step. */
  readonly charsReplaced: number
}

export type NormalizationStepId =
  | 'strip_bom'
  | 'crlf_to_lf'
  | 'remove_invisible_characters'
  | 'nbsp_to_space'
  | 'strip_trailing_line_whitespace'
  | 'collapse_blank_runs'
  | 'form_feed_to_page_break'
  | 'truncate_to_char_cap'

/** A page or a labelled section of the normalized text. */
export interface DocumentSection {
  /** 0-based position among this document's sections. */
  readonly index: number
  readonly kind: 'page' | 'section'
  /** 1-based page number when the source has real pages, else null. */
  readonly page: number | null
  /** Human-facing label (a heading, "Page 3"), when one could be determined. */
  readonly label: string | null
  /** Span within the NORMALIZED document text. */
  readonly span: TextSpan
}

/**
 * The text that every anchor in this document addresses, plus the full record
 * of how it was derived. `text` is the coordinate space: an anchor's span is
 * meaningful only against this exact string, which is why
 * `normalizedContentHash` is part of {@link DocumentVersion}.
 */
export interface NormalizedDocument {
  readonly version: DocumentVersion
  readonly source: SourceDocument
  readonly text: string
  readonly sections: readonly DocumentSection[]
  readonly steps: readonly NormalizationStep[]
  /**
   * Signals found in the RAW text — principally hidden characters, which only
   * exist before noise removal deletes them. Chunk-level signals from the
   * normalized text live on the chunks themselves.
   */
  readonly rawSignals: readonly PromptInjectionSignal[]
  readonly meta: {
    readonly rawChars: number
    readonly normalizedChars: number
    /** True when the char cap forced a cut; anchors cover only the prefix. */
    readonly truncated: boolean
  }
}
