// tests/eval/stella-release/project-binding-release-gate.test.ts
// RELEASE line — Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2), Fase 6/7.
// Offline: no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runProjectBindingEvalHarness } from './project-binding-harness'
import { evaluateProjectBindingGates, computeProjectBindingGateReport } from './project-binding-release-gate'

const RUN = runProjectBindingEvalHarness()

/**
 * A runtime report with all seven Fase 6 proofs satisfied.
 *
 * SYNTHETIC, and used only to show the gate is SATISFIABLE — that it is a
 * check rather than a permanent refusal. Not evidence of anything: a real
 * report would be built from a real disposable-database run — which, since
 * Train 4.2, EXISTS: tests/e2e/stella-ticket-journey.e2e.test.ts §19 builds one
 * against a live PostgreSQL with stella_0015 applied. Nothing HERE may be read
 * as a claim that a runtime rejects anything: this object is a literal, and the
 * distinction between a literal and a measurement is the whole reason the
 * runtime gate takes an external report instead of computing one.
 */
const FULL_RUNTIME_REPORT = {
  bindRejectedForeignProject: true,
  completeRejectedForeignProject: true,
  abortRejectedForeignProject: true,
  inspectRejectedForeignProject: true,
  chargeAttributedToExecutionProject: true,
  zeroChargeOnAttack: true,
  legacySignatureInvocable: false,
} as const

describe('evaluateProjectBindingGates — the 2 named gates', () => {
  const gates = evaluateProjectBindingGates(RUN)

  it('has exactly the 2 stable identifiers Fase 6 requires, no duplicates', () => {
    const ids = gates.map((g) => g.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual(['project-bound-ticket-attribution', 'runtime-project-attribution-verified'])
  })

  it('project-bound-ticket-attribution passes on the real, clean matrix', () => {
    const offline = gates.find((g) => g.id === 'project-bound-ticket-attribution')!
    expect(offline.passed, offline.detail).toBe(true)
  })

  it('runtime-project-attribution-verified is FALSE with no report — an unmeasured runtime is never assumed to reject', () => {
    const runtimeGate = gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/no runtime project-attribution report provided/)
    // TRAIN 4.2: the detail no longer defers to a future train — stella_0015 is
    // applied and the E2E asserts rejection. It now names the ONE thing that
    // can produce the report, which is the fact that survived.
    expect(runtimeGate.detail).toMatch(/scripts\/stella-ticket-e2e\.sh/)
  })

  it('every gate carries a non-trivial detail, never a bare boolean', () => {
    for (const gate of gates) expect(gate.detail.length).toBeGreaterThan(10)
  })
})

describe('runtime-project-attribution-verified — fails closed on a PARTIAL report (Fase 4 controls #1-4)', () => {
  it('rejects a report missing any one of the four *ForExecution rejection proofs', () => {
    const gates = evaluateProjectBindingGates(RUN, { ...FULL_RUNTIME_REPORT, bindRejectedForeignProject: false })
    const runtimeGate = gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/bind-rejects-foreign-project/)
  })

  it('rejects a report where the legacy (project-blind) signature is STILL invocable (Fase 4 control #5)', () => {
    const gates = evaluateProjectBindingGates(RUN, { ...FULL_RUNTIME_REPORT, legacySignatureInvocable: true })
    const runtimeGate = gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(runtimeGate.passed).toBe(false)
    expect(runtimeGate.detail).toMatch(/legacy-signatures-not-invocable/)
  })

  it('rejects a report claiming attribution is correct but the attack still produced a charge', () => {
    const gates = evaluateProjectBindingGates(RUN, { ...FULL_RUNTIME_REPORT, zeroChargeOnAttack: false })
    const runtimeGate = gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(runtimeGate.passed).toBe(false)
  })

  it('passes ONLY with all seven proofs — proving the gate is not unsatisfiable by construction', () => {
    const gates = evaluateProjectBindingGates(RUN, FULL_RUNTIME_REPORT)
    const runtimeGate = gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(runtimeGate.passed, runtimeGate.detail).toBe(true)
  })
})

describe('computeProjectBindingGateReport — projectBindingHarnessReady vs local-runtime-ready', () => {
  it('projectBindingHarnessReady is TRUE from the offline gate alone, with no runtime report', () => {
    const report = computeProjectBindingGateReport(RUN)
    expect(report.projectBindingHarnessReady).toBe(true)
    expect(report.missingForProjectBindingHarness).toEqual([])
  })

  it('missingForProjectBindingRuntime is non-empty without runtime evidence, and empty with it', () => {
    const without = computeProjectBindingGateReport(RUN)
    expect(without.missingForProjectBindingRuntime.length).toBeGreaterThan(0)
    // TRAIN 4.2. The anchor moved from `/train 5/` to the SCRIPT that produces
    // the report, because the work this list used to be waiting on is done:
    // stella_0015 is applied and the E2E case asserts rejection. What remains
    // true — and is what this reducer must keep saying — is that an OFFLINE
    // invocation observed nothing and therefore proves nothing.
    expect(without.missingForProjectBindingRuntime.join(' ')).toMatch(/scripts\/stella-ticket-e2e\.sh/)
    expect(without.missingForProjectBindingRuntime.join(' ')).toMatch(/stella-ticket-journey\.e2e\.test\.ts/)

    const withEvidence = computeProjectBindingGateReport(RUN, FULL_RUNTIME_REPORT)
    expect(withEvidence.missingForProjectBindingRuntime).toEqual([])
  })

  it('projectBindingHarnessReady goes FALSE when a synthetic bad run breaks a case the gate reads', () => {
    const brokenResults = RUN.results.map((r) =>
      r.caseId === 'charge-stored-under-correct-project' ? { ...r, ok: false, detail: 'synthetic failure for this test' } : r,
    )
    const brokenRun = { ...RUN, results: brokenResults, summary: { ...RUN.summary, failed: RUN.summary.failed + 1, passed: RUN.summary.passed - 1 } }
    const report = computeProjectBindingGateReport(brokenRun)
    expect(report.projectBindingHarnessReady).toBe(false)
    expect(report.missingForProjectBindingHarness.join(' ')).toMatch(/project-bound-ticket-attribution/)
  })
})

