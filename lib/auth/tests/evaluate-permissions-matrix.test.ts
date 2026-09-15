/**
 * lib/auth/tests/evaluate-permissions-matrix.test.ts
 *
 * EXHAUSTIVE ordered role/predicate behaviour matrix for Evaluate V1, plus the
 * audit-vocabulary poststate.
 *
 * Every cell is enumerated from ALL_ROLES rather than sampled. A suite that
 * checks "a few representative roles" is exactly the suite that passes while
 * hasRole(role, 'analyst') quietly admits super_admin: that expression returns
 * the RIGHT answer for five of six roles, so representative sampling has a
 * five-in-six chance of missing the one role RAT-EV-02 excludes.
 *
 * These behaviour cells CANNOT detect a mis-bound predicate whose donor has an
 * identical extension. That is N-22's job, in the sibling file. The two
 * controls are complementary and neither substitutes for the other.
 */

import { describe, it, expect } from 'vitest'

import { ALL_ROLES, type Role } from '../roles'
import {
  canArchiveEvaluation,
  canCreateEvaluation,
  canDecideEvaluation,
  canDraftEvaluationTemplate,
  canEditEvaluationCriterionResponse,
  canPublishEvaluateTemplateVersion,
  canRetireEvaluateTemplate,
  // Pre-existing helpers, imported to prove this package did not move them.
  canApproveRunMethodology,
  isInReviewSet,
  canUseStella,
} from '../permissions'
import { AUDIT_ACTIONS } from '../../audit/logger'

const SIX_ROLES: readonly Role[] = ALL_ROLES

/** Ratified extensions, restated here so the matrix is readable as a table. */
const EXPECTED: Record<string, readonly Role[]> = {
  canCreateEvaluation: ['organization_admin', 'impact_manager'],
  canEditEvaluationCriterionResponse: ['analyst', 'impact_manager', 'organization_admin'],
  canDecideEvaluation: ['organization_admin', 'impact_manager'],
  canArchiveEvaluation: ['impact_manager', 'organization_admin'],
  canDraftEvaluationTemplate: ['impact_manager', 'organization_admin'],
  canPublishEvaluateTemplateVersion: ['organization_admin'],
  canRetireEvaluateTemplate: ['organization_admin'],
}

describe('role space', () => {
  it('is the closed six-value set from the db/schema.ts role CHECK', () => {
    expect(SIX_ROLES).toHaveLength(6)
    expect([...SIX_ROLES].sort()).toEqual([
      'analyst',
      'impact_manager',
      'organization_admin',
      'reviewer',
      'super_admin',
      'viewer',
    ])
  })
})

// ---------------------------------------------------------------------------
// Single-argument predicates: 5 predicates x 6 roles = 30 ordered cells.
// ---------------------------------------------------------------------------

const SINGLE_ARG: Array<[string, (r: Role) => boolean]> = [
  ['canCreateEvaluation', canCreateEvaluation],
  ['canArchiveEvaluation', canArchiveEvaluation],
  ['canDraftEvaluationTemplate', canDraftEvaluationTemplate],
  ['canPublishEvaluateTemplateVersion', canPublishEvaluateTemplateVersion],
  ['canRetireEvaluateTemplate', canRetireEvaluateTemplate],
]

