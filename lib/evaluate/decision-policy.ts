/**
 * lib/evaluate/decision-policy.ts — publication-time policy validation, the
 * SYSTEM recommended outcome, and the two version-identity hashes.
 *
 * Authority: EVALUATE_COMMERCIAL_V1_AUTHORITY_v1.0.0.json DECISION_POLICY,
 * DECISION_OUTCOMES, SYSTEM_RECOMMENDATION, ZERO_DENOMINATOR_CONTROLS.ZD-04.
 *
 * ===========================================================================
 * VALIDATION HAPPENS AT PUBLICATION, NOT AT EVALUATION
 * ===========================================================================
 * HD-03 requires bands to be ordered, non-overlapping and exhaustive INSIDE
 * THE IMMUTABLE POLICY VERSION. The authority is pointed about why that is not
 * the same as producing correct answers at evaluation time:
 *
 *   "an evaluator that produces the right answer from unordered bands still
 *    fails HD-03, because the stored policy is what the ratification
 *    constrains."
 *
 * So `validateDecisionPolicy` inspects the STORED array in its STORED ORDER
 * and never sorts a copy to make it pass. Sorting would prove a property of
 * the sorted copy and say nothing about the row that will be frozen into
 * OBJ-2 and consulted for the life of every evaluation pinned to it.
 *
 * The output is a BRANDED type. `recommendOutcome` accepts only that brand, so
 * an unvalidated policy cannot reach the evaluator — which is what lets the
 * evaluator carry NO FALLBACK BRANCH. A fallback is how a non-exhaustive
 * policy passes for an exhaustive one
 * (DECISION_POLICY.band_requirements.no_fallback_branch).
 *
 * ===========================================================================
 * WHY TWO HASHES, AND WHY THEY MUST NEVER MERGE
 * ===========================================================================
 * DECISION_POLICY.version_identity.why_two_hashes:
 *   definition_hash      proves the WHOLE version is unchanged.
 *   decision_policy_hash proves specifically WHICH POLICY produced a
 *                        recommended outcome, so a snapshotted recommendation
 *                        stays attributable.
 * OBJ-3 snapshots decision_policy_hash_snapshot, not the policy body. Merging
 * them into one artifact hash would destroy the second guarantee: a version
 * whose criteria changed but whose policy did not would become
 * indistinguishable from one whose policy changed, and the attribution a
 * historical decision rests on would be gone.
 */

import { createHash } from 'node:crypto'

import { SCORE_DOMAIN_MAX, SCORE_DOMAIN_MIN } from './scoring'
import {
  DECISION_OUTCOMES,
  type DecisionBand,
  type DecisionPolicy,
  type PolicyValidationResult,
  type PolicyViolation,
  type RecommendationResult,
  type ScoreResult,
  type TemplateVersionDefinition,
  type ValidatedDecisionPolicy,
} from './types'

/**
 * Domain-separation tags, so the two hashes can never collide by accident.
 *
 * Each digest is taken over `<domain>:<canonical payload>`. ':' is a sound
 * separator here for a specific, checkable reason and not by habit: neither
 * tag contains a ':', so `<domain>:` is prefix-free across the two, and no
 * payload can impersonate a different domain by starting with one.
 */
const DEFINITION_HASH_DOMAIN = 'uellix.evaluate.definition_hash.v1'
const DECISION_POLICY_HASH_DOMAIN = 'uellix.evaluate.decision_policy_hash.v1'

/**
 * Raised when a validated policy fails to match a score.
 *
 * This is an INVARIANT VIOLATION, not a fallback. It cannot fire for a policy
 * that `validateDecisionPolicy` accepted, because acceptance proves coverage
 * of the whole score domain. It exists so that if the brand is ever forged,
 * the result is a loud stop rather than a quietly defaulted outcome — which is
 * precisely what ZD-04 forbids.
 */
export class DecisionPolicyTotalityError extends Error {
  constructor(score: number) {
    super(
      `DECISION_POLICY_TOTALITY_VIOLATED: score ${score} matched no band in a policy ` +
        'that was accepted as exhaustive. This is a forged brand or a mutated policy, ' +
        'never a case to be defaulted to an outcome.'
    )
    this.name = 'DecisionPolicyTotalityError'
  }
}

