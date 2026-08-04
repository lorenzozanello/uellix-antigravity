// lib/grounding/contracts/retrieval.ts
// GROUNDING line — the query/answer boundary of retrieval.
//
// This file defines the SHAPE of retrieval only. No index, no embeddings, no
// remote calls: those are later units, and defining their inputs and outputs
// first is what lets PRODUCT build against a stable surface while the backing
// implementation is still lexical, in-memory, or absent.
//
// Two invariants are carried in the types rather than in prose:
//   - a query is scoped. There is no "search everything" call to accidentally
//     reach for, because GroundingScope is a required field, not an option.
//   - a candidate is untrusted. `untrusted: true` is a literal type, so no
//     consumer can construct a candidate that claims otherwise.

import type { GroundingChunk } from './chunks'
import type { GroundingScope } from './core'
import type { PromptInjectionSeverity } from './safety'

/**
 * How candidates were found. Recorded on every candidate so a downstream
 * quality question ("why did this weak passage rank first?") is answerable
 * without knowing which implementation was deployed that day.
 */
export type RetrievalStrategy = 'lexical' | 'vector' | 'hybrid' | 'exact_reference'

export interface RetrievalQuery {
  /** Isolation boundary. Required — there is no unscoped query. */
  readonly scope: GroundingScope
  /** The question, already sanitized by the caller. */
  readonly text: string
  /** Maximum candidates to return. */
  readonly topK: number
  /**
   * Candidates scoring below this are dropped rather than returned weakly.
   * Returning noise is worse than returning nothing: a weak candidate becomes
   * a filler citation, and a filler citation is indistinguishable from a real
   * one to everyone except the reviewer who checks it.
   */
  readonly minScore: number
  /** Restrict to specific evidence items; empty means "any within scope". */
  readonly evidenceIds: readonly string[]
  /**
   * Signal severity at which a chunk is withheld from results entirely.
   * `'critical'` is the default policy (see safety.mustQuarantine).
   */
  readonly quarantineAtOrAbove: PromptInjectionSeverity
}

export interface RetrievalCandidate {
  readonly chunk: GroundingChunk
  /** Comparable only within one query and one strategy. */
  readonly score: number
  /** 0-based position in the returned ranking. */
  readonly rank: number
  readonly strategy: RetrievalStrategy
  /**
   * Extracted document content is data, never instructions. The literal type
   * makes the flag impossible to omit or to set to false.
   */
  readonly untrusted: true
}

export interface RetrievalResult {
  readonly query: RetrievalQuery
  readonly candidates: readonly RetrievalCandidate[]
  /**
   * Chunks that matched but were withheld for safety, reported as a count and
   * their reasons — never silently dropped, because "no results" and "results
   * suppressed" must lead to different conversations with a reviewer.
   */
  readonly quarantinedCount: number
  /** Candidates dropped for scoring below `minScore`. */
  readonly belowThresholdCount: number
}

/** Defaults chosen so a caller that omits policy still gets the safe policy. */
export const DEFAULT_RETRIEVAL_TOP_K = 8
export const DEFAULT_RETRIEVAL_MIN_SCORE = 0.15

export function buildRetrievalQuery(
  scope: GroundingScope,
  text: string,
  overrides: Partial<Omit<RetrievalQuery, 'scope' | 'text'>> = {},
): RetrievalQuery {
  return {
    scope,
    text,
    topK: overrides.topK ?? DEFAULT_RETRIEVAL_TOP_K,
    minScore: overrides.minScore ?? DEFAULT_RETRIEVAL_MIN_SCORE,
    evidenceIds: overrides.evidenceIds ?? [],
    quarantineAtOrAbove: overrides.quarantineAtOrAbove ?? 'critical',
  }
}
