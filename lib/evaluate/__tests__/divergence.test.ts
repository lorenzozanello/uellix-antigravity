/**
 * Local coverage for lib/evaluate/divergence.ts (HD-06, DIV-01..DIV-06).
 *
 * W-EV-2 shipped divergence as a derived inequality with NO local test file.
 * This closes that coverage debt and nothing else: the semantics asserted below
 * are read off the already-integrated implementation, which is unchanged by
 * this lane.
 *
 * WHAT THESE TESTS DO NOT CLAIM. DIV-03's rationale obligation is stated here
 * as a PREDICATE, never as enforcement. The module's own header is explicit
 * that enforcement must also exist as a database CHECK constraint, because
 * "enforcing this only in the action leaves the invariant true by convention
 * rather than by construction". A green test over a predicate is one more
 * convention. The constraint belongs to W-EV-1, which does not exist at this
 * HEAD, so nothing below should be read as discharging it.
 *
 * DIV-01 is likewise not testable as a runtime branch and is not tested as one:
 * a pre-DECIDED evaluation has no HumanDecisionSnapshot, so it cannot be
 * constructed and passed in at all. That is enforced by the SIGNATURE, which is
 * stronger than a `false` return would be — returning `false` would assert
 * agreement where no decision exists.
 */

import { describe, expect, it } from 'vitest'

import {
  decisionRationaleSatisfiesDivergenceRule,
  deriveDivergence,
  divergenceRequiresRationale,
  projectDivergenceForAudit,
} from '../divergence'
import { DECISION_OUTCOMES } from '../types'
import type { DecisionOutcome, HumanDecisionSnapshot, SystemRecommendationSnapshot } from '../types'

/**
 * A distinctive rationale, used as a LEAK SENTINEL further down.
 *
 * It is a single literal rather than a plain string like 'because' so that a
 * substring search for it cannot match incidentally on some unrelated field.
 */
const RATIONALE_SENTINEL =
  'SENTINEL_RATIONALE_9f3c: the board overrode the score after the site visit.'

function systemSnapshot(recommended: DecisionOutcome): SystemRecommendationSnapshot {
  return {
    recommended_outcome_snapshot: recommended,
    score_status_snapshot: 'COMPUTED',
    decision_policy_hash_snapshot: 'a'.repeat(64),
  }
}

function humanSnapshot(
  decided: DecisionOutcome,
  rationale: string | null = null
): HumanDecisionSnapshot {
  return { decision_outcome: decided, decision_rationale: rationale }
}

/** Every ordered pair of outcomes, so no case below is reachable only by example. */
const ALL_PAIRS: readonly { system: DecisionOutcome; human: DecisionOutcome }[] =
  DECISION_OUTCOMES.flatMap((system) => DECISION_OUTCOMES.map((human) => ({ system, human })))

describe('DIV-02 divergence is the INEQUALITY of the two snapshots', () => {
  it('reports NO divergence when the human decision equals the recommendation', () => {
    for (const outcome of DECISION_OUTCOMES) {
      expect(deriveDivergence(systemSnapshot(outcome), humanSnapshot(outcome))).toBe(false)
    }
    // The loop must actually have run over the closed set of three (HD-04);
    // an empty vocabulary would satisfy every assertion above vacuously.
    expect(DECISION_OUTCOMES).toHaveLength(3)
  })

  it('reports divergence for every ordered pair of DIFFERENT outcomes', () => {
    const different = ALL_PAIRS.filter((p) => p.system !== p.human)
    expect(different).toHaveLength(6)
    for (const pair of different) {
      expect(deriveDivergence(systemSnapshot(pair.system), humanSnapshot(pair.human))).toBe(true)
    }
  })

  it('is TOTAL over the outcome vocabulary and agrees with plain inequality', () => {
    // Not a restatement of the implementation: the point is that no pair in the
    // 3x3 space is left without an answer, and that the answer never depends on
    // anything but the two outcome values — not the hash, not score_status,
    // not the rationale.
    for (const pair of ALL_PAIRS) {
      const withRationale = deriveDivergence(
        systemSnapshot(pair.system),
        humanSnapshot(pair.human, RATIONALE_SENTINEL)
      )
      const withoutRationale = deriveDivergence(
        systemSnapshot(pair.system),
        humanSnapshot(pair.human, null)
      )
      expect(withRationale).toBe(pair.system !== pair.human)
      expect(withoutRationale).toBe(withRationale)
    }
    expect(ALL_PAIRS).toHaveLength(9)
  })
})

