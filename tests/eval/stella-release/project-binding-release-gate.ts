// tests/eval/stella-release/project-binding-release-gate.ts
// RELEASE line — Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2), Fase 6.
//
// TWO stable gate identifiers, reduced from project-binding-harness.ts's own
// run output — same discipline as idempotency-release-gate.ts: every gate
// here READS the harness's own output, none re-derives a property the
// harness already measured.
//
// `project-bound-ticket-attribution` is computable purely offline, from the
// reference-model harness — it is the ONE stable identifier Fase 6 requires.
// `runtime-project-attribution-verified` never can be, on this branch: it
// asks whether a REAL runtime actually rejects a mismatched execution
// project through `bind_operation_ticket`/`complete_operation_ticket`, which
// requires those functions to receive a new parameter — a SQL signature
// change this train is explicitly prohibited from making (see
// docs/ops/workstreams/RELEASE.md §Prohibiciones). Its reducer accepts an
// OPTIONAL report and is fail-closed by construction, matching
// evaluateRuntimeQuotaCharged's own discipline in idempotency-release-gate.ts.
//
// FASE 6, VERBATIM: `local-runtime-ready` (local-release-gate.ts) is NOT
// touched by this module, in either direction — this train does not import,
// reference, or fold this gate into that one. See
// project-binding-release-gate.test.ts, "control #9", for the negative
// control that proves this statically.

import type { ProjectBindingEvalRun } from './project-binding-harness'

export type ProjectBindingGateId = 'project-bound-ticket-attribution' | 'runtime-project-attribution-verified'

export interface ProjectBindingGateResult {
  id: ProjectBindingGateId
  passed: boolean
  detail: string
}

/**
 * Ground truth about the ONE thing that can flip
 * `runtime-project-attribution-verified` — everything this reducer needs
 * from a real, disposable-database run. Optional and external: this module
 * opens no database and calls no orchestrator; only a future
 * `scripts/stella-ticket-e2e.sh` (once CAPABILITIES ships the new
 * `bind_operation_ticket`/`complete_operation_ticket` signature, train 5)
 * would ever construct one of these.
 */
export interface RuntimeProjectAttributionReport {
  /** bindForExecution's real counterpart rejected a mismatched execution project. */
  readonly bindRejectedForeignProject: boolean
  /** completeForExecution's real counterpart rejected a mismatched execution project. */
  readonly completeRejectedForeignProject: boolean
  /** abortForExecution's real counterpart rejected a mismatched execution project. */
  readonly abortRejectedForeignProject: boolean
  /** inspectForExecution's real counterpart rejected a mismatched execution project. */
  readonly inspectRejectedForeignProject: boolean
  /** The stored charge's project_id, read back from stella_interactions,
   *  equalled the ticket's project AND the execution project. */
  readonly chargeAttributedToExecutionProject: boolean
  /** The attack scenario (ticket of project A, execution asserted against
   *  project B) produced literally zero charge rows. */
  readonly zeroChargeOnAttack: boolean
  /** MUST be false for this gate to pass. True means the legacy, project-
   *  blind `bind_operation_ticket`/`complete_operation_ticket` signatures
   *  are STILL callable and still bypass the new check entirely — exactly
   *  what `nc-legacy-signature-bypasses-project-gate` in
   *  project-binding-harness.ts proves is true of TODAY's signatures. */
  readonly legacySignatureInvocable: boolean
}

function evaluateRuntimeProjectAttributionVerified(
  report: RuntimeProjectAttributionReport | null | undefined,
): ProjectBindingGateResult {
  if (!report) {
    return {
      id: 'runtime-project-attribution-verified',
      passed: false,
      detail:
        'no runtime project-attribution report provided — this gate can only pass once bind_operation_ticket/complete_operation_ticket accept and enforce a real execution-project parameter against a real database, and the legacy (project-blind) signatures are proven not invocable (CAPABILITIES train 5, docs/ops/contracts/CONTRACT_LEDGER.md#r2-int)',
    }
  }

  const proofs: Array<[string, boolean, string]> = [
    ['bind-rejects-foreign-project', report.bindRejectedForeignProject === true, `bindRejectedForeignProject=${report.bindRejectedForeignProject}`],
    ['complete-rejects-foreign-project', report.completeRejectedForeignProject === true, `completeRejectedForeignProject=${report.completeRejectedForeignProject}`],
    ['abort-rejects-foreign-project', report.abortRejectedForeignProject === true, `abortRejectedForeignProject=${report.abortRejectedForeignProject}`],
    ['inspect-rejects-foreign-project', report.inspectRejectedForeignProject === true, `inspectRejectedForeignProject=${report.inspectRejectedForeignProject}`],
    ['charge-attributed-to-execution-project', report.chargeAttributedToExecutionProject === true, `chargeAttributedToExecutionProject=${report.chargeAttributedToExecutionProject}`],
    ['zero-charge-on-attack', report.zeroChargeOnAttack === true, `zeroChargeOnAttack=${report.zeroChargeOnAttack}`],
    ['legacy-signatures-not-invocable', report.legacySignatureInvocable === false, `legacySignatureInvocable=${report.legacySignatureInvocable}`],
  ]

  const unproven = proofs.filter(([, holds]) => !holds)
  if (unproven.length > 0) {
    return {
      id: 'runtime-project-attribution-verified',
      passed: false,
      detail: `${unproven.length} of the 7 required proofs did not hold: ${unproven.map(([name, , observed]) => `${name} (${observed})`).join('; ')}`,
    }
  }

  return {
    id: 'runtime-project-attribution-verified',
    passed: true,
    detail:
      'all 7 required proofs hold: bind/complete/abort/inspect each reject a foreign execution project, the stored charge is attributed to the correct project, the attack scenario produced zero charge, and the legacy (project-blind) signatures are proven not invocable',
  }
}

