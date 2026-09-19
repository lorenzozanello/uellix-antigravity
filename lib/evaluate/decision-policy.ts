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
  type Criterion,
  type DecisionBand,
  type DecisionOutcome,
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
 * ===========================================================================
 * THE HASH IS TAKEN OVER THE DECLARED PAYLOAD, NOT OVER THE OBJECT SUPPLIED
 * ===========================================================================
 * `canonicalize` serializes every enumerable own property it is handed. That is
 * correct for a canonicalizer and wrong as a hashing boundary. The two digests
 * below are IDENTITY digests for a row OBJ-2 will store, so what they must
 * depend on is the DECLARED PERSISTED SHAPE — not whatever an object happens to
 * be carrying at the moment it reaches the call.
 *
 * The concrete case this closes: `validateDecisionPolicy` returns a BRANDED
 * policy, and `ValidatedDecisionPolicy` is structurally assignable to
 * `DecisionPolicy`, so no call site can be made to reject one by type. Hashing
 * the object as supplied therefore made the digest depend on WHETHER THE POLICY
 * HAD BEEN VALIDATED. That is harmless while nothing persists, and unsafe the
 * moment W-EV-1 exists: the natural order at publication is validate-then-
 * record, so the recorded hash would be one that no later reader, recomputing
 * it from the stored row, could ever reproduce.
 *
 * The fix is a POSITIVE PROJECTION, never a blacklist. Deleting `__validated`,
 * or skipping keys that begin with '__', would close this instance and leave
 * the class open: the next field added to a validated wrapper, or any extra
 * column a store round-trips back, would silently enter the digest again. A
 * projection enumerates what IS hashed, so an unknown property is excluded by
 * construction rather than by a rule someone has to remember to extend.
 *
 * The field lists below are the declared shapes in ./types — DecisionBand's
 * five properties, Criterion's three, TemplateVersionDefinition's ten. Each is
 * written as an exhaustive literal rather than a spread, because a spread is
 * precisely what reintroduces the defect.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RETURN TYPES ARE `HashProjection<T>` AND NOT `unknown`
 * ---------------------------------------------------------------------------
 * A positive projection closes the UNKNOWN-field class. It does NOT, on its
 * own, close the NEWLY-DECLARED-field class: a projection that returns
 * `unknown` has nothing for TypeScript to compare its literal against, so
 * adding a field to a declared shape and forgetting it here compiles clean and
 * leaves the digest byte-identical. Measured at this base before the change:
 * two new declared persisted fields, `tsc --noEmit` exit 0 across the repo, and
 * definition_hash unmoved.
 *
 * The aggravating half is that the IDENTITY controls hide it. A frozen-literal
 * digest assertion stays GREEN precisely BECAUSE the new field was excluded —
 * the control that exists to prove "identity did not move" is what conceals the
 * omission.
 *
 * `HashProjection<T>` is a mapped type over `keyof T`, so exactness is checked
 * in BOTH directions by the compiler and no second hand-maintained list exists:
 *   - add or rename a declared field  -> the literal is MISSING a property
 *   - remove a declared field         -> the literal has an EXCESS property
 *   - change a field's representation -> the value is no longer CanonicalValue
 * See __tests__/persisted-shape.test.ts for the type-level controls that prove
 * each direction actually fails to compile.
 */

/**
 * Every value `canonicalize` has a canonical form for, and nothing else.
 *
 * This is the second half of the compile-time mechanism. Typing a projected
 * field as `unknown` would satisfy `HashProjection` while re-admitting a value
 * the canonicalizer refuses at runtime, which would move a structural defect
 * back to a throw at publication time.
 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

/**
 * EXACTLY the declared keys of T, each carrying a canonicalizable value.
 *
 * `-?` strips optionality on purpose: an optional declared field is still a
 * declared field, so it must be named here rather than silently absent.
 */
export type HashProjection<T> = { readonly [K in keyof T]-?: CanonicalValue }

