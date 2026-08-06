// tests/eval/stella-release/reserved-quota-release-gate.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 7.
//
// Nine stable gate identifiers, reduced from reserved-quota-harness.ts's own
// run output — same discipline as idempotency-release-gate.ts's nine gates
// and project-binding-release-gate.ts's two: every gate here READS the
// harness's own output, none re-derives a property the harness already
// measured. Eight are the Fase 7 dispatch list verbatim; `reserved-quota-contract`
// is a ninth, structural one — same role `operation-ticket-contract` plays in
// idempotency-release-gate.ts and `project-bound-ticket-attribution` plays in
// project-binding-release-gate.ts: it is what makes the 15-case matrix, the
// negative controls, the observability extension and the feature-flag posture
// ALL green a precondition of every other gate here, without repeating that
// check eight times.
//
// EIGHT of the nine are computable purely offline, from the reference-model
// harness. The ninth — `runtime-reserved-quota-verified` — never can be, on
// this branch: it asks whether a REAL runtime enforces the shared-capacity
// contract between `uellix_stella.consume_stella_quota` (grounded) and the
// five direct-write sibling actions, which requires a fix to R6-INT (the
// missing lock/reservation-visibility on the sibling write path) and a
// decision on R1's billing policy — both explicitly deferred to tren 5 in
// docs/ops/contracts/CONTRACT_LEDGER.md. Its reducer accepts an OPTIONAL
// report and is fail-closed by construction: a report that CLAIMS
// verification without evidence of one is rejected, never trusted — the same
// discipline `evaluateRuntimeQuotaCharged` and
// `evaluateRuntimeProjectAttributionVerified` already apply.
//
// `reserved-quota-harness-ready=true` is asserted on THIS branch (Fase 7).
// `local-runtime-ready` and `staging-blocked` are NOT touched, in either
// direction — see the static controls in
// reserved-quota-release-gate.test.ts, the same "control #9" discipline
// project-binding-release-gate.test.ts already established.

import type { ReservedQuotaEvalRun } from './reserved-quota-harness'

export type ReservedQuotaGateId =
  | 'reserved-quota-contract'
  | 'reservation-counts-as-capacity'
  | 'sibling-respects-reservations'
  | 'reserved-completion-guaranteed'
  | 'abort-releases-capacity'
  | 'expiration-releases-capacity'
  | 'cross-operation-last-unit'
  | 'reservation-period-consistent'
  | 'runtime-reserved-quota-verified'

export interface ReservedQuotaGateResult {
  id: ReservedQuotaGateId
  passed: boolean
  detail: string
}

function allPassed(run: ReservedQuotaEvalRun, caseIds: readonly string[]): boolean {
  const byId = new Map(run.results.map((r) => [r.caseId, r]))
  return caseIds.every((id) => byId.get(id)?.ok === true)
}

const CAPACITY_CASES = ['grounded-reserves-last-unit'] as const
const SIBLING_RESPECT_CASES = ['sibling-rejected-after-grounded-reserves-last-unit', 'sibling-consumes-first-then-grounded-reserve-rejected'] as const
const COMPLETION_CASES = ['grounded-completes-without-recontending', 'grounded-complete-vs-sibling-concurrent', 'retry-grounded-does-not-reserve-or-charge-again'] as const
const ABORT_CASES = ['explicit-abort-releases-then-sibling-consumes', 'grounded-failure-and-abort-charges-nothing'] as const
const EXPIRATION_CASES = ['expiration-releases-then-sibling-consumes'] as const
const CROSS_OPERATION_LAST_UNIT_CASES = ['two-grounded-reservations-for-last-unit', 'two-siblings-for-last-unit', 'grounded-complete-vs-sibling-concurrent'] as const
const PERIOD_CASES = ['reservation-crossing-period-boundary'] as const

/**
 * Ground truth about the ONE thing that can flip
 * `runtime-reserved-quota-verified` — everything this reducer needs from a
 * real, disposable-database run exercising BOTH the grounded ticket path and
 * at least one real sibling action against the SAME live database. Optional
 * and external: this module opens no database and calls no orchestrator; only
 * a future `scripts/stella-reserved-quota-e2e.sh` (once CAPABILITIES closes
 * R6-INT and a billing decision is made for R1, tren 5) would ever construct
 * one of these.
 */
