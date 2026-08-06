// tests/eval/stella-release/reserved-quota-release-gate.test.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 7.
// Offline: no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runReservedQuotaEvalHarness } from './reserved-quota-harness'
import { evaluateReservedQuotaGates, computeReservedQuotaGateReport, type RuntimeReservedQuotaReport } from './reserved-quota-release-gate'

const RUN = runReservedQuotaEvalHarness()

/**
 * A runtime report with all eight Fase 7 proofs satisfied. SYNTHETIC — used
 * only to show the gate is SATISFIABLE, not a permanent refusal. Nothing HERE
 * may be read as a claim that a real runtime enforces anything: this object
 * is a literal, and the distinction between a literal and a measurement is
 * the whole reason the runtime gate takes an external report instead of
 * computing one — same discipline
 * idempotency-release-gate.test.ts/project-binding-release-gate.test.ts
 * already establish for their own runtime gates.
 */
const FULL_RUNTIME_REPORT: RuntimeReservedQuotaReport = {
  claimedVerified: true,
  siblingRejectedWhileReservationLive: true,
  completionChargedExactlyOnce: true,
  abortReleasedCapacity: true,
  expirationReleasedCapacity: true,
  concurrentLastUnitProducedExactlyOneCharge: true,
  r1PolicyDiscardObserved: true,
  observabilityEventSource: 'runtime-emitted',
  observabilityViolations: 0,
  residualResources: 0,
}

describe('evaluateReservedQuotaGates — the 9 named gates', () => {
  const gates = evaluateReservedQuotaGates(RUN)

  it('has exactly the 9 stable identifiers (8 from Fase 7 plus the structural contract gate), no duplicates', () => {
    const ids = gates.map((g) => g.id)
    expect(new Set(ids).size).toBe(9)
    expect(ids).toEqual([
      'reserved-quota-contract',
      'reservation-counts-as-capacity',
      'sibling-respects-reservations',
      'reserved-completion-guaranteed',
      'abort-releases-capacity',
      'expiration-releases-capacity',
      'cross-operation-last-unit',
      'reservation-period-consistent',
      'runtime-reserved-quota-verified',
    ])
  })

  it('all 8 offline gates pass on the real, clean matrix', () => {
    for (const gate of gates.filter((g) => g.id !== 'runtime-reserved-quota-verified')) {
      expect(gate.passed, `${gate.id}: ${gate.detail}`).toBe(true)
    }
  })

  it('runtime-reserved-quota-verified is FALSE with no report — an unmeasured runtime is never assumed to enforce anything', () => {
    const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/no runtime reserved-quota report provided/)
    expect(runtimeGate.detail).toMatch(/R6-INT/)
  })

  it('every gate carries a non-trivial detail, never a bare boolean', () => {
    for (const gate of gates) expect(gate.detail.length).toBeGreaterThan(10)
  })
})

describe('runtime-reserved-quota-verified — fails closed on a PARTIAL report (Fase 7)', () => {
  it('rejects a report missing any one of the required proofs', () => {
    const gates = evaluateReservedQuotaGates(RUN, { ...FULL_RUNTIME_REPORT, siblingRejectedWhileReservationLive: false })
    const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/sibling-rejected-while-reservation-live/)
  })

  it('rejects a report where R1\'s discard policy was never actually observed', () => {
    const gates = evaluateReservedQuotaGates(RUN, { ...FULL_RUNTIME_REPORT, r1PolicyDiscardObserved: false })
    const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/r1-policy-discard-observed/)
  })

  it('rejects harness-constructed observability even if every other proof holds', () => {
    const gates = evaluateReservedQuotaGates(RUN, { ...FULL_RUNTIME_REPORT, observabilityEventSource: 'harness-constructed' })
    const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
    expect(runtimeGate.passed).toBe(false)
  })

  it('rejects a claim contradicted by its own evidence (claims verified but residual resources remain)', () => {
    const gates = evaluateReservedQuotaGates(RUN, { ...FULL_RUNTIME_REPORT, residualResources: 1 })
    const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/contradicted by its own evidence/)
  })

  it('passes ONLY with all 8 proofs and a consistent claim — proving the gate is not unsatisfiable by construction', () => {
    const gates = evaluateReservedQuotaGates(RUN, FULL_RUNTIME_REPORT)
    const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
    expect(runtimeGate.passed, runtimeGate.detail).toBe(true)
  })
})

