// tests/eval/stella-release/reserved-quota-oracle.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 4.
//
// The interference oracle. Every assertion here reads
// reserved-quota-protocol.ts's own state (ReservedQuotaInspectable /
// CapacitySnapshot / CapacityChargeRecord) — never an HTTP status code, never
// a UI string, same discipline idempotency-oracle.ts already documents at
// length for the ticket-protocol ledger.
//
// THE CORE INVARIANT (Fase 2/4): `Consumed + LiveReserved <= Limit` must hold
// on EVERY snapshot a scenario produces, not merely on the final one — a
// scenario that oversells for one transition and "recovers" by the time it
// reports its last snapshot is still a scenario that oversold. Every case
// function in reserved-quota-harness.ts is expected to collect a snapshot
// after EACH verb call and run `evaluateCapacityInvariantAcrossTransitions`
// over the whole sequence, not just before/after the scenario as a whole.

import type {
  CapacityChargeOrigin,
  CapacityChargeRecord,
  CapacitySnapshot,
  ConcurrentCapacityResult,
  GroundedReservation,
  ReservedQuotaInspectable,
} from './reserved-quota-protocol'

/* -------------------------------------------------------------------------- */
/* The core invariant — Fase 2/4                                              */
/* -------------------------------------------------------------------------- */

/** `Consumed + LiveReserved <= Limit`, checked on ONE snapshot. Also rejects a
 *  negative consumed/liveReserved outright — those are nonsensical regardless
 *  of the limit, and a model that could produce one would corrupt the
 *  invariant it is supposed to protect. */
export function evaluateCapacityInvariant(snapshot: CapacitySnapshot): string[] {
  const violations: string[] = []
  if (snapshot.consumed + snapshot.liveReserved > snapshot.limit) {
    violations.push(
      `capacity invariant violated for organization ${snapshot.organizationId} period ${snapshot.periodKey}: consumed(${snapshot.consumed}) + liveReserved(${snapshot.liveReserved}) > limit(${snapshot.limit})`,
    )
  }
  if (snapshot.consumed < 0) violations.push(`consumed is negative (${snapshot.consumed}) for organization ${snapshot.organizationId} period ${snapshot.periodKey}`)
  if (snapshot.liveReserved < 0) violations.push(`liveReserved is negative (${snapshot.liveReserved}) for organization ${snapshot.organizationId} period ${snapshot.periodKey}`)
  return violations
}

/**
 * The SAME check, run over an entire ORDERED sequence of snapshots — one
 * taken after every verb call in a scenario. "No basta con comprobar el
 * estado final" (Fase 2): this is the function that makes that requirement
 * mechanical rather than a comment. Each violation is tagged with the
 * transition index it came from, so a scenario that oversells transiently and
 * recovers still names the exact step where it happened.
 */
export function evaluateCapacityInvariantAcrossTransitions(snapshots: readonly CapacitySnapshot[]): string[] {
  return snapshots.flatMap((snapshot, index) => evaluateCapacityInvariant(snapshot).map((violation) => `[transition ${index}] ${violation}`))
}

/* -------------------------------------------------------------------------- */
/* Fase 4's four positive proofs                                              */
/* -------------------------------------------------------------------------- */

/** "complete convierte reserva en cargo" — the reservation's own status and
 *  chargeId, AND the charge ledger, must agree that exactly one charge exists
 *  for this reservation. */
export function evaluateReservationConvertsToCharge(protocol: ReservedQuotaInspectable, reservationId: string): string[] {
  const violations: string[] = []
  const reservation = protocol.allReservations().find((r) => r.reservationId === reservationId)
  if (!reservation) {
    violations.push(`reservation ${reservationId} not found after completion`)
    return violations
  }
  if (reservation.status !== 'completed') violations.push(`reservation ${reservationId} status is "${reservation.status}", expected "completed"`)
  if (reservation.chargeId === null) violations.push(`reservation ${reservationId} carries no chargeId after completion`)
  const charges = protocol.chargesFor(reservationId)
  if (charges.length !== 1) violations.push(`reservation ${reservationId} has ${charges.length} charge row(s) in the ledger, expected exactly 1`)
  if (reservation.chargeId !== null && charges.length === 1 && charges[0]!.chargeId !== reservation.chargeId) {
    violations.push(`reservation ${reservationId}'s own chargeId (${reservation.chargeId}) does not match its ledger row's chargeId (${charges[0]!.chargeId})`)
  }
  return violations
}

/** "no quedan simultáneamente reserva y cargo" — scanned across EVERY
 *  reservation the protocol has ever seen, not just the one under test: a
 *  'reserved' status must never carry a chargeId, and a 'completed' one must
 *  carry EXACTLY one ledger row, never zero, never more than one. */
