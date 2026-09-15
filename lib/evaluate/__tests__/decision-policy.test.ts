/**
 * P-03 from docs/ops/evaluate/EVALUATE_COMMERCIAL_V1_TEST_MANIFEST_v1.0.0.json.
 *
 * "DecisionPolicy totality (HD-03): for a published policy, every representable
 *  COMPUTED score — including each band boundary value approached from both
 *  sides — maps to exactly one member of ('approve','approve_with_conditions',
 *  'reject'). No score yields zero outcomes and none yields two."
 *
 * "Approached from both sides" is taken literally: the neighbours of each
 * boundary are the ADJACENT IEEE-754 doubles, obtained by incrementing the bit
 * pattern, not a hand-picked epsilon. A hand-picked epsilon large enough to be
 * readable is large enough to step over a defect that lives in the last ulp.
 *
 * The containment oracle below is written INDEPENDENTLY of the module under
 * test. Counting matches with the module's own comparison would prove the
 * module agrees with itself.
 */

import { describe, expect, it } from 'vitest'

import {
  DecisionPolicyTotalityError,
  recommendOutcome,
  validateDecisionPolicy,
} from '../decision-policy'
import { SCORE_DOMAIN_MAX, SCORE_DOMAIN_MIN } from '../scoring'
import type { DecisionBand, DecisionOutcome, DecisionPolicy, ScoreComputed } from '../types'

// --- adjacent-double helpers ------------------------------------------------

const bitsBuffer = new ArrayBuffer(8)
const asFloat = new Float64Array(bitsBuffer)
const asInt = new BigInt64Array(bitsBuffer)

function nextUp(value: number): number {
  if (value === SCORE_DOMAIN_MAX) return value
  asFloat[0] = value
  asInt[0] = asInt[0] + BigInt(1)
  return asFloat[0]
}

function nextDown(value: number): number {
  if (value <= SCORE_DOMAIN_MIN) return value
  asFloat[0] = value
  asInt[0] = asInt[0] - BigInt(1)
  return asFloat[0]
}

// --- independent oracle -----------------------------------------------------

function oracleContains(band: DecisionBand, score: number): boolean {
  const lowerOk = band.lower_bound_inclusive
    ? band.lower_bound <= score
    : band.lower_bound < score
  const upperOk = band.upper_bound_inclusive ? score <= band.upper_bound : score < band.upper_bound
  return lowerOk && upperOk
}

function oracleMatches(policy: DecisionPolicy, score: number): DecisionOutcome[] {
  return policy.bands.filter((band) => oracleContains(band, score)).map((band) => band.outcome)
}

function computed(score: number): ScoreComputed {
  return {
    score_status: 'COMPUTED',
    score,
    denominator: 1,
    numerator: score,
    governed_na_criterion_keys: [],
    unanswered_criterion_keys: [],
  }
}

// --- the policy under test --------------------------------------------------

const PUBLISHED_POLICY: DecisionPolicy = {
  bands: [
    {
      outcome: 'reject',
      lower_bound: 0,
      lower_bound_inclusive: true,
      upper_bound: 0.5,
      upper_bound_inclusive: false,
    },
    {
      outcome: 'approve_with_conditions',
      lower_bound: 0.5,
      lower_bound_inclusive: true,
      upper_bound: 0.8,
      upper_bound_inclusive: false,
    },
    {
      outcome: 'approve',
      lower_bound: 0.8,
      lower_bound_inclusive: true,
      upper_bound: 1,
      upper_bound_inclusive: true,
    },
  ],
}

const BOUNDARIES = [0, 0.5, 0.8, 1]

describe('P-03 DecisionPolicy totality (HD-03)', () => {
  const validation = validateDecisionPolicy(PUBLISHED_POLICY)

  it('accepts a policy that is ordered, non-overlapping and exhaustive', () => {
    expect(validation.valid).toBe(true)
  })

  it('maps every score in a dense sweep to exactly one outcome', () => {
    if (!validation.valid) throw new Error('policy must validate for this control to mean anything')

    const STEPS = 10_000
    let checked = 0
    for (let i = 0; i <= STEPS; i += 1) {
      const score = i / STEPS
      const matches = oracleMatches(PUBLISHED_POLICY, score)
      expect(matches).toHaveLength(1)
      expect(recommendOutcome(validation.policy, computed(score))).toEqual({
        recommended: true,
        outcome: matches[0],
      })
      checked += 1
    }
    // A sweep that examined nothing would pass every assertion above.
    expect(checked).toBe(STEPS + 1)
  })

  it('maps each boundary and BOTH of its adjacent doubles to exactly one outcome', () => {
    if (!validation.valid) throw new Error('policy must validate for this control to mean anything')

    const probes: number[] = []
    for (const boundary of BOUNDARIES) {
      probes.push(nextDown(boundary), boundary, nextUp(boundary))
    }

    for (const score of probes) {
      if (score < SCORE_DOMAIN_MIN || score > SCORE_DOMAIN_MAX) continue
      const matches = oracleMatches(PUBLISHED_POLICY, score)
      expect({ score, count: matches.length }).toEqual({ score, count: 1 })
      expect(recommendOutcome(validation.policy, computed(score))).toEqual({
        recommended: true,
        outcome: matches[0],
      })
    }

    // The probes are genuinely adjacent, not equal — otherwise "from both
    // sides" would be one side twice.
    expect(nextDown(0.5)).toBeLessThan(0.5)
    expect(nextUp(0.5)).toBeGreaterThan(0.5)
  })

  it('gives each boundary value to exactly one side, deterministically', () => {
    if (!validation.valid) throw new Error('unreachable')
    // 0.5 is closed on the upper band's lower side, so it belongs THERE and
    // not to the band that ends at it.
    expect(recommendOutcome(validation.policy, computed(0.5))).toEqual({
      recommended: true,
      outcome: 'approve_with_conditions',
    })
    expect(recommendOutcome(validation.policy, computed(nextDown(0.5)))).toEqual({
      recommended: true,
      outcome: 'reject',
    })
    expect(recommendOutcome(validation.policy, computed(0.8))).toEqual({
      recommended: true,
      outcome: 'approve',
    })
    expect(recommendOutcome(validation.policy, computed(nextDown(0.8)))).toEqual({
      recommended: true,
      outcome: 'approve_with_conditions',
    })
  })
})

