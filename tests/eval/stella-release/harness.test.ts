// tests/eval/stella-release/harness.test.ts
// RELEASE line — the release eval harness over the official matrix
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fases 2-4).
// Offline: zero network, zero DB, zero provider calls.
//
// The train 1 version of this file asserted that every check passed. That is
// exactly the assertion a tautological check satisfies for free, so most of
// what follows asserts the opposite direction: that the evaluators REJECT the
// inputs they claim to reject, and that a check which cannot fail is reported
// as a failure.

import { describe, it, expect } from 'vitest'
import {
  RELEASE_EVAL_MATRIX,
  RELEASE_EVAL_MATRIX_VERSION,
  PROVIDER_DEPENDENT_METRICS,
  validateReleaseEvalMatrix,
  ReleaseEvalMatrixError,
} from './matrix'
import {
  runReleaseEvalHarness,
  detectContradictionAcknowledgment,
  classifyRejection,
  withNegativeControls,
  evaluateCapRegressionSurface,
  evaluateProjectScopeEnforcement,
  evaluateCanonicalProvenance,
  evaluateRetrievalScoring,
  evaluateContradictionHandling,
  projectCitationForProduct,
  emptySurfaceProbe,
  realCapSurfaceProbe,
  releaseEvalFailureReasons,
  RELEASE_HARNESS_VERSION,
  ReleaseEvalHarnessError,
  type ReleaseEvalSummary,
} from './harness'
import {
  RELEASE_FIXTURES_VERSION,
  ALPHA_PROJECT_ONE_CHUNK,
  ALPHA_PROJECT_TWO_CHUNK,
  BETA_PROJECT_ONE_CHUNK,
  CONTRADICTION_SIDE_A_CHUNK,
  CONTRADICTION_SIDE_B_CHUNK,
  ALPHA_PROJECT_ONE_QUERY,
  ALPHA_PROJECT_ONE_RETRIEVAL,
  MISRANKED_RETRIEVAL,
  BELOW_THRESHOLD_ADMITTED_RETRIEVAL,
  GROUNDED_ANSWER,
  CONTRADICTION_ACKNOWLEDGED_ANSWER,
  CONTRADICTION_IGNORED_ANSWER,
  GROUNDING_SCOPES,
  NONEXISTENT_CITATION,
  DRIFTED_CITATION,
  CROSS_PROJECT_CITATION,
  CROSS_ORGANIZATION_CITATION,
  ISOLATION_MARKERS,
  citationTo,
  DECISION_ACCEPTED_INPUT,
  DECISION_REJECTED_INPUT,
  DECISION_UNDONE_INPUT,
} from './fixtures'
import { StellaDecisionInputSchema } from '@/app/actions/stella/decisions-schema'
import { ProviderSourceRefIndexesError } from '@/lib/stella/context/decode-provider-source-ref-indexes'
import type { ContentHash, GroundingAnswerState, GroundingChunk } from '@/lib/grounding/contracts'

const ALL_CHUNKS: ReadonlyMap<ContentHash, GroundingChunk> = new Map(
  [ALPHA_PROJECT_ONE_CHUNK, ALPHA_PROJECT_TWO_CHUNK, BETA_PROJECT_ONE_CHUNK, CONTRADICTION_SIDE_A_CHUNK, CONTRADICTION_SIDE_B_CHUNK]
    .map((c) => [c.chunkId, c] as const),
)

function answerCiting(citation: Parameters<typeof projectCitationForProduct>[0]): GroundingAnswerState {
  return {
    ...GROUNDED_ANSWER,
    assertions: [{ kind: 'evidence', statement: 'afirmación de prueba', citations: [citation] }],
  }
}

