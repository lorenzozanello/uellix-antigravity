// tests/eval/stella-release/local-release-gate.test.ts
// RELEASE line — tests for the local Stella release gate
// (STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3, Fases 3 and 5). Offline:
// no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import { runReleaseEvalHarness, type ReleaseEvalRun, type ReleaseCaseResult } from './harness'
import { evaluateLocalReleaseGates, computeLocalReleaseGateReport } from './local-release-gate'

const CLEAN_RUN_1 = runReleaseEvalHarness()
const CLEAN_RUN_2 = runReleaseEvalHarness()

describe('evaluateLocalReleaseGates — the 11 named gates on a real, clean run', () => {
  const gates = evaluateLocalReleaseGates(CLEAN_RUN_1, CLEAN_RUN_2)

  it('has exactly 11 gates, matching Fase 3 by name, no duplicates', () => {
    const ids = gates.map((g) => g.id)
    expect(new Set(ids).size).toBe(11)
    expect(ids).toEqual(expect.arrayContaining([
      'contract-complete', 'isolation', 'citation-validity', 'unsupported-claims', 'abstention-correctness',
      'contradiction-attribution', 'feature-flag-safety', 'decision-provenance', 'no-provider-calls',
      'no-secrets', 'determinism',
    ]))
  })

  it('every gate passes on a real, clean run of the actual matrix', () => {
    const failing = gates.filter((g) => !g.passed)
    expect(failing.map((g) => `${g.id}: ${g.detail}`)).toEqual([])
  })

  it('every gate carries a non-trivial detail, never a bare boolean', () => {
    for (const gate of gates) expect(gate.detail.length).toBeGreaterThan(10)
  })
})

describe('computeLocalReleaseGateReport — reduction to the 5 readiness levels', () => {
  const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2)

  it('is library-ready, integration-ready and local-runtime-ready on the real, clean matrix', () => {
    expect(report.libraryReady).toBe(true)
    expect(report.integrationReady).toBe(true)
    expect(report.localRuntimeReady).toBe(true)
  })

  it('is UNCONDITIONALLY staging-blocked and hosted-blocked, regardless of how clean the run is', () => {
    expect(report.stagingBlocked).toBe(true)
    expect(report.hostedBlocked).toBe(true)
  })

  it('lists specific, non-empty missing evidence for staging — never a bare "blocked"', () => {
    expect(report.missingForStaging.length).toBeGreaterThan(0)
    expect(report.missingForStaging.join(' ')).toMatch(/STELLA_DECISIONS_PERSISTENCE_ENABLED/)
    expect(report.missingForStaging.join(' ')).toMatch(/gate G2/)
  })

  it('hosted evidence gaps are a strict superset of staging\'s, plus the human-gated items', () => {
    for (const item of report.missingForStaging) expect(report.missingForHosted).toContain(item)
    expect(report.missingForHosted.join(' ')).toMatch(/gate G1/)
    expect(report.missingForHosted.join(' ')).toMatch(/gate G4/)
    expect(report.missingForHosted.join(' ')).toMatch(/gate G7/)
    expect(report.missingForHosted.join(' ')).toMatch(/RR-CAP-14-A/)
  })

  it('names the prepared-but-not-applied decisions persistence package by its real path', () => {
    expect(report.missingForStaging.join(' ')).toMatch(/db\/prepared\/stella_0003_suggestion_decisions\.sql/)
  })
})

// ---------------------------------------------------------------------------
// Synthetic runs — proving the REDUCTION logic discriminates, the same
// obligation every check in harness.ts already carries (a boolean that cannot
// go false proves nothing). These construct a fake ReleaseEvalRun directly
// rather than mutating the real matrix, mirroring the `mutate()` pattern in
// harness.test.ts's failure-gates block.
// ---------------------------------------------------------------------------
function fakeResult(overrides: Partial<ReleaseCaseResult>): ReleaseCaseResult {
  return { checkId: 'x', fixtureId: 'x', ok: true, outcome: 'pass', detail: 'x', negativeControls: [], ...overrides }
}

