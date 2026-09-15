/**
 * P-09 from docs/ops/evaluate/EVALUATE_COMMERCIAL_V1_TEST_MANIFEST_v1.0.0.json.
 *
 * P-09 has four clauses. Two are dischargeable by a pure engine at this HEAD
 * and two are not, and they are labelled rather than blurred:
 *
 *   (a) UNIQUE (template_id, version) and UNIQUE (template_id, ordinal)
 *       -> DEFERRED. These are OBJ-2 identity constraints. W-EV-2 is the pure
 *          engine; it authors no DDL and no migration, so there is no relation
 *          at this HEAD for a uniqueness violation to be refused BY. Asserting
 *          uniqueness over an in-memory array here would be a test of the
 *          array, dressed as a test of the constraint.
 *   (b) definition_hash and decision_policy_hash computed over a canonical
 *       serialization and stable across recomputation  -> DISCHARGED below.
 *   (c) the two hashes are SEPARATE                    -> DISCHARGED below.
 *   (d) an evaluation pinned to version N is unaffected by the publication of
 *       version N+1 or by the retirement of its container -> DISCHARGED below
 *          in its pure half: the observable the engine owns is the Score and
 *          the recommended outcome. The persistence half (the pin is never
 *          repointed by any statement) is DEFERRED with (a).
 */

import { describe, expect, it } from 'vitest'

import {
  canonicalize,
  computeDecisionPolicyHash,
  computeDefinitionHash,
  recommendOutcome,
  validateDecisionPolicy,
} from '../decision-policy'
import { computeScore } from '../scoring'
import type {
  Criterion,
  CriterionResponse,
  DecisionBand,
  DecisionPolicy,
  TemplateVersionDefinition,
  ValidatedDecisionPolicy,
} from '../types'