describe('P-03 policies that need a fallback are REJECTED AT PUBLICATION', () => {
  function codesFor(policy: DecisionPolicy): string[] {
    const result = validateDecisionPolicy(policy)
    if (result.valid) return []
    return result.violations.map((violation) => violation.code)
  }

  it('rejects a gap between bands', () => {
    expect(
      codesFor({
        bands: [
          { ...PUBLISHED_POLICY.bands[0], upper_bound: 0.4 },
          PUBLISHED_POLICY.bands[1],
          PUBLISHED_POLICY.bands[2],
        ],
      })
    ).toContain('BAND_GAP')
  })

  it('rejects an overlap between bands', () => {
    expect(
      codesFor({
        bands: [
          { ...PUBLISHED_POLICY.bands[0], upper_bound: 0.6 },
          PUBLISHED_POLICY.bands[1],
          PUBLISHED_POLICY.bands[2],
        ],
      })
    ).toContain('BAND_OVERLAP')
  })

  it('rejects a boundary value claimed by both neighbours', () => {
    expect(
      codesFor({
        bands: [
          { ...PUBLISHED_POLICY.bands[0], upper_bound_inclusive: true },
          PUBLISHED_POLICY.bands[1],
          PUBLISHED_POLICY.bands[2],
        ],
      })
    ).toContain('BOUNDARY_OWNERSHIP_AMBIGUOUS')
  })

  it('rejects a boundary value claimed by neither neighbour', () => {
    expect(
      codesFor({
        bands: [
          PUBLISHED_POLICY.bands[0],
          { ...PUBLISHED_POLICY.bands[1], lower_bound_inclusive: false },
          PUBLISHED_POLICY.bands[2],
        ],
      })
    ).toContain('BAND_GAP')
  })

  it('rejects a policy that does not cover the minimum or the maximum score', () => {
    expect(
      codesFor({ bands: [{ ...PUBLISHED_POLICY.bands[0], lower_bound_inclusive: false }, PUBLISHED_POLICY.bands[1], PUBLISHED_POLICY.bands[2]] })
    ).toContain('DOMAIN_NOT_COVERED_AT_MINIMUM')
    expect(
      codesFor({ bands: [PUBLISHED_POLICY.bands[0], PUBLISHED_POLICY.bands[1], { ...PUBLISHED_POLICY.bands[2], upper_bound_inclusive: false }] })
    ).toContain('DOMAIN_NOT_COVERED_AT_MAXIMUM')
  })

  it('rejects an empty policy', () => {
    expect(codesFor({ bands: [] })).toEqual(['EMPTY_POLICY'])
  })

  it('rejects a point band that is not closed on both sides', () => {
    expect(
      codesFor({
        bands: [
          { ...PUBLISHED_POLICY.bands[0], upper_bound: 0, upper_bound_inclusive: false },
          { ...PUBLISHED_POLICY.bands[1], lower_bound: 0 },
          PUBLISHED_POLICY.bands[2],
        ],
      })
    ).toContain('DEGENERATE_BAND_NOT_CLOSED')
  })

  /**
   * THE HD-03 SUBTLETY, ASSERTED.
   *
   * "an evaluator that produces the right answer from unordered bands still
   *  fails HD-03, because the stored policy is what the ratification
   *  constrains."
   *
   * The policy below is the SAME THREE BANDS as PUBLISHED_POLICY, merely
   * stored in a different order. It partitions the score domain perfectly, so
   * an evaluator that sorted a copy would answer every score correctly — and
   * would still be wrong, because ORDER is a property of the row that gets
   * frozen into OBJ-2. Validation must refuse it.
   */
  it('rejects a perfectly-partitioning policy whose STORED order is not monotonic', () => {
    const shuffled: DecisionPolicy = {
      bands: [PUBLISHED_POLICY.bands[2], PUBLISHED_POLICY.bands[0], PUBLISHED_POLICY.bands[1]],
    }
    // The partition itself is sound: every probe still lands in exactly one band.
    for (const boundary of BOUNDARIES) {
      expect(oracleMatches(shuffled, boundary)).toHaveLength(1)
    }
    // ...and it is refused anyway.
    expect(codesFor(shuffled)).toContain('BANDS_NOT_ASCENDING')
  })
})

describe('P-03 the evaluator carries no fallback branch', () => {
  it('raises rather than defaulting when a forged brand hides a non-total policy', () => {
    // Only reachable by forging the brand — validateDecisionPolicy would never
    // have returned this. The point of the control is that the failure is a
    // STOP, not a quietly defaulted outcome (ZD-04).
    const forged = {
      bands: [PUBLISHED_POLICY.bands[0]],
      __validated: 'DECISION_POLICY_TOTALITY_PROVEN',
    } as unknown as Parameters<typeof recommendOutcome>[0]

    expect(() => recommendOutcome(forged, computed(0.9))).toThrow(DecisionPolicyTotalityError)
    // And it produced no outcome on the way out.
    expect(() => recommendOutcome(forged, computed(0.9))).toThrow(/never a case to be defaulted/)
  })
})