describe('DIV-03 / DIV-04 rationale is MANDATORY on divergence, PERMITTED on agreement', () => {
  const diverged = { system: systemSnapshot('approve'), human: humanSnapshot('reject') }

  it('requires a rationale exactly when the decision diverges', () => {
    for (const pair of ALL_PAIRS) {
      expect(divergenceRequiresRationale(systemSnapshot(pair.system), humanSnapshot(pair.human))).toBe(
        pair.system !== pair.human
      )
    }
  })

  it('refuses a divergent decision whose rationale is absent or blank', () => {
    const absent: (string | null)[] = [null, '', ' ', '   ', '\t', '\n', ' \t\n ']
    for (const rationale of absent) {
      expect(
        decisionRationaleSatisfiesDivergenceRule(diverged.system, humanSnapshot('reject', rationale))
      ).toBe(false)
    }
  })

  it('accepts a divergent decision carrying a real rationale', () => {
    expect(
      decisionRationaleSatisfiesDivergenceRule(
        diverged.system,
        humanSnapshot('reject', RATIONALE_SENTINEL)
      )
    ).toBe(true)
    // A single non-blank character is enough: DIV-03 requires the rationale to
    // exist, and this module does not judge its quality.
    expect(
      decisionRationaleSatisfiesDivergenceRule(diverged.system, humanSnapshot('reject', 'x'))
    ).toBe(true)
  })

  it('does NOT manufacture a rationale obligation for an agreeing decision', () => {
    // The asymmetry is the control. A rule that simply demanded a rationale
    // everywhere would pass the divergent cases above and be wrong here.
    for (const outcome of DECISION_OUTCOMES) {
      const system = systemSnapshot(outcome)
      expect(divergenceRequiresRationale(system, humanSnapshot(outcome, null))).toBe(false)
      expect(decisionRationaleSatisfiesDivergenceRule(system, humanSnapshot(outcome, null))).toBe(
        true
      )
      expect(decisionRationaleSatisfiesDivergenceRule(system, humanSnapshot(outcome, ''))).toBe(true)
      // DIV-04: permitted, not forbidden.
      expect(
        decisionRationaleSatisfiesDivergenceRule(system, humanSnapshot(outcome, RATIONALE_SENTINEL))
      ).toBe(true)
    }
  })
})

describe('DIV-06 the audit projection carries outcome values and nothing else', () => {
  const system = systemSnapshot('approve')
  const human = humanSnapshot('reject', RATIONALE_SENTINEL)

  it('exposes exactly the three intended fields', () => {
    const projection = projectDivergenceForAudit(system, human)
    // An exact key set, not a containment check: a containment check passes
    // unchanged on the day a fourth field is added.
    expect(Object.keys(projection).sort()).toEqual([
      'decision_outcome',
      'diverged',
      'recommended_outcome_snapshot',
    ])
    expect(projection).toEqual({
      recommended_outcome_snapshot: 'approve',
      decision_outcome: 'reject',
      diverged: true,
    })
  })

  it('never carries decision_rationale TEXT (NSB-04)', () => {
    const projection = projectDivergenceForAudit(system, human)
    const serialized = JSON.stringify(projection)

    // POSITIVE CONTROL FIRST. Without it this is a negative claim resting on a
    // string that might simply never have been present — a typo in the
    // sentinel would make the assertion below pass while proving nothing.
    expect(JSON.stringify(human)).toContain(RATIONALE_SENTINEL)

    expect(serialized).not.toContain(RATIONALE_SENTINEL)
    expect(serialized).not.toContain('decision_rationale')
    expect(Object.values(projection)).not.toContain(RATIONALE_SENTINEL)
  })

  it('omits the hash and score_status the system snapshot carries', () => {
    // DIV-06 names the outcome values. The projection is not a passthrough of
    // whatever the two snapshots hold, so the remaining snapshot fields must be
    // absent rather than merely unasserted.
    const projection = projectDivergenceForAudit(system, human)
    const serialized = JSON.stringify(projection)
    expect(JSON.stringify(system)).toContain(system.decision_policy_hash_snapshot)
    expect(serialized).not.toContain(system.decision_policy_hash_snapshot)
    expect(serialized).not.toContain('score_status_snapshot')
    expect(serialized).not.toContain('decision_policy_hash_snapshot')
  })

  it('reports a diverged flag that agrees with deriveDivergence for every pair', () => {
    for (const pair of ALL_PAIRS) {
      const s = systemSnapshot(pair.system)
      const h = humanSnapshot(pair.human, RATIONALE_SENTINEL)
      const projection = projectDivergenceForAudit(s, h)
      expect(projection.diverged).toBe(deriveDivergence(s, h))
      expect(projection.recommended_outcome_snapshot).toBe(pair.system)
      expect(projection.decision_outcome).toBe(pair.human)
    }
  })
})
