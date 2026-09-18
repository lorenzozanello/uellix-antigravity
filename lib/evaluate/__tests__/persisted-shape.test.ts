/**
 * The three prerequisites that must hold BEFORE Evaluate persistence DDL
 * (W-EV-1) is authored:
 *
 *   A. fail-closed authoritative hashing — a malformed payload gets NO digest
 *   B. compile-time exhaustiveness — a persisted field cannot silently fall out
 *      of the authoritative projection
 *   C. exactly ONE authoritative persisted/hashed row shape
 *
 * Several controls here are TYPE tests. Their @ts-expect-error blocks fail
 * `tsc --noEmit` if the expected error ever stops occurring, so the mechanism is
 * checked by the compiler and not by an assertion that could be satisfied at
 * runtime by anything at all. A green vitest run is NOT evidence for them; the
 * typecheck is.
 *
 * Every measured "before" number quoted below was taken at
 * 5ea678e6a42e99c420ca58ae6b5d150a404dc036.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  computeDecisionPolicyHash,
  computeDefinitionHash,
  EvaluatePersistedShapeError,
  validateDecisionPolicyShape,
  validateTemplateVersionDefinition,
  type CanonicalValue,
  type HashProjection,
} from '../decision-policy'
import type {
  Criterion,
  DecisionBand,
  DecisionPolicy,
  TemplateVersionDefinition,
} from '../types'

const POLICY: DecisionPolicy = {
  bands: [
    {
      outcome: 'reject',
      lower_bound: 0,
      lower_bound_inclusive: true,
      upper_bound: 0.5,
      upper_bound_inclusive: false,
    },
    {
      outcome: 'approve',
      lower_bound: 0.5,
      lower_bound_inclusive: true,
      upper_bound: 1,
      upper_bound_inclusive: true,
    },
  ],
}

const VALID: TemplateVersionDefinition = {
  organization_id: 'org-1',
  template_id: 'tpl-1',
  version: '1.0.0',
  ordinal: 1,
  criteria_json: [{ criterion_key: 'governance', weight: 1, max_score: 10 }],
  decision_policy_json: POLICY,
  supersedes_version_id: null,
  created_by: 'user-admin-1',
  created_by_role: 'organization_admin',
  created_at: '2026-09-01T09:00:00.000Z',
}

/** Every violation code/path a refusal reported, for precise assertions. */
function violationsOf(run: () => unknown): readonly string[] {
  try {
    run()
  } catch (error) {
    if (error instanceof EvaluatePersistedShapeError) {
      return error.violations.map((v) => `${v.code}@${v.path}`)
    }
    throw error
  }
  throw new Error('expected a refusal, but the payload was hashed as authoritative')
}

