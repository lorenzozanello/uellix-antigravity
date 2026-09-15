/**
 * P-01, P-02 (positive) and N-02 (negative) from
 * docs/ops/evaluate/EVALUATE_COMMERCIAL_V1_TEST_MANIFEST_v1.0.0.json.
 *
 * M-03 (mutation) is discharged against N-02: making computeScore return 0
 * with score_status 'COMPUTED' when the denominator is zero must turn N-02
 * RED. It does — N-02 asserts on the ABSENCE OF A NUMBER, not on the status
 * field alone, which is the exact failure mode M-03 exists to detect.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateDecisionPolicy, recommendOutcome } from '../decision-policy'
import { computeScore, projectCurrentResponses, EvaluateScoringInputError } from '../scoring'
import type { Criterion, CriterionResponse, DecisionPolicy } from '../types'

const SCORING_SOURCE_PATH = path.join(process.cwd(), 'lib', 'evaluate', 'scoring.ts')

function scored(criterion_key: string, ordinal: number, score_value: number): CriterionResponse {
  return {
    criterion_key,
    ordinal,
    response_kind: 'SCORED',
    score_value,
    na_rationale: null,
    recorded_by: 'user-analyst-1',
    recorded_by_role: 'analyst',
    recorded_at: '2026-09-14T10:00:00.000Z',
  }
}

function governedNa(criterion_key: string, ordinal: number): CriterionResponse {
  return {
    criterion_key,
    ordinal,
    response_kind: 'NOT_APPLICABLE',
    score_value: null,
    na_rationale: 'Out of scope for this grant-funded project.',
    recorded_by: 'user-impact-manager-1',
    recorded_by_role: 'impact_manager',
    recorded_at: '2026-09-14T10:05:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// P-01 — EV-01 arithmetic
// ---------------------------------------------------------------------------

describe('P-01 governed N/A is excluded from BOTH numerator and denominator', () => {
  // Weights and max_scores are chosen so that the ratified rule and each
  // plausible wrong rule land on a DIFFERENT number. A fixture on which two
  // rules agree proves nothing about which one is implemented.
  const criteria: readonly Criterion[] = [
    { criterion_key: 'governance', weight: 1, max_score: 10 },
    { criterion_key: 'outcomes', weight: 3, max_score: 10 },
    { criterion_key: 'safeguarding', weight: 2, max_score: 10 },
  ]
  const responses: readonly CriterionResponse[] = [
    scored('governance', 1, 8),
    scored('outcomes', 1, 6),
    governedNa('safeguarding', 1),
  ]

  // The ratified rule: safeguarding contributes to NEITHER sum.
  const RATIFIED = (1 * 0.8 + 3 * 0.6) / (1 + 3) // 2.6 / 4 = 0.65
  // Wrong rule A — N/A scored as zero: weight stays in the denominator.
  const NA_AS_ZERO = (1 * 0.8 + 3 * 0.6) / (1 + 3 + 2) // 2.6 / 6
  // Wrong rule B — N/A scored as the maximum. SCORING.governed_na_arithmetic
  // names both A and B explicitly: "It is not scored as zero and it is not
  // scored as the maximum."
  const NA_AS_MAX = (1 * 0.8 + 3 * 0.6 + 2 * 1) / (1 + 3 + 2) // 4.6 / 6

  it('computes the ratified value and not either wrong arithmetic', () => {
    const result = computeScore(criteria, responses)

    expect(result.score_status).toBe('COMPUTED')
    if (result.score_status !== 'COMPUTED') throw new Error('unreachable')

    expect(result.score).toBeCloseTo(RATIFIED, 12)
    expect(result.denominator).toBe(4)
    expect(result.numerator).toBeCloseTo(2.6, 12)

    // The three comparators are genuinely distinct, so each assertion below
    // discriminates. Asserted rather than assumed: if a future change to the
    // fixture collapsed two of them, this test would silently stop
    // distinguishing the rules it exists to distinguish.
    expect(RATIFIED).not.toBeCloseTo(NA_AS_ZERO, 6)
    expect(RATIFIED).not.toBeCloseTo(NA_AS_MAX, 6)
    expect(NA_AS_ZERO).not.toBeCloseTo(NA_AS_MAX, 6)

    expect(result.score).not.toBeCloseTo(NA_AS_ZERO, 6)
    expect(result.score).not.toBeCloseTo(NA_AS_MAX, 6)
  })

  it('reports the excluded criterion as a governed N/A and not as unanswered', () => {
    const result = computeScore(criteria, responses)
    expect(result.governed_na_criterion_keys).toEqual(['safeguarding'])
    expect(result.unanswered_criterion_keys).toEqual([])
  })

  it('keeps UNANSWERED distinct from governed N/A (SCORING.unanswered_is_not_na)', () => {
    // Same criteria, but safeguarding has NO row at all rather than an N/A row.
    const withUnanswered = computeScore(criteria, [
      scored('governance', 1, 8),
      scored('outcomes', 1, 6),
    ])

    expect(withUnanswered.score_status).toBe('COMPUTED')
    expect(withUnanswered.unanswered_criterion_keys).toEqual(['safeguarding'])
    expect(withUnanswered.governed_na_criterion_keys).toEqual([])

    // The two cases produce the SAME number — both criteria are absent from
    // the arithmetic — which is exactly why the engine must report them in
    // SEPARATE key sets. Conflating them is what would let an empty evaluation
    // reach READY_FOR_DECISION with a vacuous SCORE_NOT_COMPUTABLE.
    const withGovernedNa = computeScore(criteria, responses)
    if (withUnanswered.score_status !== 'COMPUTED') throw new Error('unreachable')
    if (withGovernedNa.score_status !== 'COMPUTED') throw new Error('unreachable')
    expect(withUnanswered.score).toBeCloseTo(withGovernedNa.score, 12)
    expect(withUnanswered.governed_na_criterion_keys).not.toEqual(
      withGovernedNa.governed_na_criterion_keys
    )
  })

  it('refuses a NOT_APPLICABLE response with no rationale (EV-01 human provenance)', () => {
    const ungoverned: CriterionResponse = { ...governedNa('safeguarding', 1), na_rationale: '   ' }
    expect(() => computeScore(criteria, [scored('governance', 1, 8), ungoverned])).toThrow(
      EvaluateScoringInputError
    )
  })

  it('uses the highest ordinal as the current response', () => {
    const superseded = computeScore(criteria, [
      scored('governance', 1, 2),
      scored('governance', 2, 8),
      scored('outcomes', 1, 6),
      governedNa('safeguarding', 1),
    ])
    if (superseded.score_status !== 'COMPUTED') throw new Error('unreachable')
    // Ordinal 2 (value 8) wins over ordinal 1 (value 2).
    expect(superseded.score).toBeCloseTo(RATIFIED, 12)

    // And the earlier action is still present in the input: the projection
    // DERIVES current, it does not destroy history (RAT-EV-03).
    const projection = projectCurrentResponses([scored('governance', 1, 2), scored('governance', 2, 8)])
    expect(projection.get('governance')?.ordinal).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P-02 — determinism (HD-01), asserted structurally as well as behaviourally
// ---------------------------------------------------------------------------

describe('P-02 the Score is deterministic and the module is structurally pure', () => {
  const criteria: readonly Criterion[] = [
    { criterion_key: 'a', weight: 2, max_score: 5 },
    { criterion_key: 'b', weight: 1, max_score: 4 },
  ]
  const responses: readonly CriterionResponse[] = [scored('a', 1, 3), scored('b', 1, 1)]

  it('returns byte-identical results for identical inputs', () => {
    const first = computeScore(criteria, responses)
    const second = computeScore(criteria, responses)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first).toEqual(second)
  })

  it('does not depend on the order of the response rows', () => {
    const forward = computeScore(criteria, responses)
    const reversed = computeScore(criteria, [...responses].reverse())
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed))
  })

  it('accepts exactly two parameters, so no Stella output can enter (SB-02)', () => {
    expect(computeScore.length).toBe(2)
  })

  /**
   * The impurity scanner, plus a POSITIVE CONTROL.
   *
   * A source sweep that has never been shown to go red is indistinguishable
   * from one that inspects nothing, so the control string below is scanned
   * first and MUST be flagged. Only then is the real module's clean result
   * evidence of anything.
   */
  const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: 'db import', pattern: /from\s+['"](?:@\/)?db\// },
    { label: 'fetch', pattern: /\bfetch\s*\(/ },
    { label: 'Date', pattern: /\bDate\s*[.(]/ },
    { label: 'Math.random', pattern: /\bMath\s*\.\s*random\b/ },
    { label: 'process.env', pattern: /\bprocess\s*\.\s*env\b/ },
    { label: 'pipeline import', pattern: /from\s+['"](?:@\/|\.\.\/)*lib\/pipeline\// },
  ]

  function scan(source: string): string[] {
    return FORBIDDEN.filter((rule) => rule.pattern.test(source)).map((rule) => rule.label)
  }

  it('the impurity scanner is not vacuous (positive control)', () => {
    const impure = [
      "import { db } from 'db/client'",
      'const t = Date.now()',
      'const r = Math.random()',
      'const k = process.env.SECRET',
      'await fetch("https://example.invalid")',
      "import { x } from '@/lib/pipeline/methodology-review'",
    ].join('\n')
    expect(scan(impure).sort()).toEqual(
      ['Date', 'Math.random', 'db import', 'fetch', 'pipeline import', 'process.env'].sort()
    )
    // Every rule fires on the control, so a clean result on the real module
    // below is evidence about the module and not about a dead scanner.
    expect(scan(impure)).toHaveLength(FORBIDDEN.length)
  })

  it('lib/evaluate/scoring.ts contains no impure construct', () => {
    const source = readFileSync(SCORING_SOURCE_PATH, 'utf8')
    expect(source.length).toBeGreaterThan(0)
    expect(scan(source)).toEqual([])
  })

  it('lib/evaluate/scoring.ts imports nothing but ./types', () => {
    const source = readFileSync(SCORING_SOURCE_PATH, 'utf8')
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import[^'"]*['"]([^'"]+)['"]/g)].map(
      (match) => match[1]
    )
    expect(specifiers).toEqual(['./types'])
  })
})

// ---------------------------------------------------------------------------
// N-02 — zero denominator (HD-02), and the M-03 mutation target
// ---------------------------------------------------------------------------

describe('N-02 an all-N/A evaluation is SCORE_NOT_COMPUTABLE with no number at all', () => {
  const criteria: readonly Criterion[] = [
    { criterion_key: 'governance', weight: 1, max_score: 10 },
    { criterion_key: 'outcomes', weight: 3, max_score: 10 },
  ]
  const allNa: readonly CriterionResponse[] = [governedNa('governance', 1), governedNa('outcomes', 1)]

  const TOTAL_POLICY: DecisionPolicy = {
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

  it('reports the status and the excluded keys', () => {
    const result = computeScore(criteria, allNa)
    expect(result.score_status).toBe('SCORE_NOT_COMPUTABLE')
    expect(result.denominator).toBe(0)
    expect(result.governed_na_criterion_keys).toEqual(['governance', 'outcomes'])
    expect(result.unanswered_criterion_keys).toEqual([])
  })

  /**
   * THE M-03 TARGET.
   *
   * M-03: "Make the scoring function return 0 with score_status 'COMPUTED'
   * when the denominator is zero, and N-02 MUST turn RED. If N-02 stays green
   * it is asserting on the status field alone and would not catch a sentinel
   * number reaching the DecisionPolicy bands."
   *
   * This case therefore asserts on the ABSENCE OF A NUMBER — ZD-03 — and not
   * on score_status. It goes red under the mutation for the correct reason.
   */
  it('carries NO score property, so no sentinel number can reach the bands (ZD-03)', () => {
    const result = computeScore(criteria, allNa)
    expect('score' in result).toBe(false)
    expect(Object.keys(result)).not.toContain('score')

    const smuggled = (result as { score?: unknown }).score
    expect(smuggled).toBeUndefined()
    // Each sentinel ZD-03 names, refuted individually.
    expect(smuggled).not.toBe(0)
    expect(smuggled).not.toBe(-1)
    expect(smuggled).not.toBeNull()
    expect(smuggled).not.toBe(Infinity)
    expect(smuggled).not.toBe(-Infinity)
    expect(Number.isNaN(smuggled as number)).toBe(false)
    expect(typeof smuggled).not.toBe('number')
  })

  it('produces NO recommended outcome — absent, not defaulted (ZD-04)', () => {
    const validation = validateDecisionPolicy(TOTAL_POLICY)
    expect(validation.valid).toBe(true)
    if (!validation.valid) throw new Error('unreachable')

    const recommendation = recommendOutcome(validation.policy, computeScore(criteria, allNa))
    expect(recommendation.recommended).toBe(false)
    if (recommendation.recommended) throw new Error('unreachable')
    expect(recommendation.reason).toBe('SCORE_NOT_COMPUTABLE')
    expect('outcome' in recommendation).toBe(false)

    // Neither of the two defaults ZD-04 names explicitly.
    const smuggled = (recommendation as { outcome?: unknown }).outcome
    expect(smuggled).not.toBe('reject')
    expect(smuggled).not.toBe('approve_with_conditions')
  })

  it('treats a criteria set with no responses at all the same way', () => {
    const empty = computeScore(criteria, [])
    expect(empty.score_status).toBe('SCORE_NOT_COMPUTABLE')
    expect('score' in empty).toBe(false)
    // ...but it is UNANSWERED, not governed N/A. One status, two distinguishable causes.
    expect(empty.unanswered_criterion_keys).toEqual(['governance', 'outcomes'])
    expect(empty.governed_na_criterion_keys).toEqual([])
  })
})

/**
 * ZD-05 (T5 refuses a SCORE_NOT_COMPUTABLE evaluation, audited as a refusal)
 * is DEFERRED, not discharged here. It belongs to the package that implements
 * the decision transition and the audit writer, neither of which exists at
 * this HEAD. Asserting it now over a module that cannot perform a transition
 * would be green by vacuity.
 */
describe.todo('N-02 (deferred half) T5 refuses and audits the refusal — requires the T5 package')
