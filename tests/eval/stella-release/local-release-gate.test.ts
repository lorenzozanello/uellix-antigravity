// tests/eval/stella-release/local-release-gate.test.ts
// RELEASE line — tests for the local Stella release gate
// (STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3, Fases 3 and 5). Offline:
// no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import { runReleaseEvalHarness, type ReleaseEvalRun, type ReleaseCaseResult } from './harness'
import {
  evaluateLocalReleaseGates,
  computeLocalReleaseGateReport,
  runtimeEntrypointMountReasons,
} from './local-release-gate'
import type { LocalRuntimeHarnessReport } from './harness-report'
import type { LocalRuntimeEvidence } from './local-release-gate'

const CLEAN_RUN_1 = runReleaseEvalHarness()
const CLEAN_RUN_2 = runReleaseEvalHarness()

describe('evaluateLocalReleaseGates — the 11 named gates on a real, clean run', () => {
  const gates = evaluateLocalReleaseGates(CLEAN_RUN_1, CLEAN_RUN_2)

  it('has exactly 12 gates — the 11 of Fase 3 plus the train-3 runtime entrypoint — by name, no duplicates', () => {
    // INTEGRATION, TRAIN 3. The eleven Fase-3 gates all read the harness's own
    // output over its own fixtures, and all eleven passed throughout train 2,
    // when no server action existed and `components/stella/**` had zero call
    // sites. A twelfth gate was added that asks a question the fixtures cannot
    // answer — see runtimeEntrypointGate. The count is DERIVED here, not
    // assumed: it is asserted against the enumerated names below.
    const ids = gates.map((g) => g.id)
    expect(new Set(ids).size).toBe(12)
    expect(ids).toEqual(expect.arrayContaining([
      'contract-complete', 'isolation', 'citation-validity', 'unsupported-claims', 'abstention-correctness',
      'contradiction-attribution', 'feature-flag-safety', 'decision-provenance', 'no-provider-calls',
      'no-secrets', 'determinism', 'runtime-entrypoint',
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

  it('is library-ready and integration-ready on the real, clean matrix, and DEGRADES local-runtime-ready', () => {
    // INTEGRATION, TRAIN 3 — the assertion this test used to make
    // (`localRuntimeReady === true`) was true for a system nothing could
    // reach. The grounded-query seam now exists end to end, but it is
    // UNMOUNTED and the two grounding SQL packages are applied to no database,
    // so "a human can run this journey locally" is still false — and saying so
    // is the point of the level.
    expect(report.libraryReady).toBe(true)
    expect(report.integrationReady).toBe(true)
    expect(report.localRuntimeReady).toBe(false)
  })

  it('says exactly WHY local-runtime is not ready — never a bare false', () => {
    expect(report.missingForLocalRuntime.length).toBeGreaterThan(0)
    const joined = report.missingForLocalRuntime.join(' ')
    // The persistence the seam reads is prepared but unapplied — permanently
    // unverifiable from an offline gate, and stated as such.
    expect(joined).toMatch(/grounding_0003_evidence_chunks\.sql/)
    expect(joined).toMatch(/applied to NO database/)
    // ...and the enforced quota still cannot be charged. TRAIN 4 changed the
    // REASON, not the fact: INT-CAP-001 is closed (stella_0013 installs
    // consume_stella_quota) and INT-INT-001 replaced it (that function needs
    // an idempotency key with no canonical server-side source).
    expect(joined).toMatch(/quota is enforced but not consumed/)
    expect(joined).toMatch(/INT-INT-001/)
    expect(joined).not.toMatch(/INT-CAP-001/)
  })

  it('no longer lists the seam as unmounted — train 4 mounted it', () => {
    // The mirror of the assertion above, and the reason it is a SEPARATE test:
    // "the reason disappeared" is a different claim from "a reason is
    // present", and collapsing them would let a future refactor that breaks
    // `runtimeEntrypointMountReasons` read as a mount.
    const joined = report.missingForLocalRuntime.join(' ')
    expect(joined).not.toMatch(/IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE/)
    expect(joined).not.toMatch(/no page\.tsx under app\/ renders/)
    // And the check itself still works — it is returning nothing because the
    // tree changed, not because it was deleted.
    expect(runtimeEntrypointMountReasons(process.cwd())).toEqual([])
  })

  it('no longer claims there is no generator — train 4 selected the extractive one', () => {
    expect(report.missingForLocalRuntime.join(' ')).not.toMatch(/no grounded-answer generator exists/)
  })

  it('does NOT list a missing entrypoint MODULE — the seam itself exists on disk', () => {
    // The distinction that matters: EXISTENCE is satisfied (the gate passes),
    // REACHABILITY is not. Collapsing the two would let a future edit delete
    // the server action and keep the same report.
    const runtimeGate = report.gates.find((g) => g.id === 'runtime-entrypoint')
    expect(runtimeGate?.passed).toBe(true)
    expect(report.missingForLocalRuntime.join(' ')).not.toMatch(/missing: app\/actions\/stella\/grounded-query\.ts/)
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

  it('staging/hosted stay blocked even when every harness gate is clean', () => {
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2)
    // Every one of the twelve gates passes, and local-runtime is STILL not
    // ready — because readiness depends on reachability and on applied
    // persistence, neither of which a gate over fixtures can grant.
    expect(report.gates.filter((g) => !g.passed)).toEqual([])
    expect(report.localRuntimeReady).toBe(false)
    expect(report.stagingBlocked).toBe(true)
    expect(report.hostedBlocked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TRAIN 4 — localRuntimeHarnessReady. This module still opens zero SQL
// connections itself (see the file header); everything below feeds a
// SYNTHETIC harness report through the same reduction the real
// scripts/stella-release-e2e-dry-run.sh output goes through.
// ---------------------------------------------------------------------------
const GOOD_HARNESS_REPORT: LocalRuntimeHarnessReport = {
  containerNetworkMode: 'none',
  containerDestroyed: true,
  usedPersistentVolume: false,
  verificationMethod: 'live-database-execution',
  packagesApplied: ['grounding_0002', 'grounding_0003', 'stella_0013', 'grounding_0004'],
  train4PackageStatus: 'applied',
  documentsIngestedViaRealPipeline: true,
  sqlFunctionsInvoked: ['register_document_version', 'insert_evidence_chunks', 'finalize_document_ingestion', 'chunks_in_scope_attested'],
  databaseApplied: true,
  crossProjectRetrievalRejected: true,
  idempotentReapplyVerified: true,
  generatorKind: 'local-extractive-test-only',
  answerDerivedFromRetrieval: true,
  citationsValidatedAgainstRealChunks: true,
  citationValidationIssueCount: 0,
  contradictionAttributed: true,
  abstentionObserved: true,
  scopeAttestationVerified: true,
  quotaConsumptionClaimed: false,
  quotaRoleExists: true,
  quotaChargedByRuntime: true,
  scopeAttestedViaJwtClaims: true,
  groundedQueryFlagState: 'enabled-in-process-only',
  providerCallCount: 0,
  observabilityEventsSanitized: true,
  observabilityEventSource: 'runtime-emitted',
  observabilityEventViolationCount: 0,
  localDecisionRowCount: 0,
  decisionsPersistenceFlagState: 'disabled',
}

describe('computeLocalReleaseGateReport — TRAIN 4 localRuntimeHarnessReady', () => {
  it('defaults to NOT ready when no harness report is supplied — matches every CI run of pnpm test:stella:release-eval', () => {
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2)
    expect(report.localRuntimeHarnessReady).toBe(false)
    expect(report.missingForLocalRuntimeHarness.length).toBeGreaterThan(0)
    expect(report.missingForLocalRuntimeHarness[0]).toMatch(/no harness report provided/)
  })

  it('is ready when a real, clean harness report is supplied — and this does NOT change localRuntimeReady', () => {
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2, process.cwd(), GOOD_HARNESS_REPORT)
    expect(report.localRuntimeHarnessReady).toBe(true)
    expect(report.missingForLocalRuntimeHarness).toEqual([])
    // The two readiness levels are DELIBERATELY independent — see the
    // localRuntimeHarnessReady doc comment in local-release-gate.ts. A real
    // disposable-DB run proves the persistence/retrieval layer works; it does
    // not mount the seam, apply the packages to a real database this train's
    // scope can touch, or close INT-CAP-001.
    expect(report.localRuntimeReady).toBe(false)
  })

  it('is not ready, with the specific reason, when the harness report itself reports a gap', () => {
    const broken: LocalRuntimeHarnessReport = { ...GOOD_HARNESS_REPORT, providerCallCount: 1 }
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2, process.cwd(), broken)
    expect(report.localRuntimeHarnessReady).toBe(false)
    expect(report.missingForLocalRuntimeHarness.some((item) => item.includes('providerCallCount is 1'))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* TRAIN 4.2 — LocalRuntimeEvidence, field by field                           */
/* -------------------------------------------------------------------------- */
//
// The negative controls for the ONE thing that can lift `local-runtime-ready`.
//
// ADVERSARIAL REVIEW B (Train 4.2) raised the gap these close as MAJOR: the
// E2E's `everyChargeAttributedToItsExecutionProject` was computed by a
// near-tautological predicate, and NOTHING pinned the reducer's dependence on
// it — so a future edit could weaken that field and leave it "silently
// vouching for nothing". The E2E's computation was rewritten to compare each
// charge row against the project ITS OWN execution ran under, across more than
// one project; these tests are the other half, and they belong here because
// this is the module that decides what the field is worth.
//
// Every one of the eleven fields is mutated independently. A field the reducer
// ignores is a field a run can lie about for free.

const GOOD_RUNTIME_EVIDENCE: LocalRuntimeEvidence = {
  packagesApplied: [
    'grounding_0002_document_versions',
    'grounding_0003_evidence_chunks',
    'grounding_0004_runtime_attestation',
    'stella_0013_grounded_query_quota',
    'stella_0014_operation_tickets',
    'stella_0015_project_bound_operation_tickets',
  ],
  runtimeQuotaChargedGatePassed: true,
  projectAttributionGatePassed: true,
  chargeRowsObserved: 3,
  everyChargeAttributedToItsExecutionProject: true,
  zeroCrossProjectCharges: true,
  concurrencyAttributionHeld: true,
  packageOrderGuardHeld: true,
  observabilityViolations: 0,
  providerCalls: 0,
  residualResources: 0,
}

describe('computeLocalReleaseGateReport — TRAIN 4.2 runtime evidence', () => {
  it('with clean runtime evidence the level is READY, and says nothing is missing', () => {
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2, process.cwd(), null, GOOD_RUNTIME_EVIDENCE)
    expect(report.missingForLocalRuntime, 'never a bare false').toEqual([])
    expect(report.localRuntimeReady).toBe(true)
  })

  it('is reachable ONLY that way — the same call without evidence stays false, with the same two reasons as before Train 4.2', () => {
    const offline = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2)
    expect(offline.localRuntimeReady).toBe(false)
    const joined = offline.missingForLocalRuntime.join(' ')
    expect(joined).toMatch(/applied to NO database/)
    expect(joined).toMatch(/quota is enforced but not consumed/)
  })

  it('staging and hosted stay blocked no matter how clean the runtime evidence is', () => {
    const report = computeLocalReleaseGateReport(CLEAN_RUN_1, CLEAN_RUN_2, process.cwd(), null, GOOD_RUNTIME_EVIDENCE)
    expect(report.stagingBlocked).toBe(true)
    expect(report.hostedBlocked).toBe(true)
    expect(report.missingForStaging.length).toBeGreaterThan(0)
    expect(report.missingForHosted.length).toBeGreaterThan(0)
  })

  it('every field is load-bearing: mutating any one of them alone blocks the level', () => {
    const mutations: Array<[string, Partial<LocalRuntimeEvidence>, RegExp]> = [
      ['a required package was not applied', { packagesApplied: ['grounding_0002', 'stella_0013'] }, /stella_0015/],
      ['runtime-quota-charged did not pass', { runtimeQuotaChargedGatePassed: false }, /runtime-quota-charged/],
      ['project attribution did not pass', { projectAttributionGatePassed: false }, /runtime-project-attribution-verified/],
      ['the run charged nothing at all', { chargeRowsObserved: 0 }, /chargeRowsObserved is 0/],
      // THE FIELD ADVERSARIAL REVIEW B FOUND VOUCHING FOR NOTHING.
      ['a charge landed under another project', { everyChargeAttributedToItsExecutionProject: false }, /other than the one its execution ran under/],
      ['a cross-project execution charged', { zeroCrossProjectCharges: false }, /cross-project or cross-organization/],
      ['a race charged twice or charged the loser', { concurrencyAttributionHeld: false }, /concurrent race/],
      ['the package-order guard did not hold', { packageOrderGuardHeld: false }, /package-order guard/],
      ['an event violated the observability contract', { observabilityViolations: 2 }, /2 runtime event/],
      ['a provider was called', { providerCalls: 1 }, /providerCalls is 1/],
      ['teardown left something behind', { residualResources: 1 }, /survived teardown/],
    ]

    for (const [label, mutation, reason] of mutations) {
      const report = computeLocalReleaseGateReport(
        CLEAN_RUN_1,
        CLEAN_RUN_2,
        process.cwd(),
        null,
        { ...GOOD_RUNTIME_EVIDENCE, ...mutation },
      )
      expect(report.localRuntimeReady, `the level was granted to a run where ${label}`).toBe(false)
      expect(report.missingForLocalRuntime.join(' '), `no reason named for: ${label}`).toMatch(reason)
    }
  })
})