/**
 * ===========================================================================
 * A STRUCTURALLY INVALID PAYLOAD RECEIVES NO AUTHORITATIVE HASH
 * ===========================================================================
 * TEMPLATE_LIFECYCLE.publication_guards[2] makes definition_hash and
 * decision_policy_hash SERVER-computed over a canonical serialization. A digest
 * is therefore an assertion about a row OBJ-2 can actually store, and the only
 * honest answer for a payload that is not such a row is a refusal.
 *
 * Measured at this base before the change, every one of these returned a
 * well-formed 64-hex digest indistinguishable from an authoritative one:
 *   - a definition with `version` absent entirely
 *   - a definition whose `criteria_json` was an object, not an array
 *   - a criterion whose `weight` was the STRING "1"
 *   - the bare string 'nope' as the whole definition
 *
 * WHAT THIS DELIBERATELY DOES NOT REJECT: undeclared extra properties.
 * That tolerance is not laxity, it is required. published_at, published_by and
 * published_by_role are real OBJ-2 columns and the one write-once transition
 * permitted after insert, so a row read back from the store CARRIES them and
 * definition_hash must not move at publication — definition_hash exists to
 * prove the version did NOT move. An undeclared key is, by construction, not a
 * declared persisted field; what guarantees no SECOND semantic row can share an
 * authoritative projection is that every DECLARED field is in the projection,
 * and that is now the compiler's job (`HashProjection<T>`), not a reviewer's.
 *
 * The checks are STRUCTURAL ONLY — "is this the shape its type claims, and does
 * it have a canonical form". Band totality, score-domain coverage and
 * weight > 0 stay where they already live (validateDecisionPolicy, computeScore).
 * Hashing must not require a PUBLISHED policy: a single-band draft policy is
 * hashable and is not yet total.
 */

/** Why a payload cannot be hashed as authoritative. */
export type PersistedShapeViolationCode =
  | 'NOT_AN_OBJECT'
  | 'MISSING_DECLARED_FIELD'
  | 'WRONG_DECLARED_TYPE'
  | 'NOT_AN_ARRAY'
  /**
   * A declared array carries no OWN element at an index inside [0, length).
   *
   * A hole is not a stored value. `forEach` and `map` SKIP one, so a sparse
   * array walked by either was validated at the indices that exist and then
   * serialized with `join`, which renders the hole as the empty string — a
   * payload that no OBJ-2 row can hold, wearing an authoritative digest.
   */
  | 'SPARSE_ARRAY'
  /**
   * Reading a declared field threw.
   *
   * Classified rather than propagated: a value whose declared property cannot
   * even be read once is not a storable row, and the caller of a hashing
   * boundary must learn that from the Evaluate refusal that names the FIELD,
   * not from whatever an accessor happened to raise.
   */
  | 'UNREADABLE_DECLARED_FIELD'

export type PersistedShapeViolation = {
  readonly code: PersistedShapeViolationCode
  /** Dotted path to the offending field, e.g. `criteria_json[0].weight`. */
  readonly path: string
  readonly message: string
}

/** Discriminated, like PolicyValidationResult. Never a boolean plus a nullable. */
export type PersistedShapeValidationResult<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly violations: readonly PersistedShapeViolation[] }

/**
 * Raised when an authoritative hash is requested for a payload that is not a
 * storable row.
 *
 * A throw rather than a sentinel digest: ZD-03 already establishes that this
 * package does not answer an unanswerable question with a placeholder value,
 * and a caller that forgot to check would otherwise persist the placeholder.
 */
export class EvaluatePersistedShapeError extends Error {
  readonly violations: readonly PersistedShapeViolation[]

