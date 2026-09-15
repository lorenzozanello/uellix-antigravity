/**
 * lib/evaluate/divergence.ts — divergence as a derived inequality.
 *
 * Authority: EVALUATE_COMMERCIAL_V1_AUTHORITY_v1.0.0.json DIVERGENCE_CONTROLS
 * (DIV-01..DIV-07), HD-06.
 *
 * ===========================================================================
 * NOTHING HERE IS STORED
 * ===========================================================================
 * DIV-02: divergence "is computed from the two snapshot columns on read. It is
 * NOT stored." The rationale is worth restating because it is the whole design:
 *
 *   "A stored divergence flag is a third value that can disagree with the two
 *    it summarizes. Deriving it makes disagreement impossible by construction."
 *
 * So this module exports PURE FUNCTIONS OVER TWO SNAPSHOTS and no writer, no
 * persistence shape and no divergence record type. OBJ-3 carries no divergence
 * column and there is deliberately no evaluation_divergences relation.
 *
 * ===========================================================================
 * THIS MODULE DOES NOT IMPLEMENT T5
 * ===========================================================================
 * The human decision transition belongs to a later package. What lives here is
 * only the DERIVATION a read model and an audit payload need. In particular
 * `divergenceRequiresRationale` states DIV-03's condition; it does not enforce
 * it, does not write a row and does not refuse a transition. DIV-03 is explicit
 * that enforcement must also exist as a database CHECK constraint, because
 * "enforcing this only in the action leaves the invariant true by convention
 * rather than by construction" — a predicate in a TypeScript module is one more
 * convention, not the construction.
 */

import type { DecisionOutcome, HumanDecisionSnapshot, SystemRecommendationSnapshot } from './types'

/**
 * DIV-02, stated once: divergence is the inequality of the two snapshots.
 *
 * Both parameters are non-nullable by DIV-05 — T5 refuses a
 * SCORE_NOT_COMPUTABLE evaluation (ZD-05), so a DECIDED row always carries a
 * recommended_outcome_snapshot. There is therefore no "divergence unknown"
 * third value here for a case the state machine already forecloses, and no
 * caller can construct one.
 *
 * DIV-01 is honoured by the SIGNATURE rather than by a runtime branch: a
 * pre-DECIDED evaluation has no HumanDecisionSnapshot, so it cannot be passed
 * in at all. That is different from — and stronger than — returning `false`
 * for it, which would assert agreement where no decision exists.
 */
export function deriveDivergence(
  system: SystemRecommendationSnapshot,
  human: HumanDecisionSnapshot
): boolean {
  return human.decision_outcome !== system.recommended_outcome_snapshot
}

/**
 * DIV-03 / DIV-04: rationale is MANDATORY on divergence, PERMITTED on
 * agreement. Agreement needs no justification; disagreement does.
 */
export function divergenceRequiresRationale(
  system: SystemRecommendationSnapshot,
  human: HumanDecisionSnapshot
): boolean {
  return deriveDivergence(system, human)
}

/**
 * Whether a decision snapshot pair satisfies DIV-03's rationale obligation.
 *
 * A whitespace-only rationale counts as absent: DIV-03 requires the row where
 * the outcomes differ and the rationale "is NULL or empty" to be
 * unrepresentable, and a single space is empty in every sense the control
 * cares about.
 */
export function decisionRationaleSatisfiesDivergenceRule(
  system: SystemRecommendationSnapshot,
  human: HumanDecisionSnapshot
): boolean {
  if (!divergenceRequiresRationale(system, human)) return true
  const rationale = human.decision_rationale
  return rationale !== null && rationale.trim() !== ''
}

/**
 * The audit-safe projection of a divergence finding (DIV-06).
 *
 * Carries the two outcome VALUES — both members of a closed three-value enum,
 * and therefore not tenant content — and never the rationale TEXT, which stays
 * in OBJ-3 behind bypass-free RLS. NSB-04 is explicit that Evaluate audit
 * payloads hold "ids, state names, outcome values, score_status values, role
 * values, hashes and timestamps — never decision_rationale text, never
 * na_rationale text, never criteria_json".
 *
 * The rationale HASH that DIV-06 also names is deliberately not computed here:
 * hashing the rationale is the audit writer's act, and this module is the
 * derivation, not the writer.
 */
export type DivergenceProjection = {
  readonly recommended_outcome_snapshot: DecisionOutcome
  readonly decision_outcome: DecisionOutcome
  readonly diverged: boolean
}

export function projectDivergenceForAudit(
  system: SystemRecommendationSnapshot,
  human: HumanDecisionSnapshot
): DivergenceProjection {
  return {
    recommended_outcome_snapshot: system.recommended_outcome_snapshot,
    decision_outcome: human.decision_outcome,
    diverged: deriveDivergence(system, human),
  }
}