describe('release eval matrix', () => {
  it('is valid (unique checkIds, all categories covered, limitations declared)', () => {
    expect(() => validateReleaseEvalMatrix(RELEASE_EVAL_MATRIX)).not.toThrow()
  })

  it('has one entry per declared category', () => {
    expect(new Set(RELEASE_EVAL_MATRIX.map((e) => e.category)).size).toBe(RELEASE_EVAL_MATRIX.length)
  })

  it('rejects a matrix with a duplicated checkId', () => {
    expect(() => validateReleaseEvalMatrix([RELEASE_EVAL_MATRIX[0]!, RELEASE_EVAL_MATRIX[0]!])).toThrow(ReleaseEvalMatrixError)
  })

  it('rejects an offline-unmeasurable entry with no declared limitation', () => {
    const broken = { ...RELEASE_EVAL_MATRIX[0]!, offlineMeasurable: false, offlineLimitation: undefined }
    expect(() => validateReleaseEvalMatrix([broken])).toThrow(ReleaseEvalMatrixError)
  })

  it('rejects an entry that declares no metric', () => {
    const broken = { ...RELEASE_EVAL_MATRIX[0]!, metrics: [] }
    expect(() => validateReleaseEvalMatrix([broken])).toThrow(ReleaseEvalMatrixError)
  })

  // B-M6: train 1 pinned `latency` on two checks that could not measure it.
  it('rejects an entry that claims to feed a provider-dependent metric', () => {
    const broken = { ...RELEASE_EVAL_MATRIX[0]!, metrics: ['latency'] as const }
    expect(() => validateReleaseEvalMatrix([broken])).toThrow(/provider-dependent metric/)
  })

  it('no matrix entry declares a provider-dependent metric', () => {
    for (const entry of RELEASE_EVAL_MATRIX) {
      for (const metric of entry.metrics) {
        expect(PROVIDER_DEPENDENT_METRICS).not.toContain(metric)
      }
    }
  })
})

