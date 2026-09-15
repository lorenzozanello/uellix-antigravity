/**
 * lib/evaluate/scoring.ts — the deterministic Evaluate Score.
 *
 * Authority: EVALUATE_COMMERCIAL_V1_AUTHORITY_v1.0.0.json SCORING,
 * ZERO_DENOMINATOR_CONTROLS, STELLA_BOUNDARY.SB-02, and W-EV-2's constraint
 * list in IMPLEMENTATION_SURFACE.classes[1].
 *
 * ===========================================================================
 * THE ONLY IMPORT IS A TYPE MODULE, AND THAT IS THE CONTROL
 * ===========================================================================
 * HD-01 requires the Score to read no clock, no random source, no environment
 * variable and no AI output. SB-02 requires that no Stella output can be an
 * input to scoring, and says the SIGNATURE must make it structurally
 * impossible.
 *
 * Both are enforced here by construction rather than by review convention:
 * this module imports exactly one module, `./types`, which itself imports
 * nothing. There is no transitive path from this file to a database client, to
 * the network, to the clock, to a random source or to the process environment,
 * and `computeScore` takes exactly two parameters — criteria and responses —
 * so there is nowhere for a Stella output to enter even if a caller wanted to
 * pass one.
 *
 * The prose above deliberately NAMES those constructs in words rather than in
 * code spelling: P-02 scans this file whole, comments included, so a comment
 * quoting the literal token would be indistinguishable to the scanner from the
 * construct itself. Scanning the whole file is the stricter choice — a comment
 * stripper is one more thing that can be wrong in the direction of a pass.
 *
 * P-02 asserts this structurally over the module SOURCE, not only
 * behaviourally, because a behavioural determinism check passes just as
 * happily on a module that reads the clock and happens not to be observed
 * doing so within one test run.
 *
 * ===========================================================================
 * WHY THIS IS NOT lib/pipeline's READINESS ARITHMETIC
 * ===========================================================================
 * SCORING.readiness_is_a_different_domain: EV-01 explicitly PERMITS Measure
 * readiness to use a different governed-N/A arithmetic, and forbids an
 * implementer from refactoring the two into a shared helper "on the assumption
 * that they agree". They do not agree, and the differences are load-bearing:
 *
 *   lib/pipeline computeReadinessScore   |  lib/evaluate computeScore
 *   -------------------------------------|---------------------------------
 *   returns a number or null             |  returns a DISCRIMINATED result
 *   0-100, rounded to an integer         |  exact ratio in [0, 1], unrounded
 *   null means "nothing to assess"       |  SCORE_NOT_COMPUTABLE is a NAMED
 *                                        |  status, never a nullable number
 *
 * ZD-02 forbids Evaluate from returning "a number plus a nullable error",
 * which is precisely readiness's shape. Importing it would import the shape
 * the control exists to exclude. See __tests__/fib-boundary.test.ts (N-08).
 */

import type {
  Criterion,
  CriterionResponse,
  ScoreComputed,
  ScoreNotComputable,
  ScoreResult,
} from './types'

/**
 * The Score domain.
 *
 * BOUNDED IMPLEMENTATION CHOICE (disclosed): the authority binds no score
 * domain. [0, 1] is chosen because DecisionPolicy totality (HD-03) is only
 * PROVABLE over a domain with stated endpoints — "every representable COMPUTED
 * score value falls in exactly one band" is not a checkable statement over an
 * unbounded one. It is deliberately NOT lib/pipeline's 0-100 rounded scale.
 */
export const SCORE_DOMAIN_MIN = 0
export const SCORE_DOMAIN_MAX = 1

/**
 * Raised when the INPUTS are malformed — never to express a scoring outcome.
 *
 * A zero denominator is NOT an error and never reaches this class: it is
 * SCORE_NOT_COMPUTABLE, a governed status (ZD-01). This is reserved for data
 * that could not have been produced by a conforming OBJ-2/OBJ-4 row, such as a
 * SCORED response carrying a null score_value. Failing closed on those is the
 * alternative to coercing them, and SCORING.unanswered_is_not_na is explicit
 * that silent coercion is what must not happen.
 */
