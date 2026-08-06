// tests/eval/stella-release/idempotency-release-gate.test.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 7.
// Offline: no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import { runIdempotencyEvalHarness } from './idempotency-harness'
import { evaluateIdempotencyReleaseGates, computeIdempotencyReleaseGateReport } from './idempotency-release-gate'

const RUN = runIdempotencyEvalHarness()

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

  it('runtime-quota-charged is FALSE with no report — this branch calls no real function', () => {
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/INT-INT-001/)
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

  it('would pass ONLY when the claim and the observed count agree on a real charge — proving the gate is not permanently unsatisfiable by construction', () => {
    const gates = evaluateIdempotencyReleaseGates(RUN, { claimedCharged: true, chargesObservedForTicket: 1 })
    const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed).toBe(true)
  })
})

describe('computeIdempotencyReleaseGateReport — idempotency-harness-ready vs local-runtime-ready', () => {
  it('idempotencyHarnessReady is TRUE from the 8 offline gates alone, with no runtime report', () => {
    const report = computeIdempotencyReleaseGateReport(RUN)
    expect(report.idempotencyHarnessReady).toBe(true)
    expect(report.missingForIdempotencyHarness).toEqual([])
  })

  it('missingForOperationTicketRuntime is always non-empty on this branch — runtime-quota-charged cannot be satisfied without a real package', () => {
    const report = computeIdempotencyReleaseGateReport(RUN)
    expect(report.missingForOperationTicketRuntime.length).toBeGreaterThan(0)
    expect(report.missingForOperationTicketRuntime.join(' ')).toMatch(/INT-INT-001/)
  })

  it('idempotencyHarnessReady stays TRUE even when a (real) runtime report is supplied and satisfies runtime-quota-charged — it never depends on that gate', () => {
    const report = computeIdempotencyReleaseGateReport(RUN, { claimedCharged: true, chargesObservedForTicket: 1 })
    expect(report.idempotencyHarnessReady).toBe(true)
    // The runtime gate itself is satisfied, but this module never claims
    // local-runtime-ready on that basis alone — see local-release-gate.ts,
    // which this module does not modify.
    expect(report.missingForOperationTicketRuntime.filter((r) => r.includes('no db/prepared')).length).toBe(1)
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
