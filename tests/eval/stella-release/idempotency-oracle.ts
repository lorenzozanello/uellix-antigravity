// tests/eval/stella-release/idempotency-oracle.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 3.
//
// The quota oracle. Every assertion here reads ticket-protocol.ts's ledger
// surface (QuotaLedgerInspectable) — never an HTTP status code, never a UI
// string. "No aceptes como evidencia únicamente un estado HTTP o código de
// UI" is enforced structurally: nothing in this file, or in
// idempotency-harness.ts, ever constructs or reads anything resembling a
// response status. The only inputs are `QuotaLedgerSnapshot` (before/after),
// `ChargeRecord[]` and `OperationOutcome` — all of which come straight out of
// the reference protocol's own state, the same "the check and its evidence
// are the SAME evaluator" discipline harness.ts's negative-controls.ts
// documents at length.

import type { ChargeRecord, OperationOutcome, QuotaLedgerSnapshot } from './ticket-protocol'

export interface QuotaOracleExpectation {
  /** How many NEW charge rows this scenario's final action is allowed to have
   *  produced, beyond whatever existed before it ran. */
  readonly additionalCharges: number
  /** The ticket this scenario's charge (if any) must be attributable to —
   *  omit when the scenario expects zero charges. */
  readonly chargeableTicketId?: string
  /** When a charge IS expected, the idempotency key the oracle requires the
   *  charge to have used — proving the EFFECTIVE key, not merely that some
   *  key was used. */
  readonly expectedIdempotencyKey?: string
}

/**
 * Compares a before/after ledger pair plus the full charge log against one
 * expectation. Returns a list of violations (empty = clean) — the same shape
 * `evaluateTenantIsolation` and friends already use in harness.ts, so this
 * plugs into `controlExpectsViolations` from negative-controls.ts without any
 * adaptation.
 */
export function evaluateQuotaOracle(
  before: QuotaLedgerSnapshot,
  after: QuotaLedgerSnapshot,
  allChargesAfter: readonly ChargeRecord[],
  expectation: QuotaOracleExpectation,
): string[] {
  const violations: string[] = []

  const chargeDelta = after.used - before.used
  if (chargeDelta !== expectation.additionalCharges) {
    violations.push(
      `used went from ${before.used} to ${after.used} (delta ${chargeDelta}), expected a delta of ${expectation.additionalCharges}`,
    )
  }

  if (before.organizationId !== after.organizationId || before.quota !== after.quota) {
    violations.push('the quota ORACLE itself was pointed at two different organizations/quotas — scenario is malformed')
  }

  if (expectation.chargeableTicketId) {
    const forTicket = allChargesAfter.filter((c) => c.ticketId === expectation.chargeableTicketId)
    if (forTicket.length !== 1) {
      violations.push(
        `ticket ${expectation.chargeableTicketId} has ${forTicket.length} charge row(s) in the ledger, expected exactly 1`,
      )
    } else if (expectation.expectedIdempotencyKey && forTicket[0]!.idempotencyKey !== expectation.expectedIdempotencyKey) {
      violations.push(
        `the charge for ticket ${expectation.chargeableTicketId} used idempotency key "${forTicket[0]!.idempotencyKey}", expected "${expectation.expectedIdempotencyKey}" — the EFFECTIVE key charged does not match the ticket's own server-derived key`,
      )
    }
  } else if (expectation.additionalCharges === 0) {
    // A "definitively zero charge" scenario must show zero NEW rows for the
    // whole ledger snapshot, not merely for one ticket — an aborted/failed/
    // rejected ticket that somehow charged under a DIFFERENT ticket's row
    // would pass a per-ticket check while still spending a unit.
    if (chargeDelta !== 0) violations.push(`expected definitively zero charge, but the ledger used-count moved by ${chargeDelta}`)
  }

  return violations
}

/**
 * Fase 3's explicit list of what "the good case" must prove, each stated as
 * one oracle call so a single failing bullet names itself rather than hiding
 * inside a combined boolean.
 */
export interface GoodPathOracleProof {
  readonly oneCompletedOperationOneCharge: string[]
  readonly retryProducesZeroAdditionalCharges: string[]
  readonly newOperationProducesOneAdditionalCharge: string[]
  readonly abortProducesZeroDefinitiveCharge: string[]
  readonly failureProducesZeroDefinitiveCharge: string[]
  readonly crossScopeTicketProducesZeroCharge: string[]
  readonly replayWithDifferentQueryIsZeroChargeAndRejected: readonly [violations: string[], wasRejected: boolean]
}

/** True iff every proof in the bundle is clean — zero violations everywhere,
 *  and the replay-with-different-query case was in fact rejected (not merely
 *  zero-charge by accident). */
export function goodPathProofHolds(proof: GoodPathOracleProof): boolean {
  const [replayViolations, wasRejected] = proof.replayWithDifferentQueryIsZeroChargeAndRejected
  return (
    proof.oneCompletedOperationOneCharge.length === 0 &&
    proof.retryProducesZeroAdditionalCharges.length === 0 &&
    proof.newOperationProducesOneAdditionalCharge.length === 0 &&
    proof.abortProducesZeroDefinitiveCharge.length === 0 &&
    proof.failureProducesZeroDefinitiveCharge.length === 0 &&
    proof.crossScopeTicketProducesZeroCharge.length === 0 &&
    replayViolations.length === 0 &&
    wasRejected
  )
}

/** Whether an OperationOutcome represents a REJECTION in the oracle's sense —
 *  used to satisfy the "replay with different query = zero charge AND
 *  rejection" bullet, which needs both halves proven, not just the charge
 *  count. */
export function outcomeWasRejected(outcome: OperationOutcome): boolean {
  return outcome.kind === 'rejected' || outcome.kind === 'expired'
}