function fakeRun(overrides: Partial<ReleaseEvalRun['summary']>, resultOverrides: ReleaseCaseResult[] = []): ReleaseEvalRun {
  const base = CLEAN_RUN_1
  return {
    summary: { ...base.summary, ...overrides },
    results: resultOverrides.length > 0 ? [...base.results.filter((r) => !resultOverrides.some((o) => o.checkId === r.checkId)), ...resultOverrides] : base.results,
    observations: base.observations,
  }
}

describe('evaluateLocalReleaseGates — discriminates on a broken synthetic run', () => {
  it('isolation gate fails when isolationViolations > 0', () => {
    const broken = fakeRun({ isolationViolations: 1 })
    const gates = evaluateLocalReleaseGates(broken, broken)
    expect(gates.find((g) => g.id === 'isolation')?.passed).toBe(false)
  })

  it('no-provider-calls gate fails when providerCalls !== 0', () => {
    const broken = fakeRun({ providerCalls: 1 })
    const gates = evaluateLocalReleaseGates(broken, broken)
    expect(gates.find((g) => g.id === 'no-provider-calls')?.passed).toBe(false)
  })

  it('feature-flag-safety gate fails when that specific check did not pass', () => {
    const broken = fakeRun({}, [fakeResult({ checkId: 'stella-decision-feature-flag-blocks-persistence', ok: false, outcome: 'system-error' })])
    const gates = evaluateLocalReleaseGates(broken, broken)
    expect(gates.find((g) => g.id === 'feature-flag-safety')?.passed).toBe(false)
  })

  it('decision-provenance gate fails when any ONE of its 4 checks did not pass', () => {
    const broken = fakeRun({}, [fakeResult({ checkId: 'stella-decision-rollback-append-only', ok: false, outcome: 'system-error' })])
    const gates = evaluateLocalReleaseGates(broken, broken)
    expect(gates.find((g) => g.id === 'decision-provenance')?.passed).toBe(false)
  })

  it('determinism gate fails when two runs disagree', () => {
    const first = CLEAN_RUN_1
    const second = fakeRun({ passed: CLEAN_RUN_1.summary.passed - 1, failed: CLEAN_RUN_1.summary.failed + 1 })
    const gates = evaluateLocalReleaseGates(first, second)
    expect(gates.find((g) => g.id === 'determinism')?.passed).toBe(false)
  })
})

describe('computeLocalReleaseGateReport — readiness levels discriminate on a broken synthetic run', () => {
  it('local-runtime-ready is false when a single non-structural gate fails, even though library/integration-ready can stay true', () => {
    const broken = fakeRun({ isolationViolations: 1 })
    const report = computeLocalReleaseGateReport(broken, broken)
    expect(report.localRuntimeReady).toBe(false)
    // isolation is not part of library/integration-ready's own criteria, so
    // those two stay true — the reduction is a strict hierarchy, not a single
    // flat boolean.
    expect(report.libraryReady).toBe(true)
    expect(report.integrationReady).toBe(true)
  })

  it('integration-ready (and therefore local-runtime-ready) is false when a provider call is made', () => {
    const broken = fakeRun({ providerCalls: 1 })
    const report = computeLocalReleaseGateReport(broken, broken)
    expect(report.integrationReady).toBe(false)
    expect(report.localRuntimeReady).toBe(false)
  })

  it('library-ready (and everything above it) is false when a check is tautological', () => {
    const broken = fakeRun({ tautologicalChecks: ['some-check'] })
    const report = computeLocalReleaseGateReport(broken, broken)
    expect(report.libraryReady).toBe(false)
    expect(report.integrationReady).toBe(false)
    expect(report.localRuntimeReady).toBe(false)
  })

  it('staging/hosted stay blocked even when every other gate is clean', () => {
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2)
    expect(report.localRuntimeReady).toBe(true)
    expect(report.stagingBlocked).toBe(true)
    expect(report.hostedBlocked).toBe(true)
  })
})