/** Does `score` fall inside `band`, honouring each bound's stated closure? */
function bandContains(band: DecisionBand, score: number): boolean {
  const aboveLower = band.lower_bound_inclusive
    ? score >= band.lower_bound
    : score > band.lower_bound
  const belowUpper = band.upper_bound_inclusive
    ? score <= band.upper_bound
    : score < band.upper_bound
  return aboveLower && belowUpper
}

/**
 * Validate a STORED DecisionPolicy for publication (HD-03).
 *
 * Every violation is collected rather than short-circuiting on the first: a
 * template author fixing one boundary at a time cannot tell whether the policy
 * is nearly publishable or deeply wrong if only the first fault is reported.
 */
export function validateDecisionPolicy(policy: DecisionPolicy): PolicyValidationResult {
  const violations: PolicyViolation[] = []
  const bands = policy.bands

  if (bands.length === 0) {
    violations.push({
      code: 'EMPTY_POLICY',
      message: 'A DecisionPolicy with no bands covers no score and is not publishable.',
    })
    return { valid: false, violations }
  }

  bands.forEach((band, index) => {
    if (!DECISION_OUTCOMES.includes(band.outcome)) {
      violations.push({
        code: 'UNKNOWN_OUTCOME',
        band_index: index,
        message: `band ${index} has outcome '${String(band.outcome)}', outside the closed set of three (HD-04).`,
      })
    }
    if (!Number.isFinite(band.lower_bound) || !Number.isFinite(band.upper_bound)) {
      violations.push({
        code: 'NON_FINITE_BOUND',
        band_index: index,
        message: `band ${index} has a non-finite bound.`,
      })
      return
    }
    if (
      band.lower_bound < SCORE_DOMAIN_MIN ||
      band.upper_bound > SCORE_DOMAIN_MAX ||
      band.lower_bound > SCORE_DOMAIN_MAX ||
      band.upper_bound < SCORE_DOMAIN_MIN
    ) {
      violations.push({
        code: 'BOUND_OUTSIDE_SCORE_DOMAIN',
        band_index: index,
        message: `band ${index} lies partly outside the score domain [${SCORE_DOMAIN_MIN}, ${SCORE_DOMAIN_MAX}].`,
      })
    }
    if (band.lower_bound > band.upper_bound) {
      violations.push({
        code: 'INVERTED_BAND',
        band_index: index,
        message: `band ${index} has lower_bound ${band.lower_bound} above upper_bound ${band.upper_bound}.`,
      })
    }
    // A point band [x, x] is legitimate, but only if BOTH ends are closed —
    // otherwise it contains nothing while still claiming the coordinate, which
    // is a gap wearing a band's clothes.
    if (
      band.lower_bound === band.upper_bound &&
      !(band.lower_bound_inclusive && band.upper_bound_inclusive)
    ) {
      violations.push({
        code: 'DEGENERATE_BAND_NOT_CLOSED',
        band_index: index,
        message: `band ${index} is a single point but is not closed on both sides, so it contains no score.`,
      })
    }
  })

  const first = bands[0]
  const last = bands[bands.length - 1]

  if (first.lower_bound !== SCORE_DOMAIN_MIN || !first.lower_bound_inclusive) {
    violations.push({
      code: 'DOMAIN_NOT_COVERED_AT_MINIMUM',
      band_index: 0,
      message: `the first band must start at ${SCORE_DOMAIN_MIN} inclusive; a COMPUTED score of ${SCORE_DOMAIN_MIN} is representable and must land in exactly one band.`,
    })
  }
  if (last.upper_bound !== SCORE_DOMAIN_MAX || !last.upper_bound_inclusive) {
    violations.push({
      code: 'DOMAIN_NOT_COVERED_AT_MAXIMUM',
      band_index: bands.length - 1,
      message: `the last band must end at ${SCORE_DOMAIN_MAX} inclusive; a COMPUTED score of ${SCORE_DOMAIN_MAX} is representable and must land in exactly one band.`,
    })
  }

  for (let i = 0; i + 1 < bands.length; i += 1) {
    const left = bands[i]
    const right = bands[i + 1]

    // ORDERED is a property of the STORED array (HD-03). Checked, never fixed.
    if (right.lower_bound < left.lower_bound) {
      violations.push({
        code: 'BANDS_NOT_ASCENDING',
        band_index: i + 1,
        message: `band ${i + 1} starts at ${right.lower_bound}, below band ${i}'s start ${left.lower_bound}; the stored order is not monotonic.`,
      })
      continue
    }

    if (left.upper_bound < right.lower_bound) {
      violations.push({
        code: 'BAND_GAP',
        band_index: i,
        message: `scores in (${left.upper_bound}, ${right.lower_bound}) fall in no band.`,
      })
      continue
    }
    if (left.upper_bound > right.lower_bound) {
      violations.push({
        code: 'BAND_OVERLAP',
        band_index: i,
        message: `bands ${i} and ${i + 1} both claim scores in [${right.lower_bound}, ${left.upper_bound}].`,
      })
      continue
    }

    // The bounds meet exactly. Exactly one side must own the shared value.
    const bothClaim = left.upper_bound_inclusive && right.lower_bound_inclusive
    const neitherClaims = !left.upper_bound_inclusive && !right.lower_bound_inclusive
    if (bothClaim) {
      violations.push({
        code: 'BOUNDARY_OWNERSHIP_AMBIGUOUS',
        band_index: i,
        message: `the boundary value ${left.upper_bound} is claimed by both band ${i} and band ${i + 1}.`,
      })
    } else if (neitherClaims) {
      violations.push({
        code: 'BAND_GAP',
        band_index: i,
        message: `the boundary value ${left.upper_bound} is claimed by neither band ${i} nor band ${i + 1}.`,
      })
    }
  }

  if (violations.length > 0) return { valid: false, violations }

  const validated: ValidatedDecisionPolicy = {
    ...policy,
    __validated: 'DECISION_POLICY_TOTALITY_PROVEN',
  }
  return { valid: true, policy: validated }
}

