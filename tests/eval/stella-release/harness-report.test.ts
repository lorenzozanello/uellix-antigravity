// tests/eval/stella-release/harness-report.test.ts
// RELEASE line — Train 4. Negative controls for the local-runtime-harness
// gate (Fase 6). Offline: constructs report objects in memory, no docker, no
// DB, no network. Each control proves the gate accepts the honest case and
// rejects EXACTLY the one mutation Fase 6 names — a gate that cannot reject
// a mutation proves nothing (same discipline as harness.ts's own
// withNegativeControls for the offline matrix).

import { describe, expect, it } from 'vitest'
import { evaluateLocalRuntimeHarnessReadiness, type LocalRuntimeHarnessReport } from './harness-report'

const GOOD_REPORT: LocalRuntimeHarnessReport = {
  containerNetworkMode: 'none',
  containerDestroyed: true,
  usedPersistentVolume: false,
  verificationMethod: 'live-database-execution',
  packagesApplied: ['grounding_0002', 'grounding_0003', 'stella_0003'],
  train4PackageStatus: 'not-yet-available',
  documentsIngestedViaRealPipeline: true,
  sqlFunctionsInvoked: ['register_document_version', 'insert_evidence_chunks', 'finalize_document_ingestion', 'chunks_in_scope'],
  databaseApplied: true,
  crossProjectRetrievalRejected: true,
  idempotentReapplyVerified: true,
  generatorKind: 'local-extractive-test-only',
  answerDerivedFromRetrieval: true,
  citationsValidatedAgainstRealChunks: true,
  citationValidationIssueCount: 0,
  contradictionAttributed: true,
  abstentionObserved: true,
  quotaConsumptionClaimed: false,
  quotaRoleExists: false,
  scopeAttestedViaJwtClaims: true,
  groundedQueryFlagState: 'enabled-in-process-only',
  providerCallCount: 0,
  observabilityEventsSanitized: true,
  observabilityEventViolationCount: 0,
  localDecisionRowCount: 0,
  decisionsPersistenceFlagState: 'disabled',
}

describe('evaluateLocalRuntimeHarnessReadiness — the honest case', () => {
  it('is ready with zero missing items on the good report', () => {
    const result = evaluateLocalRuntimeHarnessReadiness(GOOD_REPORT)
    expect(result.localRuntimeHarnessReady).toBe(true)
    expect(result.missingForLocalRuntimeHarness).toEqual([])
  })

  it('is not ready, with a specific reason, when no report was produced at all', () => {
    const result = evaluateLocalRuntimeHarnessReadiness(null)
    expect(result.localRuntimeHarnessReady).toBe(false)
    expect(result.missingForLocalRuntimeHarness.length).toBe(1)
    expect(result.missingForLocalRuntimeHarness[0]).toMatch(/no harness report provided/)
  })
})

function mutate(overrides: Partial<LocalRuntimeHarnessReport>): LocalRuntimeHarnessReport {
  return { ...GOOD_REPORT, ...overrides }
}

function expectRejected(report: LocalRuntimeHarnessReport, pattern: RegExp): void {
  const result = evaluateLocalRuntimeHarnessReadiness(report)
  expect(result.localRuntimeHarnessReady).toBe(false)
  expect(result.missingForLocalRuntimeHarness.some((item) => pattern.test(item))).toBe(true)
}

