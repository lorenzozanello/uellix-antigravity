/**
 * lib/evaluate/types.ts — the closed vocabulary of the Evaluate V1 engine.
 *
 * Authority: docs/ops/evaluate/EVALUATE_COMMERCIAL_V1_AUTHORITY_v1.0.0.json,
 * IMPLEMENTATION_SURFACE.classes[1] (W-EV-2, "Pure scoring and DecisionPolicy
 * engine").
 *
 * This module declares TYPES ONLY. It imports nothing, so no value in the
 * Evaluate engine can reach a clock, a random source, an environment variable,
 * a database handle or a Stella output by way of the type layer.
 *
 * ===========================================================================
 * WHAT THIS PACKAGE DELIBERATELY DOES NOT MODEL
 * ===========================================================================
 * - The human decision transition (T5). W-EV-2 is the SYSTEM half only.
 * - Any stored divergence. HD-06 makes divergence derived; see divergence.ts.
 * - Any Stella-writable field. STELLA_BOUNDARY.SB-04: there is no column, and
 *   here there is no PROPERTY, for Stella to write. SB-02 is enforced
 *   structurally by computeScore's two-parameter signature in scoring.ts.
 */

/**
 * DECISION_OUTCOMES, closed at exactly three (HD-04).
 *
 * recommended_outcome_snapshot and decision_outcome draw from this SAME set on
 * purpose: it is what makes divergence a simple inequality (HD-06, DIV-02)
 * rather than a mapping table in which a disagreement could hide.
 *
 * There is no 'pending', no 'deferred', no 'abstain' and no null-as-outcome.
 * An evaluation with no outcome is expressed by its STATE, not by a fourth
 * value here.
 */
export type DecisionOutcome = 'approve' | 'approve_with_conditions' | 'reject'

/** The closed outcome set as a value, for membership checks at publication. */
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = [
  'approve',
  'approve_with_conditions',
  'reject',
] as const

/**
 * SCORING.score_status, closed at exactly two.
 *
 * SCORE_NOT_COMPUTABLE is the NAME of the zero-denominator condition (ZD-01),
 * not a separate error path. HD-02's two conditions — zero denominator, or all
 * applicable items N/A — collapse into this one value because EV-01's
 * exclusion rule makes the second reduce to the first.
 */
export type ScoreStatus = 'COMPUTED' | 'SCORE_NOT_COMPUTABLE'

/** OBJ-4.response_kind, closed at exactly two. */
export type ResponseKind = 'SCORED' | 'NOT_APPLICABLE'

/**
 * OBJ-4.recorded_by_role — RAT-EV-02's exact edit set, and the "role at time
 * of action" half of RAT-EV-03's traceability floor.
 */
export type CriterionResponseRole = 'analyst' | 'impact_manager' | 'organization_admin'

/**
 * One criterion from the pinned template version's criteria_json.
 *
 * BOUNDED IMPLEMENTATION CHOICE (disclosed): the authority binds the N/A
 * ARITHMETIC and the determinism of the Score, but it binds no criteria_json
 * shape and no score domain — OBJECT_MODEL.note is explicit that it carries
 * "no column types beyond what is needed to make an invariant checkable".
 * weight + max_score is therefore this package's executable choice, not an
 * owner-ratified shape. It is the smallest shape under which EV-01's
 * "excluded from the numerator AND the denominator" is even statable: without
 * a per-criterion denominator contribution there is nothing for N/A to be
 * excluded FROM.
 */
export type Criterion = {
  readonly criterion_key: string
  /** Denominator contribution. Must be finite and > 0 (checked at scoring). */
  readonly weight: number
  /** Normalizer for score_value. Must be finite and > 0 (checked at scoring). */
  readonly max_score: number
}

