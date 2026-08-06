// tests/eval/stella-release/e2e/reserved-quota-journey-report.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 8.
//
// PREPARED, NOT EXECUTABLE. This is the typed claim a future disposable-
// database journey — the reserved-quota sibling of
// scripts/stella-ticket-e2e.sh / e2e/ticket-protocol-journey-report.ts — would
// have to make, and the fail-closed reducer that turns it into
// `reservedQuotaJourneyReady`. NOTHING in this file runs SQL, opens a
// connection, or simulates a result. R6-INT (the five sibling actions writing
// `stella_interactions` with no lock and no visibility into a live
// `operation_tickets` reservation) is open, and R1's billing policy is
// undecided — both explicitly deferred to tren 5
// (docs/ops/contracts/CONTRACT_LEDGER.md). Calling
// `evaluateReservedQuotaJourneyReadiness()` with no report — which is every
// invocation on this branch — always returns false with the reasons stated.
//
// WHY THIS IS A SEPARATE MODULE FROM ticket-protocol-journey-report.ts
// That report proves the GROUNDED ticket lifecycle in isolation against a real
// database. This one proves the INTERFERENCE property between that lifecycle
// and a REAL sibling action (advisor/validator/composer/proxy_reviewer/
// evidence_reviewer/audit_assistant) sharing the same organization's quota —
// a claim the grounded-only journey cannot make on its own, because it never
// exercises a sibling code path at all.
//
// The 15 stages below are exactly Fase 8's list, in order: disposable base;
// baseline; Train 4 packages; reservation package; organization; two
// projects; two actors; one-unit quota; grounded ticket; sibling action;
// concurrency; abort; expire; complete; ledger; teardown. ("El arnés debe
// fallar claramente hasta que integración aporte el paquete" — Fase 8's own
// closing line — is exactly what the no-report branch of the reducer below
// does.)

export interface ReservedQuotaJourneyReport {
  /** Must be 'none' — same requirement as every prior disposable-database
   *  journey in this line. */
  readonly containerNetworkMode: string
  readonly containerDestroyed: boolean
  readonly usedPersistentVolume: boolean
  /** grounding_0002/0003/stella_0013/grounding_0004 applied — the same
   *  REQUIRED_TRAIN4_PACKAGES set ticket-protocol-journey-report.ts already
   *  enforces; this journey depends on the same baseline plus the ticket
   *  chain below it. */
  readonly train4PackagesApplied: readonly string[]
  /** stella_0014 and stella_0015 applied — the reservation/project-bound
   *  ticket chain this journey's grounded half depends on. */
  readonly ticketPackagesApplied: readonly string[]
  /** The basename of whatever future package closes R6-INT — e.g. a lock or
   *  reservation-visibility mechanism reachable from the five sibling write
   *  paths. Empty string means no such package exists in this worktree, which
   *  is the actual state today. */
  readonly reservedQuotaPackageApplied: string
  readonly organizationProvisioned: boolean
  /** Two DISTINCT real projects of the SAME organization — needed for the
   *  cross-project reservation-scope cases, distinct from the cross-operation
   *  (grounded vs. sibling) cases this journey exists to prove. */
  readonly twoProjectsProvisioned: boolean
  /** Two DISTINCT real actors of the SAME organization — needed for the
   *  reservation-scope cases idempotency-matrix.ts's own cross-actor case
   *  already covers for the ticket alone; restated here because this journey
   *  provisions its own fixtures independently. */
  readonly twoActorsProvisioned: boolean
  /** The organization's real monthly quota was provisioned to exactly 1 — the
   *  same "small quota" requirement TicketProtocolJourneyReport's own
   *  `smallQuotaProvisioned` states, sized precisely so the last-unit and
   *  cross-operation-contention stages are meaningful. */
  readonly oneUnitQuotaProvisioned: boolean
  readonly groundedTicketReservedViaRealFunction: boolean
  /** A REAL sibling action (any of
   *  advisor/validator/composer/proxy_reviewer/evidence_reviewer/audit_assistant)
   *  was invoked against the SAME organization while the grounded ticket's
   *  reservation was live, through the real code path
   *  (checkStellaQuota + db.insert), never simulated. */
  readonly siblingActionInvokedViaRealPath: boolean
  /** Two real, concurrent database sessions — one completing the grounded
   *  reservation, one running the real sibling write — disputing the
   *  organization's last real unit, measured (not assumed) to produce exactly
   *  one charge. Same "two real sessions" discipline
   *  CAP-TRAIN4-001/TicketProtocolJourneyReport's own concurrency stage
   *  already demonstrates for a single caller kind, extended here across two
   *  DIFFERENT kinds of caller. */
  readonly concurrencyAcrossOperationsProducedExactlyOneCharge: boolean
  /** A real abort, against the real function, released the reservation's
   *  capacity and a subsequent real sibling write succeeded. */
  readonly abortReleasedCapacityForSibling: boolean
  /** A real reservation whose TTL elapsed, against the real function, freed
   *  its capacity and a subsequent real sibling write succeeded. */
  readonly expirationReleasedCapacityForSibling: boolean
  /** The grounded reservation's completion, against the real function,
   *  charged exactly one unit without re-contending for capacity it already
   *  held. */
  readonly completionChargedWithoutRecontending: boolean
  /** When a real sibling won the race for the last unit BEFORE the grounded
   *  reservation completed, the grounded action's own response was measured
   *  to be DISCARDED — never persisted, never shown as successful — matching
   *  R1's policy exactly, not merely a rejection recorded in a return value. */
  readonly r1DiscardPolicyObservedOnRealRace: boolean
  /** Every `stella_interactions` row this run produced was counted via a
   *  DIFFERENT connection than the one that wrote it — same
   *  "delta of rows, never a return value" discipline
   *  INT-INT-001's own closure evidence already used — and the total across
   *  BOTH the grounded and sibling paths never exceeded the provisioned
   *  quota. */
  readonly ledgerNeverExceededQuota: boolean
  readonly providerCallCount: number
  /** Every reserved-quota lifecycle event this run emitted passed the REAL
   *  validateObservabilityEvent contract, and came from the RUNTIME — same
   *  'runtime-emitted' vs 'harness-constructed' distinction every prior
   *  journey report in this line already draws. */
  readonly observabilityEventSource: 'runtime-emitted' | 'harness-constructed'
}

