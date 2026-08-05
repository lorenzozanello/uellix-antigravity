// lib/grounding/retrieve/retrieve.ts
// GROUNDING line — the scoped retrieval pipeline.
//
//   fetch (scope-guarded) -> quarantine -> score -> threshold -> rank
//     -> deduplicate -> per-document cap -> top-k -> source diversity
//
// Every stage can only REMOVE candidates, and every removal is recorded with a
// reason. That is the design rule this file exists to hold: a candidate that
// disappears without a recorded reason is indistinguishable from a candidate
// that was never there, and the two demand different responses — one is "your
// evidence does not cover this", the other is "your evidence covers this and
// the system chose not to show it".
//
// Scope is enforced at the SOURCE, not at the end. Filtering an out-of-scope
// chunk out of the final ranking would still have scored it, still have let it
// influence idf, and still have been one refactor away from surfacing. The
// repository guard means an out-of-scope chunk never enters the pipeline at
// all — and if one does, retrieval fails loudly rather than ranking it away.

import {
  buildRetrievalQuery,
  highestSeverity,
  type ContentHash,
  type GroundingChunk,
  type GroundingScope,
  type PromptInjectionSeverity,
  type RetrievalCandidate,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievalStrategy,
} from '../contracts'
import { buildChunkQuery, type GroundingChunkRepository } from './repository'
import { LexicalChunkScorer, normalizeQueryText, type ChunkScorer } from './scorer'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * Why a candidate is not in the result.
 *
 * `displaced_for_source_diversity` is the uncomfortable one, and it is named
 * rather than hidden on purpose: it marks a chunk that scored HIGHER than one
 * that was kept. A reviewer who cannot see that has no way to tell relevance
 * ranking from policy.
 */
export type RetrievalExclusionReason =
  | 'below_min_score'
  | 'quarantined'
  | 'duplicate_content'
  | 'over_document_limit'
  | 'beyond_top_k'
  | 'displaced_for_source_diversity'

export interface RetrievalExclusion {
  readonly chunkId: ContentHash
  readonly evidenceId: string
  readonly reason: RetrievalExclusionReason
  /** The score the candidate had when it was excluded. */
  readonly score: number
  readonly detail: string
}

/**
 * A retrieval result plus everything needed to explain it.
 *
 * Extends the published {@link RetrievalResult} rather than replacing it: a
 * consumer written against the contract keeps working, and one that wants the
 * audit trail can ask for it.
 */
