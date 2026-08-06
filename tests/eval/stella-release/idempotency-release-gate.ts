// tests/eval/stella-release/idempotency-release-gate.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 7.
//
// Nine stable gate identifiers, reduced from idempotency-harness.ts's own
// case results — same discipline as local-release-gate.ts's eleven Fase-3
// gates: every gate here READS the harness's own output, none re-derives a
// property the harness already measured.
//
// EIGHT of the nine are computable purely offline, from the reference-model
// harness. The ninth — `runtime-quota-charged` — never can be, on this
// branch: it asks whether a REAL runtime actually charged a unit through
// `uellix_stella.consume_stella_quota`, which requires the SQL package,
// server-action wiring and a live database this train explicitly does not
// build (see docs/ops/workstreams/RELEASE.md, Fase §Prohibiciones). Its
// reducer accepts an OPTIONAL report and is fail-closed by construction: a
// report that CLAIMS a charge without evidence of one is rejected, never
// trusted — the same "a claim contradicted by its own data is rejected"
// discipline `evaluateLocalRuntimeHarnessReadiness` already applies to
// `quotaConsumptionClaimed` vs `quotaRoleExists`.

import type { IdempotencyEvalRun } from './idempotency-harness'

export type IdempotencyReleaseGateId =
  | 'operation-ticket-contract'
  | 'retry-no-double-charge'
  | 'same-query-new-operation'
  | 'failure-no-charge'
  | 'cross-scope-ticket-rejected'
  | 'client-cannot-select-idempotency'
  | 'concurrency-last-unit'
  | 'ticket-observability-safe'
  | 'runtime-quota-charged'

export interface IdempotencyReleaseGateResult {
  id: IdempotencyReleaseGateId
  passed: boolean
  detail: string
}

function allPassed(run: IdempotencyEvalRun, caseIds: readonly string[]): boolean {
  const byId = new Map(run.results.map((r) => [r.caseId, r]))
  return caseIds.every((id) => byId.get(id)?.ok === true)
}

const RETRY_CASES = ['retry-same-ticket-same-query-charges-once', 'retry-after-complete-is-free'] as const
const FAILURE_CASES = [
  'failure-before-reserve-charges-nothing',
  'failure-after-reserve-charges-nothing-until-retried',
  'explicit-abort-charges-nothing-definitively',
  'retry-after-abort-rejected',
] as const
const CROSS_SCOPE_CASES = [
  'cross-organization-ticket-rejected',
  'cross-project-ticket-rejected',
  'cross-actor-ticket-rejected',
  'same-ticket-different-query-text-rejected',
  'nonexistent-ticket-rejected',
  'expired-ticket-rejected-not-charged',
] as const
const CLIENT_SELECTION_CASES = ['client-cannot-choose-idempotency-key', 'client-cannot-choose-ticket-scope'] as const
const CONCURRENCY_CASES = ['concurrent-same-ticket-charges-once', 'concurrent-distinct-tickets-last-unit-charges-once'] as const

/**
 * Ground truth about the ONE thing that can flip `runtime-quota-charged` —
 * everything this reducer needs from a real E2E run. Optional and external:
 * this module opens no database and calls no orchestrator; only
 * scripts/... (once integration writes one against a real ticket SQL
 * package) would ever construct one of these.
 */
export interface RuntimeQuotaChargeReport {
  /** What the run's own log/summary CLAIMS happened. */
  readonly claimedCharged: boolean
  /** Ground truth, read from the ledger itself — how many charge rows this
   *  run actually observed for the ticket it charged. */
  readonly chargesObservedForTicket: number
}

function evaluateRuntimeQuotaCharged(report: RuntimeQuotaChargeReport | null | undefined): IdempotencyReleaseGateResult {
  if (!report) {
    return {
      id: 'runtime-quota-charged',
      passed: false,
      detail:
        'no runtime charge report provided — app/actions/stella/grounded-query.ts does not call uellix_stella.consume_stella_quota on this branch (INT-INT-001 unresolved: QUOTA_LEDGER_NOT_CHARGED). This gate can only pass once a real ticket SQL package and a connected adapter charge a unit for real and report it here',
    }
  }
  // FAIL CLOSED on a claim its own evidence contradicts — never trust the
  // claim over the count, in either direction.
  if (report.claimedCharged !== (report.chargesObservedForTicket >= 1)) {
    return {
      id: 'runtime-quota-charged',
      passed: false,
      detail: `report claims charged=${report.claimedCharged} but chargesObservedForTicket=${report.chargesObservedForTicket} — a claim contradicted by its own evidence is rejected, never trusted`,
    }
  }
  if (!report.claimedCharged) {
    return { id: 'runtime-quota-charged', passed: false, detail: 'runtime did not charge a unit this run' }
  }
  return {
    id: 'runtime-quota-charged',
    passed: true,
    detail: `runtime charged ${report.chargesObservedForTicket} unit(s) for the ticket, confirmed against the ledger, not merely claimed`,
  }
}