export interface ReservedQuotaJourneyReadiness {
  readonly reservedQuotaJourneyReady: boolean
  readonly missingForReservedQuotaJourney: readonly string[]
}

const REQUIRED_TRAIN4_PACKAGES = ['grounding_0002', 'grounding_0003', 'stella_0013', 'grounding_0004'] as const
const REQUIRED_TICKET_PACKAGES = ['stella_0014', 'stella_0015'] as const

/**
 * Fail-closed reduction, same per-field discipline
 * evaluateTicketProtocolJourneyReadiness/evaluateLocalRuntimeHarnessReadiness
 * already apply: every field is a claim the journey script could lie about
 * (accidentally or not) by taking a shortcut, and each is checked
 * independently so a report cannot claim a result the rest of its own data
 * contradicts. "No simules SQL ausente" (Fase 8): the no-report branch below
 * is the ENTIRE behaviour on this branch, and it names every missing
 * dependency rather than fabricating a result.
 */
export function evaluateReservedQuotaJourneyReadiness(report: ReservedQuotaJourneyReport | null | undefined): ReservedQuotaJourneyReadiness {
  if (!report) {
    return {
      reservedQuotaJourneyReady: false,
      missingForReservedQuotaJourney: [
        'no reserved-quota journey report provided — R6-INT is open and R1\'s billing policy is undecided (docs/ops/contracts/CONTRACT_LEDGER.md, tren 5); no db/prepared/** package exists in this worktree that closes either, and this train is prohibited from writing one. This reducer is prepared to accept a real report the day integration supplies scripts/stella-reserved-quota-e2e.sh (or equivalent) and a connected adapter for at least one real sibling action',
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
  for (const pkg of REQUIRED_TICKET_PACKAGES) {
    if (!report.ticketPackagesApplied.includes(pkg)) missing.push(`required ticket package '${pkg}' is not in ticketPackagesApplied`)
  }
  if (report.reservedQuotaPackageApplied.trim() === '') missing.push('reservedQuotaPackageApplied is empty — no package closing R6-INT was applied this run')
  if (!report.organizationProvisioned) missing.push('organizationProvisioned is false')
  if (!report.twoProjectsProvisioned) missing.push('twoProjectsProvisioned is false')
  if (!report.twoActorsProvisioned) missing.push('twoActorsProvisioned is false')
  if (!report.oneUnitQuotaProvisioned) missing.push('oneUnitQuotaProvisioned is false — the last-unit and cross-operation-contention stages need a quota of exactly 1 to be meaningful')
  if (!report.groundedTicketReservedViaRealFunction) missing.push('groundedTicketReservedViaRealFunction is false')
  if (!report.siblingActionInvokedViaRealPath) missing.push('siblingActionInvokedViaRealPath is false — no real sibling action (advisor/validator/composer/proxy_reviewer/evidence_reviewer/audit_assistant) was exercised')
  if (!report.concurrencyAcrossOperationsProducedExactlyOneCharge) missing.push('concurrencyAcrossOperationsProducedExactlyOneCharge is false')
  if (!report.abortReleasedCapacityForSibling) missing.push('abortReleasedCapacityForSibling is false')
  if (!report.expirationReleasedCapacityForSibling) missing.push('expirationReleasedCapacityForSibling is false')
  if (!report.completionChargedWithoutRecontending) missing.push('completionChargedWithoutRecontending is false')
  if (!report.r1DiscardPolicyObservedOnRealRace) missing.push('r1DiscardPolicyObservedOnRealRace is false — R1\'s discard-and-refuse policy must be measured on a REAL race, not merely asserted')
  if (!report.ledgerNeverExceededQuota) missing.push('ledgerNeverExceededQuota is false — the real ledger oversold the provisioned quota this run')
  if (report.providerCallCount !== 0) missing.push(`providerCallCount is ${report.providerCallCount} — this journey must make zero calls to any provider`)
  if (report.observabilityEventSource !== 'runtime-emitted') {
    missing.push(`observabilityEventSource is '${report.observabilityEventSource}' — events must be emitted BY the runtime, not constructed by the harness, for this journey to certify the flow's telemetry`)
  }

  return { reservedQuotaJourneyReady: missing.length === 0, missingForReservedQuotaJourney: missing }
}
