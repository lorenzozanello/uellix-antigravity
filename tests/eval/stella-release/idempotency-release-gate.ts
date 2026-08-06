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
  /**
   * Train 4.1 — the nine measured deltas the dispatch requires before this
   * gate may pass. Every field is a LEDGER DELTA or a boolean derived from
   * one, measured by a real run through the real server action against a real
   * database. None of them may be inferred from a return value.
   *
   * All optional so the pre-4.1 two-field report still type-checks; the
   * reducer treats an ABSENT field as NOT PROVEN, which is why absence
   * fails the gate rather than passing it by default.
   */
  /** Delta on the very first execution of a fresh ticket. Must be exactly 1. */
  readonly firstExecutionDelta?: number
  /** Delta when the SAME ticket and SAME query are presented again. Must be 0. */
  readonly retryDelta?: number
  /** Delta for a NEW ticket carrying the SAME query text. Must be exactly 1. */
  readonly newOperationSameTextDelta?: number
  /** Delta across abort / failure paths. Must be 0. */
  readonly abortDelta?: number
  /** Delta across cross-organization, cross-actor and forged tickets. Must be 0. */
  readonly crossScopeDelta?: number
  /** Two tickets racing for the last unit produced exactly this many charges. Must be 1. */
  readonly concurrencyLastUnitCharges?: number
  /** The post-complete retry resolved to a NAMED state rather than silence. */
  readonly postCompleteRetryCode?: string
  /** Lifecycle event names the RUNTIME actually emitted this run. */
  readonly runtimeEventsEmitted?: readonly string[]
  /** Observability payloads that violated the shared contract. Must be 0. */
  readonly observabilityViolations?: number
  /** Containers, volumes and databases surviving teardown. Must be 0. */
  readonly residualResources?: number
}

/** The post-complete retry must resolve to a state that neither charges nor feigns success. */
const ACCEPTED_POST_COMPLETE_CODES = ['ALREADY_COMPLETED_RESULT_UNAVAILABLE'] as const

const REQUIRED_RUNTIME_EVENTS = [
  'operation_ticket_issued',
  'operation_ticket_bound',
  'grounded_query_reserved',
  'grounded_query_completed',
  'quota_consumed',
] as const

function evaluateRuntimeQuotaCharged(report: RuntimeQuotaChargeReport | null | undefined): IdempotencyReleaseGateResult {
  if (!report) {
    return {
      id: 'runtime-quota-charged',
      passed: false,
      detail:
        'no runtime charge report provided — this gate can only pass once a real ticket SQL package and a connected adapter charge a unit for real, through the real server action, and report the measured deltas here (scripts/stella-ticket-e2e.sh)',
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

  // Train 4.1 — the nine additional proofs. Stated as a list of
  // (name, holds) pairs so a failure NAMES ITSELF instead of collapsing into
  // one boolean nobody can debug.
  const events = report.runtimeEventsEmitted ?? []
  const missingEvents = REQUIRED_RUNTIME_EVENTS.filter((e) => !events.includes(e))
  const proofs: Array<[string, boolean, string]> = [
    ['first-execution-charges-one', report.firstExecutionDelta === 1, `firstExecutionDelta=${report.firstExecutionDelta}`],
    ['retry-charges-zero', report.retryDelta === 0, `retryDelta=${report.retryDelta}`],
    ['new-ticket-same-text-charges-one', report.newOperationSameTextDelta === 1, `newOperationSameTextDelta=${report.newOperationSameTextDelta}`],
    ['abort-and-failure-charge-zero', report.abortDelta === 0, `abortDelta=${report.abortDelta}`],
    ['cross-scope-charges-zero', report.crossScopeDelta === 0, `crossScopeDelta=${report.crossScopeDelta}`],
    ['concurrency-last-unit-charges-one', report.concurrencyLastUnitCharges === 1, `concurrencyLastUnitCharges=${report.concurrencyLastUnitCharges}`],
    [
      'post-complete-retry-has-explicit-semantics',
      typeof report.postCompleteRetryCode === 'string' &&
        (ACCEPTED_POST_COMPLETE_CODES as readonly string[]).includes(report.postCompleteRetryCode),
      `postCompleteRetryCode=${report.postCompleteRetryCode}`,
    ],
    [
      'runtime-observability-emitted-and-clean',
      missingEvents.length === 0 && report.observabilityViolations === 0,
      `missingEvents=[${missingEvents.join(', ')}] observabilityViolations=${report.observabilityViolations}`,
    ],
    ['teardown-left-nothing', report.residualResources === 0, `residualResources=${report.residualResources}`],
  ]

  const unproven = proofs.filter(([, holds]) => !holds)
  if (unproven.length > 0) {
    return {
      id: 'runtime-quota-charged',
      passed: false,
      detail: `runtime charged, but ${unproven.length} of the 9 required proofs did not hold: ${unproven
        .map(([name, , observed]) => `${name} (${observed})`)
        .join('; ')}`,
    }
  }

  return {
    id: 'runtime-quota-charged',
    passed: true,
    detail: `runtime charged ${report.chargesObservedForTicket} unit(s) for the ticket and all 9 required proofs hold, each measured as a ledger delta by a real run through the real server action — never inferred from a return value`,
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

  // The three entries that used to be UNCONDITIONAL here are now CONDITIONAL
  // on the runtime gate, and that is the whole of the Train 4.1 change to this
  // reducer.
  //
  // They were correct when written: on the RELEASE branch no ticket package
  // existed, the server action charged nothing, and no emitter existed. Stated
  // as constants they were honest. Left as constants they would have become a
  // lie the day integration closed the gap — and a permanently-nonempty
  // "missing" list is indistinguishable from a list nobody maintains.
  //
  // They are keyed off `runtimeGate.passed` rather than off a new flag,
  // because that gate is precisely "a real runtime charged a real unit and
  // proved the nine deltas". If it did, the package exists, the action calls
  // it and the emitter emits — those are not three further claims, they are
  // preconditions of the evidence already accepted.
  const missingForOperationTicketRuntime: string[] = runtimeGate.passed
    ? []
    : [
        runtimeGate.detail,
        'no verified db/prepared/** ticket package charge observed — stella_0014 must be applied and exercised',
        'app/actions/stella/grounded-query.ts must be shown to call uellix_stella.consume_stella_quota through complete_operation_ticket',
        'no runtime observability emitter proven for the 10 ticket-lifecycle events — a validated CONTRACT is not a claim that a runtime emits them',
      ]

  return { gates, idempotencyHarnessReady, missingForIdempotencyHarness, missingForOperationTicketRuntime }
}
