// tests/eval/stella-release/harness.test.ts
// RELEASE line — the release eval harness over the official matrix
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fase 2).
// Offline: zero network, zero DB, zero provider calls.
//
// The train 1 version of this file asserted that every check passed. That is
// exactly the assertion a tautological check satisfies for free, so most of
// what follows asserts the opposite direction: that the evaluators REJECT the
// inputs they claim to reject, and that a check which cannot fail is reported
// as a failure.

import { describe, it, expect } from 'vitest'
import { RELEASE_EVAL_MATRIX, validateReleaseEvalMatrix, ReleaseEvalMatrixError } from './matrix'
import {
  runReleaseEvalHarness,
  detectContradictionAcknowledgment,
  classifyRejection,
  withNegativeControls,
  evaluateCapRegressionSurface,
  emptySurfaceProbe,
  realCapSurfaceProbe,
  releaseEvalFailureReasons,
  ReleaseEvalHarnessError,
  type ReleaseEvalSummary,
} from './harness'
import { ISOLATION_MARKERS } from './fixtures'
import { ProviderSourceRefIndexesError } from '@/lib/stella/context/decode-provider-source-ref-indexes'

describe('release eval matrix', () => {
  it('is valid (unique checkIds, all 14 categories covered, limitations declared)', () => {
    expect(() => validateReleaseEvalMatrix(RELEASE_EVAL_MATRIX)).not.toThrow()
  })

  it('has exactly 14 entries — one per required category', () => {
    expect(RELEASE_EVAL_MATRIX).toHaveLength(14)
    expect(new Set(RELEASE_EVAL_MATRIX.map((e) => e.category)).size).toBe(14)
  })

  it('rejects a matrix with a duplicated checkId', () => {
    expect(() => validateReleaseEvalMatrix([RELEASE_EVAL_MATRIX[0]!, RELEASE_EVAL_MATRIX[0]!])).toThrow(ReleaseEvalMatrixError)
  })

  it('rejects an offline-unmeasurable entry with no declared limitation', () => {
    const broken = { ...RELEASE_EVAL_MATRIX[0]!, offlineMeasurable: false, offlineLimitation: undefined }
    expect(() => validateReleaseEvalMatrix([broken])).toThrow(ReleaseEvalMatrixError)
  })

  it('rejects an entry that declares no metric', () => {
    expect(() => validateReleaseEvalMatrix([{ ...RELEASE_EVAL_MATRIX[0]!, metrics: [] }])).toThrow(ReleaseEvalMatrixError)
  })
})

describe('release eval harness (official matrix)', () => {
  const { summary, results } = runReleaseEvalHarness()

  it('every check passes or is a legitimate abstention — never a system error', () => {
    const failed = results.filter((r) => !r.ok)
    expect(failed.map((r) => `${r.checkId} [${r.outcome}] → ${r.detail}`)).toEqual([])
    expect(summary.systemErrors).toBe(0)
    expect(summary.isolationViolations).toBe(0)
  })

  it('runs fully offline (zero provider calls)', () => {
    expect(summary.providerCalls).toBe(0)
  })

  it('reports 14/14 checks passed', () => {
    expect(summary.totalChecks).toBe(14)
    expect(summary.passed).toBe(14)
    expect(summary.failed).toBe(0)
  })

  it('names the fixture every check ran against', () => {
    for (const result of results) {
      expect(result.fixtureId, `${result.checkId} has no fixtureId`).toBeTruthy()
    }
  })

  it('distinguishes abstention responses from plain passes', () => {
    const byId = new Map(results.map((r) => [r.checkId, r]))
    expect(byId.get('insufficient-evidence-empty-sentinel')?.outcome).toBe('abstention-response')
    expect(byId.get('quota-exhausted-non-retryable')?.outcome).toBe('abstention-response')
    expect(summary.abstentionResponses).toBeGreaterThanOrEqual(2)
  })

  // B-M5, second half: "14/14" hid the fact that one category is not fully
  // measurable offline, because nothing in the headline said so.
  it('separates fully-offline-measurable checks from offline-limited ones', () => {
    expect(summary.offlineMeasurableChecks + summary.offlineLimitedChecks).toBe(summary.totalChecks)
    expect(summary.offlineLimitedChecks).toBeGreaterThan(0)
  })

  it('every check carries at least one negative control, and all of them detected', () => {
    for (const result of results) {
      expect(result.negativeControls.length, `${result.checkId} has no negative control`).toBeGreaterThan(0)
    }
    const undetected = results.flatMap((r) => r.negativeControls).filter((c) => !c.detected)
    expect(undetected.map((c) => `${c.controlId} → ${c.detail}`)).toEqual([])
    expect(summary.negativeControlsUndetected).toBe(0)
    expect(summary.tautologicalChecks).toEqual([])
    expect(summary.negativeControlsRun).toBe(results.flatMap((r) => r.negativeControls).length)
  })

  it('computes every declared metric, marking provider-dependent ones as non-measurable rather than fabricating a value', () => {
    const byMetric = new Map(summary.metrics.map((m) => [m.metric, m]))
    expect(byMetric.get('citation-precision')?.measurable).toBe(true)
    for (const name of ['latency', 'token-usage', 'estimated-provider-cost']) {
      expect(byMetric.get(name)?.measurable).toBe(false)
      expect(byMetric.get(name)?.value).toBeNull()
    }
  })

  it('rejects a matrix entry with no implemented check', () => {
    const bogus = [...RELEASE_EVAL_MATRIX, { ...RELEASE_EVAL_MATRIX[0]!, checkId: 'not-a-real-check' }]
    expect(() => runReleaseEvalHarness(bogus)).toThrow(ReleaseEvalHarnessError)
  })
})

