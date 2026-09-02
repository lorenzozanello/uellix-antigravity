// tests/eval/stella-roles/harness.test.ts
// WS6 (Fable Moonshot) U3: the role eval harness over the official catalog.
// Offline: canned outputs, zero provider calls.

import { describe, it, expect } from 'vitest'
import { OFFICIAL_ROLE_EVAL_CASES } from './cases'
import {
  runRoleEvalHarness,
  runRoleEvalCase,
  validateRoleEvalCatalog,
  RoleEvalHarnessError,
} from './harness'
import { extractAguaSeguraFixtures } from './fixture-grounded'

describe('role eval catalog', () => {
  it('is valid (unique ids, per-role coverage, canaries present)', () => {
    expect(() => validateRoleEvalCatalog(OFFICIAL_ROLE_EVAL_CASES)).not.toThrow()
  })

  it('rejects a catalog with duplicated case ids', () => {
    expect(() =>
      validateRoleEvalCatalog([OFFICIAL_ROLE_EVAL_CASES[0], OFFICIAL_ROLE_EVAL_CASES[0]])
    ).toThrow(RoleEvalHarnessError)
  })
})

describe('role eval harness (official catalog)', () => {
  const { summary, results } = runRoleEvalHarness()

  it('every case behaves as its expectation demands', () => {
    const failed = results.filter((r) => !r.ok)
    expect(
      failed.map((r) => `${r.caseId} → ${r.rejection ?? 'accepted'} (${r.rejectionDetail ?? ''})`),
    ).toEqual([])
    expect(summary.casesPassed).toBe(summary.totalCases)
    expect(summary.casesFailed).toBe(0)
  })

  it('all canaries are rejected with their expected reasons', () => {
    expect(summary.canaryCases).toBeGreaterThanOrEqual(5)
    expect(summary.canariesRejected).toBe(summary.canaryCases)
    const byId = new Map(results.map((r) => [r.caseId, r]))
    expect(byId.get('roles-canary-reviewer-certification-language')?.rejection).toBe('safety')
    expect(byId.get('roles-canary-reviewer-human-review-false')?.rejection).toBe('schema')
    expect(byId.get('roles-canary-composer-hallucinated-id')?.rejection).toBe('composer-references')
    expect(byId.get('roles-canary-validator-numeric-claim')?.rejection).toBe('numeric-integrity')
    expect(byId.get('roles-composer-hallucinated-figures')?.rejection).toBe('composer-figures')
  })

  it('every role is covered and fully green', () => {
    for (const [role, counts] of Object.entries(summary.byRole)) {
      expect(counts.total, `role ${role} must have cases`).toBeGreaterThan(0)
      expect(counts.passed, `role ${role} must be green`).toBe(counts.total)
    }
  })

  it('runs fully offline (zero provider calls)', () => {
    expect(summary.providerCalls).toBe(0)
    expect(summary.geminiCalls).toBe(0)
  })

  it('reports the pinned contract versions', () => {
    expect(summary.contractVersions).toEqual({
      validator: '1.0.0',
      composer: '1.0.0',
      reviewer: '1.0.0',
    })
  })
})

describe('fixture-grounded case (RK-27)', () => {
  it('derives deterministic quantities from the agua-segura fixtures', () => {
    const first = extractAguaSeguraFixtures()
    const second = extractAguaSeguraFixtures()
    expect(first).toEqual(second)
    expect(first.householdRows).toBeGreaterThan(0)
    expect(first.testimonioCount).toBeGreaterThan(0)
    expect(first.lineaBaseConfidenceScore).toBeGreaterThanOrEqual(40)
    expect(first.lineaBaseConfidenceScore).toBeLessThanOrEqual(95)
  })

  it('the fixture-grounded evidence_reviewer case passes the pipeline', () => {
    const item = OFFICIAL_ROLE_EVAL_CASES.find(
      (c) => c.caseId === 'roles-evidence_reviewer-fixture-grounded'
    )
    expect(item).toBeDefined()
    const result = runRoleEvalCase(item!)
    expect(result.ok).toBe(true)
    expect(result.rejection).toBeNull()
  })
})

describe('negative-path sanity (harness actually detects, not just passes)', () => {
  it('rejects a mutated grounded composer draft that gains an unauthorized figure', () => {
    const grounded = OFFICIAL_ROLE_EVAL_CASES.find((c) => c.caseId === 'roles-composer-grounded')!
    const mutated = {
      ...grounded,
      caseId: 'roles-composer-grounded-mutated',
      output: {
        ...(grounded.output as Record<string, unknown>),
        draft_content: 'La inversión total fue de 777777 USD según nuestras estimaciones.',
      },
    }
    const result = runRoleEvalCase(mutated)
    expect(result.rejection).toBe('composer-figures')
    expect(result.ok).toBe(false) // expectation was 'pass', so the case correctly FAILS
  })

  it('rejects a reviewer output that drops the human-review invariant', () => {
    const realistic = OFFICIAL_ROLE_EVAL_CASES.find((c) => c.caseId === 'roles-proxy_reviewer-realistic')!
    const mutated = {
      ...realistic,
      caseId: 'roles-proxy_reviewer-mutated',
      output: { ...(realistic.output as Record<string, unknown>), requires_human_review: false },
    }
    const result = runRoleEvalCase(mutated)
    expect(result.rejection).toBe('schema')
  })
})