export interface ScopedRetrievalResult extends RetrievalResult {
  readonly exclusions: readonly RetrievalExclusion[]
  readonly strategy: RetrievalStrategy
  /** Identity of the scorer that produced these numbers. */
  readonly scorerId: string
  readonly repositoryId: string
  /** Candidates the repository returned, before any stage removed one. */
  readonly inspectedCount: number
  /** Distinct evidence items represented in `candidates`. */
  readonly distinctSources: number
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * At most this many chunks from one document, so a long report cannot occupy
 * the entire context and crowd out a second source that disagrees with it.
 */
export const DEFAULT_MAX_PER_DOCUMENT = 3

/**
 * How many distinct evidence items the result should draw on when the corpus
 * allows it.
 *
 * Two, not one: a single-source answer cannot surface a contradiction, and an
 * answer that cannot surface a contradiction will report the first figure it
 * finds as though it were uncontested. Two is a floor, not a target — it is
 * abandoned rather than faked when the corpus has only one source, and it is
 * FIRST-PASS, unmeasured, like every threshold in this module.
 */
export const DEFAULT_MIN_DISTINCT_SOURCES = 2

export interface ScopedRetrievalOptions {
  readonly topK?: number
  readonly minScore?: number
  readonly maxPerDocument?: number
  readonly minDistinctSources?: number
  readonly quarantineAtOrAbove?: PromptInjectionSeverity
  readonly evidenceIds?: readonly string[]
  readonly versionIds?: readonly ContentHash[]
  /** Candidate cap requested from the repository, before ranking. */
  readonly candidateLimit?: number
  /** Defaults to the lexical scorer; an embedding scorer plugs in here. */
  readonly scorer?: ChunkScorer
}

const SEVERITY_ORDER: Record<PromptInjectionSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function retrieveGroundedChunks(
  repository: GroundingChunkRepository,
  scope: GroundingScope,
  text: string,
  options: ScopedRetrievalOptions = {},
): Promise<ScopedRetrievalResult> {
  const scorer = options.scorer ?? new LexicalChunkScorer()
  const query: RetrievalQuery = buildRetrievalQuery(scope, text, {
    topK: options.topK,
    minScore: options.minScore,
    evidenceIds: options.evidenceIds,
    quarantineAtOrAbove: options.quarantineAtOrAbove,
  })
  const maxPerDocument = options.maxPerDocument ?? DEFAULT_MAX_PER_DOCUMENT
  const minDistinctSources = options.minDistinctSources ?? DEFAULT_MIN_DISTINCT_SOURCES

  const chunkQuery = buildChunkQuery(scope, text, {
    evidenceIds: options.evidenceIds,
    versionIds: options.versionIds,
    limit: options.candidateLimit,
  })

  // Scope is enforced here, by the guard the caller wrapped the repository in.
  // A violation throws out of this call.
  const fetched = await repository.fetchCandidates(chunkQuery)
  const inspectedCount = fetched.length
  const exclusions: RetrievalExclusion[] = []

  // --- quarantine -----------------------------------------------------------
  // Before scoring: quarantined content must not influence idf either.
  const admitted: GroundingChunk[] = []
  let quarantinedCount = 0
  for (const chunk of fetched) {
    if (isQuarantined(chunk, query.quarantineAtOrAbove)) {
      quarantinedCount++
      exclusions.push({
        chunkId: chunk.chunkId,
        evidenceId: chunk.evidenceId,
        reason: 'quarantined',
        score: 0,
        detail: `Withheld: structural injection signal at or above ${query.quarantineAtOrAbove}`,
      })
      continue
    }
    admitted.push(chunk)
  }

  // --- score ---------------------------------------------------------------
  const normalized = normalizeQueryText(text)
  const scores = await scorer.scoreChunks(normalized, admitted)

  // --- threshold -----------------------------------------------------------
  const scored: { chunk: GroundingChunk; score: number }[] = []
  let belowThresholdCount = 0
  for (let i = 0; i < admitted.length; i++) {
    const chunk = admitted[i]
    const score = scores[i] ?? 0
    if (score < query.minScore || score <= 0) {
      belowThresholdCount++
      exclusions.push({
        chunkId: chunk.chunkId,
        evidenceId: chunk.evidenceId,
        reason: 'below_min_score',
        score,
        detail: `Scored ${score.toFixed(6)}, below the ${query.minScore} relevance threshold`,
      })
      continue
    }
    scored.push({ chunk, score })
  }

  // --- rank ----------------------------------------------------------------
  // Ties are broken by (evidenceId, chunkIndex) and never by input order, so
  // the ranking cannot depend on how the repository happened to enumerate.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.chunk.evidenceId.localeCompare(b.chunk.evidenceId) ||
      a.chunk.chunkIndex - b.chunk.chunkIndex ||
      a.chunk.chunkId.localeCompare(b.chunk.chunkId),
  )

  // --- deduplicate ---------------------------------------------------------
  // By content hash, after ranking, so the surviving occurrence is the
  // deterministically first one rather than whichever arrived first.
  const seenContent = new Map<ContentHash, GroundingChunk>()
  const deduplicated: typeof scored = []
  for (const entry of scored) {
    const survivor = seenContent.get(entry.chunk.contentHash)
    if (survivor) {
      exclusions.push({
        chunkId: entry.chunk.chunkId,
        evidenceId: entry.chunk.evidenceId,
        reason: 'duplicate_content',
        score: entry.score,
        detail: `Identical text already retrieved as chunk ${survivor.chunkId} (evidence ${survivor.evidenceId})`,
      })
      continue
    }
    seenContent.set(entry.chunk.contentHash, entry.chunk)
    deduplicated.push(entry)
  }

  // --- per-document cap ----------------------------------------------------
  const perDocument = new Map<string, number>()
  const capped: typeof scored = []
  for (const entry of deduplicated) {
    const used = perDocument.get(entry.chunk.evidenceId) ?? 0
    if (used >= maxPerDocument) {
      exclusions.push({
        chunkId: entry.chunk.chunkId,
        evidenceId: entry.chunk.evidenceId,
        reason: 'over_document_limit',
        score: entry.score,
        detail: `Evidence item ${entry.chunk.evidenceId} already contributed ${maxPerDocument} chunks`,
      })
      continue
    }
    perDocument.set(entry.chunk.evidenceId, used + 1)
    capped.push(entry)
  }

  // --- top-k + diversity ---------------------------------------------------
  const selected = selectWithDiversity(capped, query.topK, minDistinctSources, exclusions)

  const candidates: RetrievalCandidate[] = selected.map((entry, index) => ({
    chunk: entry.chunk,
    score: entry.score,
    rank: index,
    strategy: scorer.strategy,
    untrusted: true,
  }))

