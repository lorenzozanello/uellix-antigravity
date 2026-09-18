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

/**
 * ===========================================================================
 * D — A HOLE IN A DECLARED ARRAY IS NOT A STORED VALUE
 * ===========================================================================
 * The A-1 defect the independent preaudit of this lane found. `forEach` and
 * `map` SKIP a hole rather than visit it, so a sparse array was validated at
 * the indices that happened to exist, survived the projection with its hole
 * intact, and was serialized by `join` — which renders a hole as the empty
 * string. Every measured digest below was produced at
 * ef61e5a387484e576fd81fcb150896f4c3855c29 and is a well-formed 64-hex value
 * indistinguishable from an authoritative one.
 */
describe('D — a HOLE in a declared array receives no authoritative hash', () => {
  /**
   * A genuine hole at `index`, built by assignment past a gap.
   *
   * Never `delete arr[i]`, and never a mutation of the global Array prototype:
   * a control that pollutes a shared prototype leaks into every later test in
   * the process, and a leak is how a suite starts proving the wrong thing.
   */
  function withHole<T>(items: readonly T[], index: number): T[] {
    const sparse: T[] = []
    items.forEach((item, i) => {
      if (i !== index) sparse[i] = item
    })
    sparse.length = items.length
    return sparse
  }

  const CRITERIA: readonly Criterion[] = [
    { criterion_key: 'governance', weight: 1, max_score: 10 },
    { criterion_key: 'impact', weight: 2, max_score: 10 },
    { criterion_key: 'evidence', weight: 3, max_score: 10 },
  ]

  it('D-0: the DENSE forms of every payload below DO hash, so nothing here is vacuous', () => {
    // The positive half. Without it, every refusal in this block could be
    // satisfied by a validator that rejects multi-element arrays outright.
    expect(computeDefinitionHash({ ...VALID, criteria_json: CRITERIA })).toMatch(/^[0-9a-f]{64}$/)
    expect(computeDecisionPolicyHash(POLICY)).toMatch(/^[0-9a-f]{64}$/)
    expect(withHole(CRITERIA, 1)).toHaveLength(3)
    expect(Object.prototype.hasOwnProperty.call(withHole(CRITERIA, 1), 1)).toBe(false)
  })

  it('D-1: refuses a criteria_json with a HOLE, naming the index', () => {
    // Measured before: 6b83977562d35bc7… for a two-element criteria_json holed
    // at index 1 — hashed as authoritative.
    expect(
      violationsOf(() =>
        computeDefinitionHash({
          ...VALID,
          criteria_json: withHole(CRITERIA, 1),
        } as TemplateVersionDefinition)
      )
    ).toEqual(['SPARSE_ARRAY@criteria_json[1]'])
  })

  it('D-2: refuses a decision policy whose BANDS array has a hole', () => {
    // Measured before: f109e34561b6ceb5….
    expect(
      violationsOf(() =>
        computeDecisionPolicyHash({ bands: withHole(POLICY.bands, 1) } as DecisionPolicy)
      )
    ).toEqual(['SPARSE_ARRAY@decision_policy_json.bands[1]'])
  })

  it('D-3: refuses the same hole NESTED inside a definition, not only at the top level', () => {
    // criteria_json is depth 1; decision_policy_json.bands is depth 2. A guard
    // applied only where the walk starts would pass D-1 and still let this one
    // reach a digest.
    expect(
      violationsOf(() =>
        computeDefinitionHash({
          ...VALID,
          decision_policy_json: { bands: withHole(POLICY.bands, 0) },
        } as TemplateVersionDefinition)
      )
    ).toEqual(['SPARSE_ARRAY@decision_policy_json.bands[0]'])
  })

  it('D-4: a TRAILING hole is a hole too', () => {
    // `length` past the last own index. Nothing iterates it, so a predicate
    // written as "every element I visited was well formed" never sees it.
    const trailing = CRITERIA.slice()
    trailing.length = 4
    expect(
      violationsOf(() =>
        computeDefinitionHash({ ...VALID, criteria_json: trailing } as TemplateVersionDefinition)
      )
    ).toEqual(['SPARSE_ARRAY@criteria_json[3]'])
  })

  it('D-5: a PROTOTYPE-INHERITED numeric property does not fill the hole', () => {
    // The own-index predicate is load-bearing and `i in array` is the wrong
    // one: HasProperty walks the prototype chain, so a numeric property planted
    // on the array's own prototype makes the hole LOOK occupied while the
    // stored row still has nothing there.
    //
    // Measured before: a082bd9f49238f6c… — byte-identical to the authoritative
    // digest of the honest two-band policy, so the planted value was not merely
    // admitted, it was CERTIFIED as the stored one.
    const holed = withHole(POLICY.bands, 1)
    const planted = Object.create(Array.prototype) as Record<number, DecisionBand>
    planted[1] = POLICY.bands[1]
    Object.setPrototypeOf(holed, planted)

    // The premise of the control, asserted rather than assumed: this array is
    // still an array, index 1 answers `in`, and index 1 is still not OWN.
    expect(Array.isArray(holed)).toBe(true)
    expect(1 in holed).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(holed, 1)).toBe(false)

    expect(violationsOf(() => computeDecisionPolicyHash({ bands: holed } as DecisionPolicy))).toEqual(
      ['SPARSE_ARRAY@decision_policy_json.bands[1]']
    )
  })

  it('D-6: reports EVERY hole, and reports holes alongside ordinary violations', () => {
    const holed: Criterion[] = []
    holed[1] = { criterion_key: 'impact', weight: '2' as unknown as number, max_score: 10 }
    holed.length = 3
    expect(
      violationsOf(() =>
        computeDefinitionHash({ ...VALID, criteria_json: holed } as TemplateVersionDefinition)
      )
    ).toEqual([
      'SPARSE_ARRAY@criteria_json[0]',
      'WRONG_DECLARED_TYPE@criteria_json[1].weight',
      'SPARSE_ARRAY@criteria_json[2]',
    ])
  })
})