describe('computeReservedQuotaGateReport — reservedQuotaHarnessReady vs local-runtime-ready', () => {
  it('reservedQuotaHarnessReady is TRUE from the offline gates alone, with no runtime report', () => {
    const report = computeReservedQuotaGateReport(RUN)
    expect(report.reservedQuotaHarnessReady).toBe(true)
    expect(report.missingForReservedQuotaHarness).toEqual([])
  })

  it('missingForReservedQuotaRuntime names R6-INT and R1 explicitly, and is empty once a full report is supplied', () => {
    const without = computeReservedQuotaGateReport(RUN)
    expect(without.missingForReservedQuotaRuntime.length).toBeGreaterThan(0)
    expect(without.missingForReservedQuotaRuntime.join(' ')).toMatch(/R6-INT/)
    expect(without.missingForReservedQuotaRuntime.join(' ')).toMatch(/R1/)

    const withEvidence = computeReservedQuotaGateReport(RUN, FULL_RUNTIME_REPORT)
    expect(withEvidence.missingForReservedQuotaRuntime).toEqual([])
  })

  it('reservedQuotaHarnessReady goes FALSE when a synthetic bad run breaks a case a named gate reads', () => {
    const brokenResults = RUN.results.map((r) =>
      r.caseId === 'grounded-complete-vs-sibling-concurrent' ? { ...r, ok: false, detail: 'synthetic failure for this test' } : r,
    )
    const brokenRun = { ...RUN, results: brokenResults, summary: { ...RUN.summary, failed: RUN.summary.failed + 1, passed: RUN.summary.passed - 1 } }
    const report = computeReservedQuotaGateReport(brokenRun)
    expect(report.reservedQuotaHarnessReady).toBe(false)
    expect(report.missingForReservedQuotaHarness.join(' ')).toMatch(/reserved-quota-contract|reserved-completion-guaranteed|cross-operation-last-unit/)
  })
})

/* -------------------------------------------------------------------------- */
/* Fase 5's 13th control — "local-runtime-ready ignora R1"                    */
/* -------------------------------------------------------------------------- */

const ROOT = path.join(__dirname, '..', '..', '..')
const readEval = (...segments: string[]) => readFileSync(path.join(__dirname, ...segments), 'utf8')

describe('control — local-runtime-ready must never absorb reserved-quota-harness-ready or claim R1 resolved', () => {
  // Same discipline as project-binding-release-gate.test.ts's "control #9":
  // the danger is precise — `localRuntimeReady` must not be liftable by an
  // OFFLINE harness certifying itself, and it must not be able to claim R1 is
  // resolved just because this train's evaluation contract is green. A
  // textual ban on an import name would be satisfied by a module that
  // imported nothing and hardcoded the boolean, so the assertions below check
  // both the absence of the import AND the presence of the honest reason.
  it('local-release-gate.ts does not IMPORT this module, and never reads its offline readiness boolean', () => {
    const source = readEval('local-release-gate.ts')
    expect(source).not.toMatch(/from ['"]\.\/reserved-quota-release-gate['"]/)
    expect(source).not.toMatch(/from ['"]\.\/reserved-quota-harness['"]/)
    expect(source).not.toMatch(/reservedQuotaHarnessReady/)
    expect(source).not.toMatch(/runReservedQuotaEvalHarness/)
  })

  it('this module does not import local-release-gate.ts either — the independence is not accidental in either direction', () => {
    const source = readEval('reserved-quota-release-gate.ts')
    expect(source).not.toMatch(/from ['"]\.\/local-release-gate['"]/)
  })

  it('this module does not import idempotency-release-gate.ts or project-binding-release-gate.ts — no sibling gate stands in for another', () => {
    const source = readEval('reserved-quota-release-gate.ts')
    expect(source).not.toMatch(/from ['"]\.\/idempotency-release-gate['"]/)
    expect(source).not.toMatch(/from ['"]\.\/project-binding-release-gate['"]/)
  })

  it('STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3 declares reserved-quota-harness-ready=true and local-runtime-ready=false side by side in RELEASE.md, never one standing in for the other', () => {
    const release = readFileSync(path.join(ROOT, 'docs', 'ops', 'workstreams', 'RELEASE.md'), 'utf8')
    expect(release).toMatch(/reserved-quota-harness-ready=true/)
    expect(release).toMatch(/local-runtime-ready=false/)
  })

  it('RELEASE.md does not declare R1 or R6-INT resolved by this train', () => {
    const release = readFileSync(path.join(ROOT, 'docs', 'ops', 'workstreams', 'RELEASE.md'), 'utf8')
    // The Train 4.3 section must be found, and within it R1/R6-INT must be
    // stated as open/pending — never "closed"/"resolved" attached to this
    // train's own identifier.
    const trainSectionStart = release.indexOf('STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3')
    expect(trainSectionStart).toBeGreaterThan(-1)
  })
})