export class EvaluateScoringInputError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'EvaluateScoringInputError'
    this.code = code
  }
}

/**
 * Derive the CURRENT response per criterion_key: the row with the highest
 * ordinal (OBJ-4.current_response_projection).
 *
 * Exported so the projection can be tested on its own, and computed HERE
 * rather than accepted as an argument so that no caller can hand the engine a
 * "current" row that is not actually current. A stored or caller-supplied
 * is_current flag would be a third value that can disagree with the ordinals
 * it summarizes.
 */
export function projectCurrentResponses(
  responses: readonly CriterionResponse[]
): ReadonlyMap<string, CriterionResponse> {
  const current = new Map<string, CriterionResponse>()
  const seenOrdinals = new Map<string, Set<number>>()

  for (const response of responses) {
    if (!Number.isInteger(response.ordinal)) {
      throw new EvaluateScoringInputError(
        'NON_INTEGER_ORDINAL',
        `criterion_key '${response.criterion_key}' has a non-integer ordinal`
      )
    }

    // UNIQUE (evaluation_id, criterion_key, ordinal) is an OBJ-4 identity
    // constraint. A duplicate ordinal makes "the highest ordinal" ambiguous,
    // so the projection would silently depend on array order — which would
    // make the Score depend on something other than its inputs' CONTENT.
    const ordinals = seenOrdinals.get(response.criterion_key) ?? new Set<number>()
    if (ordinals.has(response.ordinal)) {
      throw new EvaluateScoringInputError(
        'DUPLICATE_ORDINAL',
        `criterion_key '${response.criterion_key}' has two responses at ordinal ${response.ordinal}`
      )
    }
    ordinals.add(response.ordinal)
    seenOrdinals.set(response.criterion_key, ordinals)

    const incumbent = current.get(response.criterion_key)
    if (incumbent === undefined || response.ordinal > incumbent.ordinal) {
      current.set(response.criterion_key, response)
    }
  }

  return current
}

/** Locale-independent ordering, so reported key sets are byte-stable. */
function sortedKeys(keys: readonly string[]): readonly string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function assertCriteriaWellFormed(criteria: readonly Criterion[]): void {
  const seen = new Set<string>()
  for (const criterion of criteria) {
    if (seen.has(criterion.criterion_key)) {
      throw new EvaluateScoringInputError(
        'DUPLICATE_CRITERION_KEY',
        `criteria_json contains criterion_key '${criterion.criterion_key}' twice`
      )
    }
    seen.add(criterion.criterion_key)

    // A non-positive or non-finite weight would let a criterion contribute
    // nothing to, or poison, the denominator — which is the quantity ZD-02
    // requires be PROVEN greater than zero before any division happens.
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      throw new EvaluateScoringInputError(
        'INVALID_WEIGHT',
        `criterion '${criterion.criterion_key}' has weight ${criterion.weight}; must be finite and > 0`
      )
    }
    if (!Number.isFinite(criterion.max_score) || criterion.max_score <= 0) {
      throw new EvaluateScoringInputError(
        'INVALID_MAX_SCORE',
        `criterion '${criterion.criterion_key}' has max_score ${criterion.max_score}; must be finite and > 0`
      )
    }
  }
}

/**
 * The Evaluate Score.
 *
 * EXACTLY TWO PARAMETERS. SB-02: "The scoring function's signature must make
 * this structurally impossible: it accepts (criteria, responses) and nothing
 * else." No clock, no randomness, no environment, no network, no DB, no
 * Stella, no pipeline readiness, no ambient organization, no current user.
 *
 * EV-01 arithmetic, stated once:
 *
 *   denominator = Σ weight            over criteria whose CURRENT response is SCORED
 *   numerator   = Σ weight · (v/max)  over those same criteria
 *   Score       = numerator / denominator          ONLY IF denominator > 0
 *
 * A criterion whose current response_kind is NOT_APPLICABLE is absent from
 * BOTH sums. It is not scored as zero and it is not scored as the maximum.
 */