/**
 * One APPEND-ONLY OBJ-4 row.
 *
 * Deliberately NOT an upserted current-state row: RAT-EV-03's traceability
 * floor requires that a later action never destroy an earlier action's four
 * facts (actor, role at action, response/version, timestamp). The engine
 * therefore receives the LINEAGE and derives the current projection itself
 * (see projectCurrentResponses) rather than trusting a caller-supplied
 * is_current flag — a stored flag would be a third value that can disagree
 * with the ordinals it summarizes.
 */
export type CriterionResponse = {
  readonly criterion_key: string
  /** Monotonic per (evaluation_id, criterion_key). Highest ordinal is current. */
  readonly ordinal: number
  readonly response_kind: ResponseKind
  /** NOT NULL when response_kind === 'SCORED'; NULL when 'NOT_APPLICABLE'. */
  readonly score_value: number | null
  /** NOT NULL and non-empty when response_kind === 'NOT_APPLICABLE' (EV-01). */
  readonly na_rationale: string | null
  readonly recorded_by: string
  readonly recorded_by_role: CriterionResponseRole
  readonly recorded_at: string
  readonly supersedes_response_id?: string | null
}

/**
 * The Score, as a DISCRIMINATED result (ZD-02).
 *
 * The COMPUTED variant is the ONLY variant carrying a score property. That is
 * the whole point: under SCORE_NOT_COMPUTABLE there is no number in existence
 * to be compared against a DecisionPolicy band, so ZD-03's ban on sentinel
 * numbers (0, -1, NaN, Infinity, null-coerced) is enforced by the type rather
 * than by a convention someone must remember.
 */
export type ScoreResult = ScoreComputed | ScoreNotComputable

export type ScoreComputed = {
  readonly score_status: 'COMPUTED'
  /** Exact ratio in [0, 1]. Never rounded — see scoring.ts SCORE_DOMAIN. */
  readonly score: number
  /** Sum of weight over criteria whose CURRENT response is SCORED. Always > 0. */
  readonly denominator: number
  /** Sum of weight * (score_value / max_score) over those same criteria. */
  readonly numerator: number
  /** criterion_keys excluded from BOTH numerator and denominator per EV-01. */
  readonly governed_na_criterion_keys: readonly string[]
  /**
   * criterion_keys with NO response row at all.
   *
   * SCORING.unanswered_is_not_na: an UNANSWERED criterion is NOT a governed
   * N/A. It blocks T3; it is not excluded-by-the-N/A-rule. Both are absent
   * from the arithmetic for the plain reason that neither carries a score, so
   * the engine reports them as SEPARATE key sets. That separation is what
   * stops an empty evaluation from being indistinguishable from an all-N/A
   * one — the conflation the authority names explicitly.
   */
  readonly unanswered_criterion_keys: readonly string[]
}

export type ScoreNotComputable = {
  readonly score_status: 'SCORE_NOT_COMPUTABLE'
  readonly denominator: 0
  readonly governed_na_criterion_keys: readonly string[]
  readonly unanswered_criterion_keys: readonly string[]
}

/**
 * One DecisionPolicy band.
 *
 * Both bounds carry an EXPLICIT inclusivity flag. HD-03's boundary_closure
 * requires band boundaries to be "explicit and closed on a stated side"; a
 * policy that leaves a boundary value ambiguous is not publishable, because
 * ambiguity at a boundary is either an overlap or a gap and HD-03 forbids
 * both. Encoding inclusivity as DATA rather than as a comparison convention
 * inside the evaluator is what makes the property checkable on the STORED
 * policy, which is what the ratification actually constrains.
 */
export type DecisionBand = {
  readonly outcome: DecisionOutcome
  readonly lower_bound: number
  readonly lower_bound_inclusive: boolean
  readonly upper_bound: number
  readonly upper_bound_inclusive: boolean
}

/** decision_policy_json, as stored in the immutable OBJ-2 row. */
export type DecisionPolicy = {
  readonly bands: readonly DecisionBand[]
}