/**
 * ===========================================================================
 * E — WHAT IS VALIDATED IS EXACTLY WHAT IS HASHED
 * ===========================================================================
 * The A-2 defect. Validation and the hash projection used to read the same
 * declared property INDEPENDENTLY, from the same object. For a plain row the
 * two reads agree; for an accessor-backed one they need not, and the digest
 * then certifies a value no check ever saw.
 *
 * Accessor-backed input stays ACCEPTED — a store, an ORM or a proxy may
 * legitimately present a row through getters, and refusing those would refuse
 * storable rows. What is foreclosed is the SECOND read.
 */
describe('E — a validated value is the value that gets hashed', () => {
  /** A property that answers `first` once and `then` on every later read. */
  function divergent<T extends object>(
    base: T,
    key: string,
    first: unknown,
    then: unknown
  ): { readonly object: T; reads: () => number } {
    let reads = 0
    const object = { ...base } as Record<string, unknown>
    Object.defineProperty(object, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1
        return reads === 1 ? first : then
      },
    })
    return { object: object as T, reads: () => reads }
  }

  it('E-0: an honestly accessor-backed row is still ACCEPTED and hashes as its plain twin', () => {
    // The positive half: the remediation must not turn "reached us through
    // getters" into "unstorable". Without this, every control below could be
    // satisfied by refusing accessors outright.
    const stable = divergent(VALID, 'version', '1.0.0', '1.0.0')
    expect(computeDefinitionHash(stable.object)).toBe(computeDefinitionHash(VALID))
  })

  it('E-1: a DIVERGENT top-level field hashes its FIRST read, and is read only once', () => {
    // Measured before: this hashed 423f195f74fe3c69… — byte-identical to the
    // authoritative digest of an honest '9.9.9' row, while validation had
    // approved '1.0.0'.
    const evil = divergent(VALID, 'version', '1.0.0', '9.9.9')
    const digest = computeDefinitionHash(evil.object)

    expect(digest).toBe(computeDefinitionHash(VALID))
    expect(digest).not.toBe(computeDefinitionHash({ ...VALID, version: '9.9.9' }))
    expect(evil.reads()).toBe(1)
  })

  it('E-2: a DIVERGENT nested Criterion field hashes its FIRST read', () => {
    const evil = divergent(VALID.criteria_json[0], 'weight', 1, 99)
    const digest = computeDefinitionHash({ ...VALID, criteria_json: [evil.object] })

    expect(digest).toBe(computeDefinitionHash(VALID))
    expect(digest).not.toBe(
      computeDefinitionHash({
        ...VALID,
        criteria_json: [{ criterion_key: 'governance', weight: 99, max_score: 10 }],
      })
    )
    expect(evil.reads()).toBe(1)
  })

  it('E-3: a DIVERGENT nested DecisionBand bound hashes its FIRST read', () => {
    // The deepest declared level: definition -> decision_policy_json -> bands[i]
    // -> upper_bound. A snapshot taken only at the top would leave this live.
    const evil = divergent(POLICY.bands[0], 'upper_bound', 0.5, 0.75)
    const policy = { bands: [evil.object, POLICY.bands[1]] }

    expect(computeDecisionPolicyHash(policy)).toBe(computeDecisionPolicyHash(POLICY))
    expect(evil.reads()).toBe(1)

    const nestedEvil = divergent(POLICY.bands[0], 'upper_bound', 0.5, 0.75)
    expect(
      computeDefinitionHash({
        ...VALID,
        decision_policy_json: { bands: [nestedEvil.object, POLICY.bands[1]] },
      })
    ).toBe(computeDefinitionHash(VALID))
    expect(nestedEvil.reads()).toBe(1)
  })

  it('E-4: the second read cannot substitute a value with NO canonical form', () => {
    // THE ERROR CONTRACT. Measured before, this exact payload escaped as a raw
    // `TypeError: canonicalize: non-finite numbers have no canonical form` —
    // from a function whose documented failure mode is an Evaluate refusal
    // naming the field. A caller catching EvaluatePersistedShapeError saw an
    // uncaught TypeError instead.
    const evil = divergent(VALID.criteria_json[0], 'weight', 1, Number.NaN)
    let thrown: unknown = null
    let digest = ''
    try {
      digest = computeDefinitionHash({ ...VALID, criteria_json: [evil.object] })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeNull()
    expect(digest).toBe(computeDefinitionHash(VALID))
  })

  it('E-5: a declared field that THROWS on read is classified, never leaked raw', () => {
    // The other half of the contract: a throw from caller-supplied data must
    // surface as the Evaluate persisted-shape refusal that names the FIELD, and
    // must not be broadly swallowed — the violation is reported, with its path.
    const hostile = { ...VALID } as Record<string, unknown>
    Object.defineProperty(hostile, 'created_at', {
      enumerable: true,
      get() {
        throw new TypeError('the store could not materialize this column')
      },
    })

    let thrown: unknown = null
    try {
      computeDefinitionHash(hostile as unknown as TemplateVersionDefinition)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(EvaluatePersistedShapeError)
    expect(thrown).not.toBeInstanceOf(TypeError)
    expect(violationsOf(() => computeDefinitionHash(hostile as unknown as TemplateVersionDefinition)))
      .toEqual(['UNREADABLE_DECLARED_FIELD@created_at'])
  })

  it('E-6: the accepted value is a fresh PLAIN snapshot, live at no declared depth', () => {
    // What makes E-1..E-4 structural rather than incidental: after validation
    // there is no original reference and no accessor left inside the
    // authoritative payload for a later read to consult.
    const accepted = validateTemplateVersionDefinition(VALID)
    expect(accepted.valid).toBe(true)
    if (!accepted.valid) throw new Error('unreachable')

    // Depth 1: the definition itself. Depth 2: criteria_json[i] and
    // decision_policy_json. Depth 3: decision_policy_json.bands[i].
    expect(accepted.value).not.toBe(VALID)
    expect(accepted.value.criteria_json).not.toBe(VALID.criteria_json)
    expect(accepted.value.criteria_json[0]).not.toBe(VALID.criteria_json[0])
    expect(accepted.value.decision_policy_json).not.toBe(VALID.decision_policy_json)
    expect(accepted.value.decision_policy_json.bands).not.toBe(POLICY.bands)
    expect(accepted.value.decision_policy_json.bands[0]).not.toBe(POLICY.bands[0])

    // ...and every own property, at every depth, is DATA. An accessor anywhere
    // in here would be a second read waiting to happen.
    const accessorFreeAtEveryDepth = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return true
      return Reflect.ownKeys(value).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !('value' in descriptor)) return false
        return accessorFreeAtEveryDepth(descriptor.value)
      })
    }
    expect(accessorFreeAtEveryDepth(accepted.value)).toBe(true)

    // The same for the policy entrypoint, which callers reach on its own.
    const policySnapshot = validateDecisionPolicyShape(POLICY)
    expect(policySnapshot.valid).toBe(true)
    if (!policySnapshot.valid) throw new Error('unreachable')
    expect(policySnapshot.value).not.toBe(POLICY)
    expect(policySnapshot.value.bands[0]).not.toBe(POLICY.bands[0])
    expect(accessorFreeAtEveryDepth(policySnapshot.value)).toBe(true)

    // And the snapshot still hashes to exactly what the raw row does.
    expect(computeDefinitionHash(accepted.value)).toBe(computeDefinitionHash(VALID))
    expect(computeDecisionPolicyHash(policySnapshot.value)).toBe(computeDecisionPolicyHash(POLICY))
  })
})

