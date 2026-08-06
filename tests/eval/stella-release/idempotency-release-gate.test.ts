// tests/eval/stella-release/idempotency-release-gate.test.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 7.
// Offline: no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import { runIdempotencyEvalHarness } from './idempotency-harness'
import { evaluateIdempotencyReleaseGates, computeIdempotencyReleaseGateReport } from './idempotency-release-gate'

const RUN = runIdempotencyEvalHarness()

/**
 * A runtime report with all nine Train 4.1 proofs satisfied.
 *
 * SYNTHETIC, and used only to show the gate is SATISFIABLE — that it is a
 * check rather than a permanent refusal. It is deliberately not evidence of
 * anything: the real report is built from measured ledger deltas by
 * `tests/e2e/stella-ticket-journey.e2e.test.ts`, which runs the real server
 * action against a real database. Nothing here may be read as a claim that a
 * runtime charged.
 */
const FULL_RUNTIME_REPORT = {
  claimedCharged: true,
  chargesObservedForTicket: 1,
  firstExecutionDelta: 1,
  retryDelta: 0,
  newOperationSameTextDelta: 1,
  abortDelta: 0,
  crossScopeDelta: 0,
  concurrencyLastUnitCharges: 1,
  postCompleteRetryCode: 'ALREADY_COMPLETED_RESULT_UNAVAILABLE',
  runtimeEventsEmitted: [
    'operation_ticket_issued',
    'operation_ticket_bound',
    'grounded_query_reserved',
    'grounded_query_completed',
    'quota_consumed',
  ],
  observabilityViolations: 0,
  residualResources: 0,
} as const

describe('evaluateIdempotencyReleaseGates — the 9 named gates', () => {
  const gates = evaluateIdempotencyReleaseGates(RUN)

  it('has exactly the 9 stable identifiers the dispatch requires, no duplicates', () => {
    const ids = gates.map((g) => g.id)
    expect(new Set(ids).size).toBe(9)
    expect(ids).toEqual([
      'operation-ticket-contract', 'retry-no-double-charge', 'same-query-new-operation', 'failure-no-charge',
      'cross-scope-ticket-rejected', 'client-cannot-select-idempotency', 'concurrency-last-unit',
      'ticket-observability-safe', 'runtime-quota-charged',
    ])
  })

  it('the 8 offline gates pass on the real, clean matrix', () => {
    const offline = gates.filter((g) => g.id !== 'runtime-quota-charged')
    const failing = offline.filter((g) => !g.passed)
    expect(failing.map((g) => `${g.id}: ${g.detail}`)).toEqual([])
  })

  it('runtime-quota-charged is FALSE with no report — an unmeasured runtime is never assumed to charge', () => {
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed).toBe(false)
    // Train 4.1: the detail no longer names INT-INT-001 as the blocker,
    // because that contract is closed. What it names now is the EVIDENCE that
    // is missing — which is the thing a reader has to go produce.
    expect(runtimeGate.detail).toMatch(/no runtime charge report provided/)
    expect(runtimeGate.detail).toMatch(/stella-ticket-e2e\.sh/)
  })

  it('every gate carries a non-trivial detail, never a bare boolean', () => {
    for (const gate of gates) expect(gate.detail.length).toBeGreaterThan(10)
  })
})

describe('runtime-quota-charged — fail-closed on a claim its own evidence contradicts (Fase 4, control #15)', () => {
  it('rejects a report that CLAIMS a charge with zero observed charge rows', () => {
    const gates = evaluateIdempotencyReleaseGates(RUN, { claimedCharged: true, chargesObservedForTicket: 0 })
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/contradicted by its own evidence/)
  })

  it('rejects a report that claims NO charge but shows an observed charge row (the symmetric lie)', () => {
    const gates = evaluateIdempotencyReleaseGates(RUN, { claimedCharged: false, chargesObservedForTicket: 1 })
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/contradicted by its own evidence/)
  })

  it('a coherent claim is NOT enough on its own — Train 4.1 also demands the nine measured deltas', () => {
    // The pre-4.1 report shape. It is coherent (claim agrees with count) and
    // it is still refused, because agreeing with yourself about one number
    // says nothing about retries, aborts, scope or concurrency.
    const gates = evaluateIdempotencyReleaseGates(RUN, { claimedCharged: true, chargesObservedForTicket: 1 })
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/required proofs did not hold/)
  })

  it('passes ONLY with all nine proofs — proving the gate is not unsatisfiable by construction', () => {
    const gates = evaluateIdempotencyReleaseGates(RUN, FULL_RUNTIME_REPORT)
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed, runtimeGate.detail).toBe(true)
  })
})

describe('computeIdempotencyReleaseGateReport — idempotency-harness-ready vs local-runtime-ready', () => {
  it('idempotencyHarnessReady is TRUE from the 8 offline gates alone, with no runtime report', () => {
    const report = computeIdempotencyReleaseGateReport(RUN)
    expect(report.idempotencyHarnessReady).toBe(true)
    expect(report.missingForIdempotencyHarness).toEqual([])
  })

  it('missingForOperationTicketRuntime is non-empty WITHOUT runtime evidence, and empty WITH it', () => {
    const without = computeIdempotencyReleaseGateReport(RUN)
    expect(without.missingForOperationTicketRuntime.length).toBeGreaterThan(0)

    // Train 4.1: the three entries that used to be unconditional are now
    // conditional on the runtime gate. A permanently non-empty list is
    // indistinguishable from a list nobody maintains.
    const withEvidence = computeIdempotencyReleaseGateReport(RUN, FULL_RUNTIME_REPORT)
    expect(withEvidence.missingForOperationTicketRuntime).toEqual([])
  })

  it('idempotencyHarnessReady stays TRUE whether or not a runtime report is supplied — it never depends on that gate', () => {
    const withEvidence = computeIdempotencyReleaseGateReport(RUN, FULL_RUNTIME_REPORT)
    expect(withEvidence.idempotencyHarnessReady).toBe(true)
    expect(computeIdempotencyReleaseGateReport(RUN).idempotencyHarnessReady).toBe(true)
  })

  it('idempotencyHarnessReady goes FALSE when a synthetic bad run breaks a case a specific gate reads', () => {
    const brokenResults = RUN.results.map((r) =>
      r.caseId === 'new-ticket-same-query-text-charges-again' ? { ...r, ok: false, detail: 'synthetic failure for this test' } : r,
    )
    const brokenRun = { ...RUN, results: brokenResults, summary: { ...RUN.summary, failed: RUN.summary.failed + 1, passed: RUN.summary.passed - 1 } }
    const report = computeIdempotencyReleaseGateReport(brokenRun)
    expect(report.idempotencyHarnessReady).toBe(false)
    expect(report.missingForIdempotencyHarness.join(' ')).toMatch(/same-query-new-operation/)
    expect(report.missingForIdempotencyHarness.join(' ')).toMatch(/operation-ticket-contract/)
  })
})