  return {
    query,
    candidates,
    quarantinedCount,
    belowThresholdCount,
    exclusions,
    strategy: scorer.strategy,
    scorerId: scorer.id,
    repositoryId: repository.id,
    inspectedCount,
    distinctSources: new Set(candidates.map((c) => c.chunk.evidenceId)).size,
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Take the top `topK` by score, then repair the source floor by swapping the
 * weakest chunk of the most-represented document for the strongest chunk of a
 * document not yet represented.
 *
 * Greedy-then-repair rather than round-robin: round-robin would reorder every
 * result to serve a floor that most queries already satisfy, which trades
 * relevance for diversity even when nothing is wrong. Repair only touches the
 * result when the floor is actually missed, and each swap is recorded.
 *
 * The floor is a floor, not a quota: when the corpus holds fewer sources than
 * asked for, the loop runs out of candidates and stops. It never pads the
 * result to reach the number.
 */
function selectWithDiversity(
  ranked: readonly { chunk: GroundingChunk; score: number }[],
  topK: number,
  minDistinctSources: number,
  exclusions: RetrievalExclusion[],
): readonly { chunk: GroundingChunk; score: number }[] {
  const selected = ranked.slice(0, Math.max(0, topK))
  const overflow = ranked.slice(Math.max(0, topK))

  // A result of k chunks cannot draw on more than k sources. Asking for more
  // is not a stricter policy, it is an unsatisfiable one: the repair loop would
  // swap the single slot back and forth until it ran out of candidates, ending
  // with an arbitrary chunk and an empty overflow — no diversity gained and the
  // beyond-top-k exclusions lost along the way.
  const floor = Math.min(minDistinctSources, selected.length)
  const displaced = new Set<ContentHash>()

  while (distinctSourcesOf(selected) < floor) {
    const represented = new Set(selected.map((entry) => entry.chunk.evidenceId))
    // Best candidate from a source that is not represented yet. `overflow` is
    // already in rank order, so the first match is the strongest.
    const promotionIndex = overflow.findIndex(
      (entry) => !represented.has(entry.chunk.evidenceId) && !displaced.has(entry.chunk.chunkId),
    )
    if (promotionIndex === -1) break

    const victimIndex = weakestOfMostRepresentedSource(selected)
    if (victimIndex === -1) break

    const [promoted] = overflow.splice(promotionIndex, 1)
    const [victim] = selected.splice(victimIndex, 1)
    displaced.add(victim.chunk.chunkId)

    exclusions.push({
      chunkId: victim.chunk.chunkId,
      evidenceId: victim.chunk.evidenceId,
      reason: 'displaced_for_source_diversity',
      score: victim.score,
      detail: `Displaced by chunk ${promoted.chunk.chunkId} from evidence ${promoted.chunk.evidenceId} to reach ${floor} distinct sources`,
    })

    selected.push(promoted)
    selected.sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.evidenceId.localeCompare(b.chunk.evidenceId) ||
        a.chunk.chunkIndex - b.chunk.chunkIndex,
    )
  }

  for (const entry of overflow) {
    exclusions.push({
      chunkId: entry.chunk.chunkId,
      evidenceId: entry.chunk.evidenceId,
      reason: 'beyond_top_k',
      score: entry.score,
      detail: `Ranked below the top ${topK}`,
    })
  }

  return selected
}

function distinctSourcesOf(
  entries: readonly { chunk: GroundingChunk }[],
): number {
  return new Set(entries.map((entry) => entry.chunk.evidenceId)).size
}

/**
 * Index of the lowest-scoring chunk belonging to the document that contributes
 * the most chunks. Taking from the most-represented source is what keeps the
 * swap from simply trading one single-source result for another.
 */
function weakestOfMostRepresentedSource(
  entries: readonly { chunk: GroundingChunk; score: number }[],
): number {
  if (entries.length === 0) return -1
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.chunk.evidenceId, (counts.get(entry.chunk.evidenceId) ?? 0) + 1)
  }

  let dominant = ''
  let dominantCount = 0
  for (const [evidenceId, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > dominantCount) {
      dominant = evidenceId
      dominantCount = count
    }
  }

  // `<=` so that among equal scores the LAST in rank order is taken: the
  // entries are already sorted, so the last one is the weakest by tie-break.
  let victim = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].chunk.evidenceId !== dominant) continue
    if (victim === -1 || entries[i].score <= entries[victim].score) victim = i
  }
  return victim
}

function isQuarantined(chunk: GroundingChunk, threshold: PromptInjectionSeverity): boolean {
  const worst = highestSeverity(chunk.signals)
  if (worst === null) return false
  return SEVERITY_ORDER[worst] >= SEVERITY_ORDER[threshold]
}