describe.each(SINGLE_ARG)('%s — exhaustive over all six roles', (name, fn) => {
  it.each(SIX_ROLES.map((r) => [r]))('%s', (role) => {
    const expected = EXPECTED[name].includes(role as Role)
    expect(fn(role as Role)).toBe(expected)
  })

  it('admits exactly its ratified extension and nothing else', () => {
    const admitted = SIX_ROLES.filter((r) => fn(r))
    expect([...admitted].sort()).toEqual([...EXPECTED[name]].sort())
  })

  it('never admits super_admin by hierarchy (HD-12, NSB-02)', () => {
    expect(fn('super_admin')).toBe(false)
  })

  it('never admits reviewer — the review-set trap', () => {
    // reviewer IS a member of the repository REVIEW_ROLES and is excluded from
    // EVERY Evaluate write set. Deriving any Evaluate predicate from
    // isInReviewSet would admit it to all of them in one move.
    expect(fn('reviewer')).toBe(false)
    expect(isInReviewSet('reviewer')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// canEditEvaluationCriterionResponse: 6 roles x 2 lock states = 12 cells.
// ---------------------------------------------------------------------------

describe('canEditEvaluationCriterionResponse — 6 roles x 2 lock states', () => {
  it.each(SIX_ROLES.flatMap((r) => [[r, true], [r, false]]))(
    'role=%s isPreLock=%s',
    (role, isPreLock) => {
      const inSet = EXPECTED.canEditEvaluationCriterionResponse.includes(role as Role)
      expect(canEditEvaluationCriterionResponse(role as Role, isPreLock as boolean)).toBe(
        inSet && (isPreLock as boolean)
      )
    }
  )

  it('analyst IS admitted pre-lock — the member no hierarchy threshold would ever admit', () => {
    expect(canEditEvaluationCriterionResponse('analyst', true)).toBe(true)
  })

  it('the governing lock denies every role, including the whole edit set', () => {
    for (const role of SIX_ROLES) {
      expect(canEditEvaluationCriterionResponse(role, false)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// canDecideEvaluation: 6 acting roles x 6 designated roles = 36 ordered cells.
// Both conditions are load-bearing (HD-05): set membership alone would let an
// impact_manager decide an evaluation designated to organization_admin.
// ---------------------------------------------------------------------------

describe('canDecideEvaluation — 36 ordered (acting, designated) cells', () => {
  const cells = SIX_ROLES.flatMap((acting) => SIX_ROLES.map((designated) => [acting, designated]))

  it('enumerates the full 6 x 6 ordered space', () => {
    expect(cells).toHaveLength(36)
  })

  it.each(cells)('acting=%s designated=%s', (acting, designated) => {
    const inSet = EXPECTED.canDecideEvaluation.includes(acting as Role)
    expect(canDecideEvaluation(acting as Role, designated as Role)).toBe(
      inSet && acting === designated
    )
  })

  it('exact role equality is load-bearing: a set member designated to the OTHER member is refused', () => {
    expect(canDecideEvaluation('impact_manager', 'organization_admin')).toBe(false)
    expect(canDecideEvaluation('organization_admin', 'impact_manager')).toBe(false)
    expect(canDecideEvaluation('impact_manager', 'impact_manager')).toBe(true)
    expect(canDecideEvaluation('organization_admin', 'organization_admin')).toBe(true)
  })

  it('fails closed when the designated value is outside the decision set', () => {
    // Unrepresentable in the column (CLOSED CHECK), but the predicate must not
    // rely on that: a matching non-member pair is still refused.
    for (const outsider of ['super_admin', 'analyst', 'reviewer', 'viewer'] as Role[]) {
      expect(canDecideEvaluation(outsider, outsider)).toBe(false)
    }
  })

  it('exactly 2 of the 36 ordered cells are permitted', () => {
    const permitted = cells.filter(([a, d]) => canDecideEvaluation(a as Role, d as Role))
    expect(permitted).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Template denial space (N-16 shape): 4 + 5 + 5 = 14 refusal cells, DERIVED
// from the role matrix rather than carried as a prose count.
// ---------------------------------------------------------------------------

describe('template denial space — derived, not hand-counted', () => {
  const acts: Array<[string, (r: Role) => boolean]> = [
    ['canDraftEvaluationTemplate', canDraftEvaluationTemplate],
    ['canPublishEvaluateTemplateVersion', canPublishEvaluateTemplateVersion],
    ['canRetireEvaluateTemplate', canRetireEvaluateTemplate],
  ]

  it('sums to 14 refusal cells', () => {
    const total = acts.reduce((n, [name]) => n + (6 - EXPECTED[name].length), 0)
    expect(total).toBe(14)
  })

  it.each(acts.flatMap(([name, fn]) => SIX_ROLES.filter((r) => !EXPECTED[name].includes(r)).map((r) => [name, r, fn])))(
    '%s refuses %s',
    (_name, role, fn) => {
      expect((fn as (r: Role) => boolean)(role as Role)).toBe(false)
    }
  )

  it('impact_manager may draft but may NOT publish or retire', () => {
    // Draft authority does not extend to publish or retire (RAT-EV-04). A
    // single collapsed template helper would pass every other cell and fail
    // exactly these two.
    expect(canDraftEvaluationTemplate('impact_manager')).toBe(true)
    expect(canPublishEvaluateTemplateVersion('impact_manager')).toBe(false)
    expect(canRetireEvaluateTemplate('impact_manager')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Untouched pre-existing semantics.
// ---------------------------------------------------------------------------

describe('pre-existing role semantics are unchanged by this package', () => {
  it('REVIEW_ROLES / isInReviewSet still admits exactly its four members', () => {
    expect(SIX_ROLES.filter((r) => isInReviewSet(r)).sort()).toEqual([
      'impact_manager',
      'organization_admin',
      'reviewer',
      'super_admin',
    ])
  })

  it('STELLA_ROLES / canUseStella still admits exactly its five members', () => {
    expect(SIX_ROLES.filter((r) => canUseStella(r)).sort()).toEqual([
      'analyst',
      'impact_manager',
      'organization_admin',
      'reviewer',
      'super_admin',
    ])
  })

  it('canApproveRunMethodology still excludes the run author', () => {
    expect(canApproveRunMethodology('reviewer', false)).toBe(true)
    expect(canApproveRunMethodology('reviewer', true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Audit vocabulary poststate: 113 -> 124.
// ---------------------------------------------------------------------------

describe('AUDIT_ACTIONS poststate', () => {
  const keys = Object.keys(AUDIT_ACTIONS)
  const values = Object.values(AUDIT_ACTIONS) as string[]

  const NEW_KEYS = [
    'EVALUATION_CREATED',
    'EVALUATION_UPDATED',
    'EVALUATION_SUBMITTED_FOR_DECISION',
    'EVALUATION_DECISION_RECORDED',
    'EVALUATION_DECISION_REFUSED',
    'EVALUATION_ARCHIVED',
    'EVALUATION_CRITERION_RESPONSE_RECORDED',
    'EVALUATION_CRITERION_RESPONSE_EDIT_REFUSED',
    'EVALUATION_TEMPLATE_VERSION_CREATED',
    'EVALUATION_TEMPLATE_VERSION_PUBLISHED',
    'EVALUATION_TEMPLATE_RETIRED',
  ]

  const NEW_VALUES = [
    'evaluation.created',
    'evaluation.updated',
    'evaluation.submitted_for_decision',
    'evaluation.decision_recorded',
    'evaluation.decision_refused',
    'evaluation.archived',
    'evaluation_criterion_response.recorded',
    'evaluation_criterion_response.edit_refused',
    'evaluation_template_version.created',
    'evaluation_template_version.published',
    'evaluation_template.retired',
  ]

  it('holds exactly 124 unique keys and 124 unique values', () => {
    expect(keys).toHaveLength(124)
    expect(new Set(keys).size).toBe(124)
    expect(new Set(values).size).toBe(124)
  })

  it('adds exactly the 11 declared Evaluate keys', () => {
    expect(NEW_KEYS).toHaveLength(11)
    for (const k of NEW_KEYS) expect(keys).toContain(k)
  })

  it('adds exactly the 11 declared Evaluate values and no other evaluation key', () => {
    const evaluationValues = values.filter((v) => v.startsWith('evaluation'))
    expect([...evaluationValues].sort()).toEqual([...NEW_VALUES].sort())
  })

  it('preserves all 113 predecessor keys — 124 minus the 11 added', () => {
    const predecessors = keys.filter((k) => !NEW_KEYS.includes(k))
    expect(predecessors).toHaveLength(113)
    // Spot-anchor a few across different FIB families, so a wholesale
    // rewrite that happened to keep the count could not pass.
    expect(predecessors).toContain('EVIDENCE_VERSION_CREATED')
    expect(predecessors).toContain('AUDIT_CORRECTION_RECORDED')
    expect(predecessors).toContain('SROI_CALCULATION_RUN_METHODOLOGY_APPROVAL_DENIED')
    expect(predecessors).toContain('LEGAL_ACCOUNT_INSTRUMENT_ACCEPTED')
    expect(predecessors).toContain('LEGAL_ORGANIZATION_INSTRUMENT_ACCEPTED')
  })

  it('every new key follows the established <object>.<verb> morphology', () => {
    for (const v of NEW_VALUES) {
      expect(v).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('records BOTH refusal events — a refusal that leaves no trace is invisible', () => {
    expect(AUDIT_ACTIONS.EVALUATION_DECISION_REFUSED).toBe('evaluation.decision_refused')
    expect(AUDIT_ACTIONS.EVALUATION_CRITERION_RESPONSE_EDIT_REFUSED).toBe(
      'evaluation_criterion_response.edit_refused'
    )
  })
})
