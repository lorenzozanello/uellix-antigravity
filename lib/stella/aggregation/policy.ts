// lib/stella/aggregation/policy.ts
// Etapa A2.3.1 (STL-A231-002/007, DR-002/DR-003). Single source of truth for
// everything about sensitive-aggregation declarations that must never be
// duplicated as a literal elsewhere, and must never be resolvable from
// client input — the server always resolves these values itself.

/**
 * Bumped whenever the rules in this file (minimum size, allowed entity
 * types, allowed dimensions, high-risk combinations) change materially. A
 * declaration verified under an older version can be classified as
 * `outdated_policy` by declaration-query.ts without needing to inspect any
 * other file — see MINIMUM_SENSITIVE_GROUP_SIZE_BY_POLICY_VERSION below.
 *
 * No automatic date-based versioning — a new version is a deliberate,
 * reviewed code change, never a side effect of the calendar.
 */
export const SENSITIVE_AGGREGATION_POLICY_VERSION = 'v1'

/**
 * Single source of truth for the minimum verifiable group size — reused by
 * lib/stella/context/sensitive-population.ts (imported from here, not
 * redeclared) so there is exactly one place that can change this number.
 * No caller — client or server — can override it; `AggregateDataDeclaration`
 * and the declarations table have no "threshold" field of their own.
 */
export const MINIMUM_SENSITIVE_GROUP_SIZE = 10

/**
 * Historical record of what MINIMUM_SENSITIVE_GROUP_SIZE was for each past
 * policy version — lets declaration-query.ts tell "verified under the
 * CURRENT policy" apart from "verified under a policy that no longer
 * applies" without needing every old declaration to store a redundant copy
 * of a threshold that was already true at the time. A future version that
 * RAISES the threshold must add its own row here; it must never rewrite v1's
 * historical value (that would silently reclassify past verifications).
 */
export const MINIMUM_GROUP_SIZE_BY_POLICY_VERSION: Readonly<Record<string, number>> = {
  v1: MINIMUM_SENSITIVE_GROUP_SIZE,
}

/**
 * Real, existing Uellix entities a declaration may reference — never an
 * arbitrary string. Each value corresponds to a table this module's
 * entity-validation.ts knows how to look up (see ENTITY_TABLE_MAP there).
 * 'stakeholder_group' is included because it is a real table the schema
 * already has, even though no context builder currently surfaces its
 * name/type as free text (see STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md —
 * listed for forward-readiness, not because it has a current consumer).
 */
export const ALLOWED_SENSITIVE_ENTITY_TYPES = [
  'project',
  'outcome',
  'indicator',
  'stakeholder_group',
  'evidence',
  'report_section',
] as const

export type SensitiveEntityType = (typeof ALLOWED_SENSITIVE_ENTITY_TYPES)[number]

export function isAllowedSensitiveEntityType(value: unknown): value is SensitiveEntityType {
  return typeof value === 'string' && (ALLOWED_SENSITIVE_ENTITY_TYPES as readonly string[]).includes(value)
}

/**
 * Structural dimension CODES a declaration may claim to cover — never a
 * free-text value (a declaration saying `dimensions: ["age_band"]` states
 * "this aggregate is broken down by age band", never which age band, and
 * never anyone's actual age). Distinct from
 * lib/stella/context/sensitive-population.ts's QUASI_IDENTIFIER_CATEGORIES,
 * which describes patterns detected in free TEXT — these describe what a
 * DECLARATION structurally covers.
 */
export const ALLOWED_AGGREGATION_DIMENSIONS = [
  'age_band',
  'gender',
  'territory_level',
  'program_period',
  'education_level_band',
  'condition_category',
] as const

export type AggregationDimension = (typeof ALLOWED_AGGREGATION_DIMENSIONS)[number]

/**
 * Conservative cap on how many dimensions a single declaration may combine —
 * more dimensions narrow the aggregate closer to an identifiable subgroup
 * even when each dimension alone is a coarse category. Not a mathematical
 * anonymity guarantee — see the module-level limitation note in
 * declaration-service.ts.
 */
export const MAX_AGGREGATION_DIMENSIONS = 2

