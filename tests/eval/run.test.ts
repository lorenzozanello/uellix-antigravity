// tests/eval/run.test.ts
// Etapa A1 (STL-A1-012) — unit tests for the eval harness's testable core.
//
// Deliberately imports ONLY from ./engine, never from ./run (the CLI entry
// that wires the real Gemini adapter). This guarantees these tests can never
// trigger a real model call: engine.ts has no adapter import at all.

import { describe, it, expect, vi } from 'vitest'
import { isRealModelEnabled, getMaxCalls, runEval, compareRuns, renderMarkdownSummary } from './engine'
import { EVAL_CASES } from './cases'
import type { EvalModelCaller, EvalRunSummary } from './types'

describe('isRealModelEnabled', () => {
  it('is false when unset', () => {
    expect(isRealModelEnabled({})).toBe(false)
  })

  it('is false for any value other than the exact string "true"', () => {
    expect(isRealModelEnabled({ STELLA_EVAL_REAL_MODEL: '1' })).toBe(false)
    expect(isRealModelEnabled({ STELLA_EVAL_REAL_MODEL: 'yes' })).toBe(false)
    expect(isRealModelEnabled({ STELLA_EVAL_REAL_MODEL: 'TRUE' })).toBe(false)
  })

  it('is true only for the exact string "true"', () => {
    expect(isRealModelEnabled({ STELLA_EVAL_REAL_MODEL: 'true' })).toBe(true)
  })
})

describe('getMaxCalls', () => {
  it('defaults to 30 when unset', () => {
    expect(getMaxCalls({})).toBe(30)
  })

  it('respects a valid positive override', () => {
    expect(getMaxCalls({ STELLA_EVAL_MAX_CALLS: '5' })).toBe(5)
  })

  it('falls back to the default on an invalid value', () => {
    expect(getMaxCalls({ STELLA_EVAL_MAX_CALLS: 'not-a-number' })).toBe(30)
    expect(getMaxCalls({ STELLA_EVAL_MAX_CALLS: '-3' })).toBe(30)
    expect(getMaxCalls({ STELLA_EVAL_MAX_CALLS: '0' })).toBe(30)
  })
})

function goldenLikeCaller(): EvalModelCaller {
  return vi.fn(async ({ role }) => {
    const base = {
      summary: 'A reasonable, non-absolute summary.',
      risk_level: 'low' as const,
      evidence_gaps: [],
      proxy_risks: [],
      attribution_risks: [],
      claim_risks: [],
      recommendations: [],
      requires_human_review: true,
    }
    const byRole: Record<string, unknown> = {
      advisor: {
        step: 'outcomes',
        what_to_do: 'Define outcomes.',
        why_it_matters: 'It matters.',
        how_to_do_it: 'Do it carefully.',
        common_mistakes: [],
        suggested_next_actions: [],
      },
      validator: base,
      composer: {
        section_key: 'executive_summary',
        draft_title: 'Draft',
        draft_content: 'Draft content requiring human review.',
        assumptions: [],
        limitations: [],
        evidence_references: [],
        proxy_references: [],
      },
      proxy_reviewer: { summary: base.summary, risk_level: 'low', findings: [], recommendations: [], requires_human_review: true },
      evidence_reviewer: { summary: base.summary, risk_level: 'low', findings: [], recommendations: [], requires_human_review: true },
      audit_assistant: { summary: base.summary, risk_level: 'low', findings: [], recommendations: [], requires_human_review: true },
    }
    return { rawOutput: JSON.stringify(byRole[role]), modelUsed: 'mock-model-eval-test' }
  })
}