  constructor(what: string, violations: readonly PersistedShapeViolation[]) {
    super(
      `${what} is not a storable Evaluate row and has no authoritative hash: ` +
        violations.map((v) => `${v.path}: ${v.message}`).join('; ')
    )
    this.name = 'EvaluatePersistedShapeError'
    this.violations = violations
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * ===========================================================================
 * VALIDATION AND PROJECTION READ THE SAME FIELD ONCE, NOT TWICE
 * ===========================================================================
 * The functions below do not merely CHECK a payload, they MATERIALIZE it. Each
 * one reads every declared property exactly once, into a plain local, and
 * returns a fresh plain object built from those locals. The hashing boundary
 * then consumes ONLY that snapshot.
 *
 * The defect this closes: validation used to read `value.version` and the
 * projection used to read `value.version` AGAIN, from the same object. For a
 * plain row those two reads agree. For an accessor-backed one they need not.
 * Measured at this base before the change, a definition whose `version` getter
 * returned '1.0.0' on its first read and '9.9.9' on its second was VALIDATED as
 * '1.0.0' and HASHED as 423f195f74fe3c69… — byte-identical to the authoritative
 * digest of an honest '9.9.9' row. The digest certified a value no check ever
 * saw. The same route ran through every nested level: Criterion, DecisionPolicy
 * and DecisionBand each had an independent second read.
 *
 * Accessor-backed input is still ACCEPTED — a store, an ORM or a proxy may
 * legitimately present a row through getters, and rejecting those would refuse
 * storable rows. What is foreclosed is the SECOND read: after materialization
 * there is no live accessor left inside the authoritative payload to consult.
 *
 * Presence is tested with `in`, which is a HasProperty operation and cannot
 * invoke an accessor, so it costs no read of the VALUE. `undefined` is the
 * failure sentinel throughout, which is sound because no declared Evaluate
 * field is typed `undefined`: a declared field is a string, a finite number, a
 * boolean, `string | null`, an array or a nested object. An absent field is
 * reported as absent; it never arrives as a present empty one.
 */

/** One declared read, or the reason there is no value to carry forward. */
type DeclaredRead = { readonly read: true; readonly value: unknown } | { readonly read: false }

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : `a non-Error ${typeof error}`
}

/**
 * THE ONE PLACE A THROW FROM READING A PAYLOAD IS CLASSIFIED.
 *
 * `read()` touches caller-supplied data — an accessor, a Proxy trap — so it can
 * raise anything. Letting that escape would surface a raw TypeError from the
 * hashing boundary, which is exactly the leak the error contract forbids.
 * Classifying it as a persisted-shape violation is not swallowing: the failure
 * is reported, with the field path, through the refusal callers already handle,
 * and nothing downstream proceeds on a value that was never obtained.
 *
 * Errors raised by this package's OWN logic never pass through here — this
 * wraps a single property access and nothing else.
 */
function readOnce(
  read: () => unknown,
  path: string,
  out: PersistedShapeViolation[]
): DeclaredRead {
  try {
    return { read: true, value: read() }
  } catch (error) {
    out.push({
      code: 'UNREADABLE_DECLARED_FIELD',
      path,
      message: `reading the declared field threw ${describeThrown(error)}`,
    })
    return { read: false }
  }
}

/** Presence, then EXACTLY ONE read of the value. */
function readDeclaredField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  out: PersistedShapeViolation[]
): DeclaredRead {
  const present = readOnce(() => key in record, path, out)
  if (!present.read) return { read: false }
  if (present.value !== true) {
    out.push({ code: 'MISSING_DECLARED_FIELD', path, message: 'declared field is absent' })
    return { read: false }
  }
  return readOnce(() => record[key], path, out)
}

function snapshotString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  out: PersistedShapeViolation[]
): string | undefined {
  const read = readDeclaredField(record, key, path, out)
  if (!read.read) return undefined
  if (typeof read.value !== 'string') {
    out.push({
      code: 'WRONG_DECLARED_TYPE',
      path,
      message: `declared string, received ${typeof read.value}`,
    })
    return undefined
  }
  return read.value
}

/**
 * A declared `number` must also be FINITE.
 *
 * Not an extra rule: `canonicalize` refuses NaN and Infinity because they have
 * no canonical form, so admitting one here would only move the same refusal to
 * a less informative throw further in.
 */
function snapshotFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  out: PersistedShapeViolation[]
): number | undefined {
  const read = readDeclaredField(record, key, path, out)
  if (!read.read) return undefined
  if (typeof read.value !== 'number') {
    out.push({
      code: 'WRONG_DECLARED_TYPE',
      path,
      message: `declared number, received ${typeof read.value}`,
    })
    return undefined
  }
  if (!Number.isFinite(read.value)) {
    out.push({ code: 'WRONG_DECLARED_TYPE', path, message: 'number has no canonical form' })
    return undefined
  }
  return read.value
}

function snapshotBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  out: PersistedShapeViolation[]
): boolean | undefined {
  const read = readDeclaredField(record, key, path, out)
  if (!read.read) return undefined
  if (typeof read.value !== 'boolean') {
    out.push({
      code: 'WRONG_DECLARED_TYPE',
      path,
      message: `declared boolean, received ${typeof read.value}`,
    })
    return undefined
  }
  return read.value
}

/**
 * Materialize a declared array, index by index, rejecting every HOLE.
 *
 * `forEach`/`map` are deliberately not used, and neither is `Object.keys`.
 * Both of the first two SKIP a hole rather than report it, which is how a
 * sparse array reached an authoritative digest: the elements that existed were
 * validated, the hole survived `map`, and `join` rendered it as the empty
 * string. `Object.keys(...).length === length` would be a heuristic, not a
 * predicate — it is satisfied by a same-sized set of the WRONG keys.
 *
 * The predicate is OWN-INDEX: `Object.prototype.hasOwnProperty.call(value, i)`.
 * `i in value` would be the wrong one, because HasProperty walks the prototype
 * chain, so a numeric property planted on an array's prototype would FILL the
 * hole and let the payload through carrying a value the stored row does not
 * have. Measured at this base before the change, exactly that produced the
 * authoritative digest a082bd9f49238f6c….
 *
 * STORED ORDER is preserved: this walks 0..length-1 and never sorts.
 */
function snapshotDeclaredArray<T>(
  value: unknown,
  path: string,
  declaredElement: string,
  snapshotItem: (item: unknown, itemPath: string, out: PersistedShapeViolation[]) => T | undefined,
  out: PersistedShapeViolation[]
): readonly T[] | undefined {
  if (!Array.isArray(value)) {
    out.push({
      code: 'NOT_AN_ARRAY',
      path,
      message: `declared an array of ${declaredElement}, received ${typeof value}`,
    })
    return undefined
  }
  const length = value.length
  const items: T[] = []
  let intact = true
  for (let i = 0; i < length; i += 1) {
    const itemPath = `${path}[${i}]`
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      out.push({
        code: 'SPARSE_ARRAY',
        path: itemPath,
        message: `declared array of length ${length} has no own element at this index; a hole is not a stored value`,
      })
      intact = false
      continue
    }
    const element = readOnce(() => (value as readonly unknown[])[i], itemPath, out)
    if (!element.read) {
      intact = false
      continue
    }
    const item = snapshotItem(element.value, itemPath, out)
    if (item === undefined) intact = false
    else items.push(item)
  }
  return intact ? items : undefined
}