/**
 * A DecisionPolicy PROVEN ordered, non-overlapping and exhaustive.
 *
 * The brand is not decoration. HD-03 makes totality a PUBLICATION-TIME
 * property of the stored policy, and recommendOutcome accepts only this type —
 * so an unvalidated policy cannot reach the evaluator, and the evaluator needs
 * no fallback branch. A fallback branch is exactly how a non-exhaustive policy
 * passes for an exhaustive one
 * (DECISION_POLICY.band_requirements.no_fallback_branch).
 */
export type ValidatedDecisionPolicy = DecisionPolicy & {
  readonly __validated: 'DECISION_POLICY_TOTALITY_PROVEN'
}

/** A single reason a policy is unpublishable. */
export type PolicyViolation = {
  readonly code: PolicyViolationCode
  readonly message: string
  /** Index into bands when the violation is attributable to one band. */
  readonly band_index?: number
}

export type PolicyViolationCode =
  | 'EMPTY_POLICY'
  | 'NON_FINITE_BOUND'
  | 'BOUND_OUTSIDE_SCORE_DOMAIN'
  | 'INVERTED_BAND'
  | 'DEGENERATE_BAND_NOT_CLOSED'
  | 'BANDS_NOT_ASCENDING'
  | 'DOMAIN_NOT_COVERED_AT_MINIMUM'
  | 'DOMAIN_NOT_COVERED_AT_MAXIMUM'
  | 'BAND_GAP'
  | 'BAND_OVERLAP'
  | 'BOUNDARY_OWNERSHIP_AMBIGUOUS'
  | 'UNKNOWN_OUTCOME'

/** Discriminated validation result. Never a boolean plus a nullable error. */
export type PolicyValidationResult =
  | { readonly valid: true; readonly policy: ValidatedDecisionPolicy }
  | { readonly valid: false; readonly violations: readonly PolicyViolation[] }

/**
 * The SYSTEM recommended outcome, as a DISCRIMINATED result.
 *
 * ZD-04: when score_status is 'SCORE_NOT_COMPUTABLE' the recommendation is
 * ABSENT — not defaulted to 'reject', not defaulted to
 * 'approve_with_conditions'. The recommended:false variant carries no outcome
 * property at all, so there is no defaulted value for a caller to read past a
 * forgotten check.
 */
export type RecommendationResult =
  | { readonly recommended: true; readonly outcome: DecisionOutcome }
  | { readonly recommended: false; readonly reason: 'SCORE_NOT_COMPUTABLE' }

/**
 * OBJ-3's SYSTEM half of the decision snapshot, written at T5.
 *
 * recommended_outcome_snapshot is NON-NULLABLE here by DIV-05: T5 refuses a
 * SCORE_NOT_COMPUTABLE evaluation (ZD-05), so a DECIDED row always has one.
 * Typing it non-nullable is what forecloses a "divergence unknown" third value
 * for a case the state machine already forecloses.
 */
export type SystemRecommendationSnapshot = {
  readonly recommended_outcome_snapshot: DecisionOutcome
  readonly score_status_snapshot: 'COMPUTED'
  readonly decision_policy_hash_snapshot: string
}

/** OBJ-3's HUMAN half of the decision snapshot, written at T5. */
export type HumanDecisionSnapshot = {
  readonly decision_outcome: DecisionOutcome
  readonly decision_rationale: string | null
}

/**
 * The immutable OBJ-2 payload that definition_hash is taken over.
 *
 * Publication columns (published_at / published_by / published_by_role) are
 * ABSENT by construction: they are the one write-once NULL-to-value transition
 * permitted after insert (OBJ-2.publication_write_once), so including them
 * would make definition_hash change at publication — and definition_hash
 * exists to prove the version is UNCHANGED.
 */
export type TemplateVersionDefinition = {
  readonly organization_id: string
  readonly template_id: string
  readonly version: string
  readonly ordinal: number
  readonly criteria_json: readonly Criterion[]
  readonly decision_policy_json: DecisionPolicy
  readonly supersedes_version_id: string | null
  readonly created_by: string
  readonly created_by_role: string
  readonly created_at: string
}