/**
 * Specific 2-dimension combinations treated as high-risk even though each
 * dimension is individually allowed and the pair is within
 * MAX_AGGREGATION_DIMENSIONS — a conservative, explicit, adjustable list,
 * not an exhaustive reidentification model. Stored as sorted pairs; compared
 * order-independently (see isHighRiskDimensionCombination).
 */
export const HIGH_RISK_DIMENSION_COMBINATIONS: ReadonlyArray<readonly [AggregationDimension, AggregationDimension]> = [
  ['gender', 'territory_level'],
  ['age_band', 'condition_category'],
]

export function isHighRiskDimensionCombination(dimensions: readonly string[]): boolean {
  for (const [a, b] of HIGH_RISK_DIMENSION_COMBINATIONS) {
    if (dimensions.includes(a) && dimensions.includes(b)) return true
  }
  return false
}

/**
 * Where a declaration's group_size claim is grounded — never "the model said
 * so" and never "extracted from free text". 'manual_verified_declaration' is
 * the only category that does not resolve to an existing system row; it
 * still requires a human verifier (see declaration-service.ts) and a
 * structural reference note, never the supporting document's content.
 */
export const ALLOWED_COUNT_SOURCE_TYPES = [
  'project_record',
  'indicator_measurement',
  'stakeholder_record',
  'verified_external_evidence',
  'manual_verified_declaration',
] as const

export type CountSourceType = (typeof ALLOWED_COUNT_SOURCE_TYPES)[number]

export function isAllowedCountSourceType(value: unknown): value is CountSourceType {
  return typeof value === 'string' && (ALLOWED_COUNT_SOURCE_TYPES as readonly string[]).includes(value)
}

export type GroupSizeBucket = 'below_10' | '10_49' | '50_249' | '250_plus'

/** Always computed server-side — never trusted from a client-supplied bucket. */
export function computeGroupSizeBucket(groupSize: number): GroupSizeBucket {
  if (groupSize < 10) return 'below_10'
  if (groupSize < 50) return '10_49'
  if (groupSize < 250) return '50_249'
  return '250_plus'
}

// ---------------------------------------------------------------------------
// Etapa A2.3.2 (STL-A232-007): injectable policy for testing a REAL v1→v2
// transition without ever touching the production constants above. The
// reclassification logic in declaration-query.ts takes a
// `SensitiveAggregationPolicy` parameter defaulting to
// CURRENT_SENSITIVE_AGGREGATION_POLICY — tests inject a fixture (e.g.
// "v2, minimum 15") to prove a declaration verified under v1/10 becomes
// outdated/below-threshold, then discard the fixture. The productive
// constant is never mutated to make a test pass.
// ---------------------------------------------------------------------------

export interface SensitiveAggregationPolicy {
  policyVersion: string
  minimumGroupSize: number
  allowedDimensions: readonly string[]
  maxDimensions: number
  highRiskCombinations: ReadonlyArray<readonly [string, string]>
}

export const CURRENT_SENSITIVE_AGGREGATION_POLICY: SensitiveAggregationPolicy = {
  policyVersion: SENSITIVE_AGGREGATION_POLICY_VERSION,
  minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
  allowedDimensions: ALLOWED_AGGREGATION_DIMENSIONS,
  maxDimensions: MAX_AGGREGATION_DIMENSIONS,
  highRiskCombinations: HIGH_RISK_DIMENSION_COMBINATIONS,
}

function isHighRiskUnderPolicy(dimensions: readonly string[], policy: SensitiveAggregationPolicy): boolean {
  for (const [a, b] of policy.highRiskCombinations) {
    if (dimensions.includes(a) && dimensions.includes(b)) return true
  }
  return false
}

/** True if `dimensions` would fail dimension-related verification under `policy` — count, allowlist, or high-risk combination. */
export function violatesPolicyDimensionRules(dimensions: readonly string[], policy: SensitiveAggregationPolicy): boolean {
  if (dimensions.length > policy.maxDimensions) return true
  if (dimensions.some((d) => !policy.allowedDimensions.includes(d))) return true
  if (isHighRiskUnderPolicy(dimensions, policy)) return true
  return false
}