function snapshotBand(
  value: unknown,
  path: string,
  out: PersistedShapeViolation[]
): DecisionBand | undefined {
  if (!isPlainRecord(value)) {
    out.push({
      code: 'NOT_AN_OBJECT',
      path,
      message: 'declared DecisionBand, received a non-object',
    })
    return undefined
  }
  // `outcome` is declared DecisionOutcome, a CLOSED set of three (HD-04) — so
  // membership IS the declared type here, not an invented business rule.
  const outcomeRead = readDeclaredField(value, 'outcome', `${path}.outcome`, out)
  let outcome: DecisionOutcome | undefined
  if (outcomeRead.read) {
    if (DECISION_OUTCOMES.includes(outcomeRead.value as never)) {
      outcome = outcomeRead.value as DecisionOutcome
    } else {
      out.push({
        code: 'WRONG_DECLARED_TYPE',
        path: `${path}.outcome`,
        message: 'not one of the three DECISION_OUTCOMES',
      })
    }
  }
  const lowerBound = snapshotFiniteNumber(value, 'lower_bound', `${path}.lower_bound`, out)
  const upperBound = snapshotFiniteNumber(value, 'upper_bound', `${path}.upper_bound`, out)
  const lowerInclusive = snapshotBoolean(
    value,
    'lower_bound_inclusive',
    `${path}.lower_bound_inclusive`,
    out
  )
  const upperInclusive = snapshotBoolean(
    value,
    'upper_bound_inclusive',
    `${path}.upper_bound_inclusive`,
    out
  )
  if (
    outcome === undefined ||
    lowerBound === undefined ||
    upperBound === undefined ||
    lowerInclusive === undefined ||
    upperInclusive === undefined
  ) {
    return undefined
  }
  return {
    outcome,
    lower_bound: lowerBound,
    lower_bound_inclusive: lowerInclusive,
    upper_bound: upperBound,
    upper_bound_inclusive: upperInclusive,
  }
}

function snapshotPolicy(
  value: unknown,
  path: string,
  out: PersistedShapeViolation[]
): DecisionPolicy | undefined {
  if (!isPlainRecord(value)) {
    out.push({
      code: 'NOT_AN_OBJECT',
      path,
      message: 'declared DecisionPolicy, received a non-object',
    })
    return undefined
  }
  const bandsRead = readDeclaredField(value, 'bands', `${path}.bands`, out)
  if (!bandsRead.read) return undefined
  const bands = snapshotDeclaredArray(
    bandsRead.value,
    `${path}.bands`,
    'DecisionBand',
    snapshotBand,
    out
  )
  return bands === undefined ? undefined : { bands }
}

function snapshotCriterion(
  value: unknown,
  path: string,
  out: PersistedShapeViolation[]
): Criterion | undefined {
  if (!isPlainRecord(value)) {
    out.push({ code: 'NOT_AN_OBJECT', path, message: 'declared Criterion, received a non-object' })
    return undefined
  }
  const criterionKey = snapshotString(value, 'criterion_key', `${path}.criterion_key`, out)
  const weight = snapshotFiniteNumber(value, 'weight', `${path}.weight`, out)
  const maxScore = snapshotFiniteNumber(value, 'max_score', `${path}.max_score`, out)
  if (criterionKey === undefined || weight === undefined || maxScore === undefined) {
    return undefined
  }
  return { criterion_key: criterionKey, weight, max_score: maxScore }
}

/**
 * Structural validation of decision_policy_json, as a reportable result.
 *
 * Distinct from `validateDecisionPolicy`, and both are needed: this one asks
 * "is this a storable policy value", that one asks "is this policy PUBLISHABLE"
 * (ordered, gapless, exhaustive — HD-03). A draft policy passes this and fails
 * that, which is the correct pair of answers.
 */
export function validateDecisionPolicyShape(
  value: unknown
): PersistedShapeValidationResult<DecisionPolicy> {
  const violations: PersistedShapeViolation[] = []
  const snapshot = snapshotPolicy(value, 'decision_policy_json', violations)
  return snapshot !== undefined && violations.length === 0
    ? { valid: true, value: snapshot }
    : { valid: false, violations }
}

/**
 * Structural validation of the immutable OBJ-2 payload, as a reportable result.
 *
 * Takes `unknown` on purpose: this is the boundary a payload crosses on its way
 * in from a request body or a store row, and a parameter typed
 * `TemplateVersionDefinition` would be asserting the very thing being checked.
 */