const POLICY_V1: DecisionPolicy = {
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

const CRITERIA_V1: readonly Criterion[] = [
  { criterion_key: 'governance', weight: 1, max_score: 10 },
  { criterion_key: 'outcomes', weight: 3, max_score: 10 },
]

const VERSION_1: TemplateVersionDefinition = {
  organization_id: 'org-1',
  template_id: 'tpl-1',
  version: '1.0.0',
  ordinal: 1,
  criteria_json: CRITERIA_V1,
  decision_policy_json: POLICY_V1,
  supersedes_version_id: null,
  created_by: 'user-admin-1',
  created_by_role: 'organization_admin',
  created_at: '2026-09-01T09:00:00.000Z',
}

describe('P-09 (b) hashes are canonical and stable across recomputation', () => {
  it('returns the same definition_hash for the same definition', () => {
    expect(computeDefinitionHash(VERSION_1)).toBe(computeDefinitionHash(VERSION_1))
    expect(computeDefinitionHash(VERSION_1)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is insensitive to the key ORDER of the payload, and only to that', () => {
    // Same facts, different property insertion order. A JSON.stringify-based
    // hash would produce a different digest here and the immutability proof
    // would fail on a round trip through any store that reorders keys.
    const reordered = {
      created_at: VERSION_1.created_at,
      created_by_role: VERSION_1.created_by_role,
      created_by: VERSION_1.created_by,
      supersedes_version_id: VERSION_1.supersedes_version_id,
      decision_policy_json: VERSION_1.decision_policy_json,
      criteria_json: VERSION_1.criteria_json,
      ordinal: VERSION_1.ordinal,
      version: VERSION_1.version,
      template_id: VERSION_1.template_id,
      organization_id: VERSION_1.organization_id,
    } as TemplateVersionDefinition

    expect(canonicalize(reordered)).toBe(canonicalize(VERSION_1))
    expect(computeDefinitionHash(reordered)).toBe(computeDefinitionHash(VERSION_1))
  })

  it('preserves ARRAY order, which is meaningful where key order is not', () => {
    // HD-03 makes band order load-bearing, so the canonicalizer must not sort
    // arrays the way it sorts object keys.
    const swapped: DecisionPolicy = {
      bands: [POLICY_V1.bands[1], POLICY_V1.bands[0], POLICY_V1.bands[2]],
    }
    expect(canonicalize(swapped)).not.toBe(canonicalize(POLICY_V1))
    expect(computeDecisionPolicyHash(swapped)).not.toBe(computeDecisionPolicyHash(POLICY_V1))
  })

  it('moves when any field of the payload moves (positive control)', () => {
    const baseline = computeDefinitionHash(VERSION_1)
    const mutations: TemplateVersionDefinition[] = [
      { ...VERSION_1, version: '1.0.1' },
      { ...VERSION_1, ordinal: 2 },
      { ...VERSION_1, organization_id: 'org-2' },
      { ...VERSION_1, criteria_json: [{ criterion_key: 'governance', weight: 2, max_score: 10 }] },
      { ...VERSION_1, decision_policy_json: { bands: [POLICY_V1.bands[0]] } },
    ]
    for (const mutated of mutations) {
      expect(computeDefinitionHash(mutated)).not.toBe(baseline)
    }
    // A hash function that ignored its input would satisfy "stable across
    // recomputation" perfectly, so stability alone is not evidence.
    expect(new Set(mutations.map(computeDefinitionHash)).size).toBe(mutations.length)
  })

  it('refuses a payload with no canonical form rather than inventing one', () => {
    expect(() => canonicalize({ weight: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalize({ weight: Number.POSITIVE_INFINITY })).toThrow(TypeError)
  })
})

describe('P-09 (c) definition_hash and decision_policy_hash stay SEPARATE', () => {
  it('produces two different digests for one version', () => {
    expect(computeDefinitionHash(VERSION_1)).not.toBe(computeDecisionPolicyHash(POLICY_V1))
  })

  it('moves definition_hash but NOT decision_policy_hash when only criteria change', () => {
    const criteriaChanged: TemplateVersionDefinition = {
      ...VERSION_1,
      criteria_json: [...CRITERIA_V1, { criterion_key: 'safeguarding', weight: 2, max_score: 10 }],
    }
    expect(computeDefinitionHash(criteriaChanged)).not.toBe(computeDefinitionHash(VERSION_1))
    // This is the guarantee a merged artifact hash would destroy: the
    // recommendation snapshotted against this policy stays attributable to it.
    expect(computeDecisionPolicyHash(criteriaChanged.decision_policy_json)).toBe(
      computeDecisionPolicyHash(VERSION_1.decision_policy_json)
    )
  })

  it('moves BOTH when the policy changes', () => {
    const policyChanged: TemplateVersionDefinition = {
      ...VERSION_1,
      decision_policy_json: {
        bands: [
          { ...POLICY_V1.bands[0], upper_bound: 0.6 },
          { ...POLICY_V1.bands[1], lower_bound: 0.6 },
          POLICY_V1.bands[2],
        ],
      },
    }
    expect(computeDefinitionHash(policyChanged)).not.toBe(computeDefinitionHash(VERSION_1))
    expect(computeDecisionPolicyHash(policyChanged.decision_policy_json)).not.toBe(
      computeDecisionPolicyHash(VERSION_1.decision_policy_json)
    )
  })

  it('keeps the two digests distinct even when the payloads would serialize alike', () => {
    // Domain separation, asserted rather than assumed: without a tag, hashing
    // "the whole payload" and "the policy alone" could collide for a payload
    // that happened to equal its own policy.
    const policyAsPayload = POLICY_V1 as unknown as TemplateVersionDefinition
    expect(computeDefinitionHash(policyAsPayload)).not.toBe(computeDecisionPolicyHash(POLICY_V1))
  })
})

describe('P-09 (d) an evaluation pinned to version N is unaffected by version N+1', () => {
  const responses: readonly CriterionResponse[] = [
    {
      criterion_key: 'governance',
      ordinal: 1,
      response_kind: 'SCORED',
      score_value: 9,
      na_rationale: null,
      recorded_by: 'user-analyst-1',
      recorded_by_role: 'analyst',
      recorded_at: '2026-09-02T09:00:00.000Z',
    },
    {
      criterion_key: 'outcomes',
      ordinal: 1,
      response_kind: 'SCORED',
      score_value: 9,
      na_rationale: null,
      recorded_by: 'user-analyst-1',
      recorded_by_role: 'analyst',
      recorded_at: '2026-09-02T09:05:00.000Z',
    },
  ]

  it('yields an identical Score and recommendation after a successor is published', () => {
    const validation = validateDecisionPolicy(VERSION_1.decision_policy_json)
    expect(validation.valid).toBe(true)
    if (!validation.valid) throw new Error('unreachable')

    const scoreBefore = computeScore(VERSION_1.criteria_json, responses)
    const recommendationBefore = recommendOutcome(validation.policy, scoreBefore)
    expect(recommendationBefore).toEqual({ recommended: true, outcome: 'approve' })

    // Version 2 is published: different criteria, a much stricter policy, and
    // the container is retired. None of it is reachable from the pinned pair.
    const VERSION_2: TemplateVersionDefinition = {
      ...VERSION_1,
      version: '2.0.0',
      ordinal: 2,
      supersedes_version_id: 'version-1-id',
      criteria_json: [
        { criterion_key: 'governance', weight: 1, max_score: 10 },
        { criterion_key: 'outcomes', weight: 3, max_score: 10 },
        { criterion_key: 'safeguarding', weight: 9, max_score: 10 },
      ],
      decision_policy_json: {
        bands: [
          {
            outcome: 'reject',
            lower_bound: 0,
            lower_bound_inclusive: true,
            upper_bound: 1,
            upper_bound_inclusive: true,
          },
        ],
      },
    }
    expect(computeDefinitionHash(VERSION_2)).not.toBe(computeDefinitionHash(VERSION_1))

    const scoreAfter = computeScore(VERSION_1.criteria_json, responses)
    const recommendationAfter = recommendOutcome(validation.policy, scoreAfter)

    expect(JSON.stringify(scoreAfter)).toBe(JSON.stringify(scoreBefore))
    expect(recommendationAfter).toEqual(recommendationBefore)

    // And the successor really would have decided differently, so the
    // invariance above is a fact about pinning and not about two policies that
    // happen to agree.
    const successorValidation = validateDecisionPolicy(VERSION_2.decision_policy_json)
    expect(successorValidation.valid).toBe(true)
    if (!successorValidation.valid) throw new Error('unreachable')
    expect(recommendOutcome(successorValidation.policy, scoreAfter)).toEqual({
      recommended: true,
      outcome: 'reject',
    })
  })
})

/**
 * W5-A HASH PROJECTION CONTROLS.
 *
 * The defect these close: `validateDecisionPolicy` returns a policy carrying an
 * enumerable `__validated` brand, `ValidatedDecisionPolicy` is structurally
 * assignable to `DecisionPolicy`, and the hashes canonicalized whatever object
 * they were handed. A policy validated before its immutable hash was recorded
 * therefore hashed DIFFERENTLY from the same policy read back out of the row.
 *
 * WHY THE EXPECTED DIGESTS ARE FROZEN LITERALS. These two constants were
 * measured on the integrated implementation BEFORE the projection existed. An
 * expectation written as computeDecisionPolicyHash(POLICY_V1) would be computed
 * by the very helper under test: it would move with the implementation and
 * report PASS for a digest that had silently changed for every row already
 * stored under it. A literal cannot move. These are the lane's immutable
 * evidence that hardening the hash boundary did NOT alter the identity of any
 * declared payload.
 */
describe('W5-A the hashes cover the DECLARED payload, not the object supplied', () => {
  const POLICY_RAW_DIGEST = 'da4b7858f4b0db49bea5b9ac929ddfd68e0c824b036a736cf9f90b7dfd1e8ea9'
  const VERSION_RAW_DIGEST = '3c43ebe82ff528ed92107d11fc7d5fd78a8e104a3dcd18a44b1dc0e1ee5d275d'

  /** The branded policy. Callers assert the brand is PRESENT, so nothing is vacuous. */
  function validatedPolicyV1(): ValidatedDecisionPolicy {
    const validation = validateDecisionPolicy(POLICY_V1)
    expect(validation.valid).toBe(true)
    if (!validation.valid) throw new Error('unreachable')
    return validation.policy
  }

  it('A: leaves the raw POLICY_V1 digest identical to its pre-projection value', () => {
    expect(computeDecisionPolicyHash(POLICY_V1)).toBe(POLICY_RAW_DIGEST)
  })

  it('B: leaves the raw VERSION_1 digest identical to its pre-projection value', () => {
    expect(computeDefinitionHash(VERSION_1)).toBe(VERSION_RAW_DIGEST)
  })

  it('C: hashes a VALIDATED policy exactly as its raw declared policy', () => {
    const validated = validatedPolicyV1()

    // The brand is a real enumerable own property and the canonicalizer still
    // serializes it. Asserting BOTH is what makes this control load-bearing: a
    // future "fix" that deleted the brand, or one that taught canonicalize to
    // skip keys beginning with a double underscore, would satisfy the digest
    // equality below while destroying the guarantee it stands for. Here the
    // brand survives untouched and is excluded by the PROJECTION alone.
    expect(Object.keys(validated)).toContain('__validated')
    expect(canonicalize(validated)).toContain('__validated')

    expect(computeDecisionPolicyHash(validated)).toBe(POLICY_RAW_DIGEST)
  })

  it('C2: leaves definition_hash unmoved when the EMBEDDED policy is the validated one', () => {
    // The brand sits at the policy's own top level, so validate-then-record
    // would have moved definition_hash by exactly the same route.
    const embedded: TemplateVersionDefinition = {
      ...VERSION_1,
      decision_policy_json: validatedPolicyV1(),
    }
    expect(computeDefinitionHash(embedded)).toBe(VERSION_RAW_DIGEST)
  })

  it('D: ignores an UNKNOWN enumerable property wherever it is attached', () => {
    // A store round-tripping an extra column, a publication column, a debugging
    // annotation: none are declared, so none may reach an identity digest.
    // Attached at four different depths on purpose — a top-level-only guard
    // would pass a shallower test and still let a nested extra through.
    const policyPlusExtra = {
      ...POLICY_V1,
      round_tripped_by_a_store: 'not a declared field',
    } as DecisionPolicy
    expect(computeDecisionPolicyHash(policyPlusExtra)).toBe(POLICY_RAW_DIGEST)

    const bandPlusExtra: DecisionPolicy = {
      bands: [
        { ...POLICY_V1.bands[0], label: 'Reject' } as DecisionBand,
        POLICY_V1.bands[1],
        POLICY_V1.bands[2],
      ],
    }
    expect(computeDecisionPolicyHash(bandPlusExtra)).toBe(POLICY_RAW_DIGEST)

    const definitionPlusExtra = {
      ...VERSION_1,
      published_at: '2026-09-02T09:00:00.000Z',
      published_by: 'user-admin-1',
    } as TemplateVersionDefinition
    expect(computeDefinitionHash(definitionPlusExtra)).toBe(VERSION_RAW_DIGEST)

    const criterionPlusExtra = {
      ...VERSION_1,
      criteria_json: [{ ...CRITERIA_V1[0], display_order: 1 } as Criterion, CRITERIA_V1[1]],
    } as TemplateVersionDefinition
    expect(computeDefinitionHash(criterionPlusExtra)).toBe(VERSION_RAW_DIGEST)
  })

  /**
   * THE SENSITIVITY CONTROLS COMPARE AGAINST A LIVE BASELINE, NOT THE LITERAL.
   *
   * This is the opposite choice from controls A-D above, and deliberately so.
   * A-D assert IDENTITY, so their expectation must be a frozen literal that
   * cannot drift with the implementation. E-F2 assert SENSITIVITY — that every
   * declared field is actually READ — and for that a frozen literal is the
   * wrong comparand: delete a field from the projection and the mutation of
   * that field silently collapses onto the unmutated digest, while the literal
   * (which now matches nothing at all) keeps every inequality below trivially
   * true. Measured, not assumed: dropping upper_bound_inclusive from the band
   * projection turned A, B, C, C2 and D red and left a literal-based E GREEN.
   *
   * Comparing against the live baseline is not the self-referential expectation
   * the frozen literals exist to avoid. Nothing here asserts WHICH digest the
   * baseline is; it asserts only that a mutated payload cannot share it. A
   * projection that ignored its input entirely would fail every line below.
   */
  it('E: moves the policy digest when ANY of the five declared band fields moves', () => {
    const baseline = computeDecisionPolicyHash(POLICY_V1)
    const mutatedBands: DecisionBand[] = [
      { ...POLICY_V1.bands[0], outcome: 'approve_with_conditions' },
      { ...POLICY_V1.bands[0], lower_bound: 0.01 },
      { ...POLICY_V1.bands[0], lower_bound_inclusive: false },
      { ...POLICY_V1.bands[0], upper_bound: 0.55 },
      { ...POLICY_V1.bands[0], upper_bound_inclusive: true },
    ]
    const digests = mutatedBands.map((band) =>
      computeDecisionPolicyHash({ bands: [band, POLICY_V1.bands[1], POLICY_V1.bands[2]] })
    )
    for (const digest of digests) expect(digest).not.toBe(baseline)
    // Mutually distinct too: five assertions that all produced one digest would
    // say nothing about WHICH field each mutation moved.
    expect(new Set(digests).size).toBe(mutatedBands.length)
  })

  it('F: moves the definition digest when ANY of the ten declared version fields moves', () => {
    const baseline = computeDefinitionHash(VERSION_1)
    const mutations: TemplateVersionDefinition[] = [
      { ...VERSION_1, organization_id: 'org-2' },
      { ...VERSION_1, template_id: 'tpl-2' },
      { ...VERSION_1, version: '1.0.1' },
      { ...VERSION_1, ordinal: 2 },
      { ...VERSION_1, criteria_json: [CRITERIA_V1[0]] },
      { ...VERSION_1, decision_policy_json: { bands: [POLICY_V1.bands[0]] } },
      { ...VERSION_1, supersedes_version_id: 'version-0-id' },
      { ...VERSION_1, created_by: 'user-admin-2' },
      { ...VERSION_1, created_by_role: 'impact_manager' },
      { ...VERSION_1, created_at: '2026-09-01T09:00:01.000Z' },
    ]
    const digests = mutations.map(computeDefinitionHash)
    for (const digest of digests) expect(digest).not.toBe(baseline)
    expect(new Set(digests).size).toBe(mutations.length)
  })

  it('F2: moves the definition digest when ANY of the three declared criterion fields moves', () => {
    const baseline = computeDefinitionHash(VERSION_1)
    const mutatedCriteria: Criterion[][] = [
      [{ ...CRITERIA_V1[0], criterion_key: 'governance_v2' }, CRITERIA_V1[1]],
      [{ ...CRITERIA_V1[0], weight: 2 }, CRITERIA_V1[1]],
      [{ ...CRITERIA_V1[0], max_score: 5 }, CRITERIA_V1[1]],
    ]
    const digests = mutatedCriteria.map((criteria_json) =>
      computeDefinitionHash({ ...VERSION_1, criteria_json })
    )
    for (const digest of digests) expect(digest).not.toBe(baseline)
    expect(new Set(digests).size).toBe(mutatedCriteria.length)
  })

  it('G: projects a declared array element-wise and never reorders it', () => {
    // The projection maps; it must never sort. HD-03 makes band order
    // load-bearing, and criterion order is stored as given.
    const swappedBands: DecisionPolicy = {
      bands: [POLICY_V1.bands[1], POLICY_V1.bands[0], POLICY_V1.bands[2]],
    }
    expect(computeDecisionPolicyHash(swappedBands)).not.toBe(POLICY_RAW_DIGEST)

    const swappedCriteria: TemplateVersionDefinition = {
      ...VERSION_1,
      criteria_json: [CRITERIA_V1[1], CRITERIA_V1[0]],
    }
    expect(computeDefinitionHash(swappedCriteria)).not.toBe(VERSION_RAW_DIGEST)
  })
})

/**
 * DEFERRED, not discharged. See the header: these belong to the package that
 * authors OBJ-2's DDL (W-EV-1) and to the one that performs T1's pin. Marking
 * them todo keeps them visible in the runner's output instead of letting an
 * absent assertion read as a satisfied one.
 */
describe.todo('P-09 (a) UNIQUE (template_id, version) and (template_id, ordinal) — requires OBJ-2 DDL')
describe.todo('P-09 (d, persistence half) template_version_id is never repointed — requires T1')