export function evaluateProjectBindingGates(
  run: ProjectBindingEvalRun,
  runtimeReport?: RuntimeProjectAttributionReport | null,
): ProjectBindingGateResult[] {
  const { summary } = run
  return [
    {
      id: 'project-bound-ticket-attribution',
      passed:
        summary.totalCases === run.results.length &&
        summary.failed === 0 &&
        summary.tautologicalCases.length === 0 &&
        summary.negativeControlsUndetected === 0 &&
        summary.observabilitySafe,
      detail: `${summary.totalCases} cases, ${summary.failed} failed, ${summary.tautologicalCases.length} tautological, ${summary.negativeControlsUndetected}/${summary.negativeControlsRun} negative controls undetected, observabilitySafe=${summary.observabilitySafe}`,
    },
    evaluateRuntimeProjectAttributionVerified(runtimeReport),
  ]
}

export interface ProjectBindingGateReport {
  gates: ProjectBindingGateResult[]
  /**
   * True iff the ONE offline gate — `project-bound-ticket-attribution` —
   * passes: the evaluation contract itself (protocol *ForExecution verbs,
   * 10-case matrix, extended quota oracle, 8 negative controls,
   * observability) is internally coherent and green. Deliberately
   * independent of `runtime-project-attribution-verified`, and deliberately
   * NEVER folded into local-release-gate.ts's `localRuntimeReady` — see this
   * module's header and project-binding-release-gate.test.ts's "control #9".
   */
  projectBindingHarnessReady: boolean
  /** Empty iff projectBindingHarnessReady is true — never a bare false. */
  missingForProjectBindingHarness: string[]
  /** What stands between this train's evaluation contract and a REAL
   *  project-bound ticket runtime. Additive to (never a replacement for)
   *  idempotency-release-gate.ts's own missingForOperationTicketRuntime and
   *  local-release-gate.ts's missingForLocalRuntime, neither of which this
   *  module reads or modifies. */
  missingForProjectBindingRuntime: string[]
}

export function computeProjectBindingGateReport(
  run: ProjectBindingEvalRun,
  runtimeReport?: RuntimeProjectAttributionReport | null,
): ProjectBindingGateReport {
  const gates = evaluateProjectBindingGates(run, runtimeReport)
  const offlineGate = gates.find((g) => g.id === 'project-bound-ticket-attribution')!
  const runtimeGate = gates.find((g) => g.id === 'runtime-project-attribution-verified')!

  const projectBindingHarnessReady = offlineGate.passed
  const missingForProjectBindingHarness = offlineGate.passed ? [] : [`gate ${offlineGate.id} failed: ${offlineGate.detail}`]

  const missingForProjectBindingRuntime: string[] = runtimeGate.passed
    ? []
    : [
        runtimeGate.detail,
        "bind_operation_ticket/complete_operation_ticket must be given a new p_project_id parameter and compare it against the ticket's own project — a signature change to a package already published by CAPABILITIES, tracked for train 5 (docs/ops/contracts/CONTRACT_LEDGER.md#r2-int)",
        'tests/e2e/stella-ticket-journey.e2e.test.ts\'s "un ticket de OTRO proyecto de la misma organización y actor" case currently PINS today\'s misattribution as expected, measured behaviour and must be rewritten to assert rejection once the signature changes — this train does not touch that file',
      ]

  return { gates, projectBindingHarnessReady, missingForProjectBindingHarness, missingForProjectBindingRuntime }
}