export function validateTemplateVersionDefinition(
  value: unknown
): PersistedShapeValidationResult<TemplateVersionDefinition> {
  const violations: PersistedShapeViolation[] = []
  if (!isPlainRecord(value)) {
    return {
      valid: false,
      violations: [
        {
          code: 'NOT_AN_OBJECT',
          path: 'definition',
          message: 'declared TemplateVersionDefinition, received a non-object',
        },
      ],
    }
  }
  // Written out one field at a time, in OBJ-2's declared order, for the same
  // reason the projections below are exhaustive literals rather than spreads: a
  // loop over a key list is a SECOND hand-maintained enumeration of the
  // declared shape, and a second list is what falls out of step.
  const organizationId = snapshotString(value, 'organization_id', 'organization_id', violations)
  const templateId = snapshotString(value, 'template_id', 'template_id', violations)
  const version = snapshotString(value, 'version', 'version', violations)
  const ordinal = snapshotFiniteNumber(value, 'ordinal', 'ordinal', violations)

  const criteriaRead = readDeclaredField(value, 'criteria_json', 'criteria_json', violations)
  const criteria = criteriaRead.read
    ? snapshotDeclaredArray(
        criteriaRead.value,
        'criteria_json',
        'Criterion',
        snapshotCriterion,
        violations
      )
    : undefined

  const policyRead = readDeclaredField(
    value,
    'decision_policy_json',
    'decision_policy_json',
    violations
  )
  const policy = policyRead.read
    ? snapshotPolicy(policyRead.value, 'decision_policy_json', violations)
    : undefined

  // supersedes_version_id is declared `string | null`; NULLABLE in OBJ-2. `null`
  // is a legitimate declared value here, so it cannot double as the failure
  // sentinel — `read` carries the distinction instead.
  const supersedesRead = readDeclaredField(
    value,
    'supersedes_version_id',
    'supersedes_version_id',
    violations
  )
  let supersedes: string | null | undefined
  if (supersedesRead.read) {
    if (supersedesRead.value === null || typeof supersedesRead.value === 'string') {
      supersedes = supersedesRead.value
    } else {
      violations.push({
        code: 'WRONG_DECLARED_TYPE',
        path: 'supersedes_version_id',
        message: `declared string | null, received ${typeof supersedesRead.value}`,
      })
    }
  }

  const createdBy = snapshotString(value, 'created_by', 'created_by', violations)
  const createdByRole = snapshotString(value, 'created_by_role', 'created_by_role', violations)
  const createdAt = snapshotString(value, 'created_at', 'created_at', violations)

  // The two conditions coincide by construction — every path that reports a
  // violation also withholds its field — and both are checked because they are
  // DIFFERENT claims: "nothing was reported wrong", and "every declared field
  // was actually obtained". The second is also what narrows the locals below
  // from `T | undefined` to `T`, so the snapshot literal needs no assertion.
  if (
    violations.length > 0 ||
    organizationId === undefined ||
    templateId === undefined ||
    version === undefined ||
    createdBy === undefined ||
    createdByRole === undefined ||
    createdAt === undefined ||
    ordinal === undefined ||
    supersedes === undefined ||
    criteria === undefined ||
    policy === undefined
  ) {
    return { valid: false, violations }
  }
  return {
    valid: true,
    value: {
      organization_id: organizationId,
      template_id: templateId,
      version,
      ordinal,
      criteria_json: criteria,
      decision_policy_json: policy,
      supersedes_version_id: supersedes,
      created_by: createdBy,
      created_by_role: createdByRole,
      created_at: createdAt,
    },
  }
}

/**
 * Project a declared array field element-wise, preserving STORED ORDER.
 *
 * `map` is not `sort`. Band order is load-bearing (HD-03) and criterion order
 * is stored as given; nothing here may reorder what the row holds.
 *
 * There is no non-array fallthrough. There used to be one — `Array.isArray(v) ?
 * v.map(project) : v` — and it was not defensive noise, it was a HOLE: a
 * `criteria_json` that was an object rather than an array was returned
 * UNPROJECTED, so every enumerable property it carried entered the digest and
 * reopened exactly the class the positive projection exists to close. Structural
 * validity is now established ONCE, at the hashing boundary, so by the time a
 * projection runs the array is an array.
 */