// ---------------------------------------------------------------------------
// The mechanism itself
// ---------------------------------------------------------------------------
describe('negative-control mechanism (a check that cannot fail is a failure)', () => {
  const passingBase = {
    checkId: 'synthetic-check',
    fixtureId: 'synthetic-fixture',
    ok: true,
    outcome: 'pass' as const,
    detail: 'clean run said everything is fine',
  }

  it('leaves a check green when every control detected its mutation', () => {
    const result = withNegativeControls(passingBase, [
      { controlId: 'nc-ok', property: 'p', detected: true, detail: 'mutation rejected' },
    ])
    expect(result.ok).toBe(true)
    expect(result.outcome).toBe('pass')
  })

  it('demotes a passing check to system-error when a control failed to detect', () => {
    const result = withNegativeControls(passingBase, [
      { controlId: 'nc-blind', property: 'the mutation must be rejected', detected: false, detail: 'mutation was ACCEPTED' },
    ])
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('system-error')
    expect(result.detail).toMatch(/^TAUTOLOGICAL/)
    expect(result.detail).toContain('nc-blind')
    // The clean-run detail is preserved, not swallowed.
    expect(result.detail).toContain('clean run said everything is fine')
  })

  it('a system fault is never laundered into an abstention', () => {
    expect(classifyRejection(new TypeError('plumbing'), ProviderSourceRefIndexesError)).toBe('system-error')
    expect(classifyRejection(new RangeError('off by one'), ProviderSourceRefIndexesError)).toBe('system-error')
    expect(classifyRejection(new ProviderSourceRefIndexesError('findings[0].sourceRefIndexes[0]', 99, 'must be an in-range integer'), ProviderSourceRefIndexesError))
      .toBe('abstention-response')
  })
})

// ---------------------------------------------------------------------------
// B-M4 — the CAP regression surface evaluator
// ---------------------------------------------------------------------------
describe('cap regression surface evaluator (B-M4)', () => {
  const realExclusions = ['**/node_modules/**', 'tests/integration/**']

  it('is clean against the real repository', () => {
    expect(evaluateCapRegressionSurface(realCapSurfaceProbe(process.cwd(), realExclusions))).toEqual([])
  })

  // The exact state train 1 proved the old check could not see.
  it('reports every CAP package when all of them are zero bytes', () => {
    const problems = evaluateCapRegressionSurface(emptySurfaceProbe(realExclusions))
    expect(problems.length).toBeGreaterThanOrEqual(10)
    expect(problems.join(' ')).toMatch(/is a stub/)
  })

  it('reports a CAP regression test swallowed by a vitest exclusion glob', () => {
    const problems = evaluateCapRegressionSurface(realCapSurfaceProbe(process.cwd(), [...realExclusions, 'tests/capability-**']))
    expect(problems.join(' ')).toMatch(/excluded from the default vitest config/)
    expect(problems.length).toBe(3)
  })

  it('reports a missing package rather than passing on absence', () => {
    const probe = realCapSurfaceProbe(process.cwd(), realExclusions)
    const problems = evaluateCapRegressionSurface({
      ...probe,
      exists: (p) => (p.includes('stella_0008') ? false : probe.exists(p)),
    })
    expect(problems.join(' ')).toMatch(/missing: db\/prepared\/stella_0008/)
  })
})

// ---------------------------------------------------------------------------
// The process must actually fail
// ---------------------------------------------------------------------------
describe('failure gates (what makes pnpm test:stella:release-eval exit non-zero)', () => {
  const clean = runReleaseEvalHarness().summary
  const mutate = (patch: Partial<ReleaseEvalSummary>): ReleaseEvalSummary => ({ ...clean, ...patch })

  it('a clean run has no failure reason', () => {
    expect(releaseEvalFailureReasons(clean)).toEqual([])
  })

  it('fails on an isolation violation', () => {
    expect(releaseEvalFailureReasons(mutate({ isolationViolations: 1 })).join(' ')).toMatch(/isolation violation/)
  })

  it('fails on a tautological check even when nothing else is wrong', () => {
    const reasons = releaseEvalFailureReasons(mutate({ tautologicalChecks: ['some-check'] }))
    expect(reasons.join(' ')).toMatch(/tautological/)
    expect(reasons.join(' ')).toContain('some-check')
  })

  it('fails on an undetected negative control', () => {
    expect(releaseEvalFailureReasons(mutate({ negativeControlsUndetected: 2 })).join(' ')).toMatch(/negative control/)
  })

  it('fails on a system error', () => {
    expect(releaseEvalFailureReasons(mutate({ systemErrors: 1 })).join(' ')).toMatch(/system error/)
  })

  it('fails if the harness ever made a provider call', () => {
    expect(releaseEvalFailureReasons(mutate({ providerCalls: 1 })).join(' ')).toMatch(/provider call/)
  })

  it('reports every applicable reason, not just the first', () => {
    expect(releaseEvalFailureReasons(mutate({ isolationViolations: 1, systemErrors: 1 })).length).toBe(2)
  })
})

describe('contradiction-acknowledgment heuristic (documented limitation)', () => {
  it('detects explicit acknowledgment keywords', () => {
    expect(detectContradictionAcknowledgment('Existe una discrepancia entre las dos fuentes.')).toBe(true)
    expect(detectContradictionAcknowledgment('Hay una contradicción evidente en los datos.')).toBe(true)
  })

  it('does not flag ordinary prose with no acknowledgment', () => {
    expect(detectContradictionAcknowledgment('El indicador mejoró de forma sostenida durante el período.')).toBe(false)
  })
})

describe('fixture sanity (a vacuous fixture makes every isolation check vacuous)', () => {
  it('the two tenant markers are distinct', () => {
    expect(ISOLATION_MARKERS.alpha).not.toBe(ISOLATION_MARKERS.beta)
  })
})