describe('evaluateLocalRuntimeHarnessReadiness — Fase 6 negative controls (each accepts the good case, rejects one mutation)', () => {
  it('rejects a preconstructed fixture used as if it were the real runtime', () => {
    expectRejected(mutate({ documentsIngestedViaRealPipeline: false }), /preconstructed fixture/)
  })

  it('rejects a report where the database stage was omitted', () => {
    expectRejected(mutate({ databaseApplied: false }), /database stage was skipped/)
  })

  it('rejects a report where the prepared SQL was never applied', () => {
    expectRejected(mutate({ packagesApplied: [] }), /required package 'grounding_0002' is not in packagesApplied/)
  })

  it('rejects a claim that quota was consumed when the DB-observed role does not exist (INT-CAP-001 is open)', () => {
    expectRejected(mutate({ quotaConsumptionClaimed: true, quotaRoleExists: false }), /quotaConsumptionClaimed is true but quotaRoleExists is false/)
  })

  it('rejects a report where cross-project scope was never checked', () => {
    expectRejected(mutate({ crossProjectRetrievalRejected: false }), /scope not checked/)
  })

  it('rejects a report carrying an invented (unvalidated) citation', () => {
    expectRejected(mutate({ citationValidationIssueCount: 1 }), /citation may be invented/)
  })

  it('rejects a hardcoded result that did not come from retrieval', () => {
    expectRejected(mutate({ answerDerivedFromRetrieval: false }), /not shown to emerge from a real retrieval call/)
  })

  it('rejects a mock generator standing in for the local extractive one', () => {
    expectRejected(mutate({ generatorKind: 'hardcoded-mock' }), /generatorKind is 'hardcoded-mock'/)
  })

  it('rejects the grounded-query flag being reported enabled globally', () => {
    expectRejected(mutate({ groundedQueryFlagState: 'enabled-globally' }), /must never be turned on outside this harness/)
  })

  it('rejects any provider call at all', () => {
    expectRejected(mutate({ providerCallCount: 1 }), /providerCallCount is 1/)
  })

  it('rejects an observability event that failed the sensitive-field contract', () => {
    expectRejected(mutate({ observabilityEventViolationCount: 1 }), /not shown clean of sensitive fields/)
  })

  it('rejects a container that was never confirmed destroyed (persistence)', () => {
    expectRejected(mutate({ containerDestroyed: false }), /not confirmed torn down/)
  })

  it('rejects a container that kept network access instead of --network none', () => {
    expectRejected(mutate({ containerNetworkMode: 'bridge' }), /containerNetworkMode is 'bridge'/)
  })

  it('rejects a persistent volume', () => {
    expectRejected(mutate({ usedPersistentVolume: true }), /usedPersistentVolume is true/)
  })

  it('rejects a "test" that only inspected files on disk rather than executing anything', () => {
    expectRejected(mutate({ verificationMethod: 'file-existence-only' }), /proves existence, not a real run/)
  })

  it('rejects a local decision that was actually persisted while the flag is disabled', () => {
    expectRejected(mutate({ localDecisionRowCount: 1 }), /must never be written to the database/)
  })

  it('rejects the decisions-persistence flag being reported enabled', () => {
    expectRejected(mutate({ decisionsPersistenceFlagState: 'enabled' }), /must stay disabled/)
  })

  it('rejects missing SQL function invocations one at a time', () => {
    for (const fn of ['register_document_version', 'insert_evidence_chunks', 'finalize_document_ingestion', 'chunks_in_scope']) {
      const withoutFn = GOOD_REPORT.sqlFunctionsInvoked.filter((name) => name !== fn)
      expectRejected(mutate({ sqlFunctionsInvoked: withoutFn }), new RegExp(`required SQL function '${fn}' was not invoked`))
    }
  })

  it('rejects a report that never proved idempotency', () => {
    expectRejected(mutate({ idempotentReapplyVerified: false }), /not proven idempotent/)
  })

  it('rejects a report where the fixture contradiction was never attributed', () => {
    expectRejected(mutate({ contradictionAttributed: false }), /never shown attributed to both sides|not shown attributed to both sides/)
  })

  it('rejects a report where abstention was never observed', () => {
    expectRejected(mutate({ abstentionObserved: false }), /not shown to abstain/)
  })

  it('rejects a report that never attested scope via a real authenticated session', () => {
    expectRejected(mutate({ scopeAttestedViaJwtClaims: false }), /not shown to run under a real authenticated session/)
  })
})