export interface RuntimeReservedQuotaReport {
  /** What the run's own log/summary CLAIMS happened. */
  readonly claimedVerified: boolean
  /** A grounded reservation for the organization's last real unit was
   *  granted, and a REAL sibling action's write attempt against the same
   *  organization was measured — never assumed — to be rejected while that
   *  reservation was live. */
  readonly siblingRejectedWhileReservationLive: boolean
  /** The reservation's own completion, measured as a `stella_interactions`
   *  row delta, charged exactly one unit without re-contending. */
  readonly completionChargedExactlyOnce: boolean
  /** An explicit abort, measured against the real ledger, released the unit
   *  and a subsequent real sibling write succeeded. */
  readonly abortReleasedCapacity: boolean
  /** A reservation whose TTL elapsed, measured against the real ledger,
   *  released the unit and a subsequent real sibling write succeeded. */
  readonly expirationReleasedCapacity: boolean
  /** Two real, concurrent sessions — a grounded completion and a sibling
   *  write — disputing the organization's last real unit produced exactly one
   *  charge, measured as a ledger delta from a THIRD connection. */
  readonly concurrentLastUnitProducedExactlyOneCharge: boolean
  /** When the sibling path won the race (per R1's policy), the grounded
   *  action's own response was measured to be DISCARDED — never presented as
   *  successful — and the ticket transitioned to the quota_refused-equivalent
   *  state, never silently completed anyway. */
  readonly r1PolicyDiscardObserved: boolean
  /** Lifecycle event names the RUNTIME actually emitted this run — same
   *  'runtime-emitted' vs 'harness-constructed' distinction
   *  LocalRuntimeHarnessReport/TicketProtocolJourneyReport already draw. */
  readonly observabilityEventSource: 'runtime-emitted' | 'harness-constructed'
  /** Observability payloads that violated the shared contract. Must be 0. */
  readonly observabilityViolations: number
  /** Containers, volumes and databases surviving teardown. Must be 0. */
  readonly residualResources: number
}

function evaluateRuntimeReservedQuotaVerified(report: RuntimeReservedQuotaReport | null | undefined): ReservedQuotaGateResult {
  if (!report) {
    return {
      id: 'runtime-reserved-quota-verified',
      passed: false,
      detail:
        'no runtime reserved-quota report provided — this gate can only pass once R6-INT (the missing lock/reservation-visibility on the five sibling write paths) is closed and R1\'s billing policy is decided, and a real disposable-database run measures the shared-capacity contract end to end (docs/ops/contracts/CONTRACT_LEDGER.md, tren 5)',
    }
  }
  if (report.claimedVerified !== (report.residualResources === 0 && report.observabilityViolations === 0)) {
    return {
      id: 'runtime-reserved-quota-verified',
      passed: false,
      detail: `report claims verified=${report.claimedVerified} but residualResources=${report.residualResources} observabilityViolations=${report.observabilityViolations} — a claim contradicted by its own evidence is rejected, never trusted`,
    }
  }
  if (!report.claimedVerified) {
    return { id: 'runtime-reserved-quota-verified', passed: false, detail: 'runtime did not claim the reserved-quota contract verified this run' }
  }

  const proofs: Array<[string, boolean, string]> = [
    ['sibling-rejected-while-reservation-live', report.siblingRejectedWhileReservationLive, `siblingRejectedWhileReservationLive=${report.siblingRejectedWhileReservationLive}`],
    ['completion-charges-exactly-once', report.completionChargedExactlyOnce, `completionChargedExactlyOnce=${report.completionChargedExactlyOnce}`],
    ['abort-releases-capacity', report.abortReleasedCapacity, `abortReleasedCapacity=${report.abortReleasedCapacity}`],
    ['expiration-releases-capacity', report.expirationReleasedCapacity, `expirationReleasedCapacity=${report.expirationReleasedCapacity}`],
    ['concurrent-last-unit-one-charge', report.concurrentLastUnitProducedExactlyOneCharge, `concurrentLastUnitProducedExactlyOneCharge=${report.concurrentLastUnitProducedExactlyOneCharge}`],
    ['r1-policy-discard-observed', report.r1PolicyDiscardObserved, `r1PolicyDiscardObserved=${report.r1PolicyDiscardObserved}`],
    ['runtime-observability-emitted-and-clean', report.observabilityEventSource === 'runtime-emitted' && report.observabilityViolations === 0, `observabilityEventSource=${report.observabilityEventSource} observabilityViolations=${report.observabilityViolations}`],
    ['teardown-left-nothing', report.residualResources === 0, `residualResources=${report.residualResources}`],
  ]

  const unproven = proofs.filter(([, holds]) => !holds)
  if (unproven.length > 0) {
    return {
      id: 'runtime-reserved-quota-verified',
      passed: false,
      detail: `runtime claimed verification, but ${unproven.length} of the 8 required proofs did not hold: ${unproven.map(([name, , observed]) => `${name} (${observed})`).join('; ')}`,
    }
  }

  return {
    id: 'runtime-reserved-quota-verified',
    passed: true,
    detail: 'all 8 required proofs hold, each measured against a real disposable database through the real grounded ticket path and at least one real sibling action — never inferred from a return value',
  }
}