/**
 * ===========================================================================
 * F — THE UNDECLARED OBJ-2 COLUMNS MUST KEEP ROUND-TRIPPING
 * ===========================================================================
 * The tolerance asserted in A is not laxity and the remediation must not
 * narrow it. These six are the conceptual columns an OBJ-2 row carries that
 * are NOT part of definition identity: the surrogate key, the two identity
 * digests themselves, and the three write-once publication columns. A row read
 * back out of the store carries all six, and definition_hash must not move —
 * definition_hash exists to prove the version did NOT move.
 *
 * Note the two digests in particular: definition_hash cannot be an input to
 * definition_hash, so a validator that rejected undeclared keys would make the
 * stored row unhashable by the very function that produced its hash.
 */
describe('F — the six undeclared OBJ-2 columns leave definition_hash unmoved', () => {
  const EXTRAS = {
    id: '6f1d2c30-0000-4000-8000-000000000001',
    definition_hash: 'f'.repeat(64),
    decision_policy_hash: 'e'.repeat(64),
    published_at: '2026-09-02T09:00:00.000Z',
    published_by: 'user-admin-1',
    published_by_role: 'organization_admin',
  } as const

  it('F-1: each extra ALONE leaves the digest and the acceptance unchanged', () => {
    // One at a time, so a failure names the column rather than the set.
    for (const [key, extra] of Object.entries(EXTRAS)) {
      const roundTripped = { ...VALID, [key]: extra } as TemplateVersionDefinition
      expect(validateTemplateVersionDefinition(roundTripped).valid).toBe(true)
      expect(computeDefinitionHash(roundTripped)).toBe(computeDefinitionHash(VALID))
    }
  })

  it('F-2: all six TOGETHER, on a fully storage-shaped row, leave the digest unchanged', () => {
    const storageShaped = { ...VALID, ...EXTRAS } as TemplateVersionDefinition
    expect(Object.keys(storageShaped)).toHaveLength(Object.keys(VALID).length + 6)
    expect(validateTemplateVersionDefinition(storageShaped).valid).toBe(true)
    expect(computeDefinitionHash(storageShaped)).toBe(computeDefinitionHash(VALID))
  })

  it('F-3: the tolerance is EXCLUSION, not acceptance-into-the-digest', () => {
    // Two storage-shaped rows whose declared content is identical but whose
    // undeclared columns differ must share one identity. If the extras were
    // merely tolerated and then hashed, these would diverge.
    const rowA = { ...VALID, ...EXTRAS } as TemplateVersionDefinition
    const rowB = {
      ...VALID,
      ...EXTRAS,
      id: '6f1d2c30-0000-4000-8000-000000000002',
      published_by: 'user-admin-2',
    } as TemplateVersionDefinition
    expect(computeDefinitionHash(rowA)).toBe(computeDefinitionHash(rowB))
  })

  it('F-4: no allow-list or deny-list of extras is hard-coded anywhere in the engine', () => {
    // The exclusion is structural — a POSITIVE projection of the declared
    // fields — so an extra nobody anticipated is excluded by construction. A
    // named list would close this instance and leave the class open.
    const engine = readFileSync(join(process.cwd(), 'lib', 'evaluate', 'decision-policy.ts'), 'utf8')
    const code = engine
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    for (const columnName of Object.keys(EXTRAS)) {
      expect(code).not.toContain(`'${columnName}'`)
      expect(code).not.toContain(`"${columnName}"`)
    }
  })
})
