// lib/grounding/retrieve/calibration.ts
// GROUNDING line — presentation buckets over the numeric relevance score.
//
// THESE THRESHOLDS ARE A FIRST LOCAL CALIBRATION. THEY ARE NOT OPTIMAL AND
// HAVE NOT BEEN EVALUATED.
//
// That is not a disclaimer, it is the status. They were chosen by reading the
// scale the lexical scorer produces (see below), not by measuring answer
// quality against a labelled set, because no such set exists yet. Workstream
// risk R4 records the same thing about DEFAULT_RETRIEVAL_MIN_SCORE, and
// INTEGRATION-001 §6 states that the adapter's thresholds inherit that
// uncertainty. They are expected to move once evals exist.
//
// What IS designed rather than guessed:
//
//   - the thresholds are named constants with a VERSION, so a stored bucket
//     can be traced to the calibration that produced it and a recalibration is
//     visible in the data instead of silently reinterpreting history;
//   - bucketing never replaces the score. `presentRelevance` returns both,
//     plus the strategy and scorer identity, because a score is comparable
//     only within one query and one strategy — discarding it would leave no
//     way to recalibrate on historical data, and no way to notice that a
//     retrieval strategy changed scale underneath the thresholds.
//
// Scale of LexicalChunkScorer, for whoever recalibrates next: a score of 1.0
// requires every query term present at high frequency. A chunk containing
// every query term exactly once lands near 0.45, and one containing about half
// of them near 0.23. The boundaries below sit under those two landmarks.

import type { RetrievalCandidate, RetrievalStrategy } from '../contracts'
import type { ScopedRetrievalResult } from './retrieve'

export type RelevanceBucket = 'high' | 'medium' | 'low'

/**
 * Version of the threshold set. Bump on ANY change to the numbers below.
 * The date-stamped suffix is deliberate: it makes an uncalibrated threshold
 * look uncalibrated at the call site.
 */
export const RELEVANCE_THRESHOLDS_VERSION = 'grounding-relevance-2026-08-local-1' as const

/**
 * Inclusive lower bounds. `high` sits just below "every query term present
 * once" and `medium` just below "about half of them", so the buckets separate
 * passages that address the whole question from passages that touch part of it.
 */
export const RELEVANCE_THRESHOLDS = {
  high: 0.4,
  medium: 0.2,
} as const

/**
 * Bucket a score.
 *
 * Throws outside [0, 1] rather than clamping. A score off the scale means the
 * scorer changed and these thresholds did not — precisely the decalibration
 * that must not pass silently.
 */
export function relevanceBucket(score: number): RelevanceBucket {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(
      `Relevance score must lie in [0, 1] under calibration ${RELEVANCE_THRESHOLDS_VERSION}, got ${score}`,
    )
  }
  if (score >= RELEVANCE_THRESHOLDS.high) return 'high'
  if (score >= RELEVANCE_THRESHOLDS.medium) return 'medium'
  return 'low'
}

/**
 * A candidate's relevance as a UI may present it, with everything needed to
 * re-derive or re-calibrate the bucket travelling beside it.
 */
export interface PresentedRelevance {
  readonly score: number
  readonly bucket: RelevanceBucket
  readonly strategy: RetrievalStrategy
  readonly scorerId: string
  readonly thresholdsVersion: typeof RELEVANCE_THRESHOLDS_VERSION
}

export function presentRelevance(
  candidate: RetrievalCandidate,
  result: ScopedRetrievalResult,
): PresentedRelevance {
  return {
    score: candidate.score,
    bucket: relevanceBucket(candidate.score),
    strategy: candidate.strategy,
    scorerId: result.scorerId,
    thresholdsVersion: RELEVANCE_THRESHOLDS_VERSION,
  }
}