describe('A — only a storable Evaluate row reaches authoritative hashing', () => {
  it('hashes a VALID row, and does so stably across recomputation', () => {
    // The positive half. Without it every negative below could be satisfied by a
    // function that refuses everything.
    const digest = computeDefinitionHash(VALID)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(computeDefinitionHash(VALID)).toBe(digest)
    expect(computeDecisionPolicyHash(POLICY)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a row with a DECLARED FIELD ABSENT', () => {
    // Measured before: this returned 69cdc5bd53ef4912… — a well-formed digest
    // indistinguishable from an authoritative one.
    const missing: Record<string, unknown> = { ...VALID }
    delete missing.version
    expect(
      violationsOf(() => computeDefinitionHash(missing as unknown as TemplateVersionDefinition))
    ).toEqual(['MISSING_DECLARED_FIELD@version'])
  })

  it('refuses a row whose declared ARRAY field is not an array', () => {
    // Measured before: 78dfcf83ad4b825c… — and worse, the non-array was returned
    // UNPROJECTED, so every property it carried entered the digest.
    const asObject = { ...VALID, criteria_json: { sneaky: 'leak' } }
    expect(
      violationsOf(() => computeDefinitionHash(asObject as unknown as TemplateVersionDefinition))
    ).toEqual(['NOT_AN_ARRAY@criteria_json'])
  })

  it('refuses a row whose declared NUMBER arrives as a string', () => {
    // Measured before: 93f0a15cc127b6b3… — a different digest from the numeric
    // form, so one weight had two authoritative identities.
    const stringWeight = {
      ...VALID,
      criteria_json: [{ criterion_key: 'governance', weight: '1', max_score: 10 }],
    }
    expect(
      violationsOf(() => computeDefinitionHash(stringWeight as unknown as TemplateVersionDefinition))
    ).toEqual(['WRONG_DECLARED_TYPE@criteria_json[0].weight'])
  })

  it('refuses a row that is not an object at all', () => {
    // Measured before: the bare string 'nope' hashed to f09dcf2aab155f00….
    expect(violationsOf(() => computeDefinitionHash('nope' as unknown as TemplateVersionDefinition))
    ).toEqual(['NOT_AN_OBJECT@definition'])
    expect(violationsOf(() => computeDefinitionHash(null as unknown as TemplateVersionDefinition))
    ).toEqual(['NOT_AN_OBJECT@definition'])
  })

  it('refuses a POLICY with no bands, which used to be hashed WHOLE and unprojected', () => {
    // The sharpest instance. Measured before, both of these produced DIFFERENT
    // authoritative digests (562cca94… and fcc65ad4…) because the absent-bands
    // path returned the object as supplied — so a validation brand, or any column
    // a store round-tripped, became load-bearing in decision_policy_hash.
    expect(
      violationsOf(() =>
        computeDecisionPolicyHash({ __validated: 'DECISION_POLICY_TOTALITY_PROVEN' } as unknown as DecisionPolicy)
      )
    ).toEqual(['MISSING_DECLARED_FIELD@decision_policy_json.bands'])
    expect(
      violationsOf(() => computeDecisionPolicyHash({ zzz: 'leak' } as unknown as DecisionPolicy))
    ).toEqual(['MISSING_DECLARED_FIELD@decision_policy_json.bands'])
  })

  it('refuses a malformed band, naming the band that is malformed', () => {
    const badBand = {
      bands: [POLICY.bands[0], { ...POLICY.bands[1], upper_bound_inclusive: 'yes' }],
    }
    expect(violationsOf(() => computeDecisionPolicyHash(badBand as unknown as DecisionPolicy))).toEqual(
      ['WRONG_DECLARED_TYPE@decision_policy_json.bands[1].upper_bound_inclusive']
    )
  })

  it('refuses a band outcome outside the CLOSED three', () => {
    const badOutcome = { bands: [{ ...POLICY.bands[0], outcome: 'defer' }] }
    expect(
      violationsOf(() => computeDecisionPolicyHash(badOutcome as unknown as DecisionPolicy))
    ).toEqual(['WRONG_DECLARED_TYPE@decision_policy_json.bands[0].outcome'])
  })

  it('refuses a number with no canonical form at the BOUNDARY, not deep inside', () => {
    // canonicalize would also throw, but it would throw a TypeError naming a
    // number rather than a refusal naming the FIELD.
    const notFinite = { ...VALID, ordinal: Number.NaN }
    expect(violationsOf(() => computeDefinitionHash(notFinite))).toEqual([
      'WRONG_DECLARED_TYPE@ordinal',
    ])
  })

  it('reports EVERY violation, not just the first', () => {
    // A validator that returned on first failure would make a caller fix a
    // malformed payload one round trip at a time.
    const wrecked = { ...VALID, version: 7, ordinal: 'first', created_by: null }
    const violations = violationsOf(() =>
      computeDefinitionHash(wrecked as unknown as TemplateVersionDefinition)
    )
    expect(violations).toContain('WRONG_DECLARED_TYPE@version')
    expect(violations).toContain('WRONG_DECLARED_TYPE@ordinal')
    expect(violations).toContain('WRONG_DECLARED_TYPE@created_by')
    expect(violations).toHaveLength(3)
  })

  it('reports a refusal WITHOUT throwing, for callers that collect violations', () => {
    const ok = validateTemplateVersionDefinition(VALID)
    expect(ok.valid).toBe(true)

    const bad = validateTemplateVersionDefinition({ ...VALID, template_id: 12 })
    expect(bad.valid).toBe(false)
    if (!bad.valid) expect(bad.violations[0].path).toBe('template_id')

    expect(validateDecisionPolicyShape(POLICY).valid).toBe(true)
    expect(validateDecisionPolicyShape({ bands: 'nope' }).valid).toBe(false)
  })

  /**
   * THE TOLERANCE IS DELIBERATE AND AUTHORITY-REQUIRED, SO IT IS ASSERTED TOO.
   *
   * published_at / published_by / published_by_role are real OBJ-2 columns and
   * the ONE write-once transition permitted after insert, so a row read back
   * from the store carries them and definition_hash must not move at
   * publication — definition_hash exists to prove the version did NOT move.
   * Rejecting undeclared keys would therefore break the authority, not serve it.
   */
  it('still ACCEPTS a row carrying undeclared columns, and excludes them', () => {
    const roundTripped = {
      ...VALID,
      published_at: '2026-09-02T09:00:00.000Z',
      published_by: 'user-admin-1',
      published_by_role: 'organization_admin',
    }
    expect(validateTemplateVersionDefinition(roundTripped).valid).toBe(true)
    expect(computeDefinitionHash(roundTripped as TemplateVersionDefinition)).toBe(
      computeDefinitionHash(VALID)
    )
  })
})

describe('B — a persisted field cannot silently leave the authoritative projection', () => {
  /**
   * WHY A TYPE-LEVEL CONTROL AND NOT A RUNTIME ONE.
   *
   * Measured at this base BEFORE the change: adding two new declared persisted
   * fields (one to Criterion, one to TemplateVersionDefinition) left
   * `tsc --noEmit` at exit 0 across the whole repository AND left
   * definition_hash byte-identical — 3902fb37c0a910dd… both with and without
   * the new fields. The projections returned `unknown`, so there was nothing for
   * the compiler to compare their literals against.
   *
   * The aggravating half is that no runtime control could have caught it: the
   * frozen-literal IDENTITY assertions stay green precisely BECAUSE the new
   * field is excluded. The control that exists to prove "identity did not move"
   * is exactly what hides the omission. So the mechanism has to be the compiler.
   */
  it('B-1: a projection MISSING a declared field does not compile', () => {
    // @ts-expect-error max_score is a declared Criterion field, so HashProjection<Criterion> requires it
    const incomplete: HashProjection<Criterion> = { criterion_key: 'governance', weight: 1 }
    // @ts-expect-error DecisionBand declares five fields; upper_bound_inclusive is absent here
    const incompleteBand: HashProjection<DecisionBand> = { outcome: 'reject', lower_bound: 0, lower_bound_inclusive: true, upper_bound: 1 }
    expect(incomplete).toBeDefined()
    expect(incompleteBand).toBeDefined()
  })

  it('B-2: a projection with an EXCESS field does not compile either', () => {
    // Exactness in the other direction: this is what turns a RENAME or a REMOVAL
    // red, where a missing-field check alone would pass a stale leftover key.
    // @ts-expect-error display_order is not a declared Criterion field
    const excess: HashProjection<Criterion> = { criterion_key: 'governance', weight: 1, max_score: 10, display_order: 1 }
    expect(excess).toBeDefined()
  })

  it('B-3: a projected value with no canonical form does not compile', () => {
    // The second half of the mechanism. Typing projected values as `unknown`
    // would satisfy exactness while re-admitting a value canonicalize refuses,
    // moving a structural defect back to a throw at publication time.
    // @ts-expect-error a function has no canonical serialization
    const notCanonical: CanonicalValue = () => 1
    // @ts-expect-error undefined is not a canonical value; an absent field is not a present empty one
    const undef: CanonicalValue = undefined
    expect(notCanonical).toBeDefined()
    expect(undef).toBeUndefined()
  })

  it('B-4: the DECLARED shapes are exactly what a complete projection admits', () => {
    // The positive half of B-1/B-2: these compile, so the @ts-expect-error
    // blocks above are failing for the stated reason and not because
    // HashProjection rejects everything.
    const criterion: HashProjection<Criterion> = {
      criterion_key: 'governance',
      weight: 1,
      max_score: 10,
    }
    const band: HashProjection<DecisionBand> = {
      outcome: 'reject',
      lower_bound: 0,
      lower_bound_inclusive: true,
      upper_bound: 1,
      upper_bound_inclusive: true,
    }
    expect(Object.keys(criterion)).toHaveLength(3)
    expect(Object.keys(band)).toHaveLength(5)
  })
})

describe('C — exactly ONE authoritative persisted/hashed row shape', () => {
  const SOURCE_DIR = join(process.cwd(), 'lib', 'evaluate')

  /**
   * Scoped to the ENGINE SOURCE, never to this file.
   *
   * A census that scanned its own test file would count the shapes quoted in its
   * own prose and fixtures, which is how a source sweep is made vacuous.
   */
  const sources = ['types.ts', 'decision-policy.ts', 'scoring.ts', 'divergence.ts'].map(
    (name) => ({ name, text: readFileSync(join(SOURCE_DIR, name), 'utf8') })
  )

  it('declares the OBJ-2 immutable column set in exactly one place', () => {
    // The five columns that together identify an OBJ-2 row. A second type
    // carrying all five would be a second truth about what a stored version IS.
    const OBJ2_MARKERS = [
      'organization_id',
      'template_id',
      'version:',
      'ordinal:',
      'criteria_json',
    ]
    const declaringTypes = sources.flatMap(({ name, text }) =>
      text
        .split(/\nexport type |\nexport interface /)
        .slice(1)
        .filter((block) => OBJ2_MARKERS.every((marker) => block.split('\n}')[0].includes(marker)))
        .map((block) => `${name}:${block.split(/[ ={<]/)[0]}`)
    )
    expect(declaringTypes).toEqual(['types.ts:TemplateVersionDefinition'])
  })

  it('takes the hash input FROM that type, so a view cannot redefine truth', () => {
    // Type-level and mutual: assignable both ways means the hasher's parameter
    // IS TemplateVersionDefinition, not merely something it accepts.
    type HashInput = Parameters<typeof computeDefinitionHash>[0]
    const forward: HashInput = VALID
    const backward: TemplateVersionDefinition = forward
    expect(backward).toBe(VALID)
  })

  it('keeps the two hashed shapes SEPARATE without duplicating either', () => {
    // decision_policy_json is a COLUMN of the one row shape, hashed on its own
    // so a snapshotted recommendation stays attributable (DECISION_POLICY
    // .version_identity.why_two_hashes). It is not a second row shape, and the
    // definition embeds it rather than restating its fields.
    const policyDeclarations = sources.flatMap(({ text }) =>
      text.match(/export type (DecisionPolicy|TemplateVersionDefinition) =/g) ?? []
    )
    expect(policyDeclarations).toHaveLength(2)
    expect(computeDefinitionHash(VALID)).not.toBe(computeDecisionPolicyHash(POLICY))
  })

  it('leaves NO second hashing entrypoint that could bypass the boundary', () => {
    // Every exported digest function must route through the validated shape.
    // A new `computeSomethingHash` that skipped validation would reopen A.
    const hashers = sources.flatMap(({ text }) => text.match(/export function compute\w*Hash/g) ?? [])
    expect(hashers.sort()).toEqual([
      'export function computeDecisionPolicyHash',
      'export function computeDefinitionHash',
    ])
    const body = sources.find((s) => s.name === 'decision-policy.ts')!.text
    // Both hashers refuse before digesting; the sha256 call is never reached
    // with an unvalidated payload.
    expect(body.match(/throw new EvaluatePersistedShapeError/g)).toHaveLength(2)
  })
})