function projectDeclaredArray<T, P>(value: readonly T[], project: (item: T) => P): readonly P[] {
  return value.map(project)
}

/** DecisionBand's five declared properties, and nothing else. */
function projectBand(band: DecisionBand): HashProjection<DecisionBand> {
  return {
    outcome: band.outcome,
    lower_bound: band.lower_bound,
    lower_bound_inclusive: band.lower_bound_inclusive,
    upper_bound: band.upper_bound,
    upper_bound_inclusive: band.upper_bound_inclusive,
  }
}

/** Criterion's three declared properties, and nothing else. */
function projectCriterion(criterion: Criterion): HashProjection<Criterion> {
  return {
    criterion_key: criterion.criterion_key,
    weight: criterion.weight,
    max_score: criterion.max_score,
  }
}

/**
 * decision_policy_json's declared shape: an ordered array of projected bands.
 *
 * There is no `bands === undefined` fallthrough returning `policy` either. That
 * one was the sharpest instance of the same hole: a policy object WITHOUT bands
 * was returned whole, so a `__validated` brand — or any column a store round-
 * tripped — became load-bearing in decision_policy_hash. Measured before the
 * change: `{ __validated: 'X' }` and `{ zzz: 'leak' }` produced two DIFFERENT
 * authoritative digests, both from the same absent-bands path.
 */
function projectDecisionPolicy(policy: DecisionPolicy): HashProjection<DecisionPolicy> {
  return { bands: projectDeclaredArray(policy.bands, projectBand) }
}

/**
 * TemplateVersionDefinition's ten declared properties, and nothing else.
 *
 * decision_policy_json is re-projected rather than copied by reference: the
 * brand sits at the POLICY's own top level, so a validated policy embedded in a
 * definition would otherwise perturb definition_hash by exactly the same route.
 *
 * Publication columns stay absent here for the reason OBJ-2 gives — they are
 * the one write-once NULL-to-value transition permitted after insert, so
 * admitting them would make definition_hash move at publication, and
 * definition_hash exists to prove the version did NOT move.
 */
function projectTemplateVersionDefinition(
  definition: TemplateVersionDefinition
): HashProjection<TemplateVersionDefinition> {
  return {
    organization_id: definition.organization_id,
    template_id: definition.template_id,
    version: definition.version,
    ordinal: definition.ordinal,
    criteria_json: projectDeclaredArray(definition.criteria_json, projectCriterion),
    decision_policy_json: projectDecisionPolicy(definition.decision_policy_json),
    supersedes_version_id: definition.supersedes_version_id,
    created_by: definition.created_by,
    created_by_role: definition.created_by_role,
    created_at: definition.created_at,
  }
}

/**
 * definition_hash — over the WHOLE immutable version payload.
 *
 * Includes decision_policy_json, because the policy is part of the version.
 * That is exactly why it cannot stand in for decision_policy_hash: it moves
 * when the criteria move, so it cannot attribute a recommendation to a policy.
 */
export function computeDefinitionHash(definition: TemplateVersionDefinition): string {
  const validation = validateTemplateVersionDefinition(definition)
  if (!validation.valid) {
    throw new EvaluatePersistedShapeError('definition', validation.violations)
  }
  return sha256Hex(
    DEFINITION_HASH_DOMAIN,
    canonicalize(projectTemplateVersionDefinition(validation.value))
  )
}

/** decision_policy_hash — over decision_policy_json ALONE. */
export function computeDecisionPolicyHash(policy: DecisionPolicy): string {
  const validation = validateDecisionPolicyShape(policy)
  if (!validation.valid) {
    throw new EvaluatePersistedShapeError('decision_policy_json', validation.violations)
  }
  return sha256Hex(
    DECISION_POLICY_HASH_DOMAIN,
    canonicalize(projectDecisionPolicy(validation.value))
  )
}