describe('runEval', () => {
  it('runs exactly maxCalls cases and reports the rest as skipped by budget', async () => {
    const caller = goldenLikeCaller()
    const summary = await runEval(EVAL_CASES, caller, 3)

    expect(summary.casesRun).toBe(3)
    expect(summary.casesSkippedBudget).toBe(EVAL_CASES.length - 3)
    expect(caller).toHaveBeenCalledTimes(3)
    expect(summary.approved).toBe(false) // skipped-by-budget runs can never be approved
  })

  it('runs all cases when maxCalls exceeds the catalog size', async () => {
    const caller = goldenLikeCaller()
    const summary = await runEval(EVAL_CASES, caller, 1000)

    expect(summary.casesRun).toBe(EVAL_CASES.length)
    expect(summary.casesSkippedBudget).toBe(0)
  })

  it('captures a caller error as a failed case result instead of throwing', async () => {
    const failingCaller: EvalModelCaller = vi.fn(async () => {
      throw new Error('simulated network failure')
    })
    const summary = await runEval(EVAL_CASES.slice(0, 2), failingCaller, 10)

    expect(summary.results).toHaveLength(2)
    expect(summary.results.every((r) => !r.passed)).toBe(true)
    expect(summary.results[0].error).toBe('simulated network failure')
  })

  it('never imports the DB client (module has no such import statement)', async () => {
    // Structural guarantee: engine.ts must not import the DB client. If it
    // ever did, this test file would need a vi.mock for it to even load.
    // (Checks for an actual import statement, not the bare string — the file's
    // own header comment documents this guarantee and would otherwise self-match.)
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'tests', 'eval', 'engine.ts'), 'utf-8')
    expect(/from\s+['"]@\/db\/client['"]/.test(source)).toBe(false)
  })
})

describe('compareRuns', () => {
  function makeSummary(overrides: Partial<EvalRunSummary> = {}): EvalRunSummary {
    return {
      runId: 'run-1',
      timestamp: '2026-01-01T00:00:00Z',
      modelUsed: 'mock-model',
      totalCases: 2,
      casesRun: 2,
      casesSkippedBudget: 0,
      passedCases: 2,
      failedCases: 0,
      roleSummaries: [],
      results: [
        { caseId: 'a', role: 'advisor', type: 'golden', modelUsed: 'mock-model', passed: true, checks: [] },
        { caseId: 'b', role: 'advisor', type: 'adversarial', modelUsed: 'mock-model', passed: true, checks: [] },
      ],
      approved: true,
      ...overrides,
    }
  }

  it('reports no previous run when none exists', () => {
    expect(compareRuns(null, makeSummary())).toEqual(['No previous run found — nothing to compare against.'])
  })

  it('reports no change when nothing flipped', () => {
    const prev = makeSummary()
    const current = makeSummary()
    expect(compareRuns(prev, current)).toEqual(['No change in pass/fail status for any case.'])
  })

  it('reports a flipped case', () => {
    const prev = makeSummary()
    const current = makeSummary({
      results: [
        { caseId: 'a', role: 'advisor', type: 'golden', modelUsed: 'mock-model', passed: false, checks: [] },
        { caseId: 'b', role: 'advisor', type: 'adversarial', modelUsed: 'mock-model', passed: true, checks: [] },
      ],
    })
    expect(compareRuns(prev, current)).toEqual(['a: PASS -> FAIL'])
  })
})

describe('renderMarkdownSummary', () => {
  it('includes the model, approval result, and per-role table', () => {
    const summary: EvalRunSummary = {
      runId: 'run-1',
      timestamp: '2026-01-01T00:00:00Z',
      modelUsed: 'mock-model',
      totalCases: 1,
      casesRun: 1,
      casesSkippedBudget: 0,
      passedCases: 1,
      failedCases: 0,
      roleSummaries: [
        { role: 'advisor', totalCases: 1, passedCases: 1, goldenPassRate: 1, negativePassRate: 1, adversarialPassRate: 1, passed: true },
      ],
      results: [],
      approved: true,
    }
    const md = renderMarkdownSummary(summary, ['No change in pass/fail status for any case.'])
    expect(md).toContain('mock-model')
    expect(md).toContain('APROBADA')
    expect(md).toContain('advisor')
  })
})