/**
 * The SYSTEM recommended outcome — advice to the human, never the decision.
 *
 * Reads ONLY the Score (DECISION_POLICY.band_requirements.reads_only_the_score:
 * not the actor, not the project, not the clock, not the organization's plan,
 * and not any Stella output).
 *
 * ZD-04: under SCORE_NOT_COMPUTABLE the recommendation is ABSENT. Not 'reject',
 * not 'approve_with_conditions'. A default here would be the SYSTEM deciding,
 * which EV-02 reserves to the human.
 */
export function recommendOutcome(
  policy: ValidatedDecisionPolicy,
  score: ScoreResult
): RecommendationResult {
  if (score.score_status === 'SCORE_NOT_COMPUTABLE') {
    return { recommended: false, reason: 'SCORE_NOT_COMPUTABLE' }
  }

  for (const band of policy.bands) {
    if (bandContains(band, score.score)) {
      return { recommended: true, outcome: band.outcome }
    }
  }

  // Unreachable for a genuinely validated policy. NOT a fallback branch: it
  // produces no outcome, it raises.
  throw new DecisionPolicyTotalityError(score.score)
}

/**
 * Canonical serialization: sorted object keys, no insignificant whitespace.
 *
 * Written here rather than imported from db/hosted/fresh-observation.ts — that
 * module lives under db/**, and W-EV-2's first constraint is "no db import".
 * A hash helper is not worth a boundary violation, and the boundary is the
 * point of the package.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalize: non-finite numbers have no canonical form')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
  }
  throw new TypeError(`canonicalize: unsupported value of type ${typeof value}`)
}

function sha256Hex(domain: string, payload: string): string {
  return createHash('sha256').update(`${domain}:${payload}`, 'utf8').digest('hex')
}

/**
 * definition_hash — over the WHOLE immutable version payload.
 *
 * Includes decision_policy_json, because the policy is part of the version.
 * That is exactly why it cannot stand in for decision_policy_hash: it moves
 * when the criteria move, so it cannot attribute a recommendation to a policy.
 */
export function computeDefinitionHash(definition: TemplateVersionDefinition): string {
  return sha256Hex(DEFINITION_HASH_DOMAIN, canonicalize(definition))
}

/** decision_policy_hash — over decision_policy_json ALONE. */
export function computeDecisionPolicyHash(policy: DecisionPolicy): string {
  return sha256Hex(DECISION_POLICY_HASH_DOMAIN, canonicalize(policy))
}
