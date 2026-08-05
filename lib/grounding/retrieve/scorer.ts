// lib/grounding/retrieve/scorer.ts
// GROUNDING line — query normalization and the pluggable scoring interface.
//
// The scorer is an interface with one lexical implementation, and the shape is
// chosen so that adding embeddings later changes WHICH scorer is passed in and
// nothing else. Specifically:
//
//   - scoreChunks is async, though the lexical implementation needs no await.
//     A semantic provider calls a network API; if this were synchronous, adding
//     one would change every signature above it, which is the "temporary"
//     decision that ends up permanent.
//   - the scorer returns numbers, not an ordering. Ranking, deduplication,
//     per-document caps and diversity are policy that must not vary by
//     strategy, or two strategies would produce answers that differ in ways
//     nobody can attribute to relevance.
//   - `id` is versioned, like EmbeddingProvider.id: a scorer change invalidates
//     comparisons against historical scores, and silently reusing an old
//     threshold on a new scale is how a calibrated system decalibrates.
//
// No provider is called here. Nothing in this file reaches the network.

import type { GroundingChunk, RetrievalStrategy } from '../contracts'
import { tokenize } from '../embedding-provider'

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

export interface NormalizedQuery {
  /** The query reduced to its comparison form; not shown to users. */
  readonly text: string
  /** Tokens in order of appearance, duplicates retained. */
  readonly tokens: readonly string[]
  /** Distinct tokens, in first-appearance order — stable across runs. */
  readonly terms: readonly string[]
}

/**
 * Fold a query into the same space chunk text is compared in.
 *
 * `tokenize` is reused from the embedding provider rather than reimplemented:
 * query and document must be folded identically, and two implementations of
 * "lowercase and strip diacritics" drift the moment one of them is fixed.
 */
export function normalizeQueryText(text: string): NormalizedQuery {
  const tokens = tokenize(text)
  const terms: string[] = []
  for (const token of tokens) {
    if (!terms.includes(token)) terms.push(token)
  }
  return { text: tokens.join(' '), tokens, terms }
}

// ---------------------------------------------------------------------------
// Scorer interface
// ---------------------------------------------------------------------------

export interface ChunkScorer {
  /** Versioned identity; a change means stored scores are no longer comparable. */
  readonly id: string
  readonly strategy: RetrievalStrategy
  /**
   * Score each chunk against the query, in the SAME ORDER as the input.
   * Scores must lie in [0, 1] and be a pure function of (query, chunks): the
   * whole determinism guarantee rests on that.
   */
  scoreChunks(query: NormalizedQuery, chunks: readonly GroundingChunk[]): Promise<readonly number[]>
}

// ---------------------------------------------------------------------------
// Lexical scorer
// ---------------------------------------------------------------------------

/**
 * Term-frequency saturation constant. Above it, repeating a term stops earning
 * much: a chunk naming "beneficiarios" nine times is not nine times as
 * relevant as one naming it once, and without saturation a keyword-stuffed
 * passage outranks the passage that actually answers the question.
 */
export const TF_SATURATION_K = 1.2

/** Ceiling of the saturation curve, used to normalize scores into [0, 1]. */
const TF_SATURATION_CEILING = TF_SATURATION_K + 1

function saturatedTermFrequency(frequency: number): number {
  if (frequency <= 0) return 0
  return (frequency * TF_SATURATION_CEILING) / (frequency + TF_SATURATION_K)
}

/**
 * Deterministic lexical scoring: inverse document frequency over the candidate
 * set, weighted by saturated term frequency, normalized to [0, 1].
 *
 * Two properties are deliberate and tested:
 *
 * 1. The score is bounded. An unbounded score cannot be thresholded, and a
 *    presentation bucket over an unbounded score is meaningless.
 * 2. IDF is computed over THE CANDIDATE SET, not a global corpus. That keeps
 *    the function pure — the same candidates always produce the same scores —
 *    at the cost of scores not being comparable across queries. The contract
 *    already says exactly that (`RetrievalCandidate.score` is "comparable only
 *    within one query and one strategy"), so this implementation matches the
 *    guarantee that was published rather than quietly exceeding it.
 */
export class LexicalChunkScorer implements ChunkScorer {
  readonly id = 'lexical-idf-tf-v1'
  readonly strategy: RetrievalStrategy = 'lexical'

  async scoreChunks(
    query: NormalizedQuery,
    chunks: readonly GroundingChunk[],
  ): Promise<readonly number[]> {
    if (query.terms.length === 0 || chunks.length === 0) {
      return chunks.map(() => 0)
    }

    const chunkFrequencies = chunks.map((chunk) => termFrequencies(chunk.text))
    const total = chunks.length

    // Accumulate idf in a fixed term order so floating-point addition happens
    // in the same sequence on every run.
    const idf = new Map<string, number>()
    for (const term of query.terms) {
      let documentFrequency = 0
      for (const frequencies of chunkFrequencies) {
        if (frequencies.has(term)) documentFrequency++
      }
      idf.set(term, Math.log(1 + total / (documentFrequency + 1)))
    }

    let maximum = 0
    for (const term of query.terms) maximum += (idf.get(term) ?? 0) * TF_SATURATION_CEILING
    if (maximum === 0) return chunks.map(() => 0)

    return chunkFrequencies.map((frequencies) => {
      let accumulated = 0
      for (const term of query.terms) {
        const frequency = frequencies.get(term) ?? 0
        if (frequency === 0) continue
        accumulated += (idf.get(term) ?? 0) * saturatedTermFrequency(frequency)
      }
      return accumulated / maximum
    })
  }
}

function termFrequencies(text: string): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>()
  for (const token of tokenize(text)) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  return frequencies
}