export function evaluateNoSimultaneousReservationAndCharge(protocol: ReservedQuotaInspectable): string[] {
  const violations: string[] = []
  for (const reservation of protocol.allReservations()) {
    if (reservation.status === 'reserved' && reservation.chargeId !== null) {
      violations.push(`reservation ${reservation.reservationId} is "reserved" but already carries chargeId ${reservation.chargeId} — a live reservation and a charge must never coexist`)
    }
    if (reservation.status === 'completed') {
      const charges = protocol.chargesFor(reservation.reservationId)
      if (charges.length !== 1) {
        violations.push(`completed reservation ${reservation.reservationId} has ${charges.length} charge row(s), expected exactly 1`)
      }
    }
    if ((reservation.status === 'aborted' || reservation.status === 'expired') && reservation.chargeId !== null) {
      violations.push(`reservation ${reservation.reservationId} is "${reservation.status}" but carries chargeId ${reservation.chargeId} — an aborted/expired reservation must never have charged`)
    }
  }
  return violations
}

/** "la unidad no se disputa de nuevo" — a replay (retry, or a second
 *  completeGroundedReservation on an already-completed reservation) must move
 *  neither `consumed` nor `liveReserved`. Takes the two snapshots straddling
 *  the replay call, exactly like idempotency-oracle.ts's own before/after
 *  comparison. */
export function evaluateUnitNotRedisputed(before: CapacitySnapshot, after: CapacitySnapshot): string[] {
  const violations: string[] = []
  if (before.consumed !== after.consumed) {
    violations.push(`consumed moved from ${before.consumed} to ${after.consumed} across what should have been a replay — the unit was re-disputed`)
  }
  if (before.liveReserved !== after.liveReserved) {
    violations.push(`liveReserved moved from ${before.liveReserved} to ${after.liveReserved} across what should have been a replay`)
  }
  return violations
}

export interface ChargeAttributionExpectation {
  readonly chargeId: string
  readonly expectedOrganizationId: string
  readonly expectedProjectId: string
  readonly expectedOrigin: CapacityChargeOrigin
}

/** "la atribución del cargo sigue correcta" — organization, project AND
 *  origin (grounded vs. the specific sibling category) must all match, not
 *  merely "a charge exists somewhere". */
export function evaluateChargeAttribution(charge: CapacityChargeRecord | undefined, expectation: ChargeAttributionExpectation): string[] {
  const violations: string[] = []
  if (!charge) {
    violations.push(`no charge record found for chargeId ${expectation.chargeId}`)
    return violations
  }
  if (charge.organizationId !== expectation.expectedOrganizationId) {
    violations.push(`charge ${charge.chargeId} attributed to organization "${charge.organizationId}", expected "${expectation.expectedOrganizationId}"`)
  }
  if (charge.projectId !== expectation.expectedProjectId) {
    violations.push(`charge ${charge.chargeId} attributed to project "${charge.projectId}", expected "${expectation.expectedProjectId}"`)
  }
  if (charge.origin !== expectation.expectedOrigin) {
    violations.push(`charge ${charge.chargeId} attributed to origin "${charge.origin}", expected "${expectation.expectedOrigin}"`)
  }
  return violations
}

/* -------------------------------------------------------------------------- */
/* General-purpose delta oracle — mirrors idempotency-oracle.ts's shape       */
/* -------------------------------------------------------------------------- */

export interface CapacityOracleExpectation {
  /** How many NEW charge rows this scenario's final action is allowed to have
   *  produced, beyond whatever existed before it ran. */
  readonly additionalConsumed: number
  /** When provided, `liveReserved` must have moved by EXACTLY this delta —
   *  omit when a scenario does not assert the reservation count. */
  readonly liveReservedDelta?: number
  readonly expectedChargeReservationId?: string
  readonly expectedChargeCategory?: CapacityChargeOrigin
}