/* -------------------------------------------------------------------------- */
/* Fase 4 control #9 — "local-runtime-ready ignora R2-INT"                    */
/* -------------------------------------------------------------------------- */

const ROOT = path.join(__dirname, '..', '..', '..')
const readEval = (...segments: string[]) => readFileSync(path.join(__dirname, ...segments), 'utf8')

describe('control #9 — project-binding-harness-ready must never substitute for local-runtime-ready', () => {
  // -------------------------------------------------------------------------
  // RESTATED BY INTEGRATION, TRAIN 4.2 — the PROPERTY is unchanged and the
  // MEASUREMENT is now able to tell apart the two things it was conflating.
  //
  // As written on the RELEASE branch these two controls banned the STRING
  // `project-binding` and the string `idempotency-release-gate` from appearing
  // anywhere in local-release-gate.ts. That was a sound proxy while
  // `localRuntimeReady` could depend on nothing outside its own fixtures.
  //
  // It stopped being one the moment integration gave that level a way to be
  // satisfied by REAL evidence: `LocalRuntimeEvidence` carries, among ten other
  // measurements, the verdict of `runtime-project-attribution-verified` — a
  // gate that requires a live database, a real charge and a read-back of the
  // row. Naming that gate in a comment now trips a control aimed at something
  // else entirely.
  //
  // The danger the control exists to prevent is precise: `localRuntimeReady`
  // must not be liftable by an OFFLINE harness certifying itself. So the
  // assertions below are rewritten to forbid exactly that — an IMPORT of either
  // sibling module, or a read of either module's offline readiness boolean —
  // and a fourth is added that pins the positive property: no runtime evidence,
  // no local-runtime-ready. A textual ban would have been satisfied by a
  // module that imported nothing and hardcoded `localRuntimeReady = true`.
  // -------------------------------------------------------------------------
  it('local-release-gate.ts does not IMPORT this module, and never reads its offline readiness boolean', () => {
    const source = readEval('local-release-gate.ts')
    expect(source).not.toMatch(/from ['"]\.\/project-binding-release-gate['"]/)
    expect(source).not.toMatch(/from ['"]\.\/project-binding-harness['"]/)
    expect(source).not.toMatch(/projectBindingHarnessReady/)
    expect(source).not.toMatch(/runProjectBindingEvalHarness/)
  })

  it('local-release-gate.ts does not import idempotency-release-gate.ts either, nor read idempotencyHarnessReady — the same discipline Train 4.1 established, so a future edit cannot special-case ONE sibling gate into localRuntimeReady while leaving this one out', () => {
    const source = readEval('local-release-gate.ts')
    expect(source).not.toMatch(/from ['"]\.\/idempotency-release-gate['"]/)
    expect(source).not.toMatch(/from ['"]\.\/idempotency-harness['"]/)
    expect(source).not.toMatch(/idempotencyHarnessReady/)
    expect(source).not.toMatch(/runIdempotencyEvalHarness/)
  })

  it('localRuntimeReady is UNREACHABLE without runtime evidence — the positive half of the same property', () => {
    // The offline harness gates can all be green and this level still false.
    // Asserted over the reduction's own shape rather than by running it: the
    // two entries that used to be permanent strings are now produced by
    // `missingFromRuntimeEvidence`, whose no-report branch returns them
    // verbatim.
    const source = readEval('local-release-gate.ts')
    expect(source).toMatch(/function missingFromRuntimeEvidence\(/)
    expect(source).toMatch(/if \(!evidence\) \{\s*\n\s*return \[/)
    expect(source).toMatch(/localRuntimeReady = integrationReady && missingForLocalRuntime\.length === 0/)
    // And the evidence itself cannot be a single caller-supplied boolean.
    expect(source).toMatch(/interface LocalRuntimeEvidence/)
    expect(source).toMatch(/packageOrderGuardHeld/)
    expect(source).toMatch(/everyChargeAttributedToItsExecutionProject/)
  })

  it('this module does not import local-release-gate.ts either — the independence is not accidental in either direction', () => {
    // A prose MENTION in a comment (explaining what this module deliberately
    // does NOT do) is fine and expected; an actual import statement is not.
    const source = readEval('project-binding-release-gate.ts')
    expect(source).not.toMatch(/from ['"]\.\/local-release-gate['"]/)
  })

  it('STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2 declares project-binding-harness-ready=true and local-runtime-ready=false side by side in RELEASE.md, never one standing in for the other', () => {
    const release = readFileSync(path.join(ROOT, 'docs', 'ops', 'workstreams', 'RELEASE.md'), 'utf8')
    expect(release).toMatch(/project-binding-harness-ready=true/)
    expect(release).toMatch(/local-runtime-ready=false/)
  })
})
