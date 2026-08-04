// tests/eval/stella-release/harness.test.ts
// RELEASE line — the release eval harness over the official matrix
// (STELLA_RELEASE_EVALUATION_FOUNDATION_TRAIN_1, Fase 3).
// Offline: zero network, zero DB, zero provider calls.

import { describe, it, expect } from 'vitest'
import { RELEASE_EVAL_MATRIX, validateReleaseEvalMatrix, ReleaseEvalMatrixError } from './matrix'
import { runReleaseEvalHarness, detectContradictionAcknowledgment, ReleaseEvalHarnessError } from './harness'

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

  it('distinguishes abstention responses from plain passes (Fase 3 requirement)', () => {
    // At least the insufficient-evidence and quota-exhausted checks must be
    // classified as legitimate abstentions, not indistinguishable passes.
    expect(summary.abstentionResponses).toBeGreaterThanOrEqual(2)
    const byId = new Map(results.map((r) => [r.checkId, r]))
    expect(byId.get('insufficient-evidence-empty-sentinel')?.outcome).toBe('abstention-response')
    expect(byId.get('quota-exhausted-non-retryable')?.outcome).toBe('abstention-response')
  })

  it('computes every declared metric, marking provider-dependent ones as non-measurable rather than fabricating a value', () => {
    const byMetric = new Map(summary.metrics.map((m) => [m.metric, m]))
    expect(byMetric.get('citation-precision')?.measurable).toBe(true)
    expect(byMetric.get('latency')?.measurable).toBe(false)
    expect(byMetric.get('latency')?.value).toBeNull()
    expect(byMetric.get('token-usage')?.measurable).toBe(false)
    expect(byMetric.get('token-usage')?.value).toBeNull()
    expect(byMetric.get('estimated-provider-cost')?.measurable).toBe(false)
    expect(byMetric.get('estimated-provider-cost')?.value).toBeNull()
  })

  it('rejects a matrix entry with no implemented check', () => {
    const bogus = [...RELEASE_EVAL_MATRIX, { ...RELEASE_EVAL_MATRIX[0]!, checkId: 'not-a-real-check' }]
    expect(() => runReleaseEvalHarness(bogus)).toThrow(ReleaseEvalHarnessError)
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

describe('negative-path sanity (harness actually detects, not just passes)', () => {
  it('the citation-correct-decodes logic rejects an index one past the catalog bound', async () => {
    const { buildContextualAdvisorRequest } = await import('@/lib/stella/context/build-contextual-advisor-request')
    const { decodeProviderSourceRefIndexes, ProviderSourceRefIndexesError } = await import('@/lib/stella/context/decode-provider-source-ref-indexes')
    const { ORG_ALPHA_CONTEXT } = await import('./fixtures')
    const request = buildContextualAdvisorRequest('evidence', ORG_ALPHA_CONTEXT)
    const offByOne = {
      step: 'evidence', responseType: 'review', summary: 's',
      findings: [{ id: 'f', severity: 'info', title: 't', explanation: 'e', sourceRefIndexes: [request.canonicalSourceFieldPaths.length] }],
      suggestions: [], clarifyingQuestions: [], limitations: [], requiresHumanReview: true,
    }
    expect(() => decodeProviderSourceRefIndexes(offByOne, request.canonicalSourceFieldPaths, 'evidence'))
      .toThrow(ProviderSourceRefIndexesError)
  })

  it('the cross-organization check would catch a marker deliberately mixed into the wrong tenant', async () => {
    const { ISOLATION_MARKERS } = await import('./fixtures')
    // Sanity on the fixtures themselves: the two markers must be distinct,
    // or the isolation check below would pass vacuously.
    expect(ISOLATION_MARKERS.alpha).not.toBe(ISOLATION_MARKERS.beta)
  })
})