export function evaluateCapacityOracle(
  before: CapacitySnapshot,
  after: CapacitySnapshot,
  allChargesAfter: readonly CapacityChargeRecord[],
  expectation: CapacityOracleExpectation,
): string[] {
  const violations: string[] = []

  const consumedDelta = after.consumed - before.consumed
  if (consumedDelta !== expectation.additionalConsumed) {
    violations.push(`consumed went from ${before.consumed} to ${after.consumed} (delta ${consumedDelta}), expected a delta of ${expectation.additionalConsumed}`)
  }

  if (expectation.liveReservedDelta !== undefined) {
    const liveDelta = after.liveReserved - before.liveReserved
    if (liveDelta !== expectation.liveReservedDelta) {
      violations.push(`liveReserved went from ${before.liveReserved} to ${after.liveReserved} (delta ${liveDelta}), expected a delta of ${expectation.liveReservedDelta}`)
    }
  }

  if (before.organizationId !== after.organizationId || before.limit !== after.limit) {
    violations.push('the oracle itself was pointed at two different organizations/limits — scenario is malformed')
  }

  violations.push(...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after))

  if (expectation.expectedChargeReservationId) {
    const forReservation = allChargesAfter.filter((c) => c.reservationId === expectation.expectedChargeReservationId)
    if (forReservation.length !== 1) {
      violations.push(`reservation ${expectation.expectedChargeReservationId} has ${forReservation.length} charge row(s) in the ledger, expected exactly 1`)
    } else if (expectation.expectedChargeCategory && forReservation[0]!.origin !== expectation.expectedChargeCategory) {
      violations.push(`the charge for reservation ${expectation.expectedChargeReservationId} has origin "${forReservation[0]!.origin}", expected "${expectation.expectedChargeCategory}"`)
    }
  } else if (expectation.additionalConsumed === 0) {
    // A "definitively zero charge" scenario must show zero NEW rows for the
    // whole ledger snapshot, not merely for one reservation — a
    // rejected/aborted/expired attempt that somehow charged under a
    // DIFFERENT reservation's row would pass a per-reservation check while
    // still spending a unit.
    if (consumedDelta !== 0) violations.push(`expected definitively zero charge, but the ledger consumed-count moved by ${consumedDelta}`)
  }

  return violations
}

/* -------------------------------------------------------------------------- */
/* Concurrency — "ganador en concurrencia"                                    */
/* -------------------------------------------------------------------------- */

function isWinningOutcome(result: ConcurrentCapacityResult): boolean {
  return result.kind === 'charged' || result.kind === 'reservation_held' || result.kind === 'consumed'
}
function isLosingOutcome(result: ConcurrentCapacityResult): boolean {
  return result.kind === 'quota_exceeded' || result.kind === 'quota_refused'
}

export interface ConcurrencyWinnerEvaluation {
  readonly winners: number
  readonly losers: number
  readonly unaccountedFor: number
  readonly violations: string[]
}

/** Exactly one attempt among a set racing for ONE unit of remaining capacity
 *  must win; every other one must be a named loser (quota_exceeded or
 *  quota_refused) — never silently unaccounted for. */
export function evaluateExactlyOneWinner(results: readonly ConcurrentCapacityResult[]): ConcurrencyWinnerEvaluation {
  const winners = results.filter(isWinningOutcome).length
  const losers = results.filter(isLosingOutcome).length
  const unaccountedFor = results.length - winners - losers
  const violations: string[] = []
  if (winners !== 1) {
    violations.push(`expected exactly 1 winner among ${results.length} concurrent attempts racing for one unit, got ${winners} (kinds: ${results.map((r) => r.kind).join(', ')})`)
  }
  if (unaccountedFor !== 0) {
    violations.push(`${unaccountedFor} concurrent attempt(s) resolved to neither a winning nor a losing outcome — every attempt must be accounted for`)
  }
  return { winners, losers, unaccountedFor, violations }
}

/* -------------------------------------------------------------------------- */
/* Per-transition inspection — Fase 4's ten inspected dimensions              */
/* -------------------------------------------------------------------------- */

export interface CapacityTransitionInspection {
  readonly limit: number
  readonly consumed: number
  readonly liveReserved: number
  readonly expiredReservations: number
  readonly completedReservations: number
  readonly organizationId: string
  readonly periodKey: string
  readonly charges: readonly CapacityChargeRecord[]
  readonly reservations: readonly GroundedReservation[]
}

/**
 * One call captures every dimension Fase 4 lists — limit, charges, live
 * reservations, expired reservations, completed operations, project,
 * organization, category (via `charges[].origin`/`charges[].projectId`),
 * period, and (separately, via `evaluateExactlyOneWinner`) the winner in a
 * concurrent race. Harness case functions call this after each verb, not
 * only at the start and the end.
 */
export function inspectTransition(
  protocol: ReservedQuotaInspectable,
  organizationId: string,
  periodKey: string,
  limit: number,
): CapacityTransitionInspection {
  const reservations = protocol.allReservations().filter((r) => r.scope.organizationId === organizationId)
  const charges = protocol.allCharges().filter((c) => c.organizationId === organizationId && c.periodKey === periodKey)
  return {
    limit,
    consumed: charges.length,
    liveReserved: reservations.filter((r) => r.status === 'reserved').length,
    expiredReservations: reservations.filter((r) => r.status === 'expired').length,
    completedReservations: reservations.filter((r) => r.status === 'completed').length,
    organizationId,
    periodKey,
    charges,
    reservations,
  }
}