describe('release eval harness (official matrix)', () => {
  const { summary, results, observations } = runReleaseEvalHarness()

  it('every check passes or is a legitimate abstention — never a system error', () => {
    const failed = results.filter((r) => !r.ok)
    expect(failed.map((r) => `${r.checkId} [${r.outcome}] → ${r.detail}`)).toEqual([])
    expect(summary.systemErrors).toBe(0)
    expect(summary.isolationViolations).toBe(0)
    expect(summary.citationValidationFailures).toBe(0)
  })

  it('runs fully offline (zero provider calls)', () => {
    expect(summary.providerCalls).toBe(0)
  })

  it('runs the whole matrix', () => {
    expect(summary.totalChecks).toBe(RELEASE_EVAL_MATRIX.length)
    expect(summary.passed).toBe(RELEASE_EVAL_MATRIX.length)
    expect(summary.failed).toBe(0)
  })

  it('reports its three versions in the structured output', () => {
    expect(summary.harnessVersion).toBe(RELEASE_HARNESS_VERSION)
    expect(summary.matrixVersion).toBe(RELEASE_EVAL_MATRIX_VERSION)
    expect(summary.fixturesVersion).toBe(RELEASE_FIXTURES_VERSION)
  })

  it('names the fixture every check ran against', () => {
    for (const result of results) {
      expect(result.fixtureId, `${result.checkId} has no fixtureId`).toBeTruthy()
    }
  })

  it('distinguishes abstention responses from plain passes', () => {
    const byId = new Map(results.map((r) => [r.checkId, r]))
    expect(byId.get('insufficient-evidence-empty-sentinel')?.outcome).toBe('abstention-response')
    expect(byId.get('abstention-schema-enforced')?.outcome).toBe('abstention-response')
    expect(byId.get('grounding-contradiction-marked')?.outcome).toBe('abstention-response')
    expect(summary.abstentionResponses).toBeGreaterThanOrEqual(3)
  })

  // B-M5: "14/14" hid the fact that one category is not fully measurable.
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

  // B-M6: structural-regression was declared and never emitted.
  it('emits every metric the matrix declares, including structural-regression', () => {
    const emitted = new Set(summary.metrics.map((m) => m.metric))
    for (const entry of RELEASE_EVAL_MATRIX) {
      for (const metric of entry.metrics) expect(emitted).toContain(metric)
    }
    expect(emitted).toContain('structural-regression')
    expect(summary.metrics.find((m) => m.metric === 'structural-regression')?.value).not.toBeNull()
  })

  it('marks provider-dependent metrics as non-measurable with a structured reason, never a bare null', () => {
    for (const name of PROVIDER_DEPENDENT_METRICS) {
      const metric = summary.metrics.find((m) => m.metric === name)!
      expect(metric.measurable, `${name} must not claim to be measurable offline`).toBe(false)
      expect(metric.value).toBeNull()
      expect(metric.nullReason).not.toBeNull()
      expect(metric.nullReason!.code).toBeTruthy()
      expect(metric.nullReason!.detail.length).toBeGreaterThan(20)
    }
    expect(summary.metrics.find((m) => m.metric === 'latency')!.nullReason!.gate).toBe('G1')
    expect(summary.metrics.find((m) => m.metric === 'estimated-provider-cost')!.nullReason!.gate).toBe('G9')
  })

  it('never emits a value together with a null reason', () => {
    for (const metric of summary.metrics) {
      expect(metric.value === null).toBe(metric.nullReason !== null)
    }
  })

  it('produces deterministic structured output across runs', () => {
    const second = runReleaseEvalHarness()
    expect(JSON.stringify(second.results)).toBe(JSON.stringify(results))
    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(summary))
  })

  it('keeps the non-deterministic wall-clock observation out of the summary', () => {
    expect(observations.harnessWallClockMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(summary)).not.toContain('harnessWallClockMs')
  })

  it('rejects a matrix entry with no implemented check', () => {
    const bogus = [...RELEASE_EVAL_MATRIX, { ...RELEASE_EVAL_MATRIX[0]!, checkId: 'not-a-real-check', category: 'abstencion' as const }]
    expect(() => runReleaseEvalHarness(bogus)).toThrow(ReleaseEvalHarnessError)
  })

  it('rejects a matrix whose declared metric nothing emits', () => {
    // Drop every entry that feeds isolation-violations except one that keeps a
    // metric no contributor produces, by declaring a metric the matrix knows
    // but computeReleaseMetrics is asked to reconcile against.
    const subset = RELEASE_EVAL_MATRIX.filter((e) => e.checkId === 'sufficient-evidence-citation-resolves')
    // The subset still emits all metrics (they are computed unconditionally),
    // so reconciliation must complain about the ones nothing declares.
    expect(() => runReleaseEvalHarness(subset)).toThrow(/no matrix entry declares it|missing required category/)
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
// Grounding-contract evaluators (Fase 5)
// ---------------------------------------------------------------------------
describe('project-scope enforcement', () => {
  const reader = ALPHA_PROJECT_ONE_QUERY.scope

  it('accepts an answer that cites only in-scope chunks', () => {
    expect(evaluateProjectScopeEnforcement(GROUNDED_ANSWER, ALL_CHUNKS, reader)).toEqual([])
  })

  it('rejects a citation to a SIBLING PROJECT of the same organization', () => {
    const violations = evaluateProjectScopeEnforcement(answerCiting(CROSS_PROJECT_CITATION), ALL_CHUNKS, reader)
    expect(violations.join(' ')).toMatch(/crosses the reader scope/)
  })

  it('rejects a citation to another organization', () => {
    expect(evaluateProjectScopeEnforcement(answerCiting(CROSS_ORGANIZATION_CITATION), ALL_CHUNKS, reader).length).toBe(1)
  })

  it('rejects a citation to a chunk that was never retrieved', () => {
    expect(evaluateProjectScopeEnforcement(answerCiting(NONEXISTENT_CITATION), ALL_CHUNKS, reader).join(' '))
      .toMatch(/no chunk in the retrieved set/)
  })

  it('lets an org-wide reader read a project-scoped chunk, but not the reverse', () => {
    expect(evaluateProjectScopeEnforcement(answerCiting(CROSS_PROJECT_CITATION), ALL_CHUNKS, GROUNDING_SCOPES.alphaOrgWide)).toEqual([])
    expect(evaluateProjectScopeEnforcement(answerCiting(CROSS_ORGANIZATION_CITATION), ALL_CHUNKS, GROUNDING_SCOPES.alphaOrgWide).length).toBe(1)
  })
})

describe('canonical provenance', () => {
  it('accepts a chunk whose verification chain closes', () => {
    expect(evaluateCanonicalProvenance(ALPHA_PROJECT_ONE_CHUNK)).toEqual([])
  })

  it('rejects a chunk whose text was edited after hashing', () => {
    const tampered = { ...ALPHA_PROJECT_ONE_CHUNK, text: `${ALPHA_PROJECT_ONE_CHUNK.text} extra` }
    expect(evaluateCanonicalProvenance(tampered).join(' ')).toMatch(/contentHash is not the hash of the chunk text/)
  })

  it('rejects a chunk whose id does not re-derive', () => {
    const forged = { ...ALPHA_PROJECT_ONE_CHUNK, chunkIndex: ALPHA_PROJECT_ONE_CHUNK.chunkIndex + 1 }
    expect(evaluateCanonicalProvenance(forged).join(' ')).toMatch(/does not re-derive/)
  })

  it('rejects a stale pipeline version', () => {
    const stale = {
      ...ALPHA_PROJECT_ONE_CHUNK,
      provenance: { ...ALPHA_PROJECT_ONE_CHUNK.provenance, chunkerVersion: 'chunk-0' },
    }
    expect(evaluateCanonicalProvenance(stale).join(' ')).toMatch(/chunkerVersion/)
  })
})

describe('retrieval score ordering', () => {
  it('accepts a well-formed ranking', () => {
    expect(evaluateRetrievalScoring(ALPHA_PROJECT_ONE_RETRIEVAL)).toEqual([])
  })

  it('rejects a ranking that contradicts its own scores', () => {
    expect(evaluateRetrievalScoring(MISRANKED_RETRIEVAL).join(' ')).toMatch(/not monotone/)
  })

  it('rejects a candidate returned below the query minScore', () => {
    expect(evaluateRetrievalScoring(BELOW_THRESHOLD_ADMITTED_RETRIEVAL).join(' ')).toMatch(/below the query minScore/)
  })

  it('rejects a non-finite score instead of comparing it', () => {
    const nan = {
      ...ALPHA_PROJECT_ONE_RETRIEVAL,
      candidates: [{ ...ALPHA_PROJECT_ONE_RETRIEVAL.candidates[0]!, score: Number.NaN }],
    }
    expect(evaluateRetrievalScoring(nan).join(' ')).toMatch(/not a finite number/)
  })
})

describe('contradiction handling', () => {
  it('accepts an answer that marks both sides and defers to a human', () => {
    expect(evaluateContradictionHandling(CONTRADICTION_ACKNOWLEDGED_ANSWER, ALL_CHUNKS)).toEqual([])
  })

  it('rejects an answer that cites both sides and presents it as settled', () => {
    expect(evaluateContradictionHandling(CONTRADICTION_IGNORED_ANSWER, ALL_CHUNKS).join(' '))
      .toMatch(/carries no ContradictionMarker/)
  })

  it('rejects a marker claiming Stella resolved the contradiction itself', () => {
    const selfResolved = {
      ...CONTRADICTION_IGNORED_ANSWER,
      contradictions: [{ ...CONTRADICTION_ACKNOWLEDGED_ANSWER.contradictions[0]!, resolution: 'resolved_automatically' as never }],
    }
    expect(evaluateContradictionHandling(selfResolved, ALL_CHUNKS).join(' ')).toMatch(/never resolves a contradiction itself/)
  })

  it('does not flag an answer with no contradiction in it', () => {
    expect(evaluateContradictionHandling(GROUNDED_ANSWER, ALL_CHUNKS)).toEqual([])
  })
})

describe("PRODUCT adapter input completeness (INTEGRATION-001 acceptance criterion)", () => {
  it('projects a well-formed citation', () => {
    const { projection, violations } = projectCitationForProduct(citationTo(ALPHA_PROJECT_ONE_CHUNK), ALL_CHUNKS)
    expect(violations).toEqual([])
    expect(projection).toEqual({
      sourceField: 'evidence/ev-alpha-1/chunk/0',
      label: 'linea-base-hogares-2025.pdf (líneas 1–1)',
    })
  })

  it('refuses to project a citation whose quote drifted off its passage', () => {
    const { projection, violations } = projectCitationForProduct(DRIFTED_CITATION, ALL_CHUNKS)
    expect(projection).toBeNull()
    expect(violations.join(' ')).toMatch(/quotedTextHash does not match/)
  })

  it('refuses to project a citation with no retrieved chunk', () => {
    expect(projectCitationForProduct(NONEXISTENT_CITATION, ALL_CHUNKS).projection).toBeNull()
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

// ---------------------------------------------------------------------------
// Fase 4 — the process must actually fail
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

  it('fails on an invalid citation', () => {
    expect(releaseEvalFailureReasons(mutate({ citationValidationFailures: 1 })).join(' ')).toMatch(/citation validation failure/)
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
    const reasons = releaseEvalFailureReasons(mutate({ isolationViolations: 1, citationValidationFailures: 1, systemErrors: 1 }))
    expect(reasons.length).toBe(3)
  })
})

describe('decision journey (train 3: accept/reject/rollback + its two failure modes)', () => {
  const byId = new Map(runReleaseEvalHarness().results.map((r) => [r.checkId, r]))

  it('the feature-flag gate is classified as an abstention, not a plain pass', () => {
    expect(byId.get('stella-decision-feature-flag-blocks-persistence')?.outcome).toBe('abstention-response')
  })

  it('accepted, rejected and rollback all resolve against the real schema, never a system error', () => {
    expect(byId.get('stella-decision-accepted-contract-valid')?.outcome).toBe('pass')
    expect(byId.get('stella-decision-rejected-contract-valid')?.outcome).toBe('pass')
    expect(byId.get('stella-decision-rollback-append-only')?.outcome).toBe('pass')
  })

  it('the persistence-error check is structural (source inspection), and never a system error on the real file', () => {
    expect(byId.get('stella-decision-persistence-error-non-leaking')?.outcome).toBe('pass')
  })

  // The append-only claim in stella-decision-rollback-append-only is checked
  // against "undone" only inside the harness; here it is checked directly
  // against the real schema for EVERY decision value, not just "undone" — a
  // mutation-target field must never be accepted regardless of which
  // decision it rides in on.
  it('the real schema rejects a client-supplied decisionId on every decision value', () => {
    for (const input of [DECISION_ACCEPTED_INPUT, DECISION_REJECTED_INPUT, DECISION_UNDONE_INPUT]) {
      expect(StellaDecisionInputSchema.safeParse({ ...input, decisionId: 'some-existing-row-id' }).success).toBe(false)
    }
  })

  it('the real schema accepts every documented decision value with its matching optional field', () => {
    expect(StellaDecisionInputSchema.safeParse(DECISION_ACCEPTED_INPUT).success).toBe(true)
    expect(StellaDecisionInputSchema.safeParse(DECISION_REJECTED_INPUT).success).toBe(true)
    expect(StellaDecisionInputSchema.safeParse(DECISION_UNDONE_INPUT).success).toBe(true)
  })
})

describe('fixture sanity (a vacuous fixture makes every isolation check vacuous)', () => {
  it('the two tenant markers are distinct', () => {
    expect(ISOLATION_MARKERS.alpha).not.toBe(ISOLATION_MARKERS.beta)
  })

  it('the two alpha projects really are different projects of the same organization', () => {
    expect(ALPHA_PROJECT_ONE_CHUNK.scope.organizationId).toBe(ALPHA_PROJECT_TWO_CHUNK.scope.organizationId)
    expect(ALPHA_PROJECT_ONE_CHUNK.scope.projectId).not.toBe(ALPHA_PROJECT_TWO_CHUNK.scope.projectId)
  })

  it('the contradictory chunks are distinct passages of the same project', () => {
    expect(CONTRADICTION_SIDE_A_CHUNK.chunkId).not.toBe(CONTRADICTION_SIDE_B_CHUNK.chunkId)
    expect(CONTRADICTION_SIDE_A_CHUNK.scope).toEqual(CONTRADICTION_SIDE_B_CHUNK.scope)
  })
})