export function evaluateReservedQuotaGates(run: ReservedQuotaEvalRun, runtimeReport?: RuntimeReservedQuotaReport | null): ReservedQuotaGateResult[] {
  const { summary } = run
  return [
    {
      id: 'reserved-quota-contract',
      passed:
        summary.totalCases === run.results.length &&
        summary.failed === 0 &&
        summary.tautologicalCases.length === 0 &&
        summary.negativeControlsUndetected === 0 &&
        summary.observabilitySafe &&
        summary.featureFlagSafe,
      detail: `${summary.totalCases} cases, ${summary.failed} failed, ${summary.tautologicalCases.length} tautological, ${summary.negativeControlsUndetected}/${summary.negativeControlsRun} negative controls undetected, observabilitySafe=${summary.observabilitySafe}, featureFlagSafe=${summary.featureFlagSafe}`,
    },
    {
      id: 'reservation-counts-as-capacity',
      passed: allPassed(run, CAPACITY_CASES),
      detail: `${CAPACITY_CASES.join(', ')} — a grounded reservation occupies capacity at reserve time, before it ever charges`,
    },
    {
      id: 'sibling-respects-reservations',
      passed: allPassed(run, SIBLING_RESPECT_CASES),
      detail: `${SIBLING_RESPECT_CASES.join(', ')} — a sibling consumption is rejected against a live reservation, in either order of arrival`,
    },
    {
      id: 'reserved-completion-guaranteed',
      passed: allPassed(run, COMPLETION_CASES),
      detail: `${COMPLETION_CASES.join(', ')} — a held reservation completes without recontending, survives a concurrent sibling race, and a replay never re-reserves or re-charges`,
    },
    {
      id: 'abort-releases-capacity',
      passed: allPassed(run, ABORT_CASES),
      detail: `${ABORT_CASES.join(', ')} — an explicit abort, and an abort following a failed orchestration, both release the held unit definitively`,
    },
    {
      id: 'expiration-releases-capacity',
      passed: allPassed(run, EXPIRATION_CASES),
      detail: `${EXPIRATION_CASES.join(', ')} — a stale, un-completed reservation is transitioned to expired and its unit becomes available`,
    },
    {
      id: 'cross-operation-last-unit',
      passed: allPassed(run, CROSS_OPERATION_LAST_UNIT_CASES),
      detail: `${CROSS_OPERATION_LAST_UNIT_CASES.join(', ')} — two grounded reservations, two siblings, and a grounded-vs-sibling race for the same last unit each produce exactly one winner`,
    },
    {
      id: 'reservation-period-consistent',
      passed: allPassed(run, PERIOD_CASES),
      detail: `${PERIOD_CASES.join(', ')} — a reservation crossing an accounting-period boundary still charges correctly, attributed to the period active at completion, without starving the new period's budget`,
    },
    evaluateRuntimeReservedQuotaVerified(runtimeReport),
  ]
}

export interface ReservedQuotaGateReport {
  gates: ReservedQuotaGateResult[]
  /**
   * True iff the eight OFFLINE gates all pass — the evaluation contract
   * itself (protocol, 15-case matrix, interference oracle, negative controls,
   * observability extension) is internally coherent and green. Deliberately
   * independent of `runtime-reserved-quota-verified`, matching
   * `idempotencyHarnessReady`/`projectBindingHarnessReady`.
   */
  reservedQuotaHarnessReady: boolean
  /** Empty iff reservedQuotaHarnessReady is true — never a bare false. */
  missingForReservedQuotaHarness: string[]
  /** What additionally stands between this train's evaluation contract and a
   *  REAL runtime enforcing the shared-capacity contract. Additive to (never a
   *  replacement for) idempotency-release-gate.ts's
   *  missingForOperationTicketRuntime and local-release-gate.ts's own
   *  missingForLocalRuntime, neither of which this module reads or modifies. */
  missingForReservedQuotaRuntime: string[]
}

export function computeReservedQuotaGateReport(run: ReservedQuotaEvalRun, runtimeReport?: RuntimeReservedQuotaReport | null): ReservedQuotaGateReport {
  const gates = evaluateReservedQuotaGates(run, runtimeReport)
  const offlineGates = gates.filter((g) => g.id !== 'runtime-reserved-quota-verified')
  const reservedQuotaHarnessReady = offlineGates.every((g) => g.passed)
  const missingForReservedQuotaHarness = offlineGates.filter((g) => !g.passed).map((g) => `gate ${g.id} failed: ${g.detail}`)

  const runtimeGate = gates.find((g) => g.id === 'runtime-reserved-quota-verified')!
  const missingForReservedQuotaRuntime: string[] = runtimeGate.passed
    ? []
    : [
        runtimeGate.detail,
        'R6-INT (docs/ops/contracts/CONTRACT_LEDGER.md) must be closed — the five sibling actions must gain visibility into a live grounded reservation, or a serialising mechanism that spans both paths',
        'R1\'s billing policy must be decided (tren 5) and implemented — app/actions/stella/grounded-query.ts must be shown discarding an uncharged computed response and reporting QUOTA_EXCEEDED, never presenting it as successful',
        'no runtime observability emitter proven for the 6 reserved-quota lifecycle events — a validated CONTRACT is not a claim that a runtime emits them',
      ]

  return { gates, reservedQuotaHarnessReady, missingForReservedQuotaHarness, missingForReservedQuotaRuntime }
}
