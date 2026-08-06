// tests/eval/stella-release/e2e/ticket-protocol-journey-report.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 6.
//
// PREPARED, NOT EXECUTABLE. This is the typed claim a future disposable-
// database journey (the ticket-protocol sibling of
// scripts/stella-release-e2e-dry-run.sh / e2e/run-local-journey.ts) would have
// to make, and the fail-closed reducer that turns it into
// `ticketProtocolJourneyReady`. NOTHING in this file runs SQL, opens a
// connection, or simulates a result — there is no db/prepared/** ticket
// package for it to run against yet (this train is prohibited from writing
// one; see docs/ops/workstreams/RELEASE.md). Calling
// `evaluateTicketProtocolJourneyReadiness()` with no report — which is every
// invocation on this branch — always returns false with the reason stated.
//
// WHY THIS IS A SEPARATE MODULE FROM harness-report.ts
// harness-report.ts's `LocalRuntimeHarnessReport` is the GROUNDING journey's
// claim (ingestion, chunks, retrieval, citations) against a real disposable
// Postgres that DOES exist today (grounding_0002/0003/stella_0013/grounding_0004
// all apply cleanly, per the Train 4 integration record). The ticket protocol
// has no SQL counterpart at all — extending that report's shape with ticket
// fields would imply the two journeys run together, when in truth this one
// cannot run AT ALL until a ticket package exists. Keeping the shapes
// separate keeps that difference honest instead of papering over it with an
// always-null field bolted onto someone else's report.
//
// The 13 stages below are exactly Fase 6's list, in order: disposable base;
// baseline; Train 4 packages; ticket package; small quota; ticket issued;
// operation completed; retry; same query as a new operation; failure and
// abort; cross-project attack; concurrency; teardown.

export interface TicketProtocolJourneyReport {
  /** Must be 'none' — same requirement as LocalRuntimeHarnessReport. */
  readonly containerNetworkMode: string
  readonly containerDestroyed: boolean
  readonly usedPersistentVolume: boolean
  /** grounding_0002/0003/stella_0013/grounding_0004 applied — the same
   *  REQUIRED_PACKAGES set harness-report.ts already enforces for the
   *  grounding journey; the ticket journey depends on the same baseline. */
  readonly train4PackagesApplied: readonly string[]
  /** The basename of whatever future package installs the ticket table/
   *  functions — e.g. 'stella_0014_operation_tickets'. Empty string means no
   *  such package exists in this worktree, which is the actual state today. */
  readonly ticketPackageApplied: string
  /** The organization's quota was provisioned small enough (e.g. 1-2) for
   *  the exhaustion and last-unit-concurrency stages to be meaningful. */
  readonly smallQuotaProvisioned: boolean
  readonly ticketIssuedViaRealFunction: boolean
  readonly operationCompletedViaRealFunction: boolean
  /** A real retry of the SAME ticket, against the real function, charged
   *  zero additional units. */
  readonly retryChargedZeroAdditionalUnits: boolean
  /** A second, independently-issued ticket for the same query TEXT, against
   *  the real function, charged a second unit. */
  readonly sameQueryNewOperationCharged: boolean
  /** A simulated failure (orchestration error after reserve) followed by an
   *  explicit abort, against the real function, charged zero units. */
  readonly failureAndAbortChargedZero: boolean
  /** A ticket presented with a foreign project's scope, against the real
   *  function, was rejected with zero charge. */
  readonly crossProjectAttackRejected: boolean
  /** Two real, concurrent database sessions disputing the same ticket or the
   *  last unit of quota — same "two real sessions" discipline
   *  CAP-TRAIN4-001's evidence already demonstrates for consume_stella_quota
   *  itself — produced exactly one charge. */
  readonly concurrencyProducedExactlyOneCharge: boolean
  readonly providerCallCount: number
  /** Every ticket-lifecycle event this run emitted passed the REAL
   *  validateObservabilityEvent contract, and came from the RUNTIME — same
   *  'runtime-emitted' vs 'harness-constructed' distinction
   *  LocalRuntimeHarnessReport already draws for the grounding journey. */
  readonly observabilityEventSource: 'runtime-emitted' | 'harness-constructed'
}

export interface TicketProtocolJourneyReadiness {
  readonly ticketProtocolJourneyReady: boolean
  readonly missingForTicketProtocolJourney: readonly string[]
}

const REQUIRED_TRAIN4_PACKAGES = ['grounding_0002', 'grounding_0003', 'stella_0013', 'grounding_0004'] as const

/**
 * Fail-closed reduction, mirroring evaluateLocalRuntimeHarnessReadiness's
 * per-field discipline: every field is a claim the journey script could lie
 * about (accidentally or not) by taking a shortcut, and each is checked
 * independently so a report cannot claim a result the rest of its own data
 * contradicts.
 */
export function evaluateTicketProtocolJourneyReadiness(
  report: TicketProtocolJourneyReport | null | undefined,
): TicketProtocolJourneyReadiness {
  if (!report) {
    return {
      ticketProtocolJourneyReady: false,
      missingForTicketProtocolJourney: [
        'no ticket-protocol journey report provided (INT-INT-001 unresolved) — no db/prepared/** ticket package exists in this worktree, and this train is prohibited from writing one. This reducer is prepared to accept a real report the day integration supplies scripts/stella-ticket-protocol-e2e-dry-run.sh (or equivalent) and a connected server-action adapter',
      ],
    }
  }

  const missing: string[] = []
  if (report.containerNetworkMode !== 'none') missing.push(`containerNetworkMode is '${report.containerNetworkMode}', required 'none'`)
  if (!report.containerDestroyed) missing.push('containerDestroyed is false')
  if (report.usedPersistentVolume) missing.push('usedPersistentVolume is true — this journey must use no persistent volume')
  for (const pkg of REQUIRED_TRAIN4_PACKAGES) {
    if (!report.train4PackagesApplied.includes(pkg)) missing.push(`required Train 4 package '${pkg}' is not in train4PackagesApplied`)
  }
  if (report.ticketPackageApplied.trim() === '') missing.push('ticketPackageApplied is empty — no ticket SQL package was applied this run')
  if (!report.smallQuotaProvisioned) missing.push('smallQuotaProvisioned is false — the exhaustion and last-unit-concurrency stages need a small quota to be meaningful')
  if (!report.ticketIssuedViaRealFunction) missing.push('ticketIssuedViaRealFunction is false')
  if (!report.operationCompletedViaRealFunction) missing.push('operationCompletedViaRealFunction is false')
  if (!report.retryChargedZeroAdditionalUnits) missing.push('retryChargedZeroAdditionalUnits is false — a real retry against the real function charged more than zero')
  if (!report.sameQueryNewOperationCharged) missing.push('sameQueryNewOperationCharged is false — a second, independent ticket for the same query text did not charge')
  if (!report.failureAndAbortChargedZero) missing.push('failureAndAbortChargedZero is false')
  if (!report.crossProjectAttackRejected) missing.push('crossProjectAttackRejected is false')
  if (!report.concurrencyProducedExactlyOneCharge) missing.push('concurrencyProducedExactlyOneCharge is false')
  if (report.providerCallCount !== 0) missing.push(`providerCallCount is ${report.providerCallCount} — this journey must make zero calls to any provider`)
  if (report.observabilityEventSource !== 'runtime-emitted') {
    missing.push(`observabilityEventSource is '${report.observabilityEventSource}' — events must be emitted BY the runtime, not constructed by the harness, for this journey to certify the flow's telemetry`)
  }

  return { ticketProtocolJourneyReady: missing.length === 0, missingForTicketProtocolJourney: missing }
}