export function evaluateIdempotencyReleaseGates(
  run: IdempotencyEvalRun,
  runtimeReport?: RuntimeQuotaChargeReport | null,
): IdempotencyReleaseGateResult[] {
  const { summary } = run
  return [
    {
      id: 'operation-ticket-contract',
      passed: summary.totalCases === run.results.length && summary.failed === 0 && summary.tautologicalCases.length === 0 && summary.negativeControlsUndetected === 0,
      detail: `${summary.totalCases} cases, ${summary.failed} failed, ${summary.tautologicalCases.length} tautological, ${summary.negativeControlsUndetected}/${summary.negativeControlsRun} negative controls undetected`,
    },
    {
      id: 'retry-no-double-charge',
      passed: allPassed(run, RETRY_CASES),
      detail: `${RETRY_CASES.join(', ')} — retry of the same ticket, and a duplicate delivery after completion, both charge zero additional units`,
    },
    {
      id: 'same-query-new-operation',
      passed: allPassed(run, ['new-ticket-same-query-text-charges-again']),
      detail: 'a new, independently-issued ticket for the same query TEXT charges a new unit — no silent discount for a legitimately repeated question',
    },
    {
      id: 'failure-no-charge',
      passed: allPassed(run, FAILURE_CASES),
      detail: `${FAILURE_CASES.join(', ')} — a failure before or after reservation, and an explicit or subsequently-retried abort, all charge definitively zero`,
    },
    {
      id: 'cross-scope-ticket-rejected',
      passed: allPassed(run, CROSS_SCOPE_CASES),
      detail: `${CROSS_SCOPE_CASES.join(', ')} — cross-organization, cross-project, cross-actor, mismatched-query, nonexistent and expired tickets are all rejected with zero charge`,
    },
    {
      id: 'client-cannot-select-idempotency',
      passed: allPassed(run, CLIENT_SELECTION_CASES),
      detail: `${CLIENT_SELECTION_CASES.join(', ')} — neither a client-offered idempotency key nor a client-offered scope is ever honoured`,
    },
    {
      id: 'concurrency-last-unit',
      passed: allPassed(run, CONCURRENCY_CASES),
      detail: `${CONCURRENCY_CASES.join(', ')} — concurrent completions of the same ticket, and two distinct tickets racing for the last unit of quota, each produce exactly one charge under the (locked) model`,
    },
    {
      id: 'ticket-observability-safe',
      passed: allPassed(run, ['ticket-lifecycle-events-carry-no-secrets']),
      detail: 'all 10 ticket-lifecycle events validate clean against the shared observability contract — opaque ids and codes only',
    },
    evaluateRuntimeQuotaCharged(runtimeReport),
  ]
}

export interface IdempotencyReleaseGateReport {
  gates: IdempotencyReleaseGateResult[]
  /**
   * True iff the eight OFFLINE gates all pass — the evaluation contract
   * itself (protocol interface, 20-case matrix, quota oracle, 19 negative
   * controls, observability extension) is internally coherent and green.
   * Deliberately independent of `runtime-quota-charged`: this is "is the
   * HARNESS ready", matching `libraryReady`/`integrationReady` in
   * local-release-gate.ts, never a claim that a real runtime charges
   * anything. See Fase 6: `idempotency-harness-ready=true,
   * local-runtime-ready=false` is the expected, correct pair on this branch.
   */
  idempotencyHarnessReady: boolean
  /** Empty iff idempotencyHarnessReady is true — never a bare false. */
  missingForIdempotencyHarness: string[]
  /**
   * What additionally stands between this train's evaluation contract and
   * the grounding local-runtime-ready gate becoming reachable. Additive to
   * (never a replacement for) local-release-gate.ts's own
   * `missingForLocalRuntime`, which this module does not modify.
   */
  missingForOperationTicketRuntime: string[]
}

export function computeIdempotencyReleaseGateReport(
  run: IdempotencyEvalRun,
  runtimeReport?: RuntimeQuotaChargeReport | null,
): IdempotencyReleaseGateReport {
  const gates = evaluateIdempotencyReleaseGates(run, runtimeReport)
  const offlineGates = gates.filter((g) => g.id !== 'runtime-quota-charged')
  const idempotencyHarnessReady = offlineGates.every((g) => g.passed)

  const missingForIdempotencyHarness = offlineGates.filter((g) => !g.passed).map((g) => `gate ${g.id} failed: ${g.detail}`)

  const runtimeGate = gates.find((g) => g.id === 'runtime-quota-charged')!
  const missingForOperationTicketRuntime: string[] = [
    ...(runtimeGate.passed ? [] : [runtimeGate.detail]),
    'no db/prepared/** ticket package exists — this train is explicitly prohibited from writing one (see docs/ops/workstreams/RELEASE.md, Train 4.1 §Prohibiciones)',
    'app/actions/stella/grounded-query.ts does not call uellix_stella.consume_stella_quota — QUOTA_LEDGER_NOT_CHARGED / INT-INT-001 remain the accurate description of the runtime',
    'no observability emitter exists for the 10 ticket-lifecycle events — this train\'s coverage is a validated CONTRACT, never a claim that a runtime emits them',
  ]

  return { gates, idempotencyHarnessReady, missingForIdempotencyHarness, missingForOperationTicketRuntime }
}