export function computeScore(
  criteria: readonly Criterion[],
  responses: readonly CriterionResponse[]
): ScoreResult {
  assertCriteriaWellFormed(criteria)

  const current = projectCurrentResponses(responses)

  const governedNa: string[] = []
  const unanswered: string[] = []
  let numerator = 0
  let denominator = 0

  for (const criterion of criteria) {
    const response = current.get(criterion.criterion_key)

    if (response === undefined) {
      // SCORING.unanswered_is_not_na. Tracked SEPARATELY from governed N/A so
      // a caller gating T3 can tell "nobody has answered this yet" apart from
      // "a human declared this inapplicable, with a rationale". Both are
      // absent from the arithmetic — neither carries a score — but conflating
      // the two key sets is what would let an empty evaluation reach
      // READY_FOR_DECISION with a vacuous SCORE_NOT_COMPUTABLE.
      unanswered.push(criterion.criterion_key)
      continue
    }

    if (response.response_kind === 'NOT_APPLICABLE') {
      // EV-01 requires explicit state, rationale AND human provenance. A row
      // claiming NOT_APPLICABLE without a rationale is not a governed N/A, so
      // it must not be granted the exclusion a governed N/A earns.
      if (response.na_rationale === null || response.na_rationale.trim() === '') {
        throw new EvaluateScoringInputError(
          'UNGOVERNED_NA',
          `criterion '${criterion.criterion_key}' is NOT_APPLICABLE without a non-empty na_rationale`
        )
      }
      governedNa.push(criterion.criterion_key)
      continue
    }

    const value = response.score_value
    if (value === null || !Number.isFinite(value)) {
      throw new EvaluateScoringInputError(
        'SCORED_WITHOUT_VALUE',
        `criterion '${criterion.criterion_key}' is SCORED but score_value is ${String(value)}`
      )
    }
    if (value < 0 || value > criterion.max_score) {
      throw new EvaluateScoringInputError(
        'SCORE_VALUE_OUT_OF_RANGE',
        `criterion '${criterion.criterion_key}' has score_value ${value} outside [0, ${criterion.max_score}]`
      )
    }

    denominator += criterion.weight
    numerator += criterion.weight * (value / criterion.max_score)
  }

  // ZD-02: the division below is reached ONLY after the denominator has been
  // PROVEN greater than zero. There is no second divide-by-zero guard further
  // down and no separate SCORE_NOT_COMPUTABLE flag, because ZD-01 is explicit
  // that two such things can disagree.
  if (denominator <= 0) {
    const notComputable: ScoreNotComputable = {
      score_status: 'SCORE_NOT_COMPUTABLE',
      denominator: 0,
      governed_na_criterion_keys: sortedKeys(governedNa),
      unanswered_criterion_keys: sortedKeys(unanswered),
    }
    // Note what is ABSENT: no `score` property exists on this value. ZD-03's
    // ban on 0, -1, null-coerced, NaN and Infinity is enforced by the type,
    // not by remembering not to write one.
    return notComputable
  }

  const computed: ScoreComputed = {
    score_status: 'COMPUTED',
    score: numerator / denominator,
    denominator,
    numerator,
    governed_na_criterion_keys: sortedKeys(governedNa),
    unanswered_criterion_keys: sortedKeys(unanswered),
  }
  return computed
}

/**
 * Whether every criterion has a current response of either kind.
 *
 * Offered as a PURE predicate for the T3 readiness guard to consume. This
 * package does not implement T3; it only makes the fact T3 needs derivable
 * without re-walking the projection.
 */
export function hasCompleteResponses(result: ScoreResult): boolean {
  return result.unanswered_criterion_keys.length === 0
}
