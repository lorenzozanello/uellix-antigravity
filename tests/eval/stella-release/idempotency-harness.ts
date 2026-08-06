// tests/eval/stella-release/idempotency-harness.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1),
// Fases 2-4. One function per idempotency-matrix.ts `caseId`, exercising the
// reference model in ticket-protocol.ts. Fully offline: no network, no DB, no
// provider — the reference protocol is a deterministic in-memory model, never
// a claim about a real database.
//
// Same discipline as harness.ts: every case's clean run and its attached
// negative controls run through the SAME evaluator function. `withControls`
// below reuses `undetectedControls`/`describeUndetected` from
// negative-controls.ts rather than reimplementing the tautology check — the
// two harnesses must not be able to disagree about what "detected" means.

import { stellaConfig } from '@/lib/stella/config'
import {
  controlExpectsViolations,
  controlExpectsVerdict,
  undetectedControls,
  describeUndetected,
  type NegativeControlResult,
} from './negative-controls'
import {
  createReferenceTicketProtocol,
  attemptClientSuppliedIdempotencyKey,
  attemptClientSuppliedScope,
  TicketAbortedError,
  TicketAlreadyCompletedError,
  TicketExpiredError,
  TicketNotFoundError,
  TicketNotReservedError,
  TicketQueryMismatchError,
  TicketScopeViolationError,
  type OperationTicketReferenceProtocol,
  type TicketProtocolDefect,
  type TicketScope,
} from './ticket-protocol'
import { evaluateQuotaOracle } from './idempotency-oracle'
import { validateObservabilityEvent, STELLA_OBSERVABILITY_EVENT_NAMES } from './observability-contract'
import { IDEMPOTENCY_MATRIX, IDEMPOTENCY_MATRIX_VERSION, validateIdempotencyMatrix } from './idempotency-matrix'

export const IDEMPOTENCY_HARNESS_VERSION = '1.0.0'

export type IdempotencyCaseOutcome = 'pass' | 'system-error'

export interface IdempotencyCaseResult {
  caseId: string
  ok: boolean
  outcome: IdempotencyCaseOutcome
  detail: string
  negativeControls: NegativeControlResult[]
}

function withControls(
  base: Omit<IdempotencyCaseResult, 'negativeControls'>,
  controls: readonly NegativeControlResult[],
): IdempotencyCaseResult {
  const list = [...controls]
  if (undetectedControls(list).length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'system-error',
      detail: `TAUTOLOGICAL — this check cannot fail: ${describeUndetected(list)} (clean run said: ${base.detail})`,
      negativeControls: list,
    }
  }
  return { ...base, negativeControls: list }
}

function describeErr(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/* -------------------------------------------------------------------------- */
/* Fixtures — two organizations, org-alpha with two projects and two actors   */
/* -------------------------------------------------------------------------- */

const ORG_A: TicketScope = { organizationId: 'idem-org-alpha', projectId: 'idem-project-alpha-1', actorId: 'idem-actor-alpha-1' }
const ORG_A_OTHER_PROJECT: TicketScope = { ...ORG_A, projectId: 'idem-project-alpha-2' }
const ORG_A_OTHER_ACTOR: TicketScope = { ...ORG_A, actorId: 'idem-actor-alpha-2' }
const ORG_B: TicketScope = { organizationId: 'idem-org-beta', projectId: 'idem-project-beta-1', actorId: 'idem-actor-beta-1' }

const AMPLE_QUOTAS = { [ORG_A.organizationId]: 100, [ORG_B.organizationId]: 100 }
const DEFAULT_TTL = 10

function freshProtocol(defect?: TicketProtocolDefect, quotas: Readonly<Record<string, number>> = AMPLE_QUOTAS, ticketTtl = DEFAULT_TTL): OperationTicketReferenceProtocol {
  return createReferenceTicketProtocol({ quotas, ticketTtl, defect })
}

/* -------------------------------------------------------------------------- */
/* first-execution-charges-once                                               */
/* -------------------------------------------------------------------------- */

function checkFirstExecutionChargesOnce(): IdempotencyCaseResult {
  const caseId = 'first-execution-charges-once'
  const protocol = freshProtocol()
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-first-execution', 1)
  const outcome = protocol.complete(ticket.ticketId, ORG_A, 2)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), {
    additionalCharges: 1,
    chargeableTicketId: ticket.ticketId,
    expectedIdempotencyKey: ticket.idempotencyKey,
  })
  if (outcome.kind !== 'charged') violations.push(`complete() returned kind="${outcome.kind}", expected "charged"`)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: `ticket ${ticket.ticketId} charged exactly once, attributable via its own idempotency key` },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* retry-same-ticket-same-query-charges-once                                  */
/* -------------------------------------------------------------------------- */

function evaluateRetrySameQueryIsFree(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-retry', 1)
  const firstOutcome = protocol.complete(ticket.ticketId, ORG_A, 2)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const retryOutcome = protocol.retry(ticket.ticketId, ORG_A, 'q-retry', 3)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 })
  if (firstOutcome.kind !== 'charged') violations.push(`first complete() returned "${firstOutcome.kind}", expected "charged"`)
  if (retryOutcome.kind !== 'replayed') violations.push(`retry() of an already-completed ticket returned "${retryOutcome.kind}", expected "replayed"`)
  if (retryOutcome.chargeId !== firstOutcome.chargeId) violations.push('retry() reported a DIFFERENT chargeId than the original completion')
  return violations
}

/**
 * Models the CALLER bug named explicitly in the Fase 4 list — "UUID nuevo
 * por retry": an orchestrator that calls `issue()` again on every retry
 * instead of holding onto the ticket it already has and calling `retry()`.
 * Not a protocol defect (the protocol behaves correctly; `issue()` minting a
 * fresh ticket every time it is called is the CORRECT behaviour for a truly
 * new operation) — this reproduces the failure at the CALL SITE, against the
 * healthy protocol, using the same quota oracle the good case uses.
 */
function evaluateReissuingOnEveryRetryDoubleCharges(): string[] {
  const protocol = freshProtocol()
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  for (let attempt = 0; attempt < 2; attempt++) {
    const ticket = protocol.issue(ORG_A, attempt) // BUG: fresh ticket every "retry"
    protocol.bind(ticket.ticketId, ORG_A, 'q-reissue-bug', attempt)
    protocol.complete(ticket.ticketId, ORG_A, attempt)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  return evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 1 })
}

function checkRetrySameTicketSameQueryChargesOnce(): IdempotencyCaseResult {
  const caseId = 'retry-same-ticket-same-query-charges-once'
  const controls = [
    controlExpectsViolations(
      'nc-complete-not-idempotent',
      'a protocol whose complete()/retry() re-charges an already-completed ticket must be caught by this same evaluator',
      () => evaluateRetrySameQueryIsFree('complete-not-idempotent'),
    ),
    controlExpectsViolations(
      'nc-caller-reissues-ticket-on-every-retry',
      'an orchestrator that mints a fresh ticket on every retry instead of reusing the one it was given must be caught double-charging, using the SAME oracle the good case uses',
      evaluateReissuingOnEveryRetryDoubleCharges,
    ),
  ]
  const violations = evaluateRetrySameQueryIsFree()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'retry() with the same ticket and the same query reports replayed, zero additional charge' }, controls)
}

/* -------------------------------------------------------------------------- */
/* new-ticket-same-query-text-charges-again                                   */
/* -------------------------------------------------------------------------- */

function evaluateNewOperationChargesAgain(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const ticketA = protocol.issue(ORG_A, 0)
  protocol.bind(ticketA.ticketId, ORG_A, 'same-query-text', 1)
  const firstOutcome = protocol.complete(ticketA.ticketId, ORG_A, 2)

  // A SECOND, independently-issued ticket for the SAME organization, bound to
  // the identical query TEXT — a reviewer legitimately asking the same
  // question twice (e.g. after uploading new evidence).
  const ticketB = protocol.issue(ORG_A, 3)
  protocol.bind(ticketB.ticketId, ORG_A, 'same-query-text', 4)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const secondOutcome = protocol.complete(ticketB.ticketId, ORG_A, 5)
  const after = protocol.snapshotLedger(ORG_A.organizationId)

  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), {
    additionalCharges: 1,
    chargeableTicketId: ticketB.ticketId,
    expectedIdempotencyKey: ticketB.idempotencyKey,
  })
  if (firstOutcome.kind !== 'charged') violations.push(`ticket A did not charge: "${firstOutcome.kind}"`)
  if (secondOutcome.kind !== 'charged') violations.push(`ticket B (same text, new ticket) returned "${secondOutcome.kind}", expected "charged" — a new question was silently deduplicated`)
  if (ticketA.idempotencyKey === ticketB.idempotencyKey) violations.push('ticket A and ticket B share an idempotency key despite being independently issued')
  return violations
}

function checkNewTicketSameQueryTextChargesAgain(): IdempotencyCaseResult {
  const caseId = 'new-ticket-same-query-text-charges-again'
  const controls = [
    controlExpectsViolations(
      'nc-idempotency-key-from-query-hash',
      'a protocol that derives the idempotency key from the QUERY text (not the ticket identity) must be caught silently deduplicating a second, legitimate question',
      () => evaluateNewOperationChargesAgain('idempotency-key-from-query-hash'),
    ),
    controlExpectsViolations(
      'nc-idempotency-key-from-timestamp-bucket',
      'a protocol that derives the idempotency key from a time bucket must be caught colliding two unrelated tickets issued in the same window',
      () => evaluateNewOperationChargesAgain('idempotency-key-from-timestamp-bucket'),
    ),
  ]
  const violations = evaluateNewOperationChargesAgain()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a second, independently-issued ticket for the same query text charges a second unit — no discount for legitimately repeated questions' }, controls)
}

/* -------------------------------------------------------------------------- */
/* same-ticket-different-query-text-rejected                                  */
/* -------------------------------------------------------------------------- */

function evaluateQueryMismatchRejected(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'original-query-text', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const violations: string[] = []
  try {
    protocol.bind(ticket.ticketId, ORG_A, 'a-completely-different-query', 2)
    violations.push('re-binding an already-bound ticket to a DIFFERENT query fingerprint did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketQueryMismatchError)) violations.push(`rebind rejected for the wrong reason: ${describeErr(error)}`)
  }
  const retryOutcome = protocol.retry(ticket.ticketId, ORG_A, 'yet-another-different-query', 3)
  if (retryOutcome.kind !== 'rejected' || retryOutcome.reason !== 'query_mismatch') {
    violations.push(`retry() with a mismatched query returned ${JSON.stringify(retryOutcome)}, expected {kind:"rejected", reason:"query_mismatch"}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  return violations
}

function checkSameTicketDifferentQueryTextRejected(): IdempotencyCaseResult {
  const caseId = 'same-ticket-different-query-text-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-query-fingerprint-rewritable',
      'a protocol that lets a bound ticket be silently repointed at a different query must be caught by this same evaluator',
      () => evaluateQueryMismatchRejected('query-fingerprint-rewritable'),
    ),
  ]
  const violations = evaluateQueryMismatchRejected()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a bound ticket presented with a different query text is rejected on rebind AND on retry, zero charge either way' }, controls)
}

/* -------------------------------------------------------------------------- */
/* cross-organization / cross-project / cross-actor                           */
/* -------------------------------------------------------------------------- */

function evaluateCrossScopeRejected(defect: TicketProtocolDefect | undefined, foreignScope: TicketScope): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-cross-scope', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const violations: string[] = []
  try {
    protocol.complete(ticket.ticketId, foreignScope, 2)
    violations.push('complete() presented with a foreign scope did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketScopeViolationError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const retryOutcome = protocol.retry(ticket.ticketId, foreignScope, 'q-cross-scope', 3)
  if (retryOutcome.kind !== 'rejected' || retryOutcome.reason !== 'scope_mismatch') {
    violations.push(`retry() with a foreign scope returned ${JSON.stringify(retryOutcome)}, expected {kind:"rejected", reason:"scope_mismatch"}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  return violations
}

// Differs from ORG_A ONLY in organizationId — isolates the axis under test.
// Using ORG_B outright would also differ in projectId/actorId, so a protocol
// that ignores organizationId would still be (correctly, but coincidentally)
// rejected on those other two axes, and the control would report a false
// "detected".
const ORG_B_SAME_PROJECT_AND_ACTOR: TicketScope = { ...ORG_A, organizationId: ORG_B.organizationId }

function checkCrossOrganizationTicketRejected(): IdempotencyCaseResult {
  const caseId = 'cross-organization-ticket-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-ticket-missing-organization-scope',
      'a protocol that drops organizationId from its scope comparison must be caught accepting a cross-organization presentation',
      () => evaluateCrossScopeRejected('ticket-missing-organization-scope', ORG_B_SAME_PROJECT_AND_ACTOR),
    ),
  ]
  const violations = evaluateCrossScopeRejected(undefined, ORG_B)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a ticket presented with a different organization is rejected on complete() and retry(), zero charge' }, controls)
}

function checkCrossProjectTicketRejected(): IdempotencyCaseResult {
  const caseId = 'cross-project-ticket-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-ticket-missing-project-scope',
      'a protocol that drops projectId from its scope comparison must be caught accepting a cross-project presentation within the same organization',
      () => evaluateCrossScopeRejected('ticket-missing-project-scope', ORG_A_OTHER_PROJECT),
    ),
  ]
  const violations = evaluateCrossScopeRejected(undefined, ORG_A_OTHER_PROJECT)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a ticket presented with a sibling project of the SAME organization is rejected, zero charge' }, controls)
}

function checkCrossActorTicketRejected(): IdempotencyCaseResult {
  const caseId = 'cross-actor-ticket-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-ticket-missing-actor-scope',
      'a protocol that drops actorId from its scope comparison must be caught letting a different member spend someone else\'s ticket',
      () => evaluateCrossScopeRejected('ticket-missing-actor-scope', ORG_A_OTHER_ACTOR),
    ),
  ]
  const violations = evaluateCrossScopeRejected(undefined, ORG_A_OTHER_ACTOR)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a ticket presented by a different actor of the SAME organization and project is rejected, zero charge' }, controls)
}

/* -------------------------------------------------------------------------- */
/* ticket-expired-rejected-not-charged                                        */
/* -------------------------------------------------------------------------- */

function evaluateExpiredTicketRejected(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect, AMPLE_QUOTAS, 2)
  const ticket = protocol.issue(ORG_A, 0) // expiresAt = 2
  protocol.bind(ticket.ticketId, ORG_A, 'q-expiry', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const farFuture = 100
  const violations: string[] = []

  // expire() FIRST, in isolation — complete()'s own expiry check has a side
  // effect (it transitions the ticket to 'expired' before throwing), which
  // would otherwise mask whether expire() itself does anything at all.
  const expired = protocol.expire(ticket.ticketId, farFuture)
  if (expired.status !== 'expired') violations.push(`expire() left status as "${expired.status}", expected "expired"`)

  try {
    protocol.complete(ticket.ticketId, ORG_A, farFuture)
    violations.push('complete() on a ticket past its expiresAt did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketExpiredError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  return violations
}

function checkExpiredTicketRejectedNotCharged(): IdempotencyCaseResult {
  const caseId = 'expired-ticket-rejected-not-charged'
  const controls = [
    controlExpectsViolations(
      'nc-ticket-missing-expiry',
      'a protocol that never enforces expiresAt must be caught completing a stale ticket',
      () => evaluateExpiredTicketRejected('ticket-missing-expiry'),
    ),
    controlExpectsViolations(
      'nc-reservation-never-recoverable',
      'a protocol whose expire() is a no-op must be caught leaving a stale reservation "reserved" forever instead of transitioning it',
      () => evaluateExpiredTicketRejected('reservation-never-recoverable'),
    ),
  ]
  const violations = evaluateExpiredTicketRejected()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a ticket past its expiresAt is rejected by complete() and transitioned by expire(), zero charge' }, controls)
}

/* -------------------------------------------------------------------------- */
/* nonexistent-ticket-rejected                                                */
/* -------------------------------------------------------------------------- */

function checkNonexistentTicketRejected(): IdempotencyCaseResult {
  const caseId = 'nonexistent-ticket-rejected'
  const protocol = freshProtocol()
  const violations: string[] = []
  try {
    protocol.complete('ticket-that-was-never-issued', ORG_A, 0)
    violations.push('complete() on an unknown ticketId did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketNotFoundError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const retryOutcome = protocol.retry('ticket-that-was-never-issued', ORG_A, 'q', 0)
  if (retryOutcome.kind !== 'rejected' || retryOutcome.reason !== 'ticket_not_found') {
    violations.push(`retry() on an unknown ticketId returned ${JSON.stringify(retryOutcome)}, expected {kind:"rejected", reason:"ticket_not_found"}`)
  }
  if (protocol.inspect('ticket-that-was-never-issued') !== null) violations.push('inspect() on an unknown ticketId did not return null')
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a ticketId the protocol never issued is rejected by complete()/retry() and inspects to null, never treated as a fresh operation' }, [])
}

/* -------------------------------------------------------------------------- */
/* failure-before-reserve / failure-after-reserve                             */
/* -------------------------------------------------------------------------- */

function checkFailureBeforeReserveChargesNothing(): IdempotencyCaseResult {
  const caseId = 'failure-before-reserve-charges-nothing'
  const protocol = freshProtocol()
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const ticket = protocol.issue(ORG_A, 0) // issued, then the orchestrator crashes before it can bind
  const violations: string[] = []
  try {
    protocol.complete(ticket.ticketId, ORG_A, 1)
    violations.push('complete() on a never-bound (issued-only) ticket did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketNotReservedError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a ticket that was issued but never bound charges zero units on any completion attempt' }, [])
}

function checkFailureAfterReserveChargesNothingUntilRetried(): IdempotencyCaseResult {
  const caseId = 'failure-after-reserve-charges-nothing-until-retried'
  const protocol = freshProtocol()
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-failure-after-reserve', 1) // reserved, then orchestration fails before complete()
  const midway = protocol.snapshotLedger(ORG_A.organizationId)
  const violations: string[] = evaluateQuotaOracle(before, midway, protocol.allCharges(), { additionalCharges: 0 })
  if (midway.activeReservations !== 1) violations.push(`activeReservations is ${midway.activeReservations} immediately after a failed-before-complete bind, expected 1 — the reservation must survive the failure`)

  // Recovery: a LATER retry() legitimately completes the same reserved ticket once.
  const retryOutcome = protocol.retry(ticket.ticketId, ORG_A, 'q-failure-after-reserve', 5)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(midway, after, protocol.allCharges(), { additionalCharges: 1, chargeableTicketId: ticket.ticketId, expectedIdempotencyKey: ticket.idempotencyKey }))
  if (retryOutcome.kind !== 'charged') violations.push(`recovery retry() returned "${retryOutcome.kind}", expected "charged"`)

  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a bound ticket whose orchestration fails before complete() charges zero units, and its reservation survives to be completed exactly once by a later retry' }, [])
}

/* -------------------------------------------------------------------------- */
/* explicit-abort / retry-after-abort                                         */
/* -------------------------------------------------------------------------- */

function evaluateAbortDefinitivelyChargesNothing(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-abort', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const aborted = protocol.abort(ticket.ticketId, ORG_A, 2)
  const violations: string[] = []
  if (defect !== 'abort-does-not-release' && aborted.status !== 'aborted') violations.push(`abort() left status as "${aborted.status}", expected "aborted"`)
  // The decisive assertion: an aborted ticket must never be completable.
  try {
    protocol.complete(ticket.ticketId, ORG_A, 3)
    violations.push('complete() on an aborted ticket did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketAbortedError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  return violations
}

function checkExplicitAbortChargesNothingDefinitively(): IdempotencyCaseResult {
  const caseId = 'explicit-abort-charges-nothing-definitively'
  const controls = [
    controlExpectsViolations(
      'nc-abort-does-not-release',
      'a protocol whose abort() does not actually block a later completion must be caught by this same evaluator',
      () => evaluateAbortDefinitivelyChargesNothing('abort-does-not-release'),
    ),
  ]
  const violations = evaluateAbortDefinitivelyChargesNothing()
  // Second half: a COMPLETED ticket cannot be aborted after the fact — abort
  // is only meaningful before a charge exists.
  const protocol = freshProtocol()
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-abort-after-complete', 1)
  protocol.complete(ticket.ticketId, ORG_A, 2)
  let abortAfterCompleteRejected = false
  try {
    protocol.abort(ticket.ticketId, ORG_A, 3)
  } catch (error) {
    abortAfterCompleteRejected = error instanceof TicketAlreadyCompletedError
  }
  if (!abortAfterCompleteRejected) violations.push('abort() on an already-completed ticket did not raise TicketAlreadyCompletedError')

  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'abort() releases a reserved ticket with zero charge, blocks any later completion, and refuses to abort an already-completed ticket' }, controls)
}

function checkRetryAfterAbortRejected(): IdempotencyCaseResult {
  const caseId = 'retry-after-abort-rejected'
  const evaluate = (defect?: TicketProtocolDefect): string[] => {
    const protocol = freshProtocol(defect)
    const ticket = protocol.issue(ORG_A, 0)
    protocol.bind(ticket.ticketId, ORG_A, 'q-retry-after-abort', 1)
    protocol.abort(ticket.ticketId, ORG_A, 2)
    const before = protocol.snapshotLedger(ORG_A.organizationId)
    const outcome = protocol.retry(ticket.ticketId, ORG_A, 'q-retry-after-abort', 3)
    const after = protocol.snapshotLedger(ORG_A.organizationId)
    const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 })
    if (outcome.kind !== 'rejected' || outcome.reason !== 'ticket_aborted') {
      violations.push(`retry() on an aborted ticket returned ${JSON.stringify(outcome)}, expected {kind:"rejected", reason:"ticket_aborted"}`)
    }
    return violations
  }
  const controls = [
    controlExpectsViolations(
      'nc-abort-does-not-release-retry-path',
      'a protocol whose abort() leaves a ticket retryable-into-a-charge must be caught by this same evaluator, via the retry() path specifically',
      () => evaluate('abort-does-not-release'),
    ),
  ]
  const violations = evaluate()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'retry() on an aborted ticket is rejected with ticket_aborted, zero charge — an abort cannot be resurrected into a charge' }, controls)
}

/* -------------------------------------------------------------------------- */
/* retry-after-complete-is-free (duplicate delivery)                          */
/* -------------------------------------------------------------------------- */

function checkRetryAfterCompleteIsFree(): IdempotencyCaseResult {
  const caseId = 'retry-after-complete-is-free'
  const controls = [
    controlExpectsViolations(
      'nc-complete-not-idempotent-duplicate-delivery',
      'a protocol that re-charges on a duplicate delivery (retry after an already-successful complete) must be caught by this same evaluator',
      () => evaluateRetrySameQueryIsFree('complete-not-idempotent'),
    ),
  ]
  const violations = evaluateRetrySameQueryIsFree()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a duplicate delivery of an already-completed ticket (indistinguishable at this layer from an application-level retry) is free either way' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* concurrency — same ticket, and last-unit across two distinct tickets       */
/* -------------------------------------------------------------------------- */

function evaluateConcurrentSameTicketChargesOnce(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-concurrent-same-ticket', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  protocol.simulateConcurrentAttempts([{ ticketId: ticket.ticketId, scope: ORG_A }, { ticketId: ticket.ticketId, scope: ORG_A }], 2)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  return evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 1, chargeableTicketId: ticket.ticketId, expectedIdempotencyKey: ticket.idempotencyKey })
}

function checkConcurrentSameTicketChargesOnce(): IdempotencyCaseResult {
  const caseId = 'concurrent-same-ticket-charges-once'
  const controls = [
    controlExpectsViolations(
      'nc-concurrent-double-charge-same-ticket',
      'a protocol without a serializing lock must be caught double-charging two concurrent attempts on the SAME ticket',
      () => evaluateConcurrentSameTicketChargesOnce('concurrent-double-charge'),
    ),
  ]
  const violations = evaluateConcurrentSameTicketChargesOnce()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'two simulated concurrent completions of the same ticket produce exactly one charge under the (locked) healthy model' }, controls)
}

function evaluateConcurrentLastUnitChargesOnce(defect?: TicketProtocolDefect): string[] {
  const protocol = createReferenceTicketProtocol({ quotas: { [ORG_A.organizationId]: 1 }, ticketTtl: DEFAULT_TTL, defect })
  const ticketA = protocol.issue(ORG_A, 0)
  const ticketB = protocol.issue(ORG_A, 0)
  protocol.bind(ticketA.ticketId, ORG_A, 'q-last-unit-a', 1)
  protocol.bind(ticketB.ticketId, ORG_A, 'q-last-unit-b', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const outcomes = protocol.simulateConcurrentAttempts(
    [{ ticketId: ticketA.ticketId, scope: ORG_A }, { ticketId: ticketB.ticketId, scope: ORG_A }],
    2,
  )
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 1 })
  const charged = outcomes.filter((o) => o.kind === 'charged').length
  const exhausted = outcomes.filter((o) => o.kind === 'quota_exceeded').length
  if (charged !== 1 || exhausted !== 1) {
    violations.push(`two distinct tickets racing for the last unit produced ${charged} charged + ${exhausted} quota_exceeded, expected exactly 1 + 1`)
  }
  return violations
}

function checkConcurrentDistinctTicketsLastUnitChargesOnce(): IdempotencyCaseResult {
  const caseId = 'concurrent-distinct-tickets-last-unit-charges-once'
  const controls = [
    controlExpectsViolations(
      'nc-concurrent-double-charge-last-unit',
      'a protocol without a serializing lock must be caught overselling the last unit of quota to two distinct, legitimately concurrent operations',
      () => evaluateConcurrentLastUnitChargesOnce('concurrent-double-charge'),
    ),
  ]
  const violations = evaluateConcurrentLastUnitChargesOnce()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'two distinct tickets racing for an organization\'s last unit of quota produce exactly one charge and one quota_exceeded under the (locked) healthy model' }, controls)
}

/* -------------------------------------------------------------------------- */
/* client cannot choose the idempotency key / the ticket scope                */
/* -------------------------------------------------------------------------- */

const FAKE_CLIENT_KEY = 'client-chosen-0000000000000000000000000000000000000000000000000000000000000000'.slice(0, 64)

function evaluateClientCannotChooseIdempotencyKey(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const { keyWasHonoured } = attemptClientSuppliedIdempotencyKey(protocol, ORG_A, 0, FAKE_CLIENT_KEY)
  return keyWasHonoured ? ['a client-supplied idempotency key WAS honoured — the ticket used it verbatim instead of a server-derived key'] : []
}

function checkClientCannotChooseIdempotencyKey(): IdempotencyCaseResult {
  const caseId = 'client-cannot-choose-idempotency-key'
  const controls = [
    controlExpectsViolations(
      'nc-client-supplied-idempotency-key-honoured',
      'an adapter that forwards a client-supplied idempotency key into issue() must be caught by this same evaluator',
      () => evaluateClientCannotChooseIdempotencyKey('client-supplied-idempotency-key-honoured'),
    ),
  ]
  const violations = evaluateClientCannotChooseIdempotencyKey()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a caller-offered idempotency key is never honoured — the ticket\'s effective key is always server-derived' }, controls)
}

function evaluateClientCannotChooseScope(defect?: TicketProtocolDefect): string[] {
  const protocol = freshProtocol(defect)
  const { scopeWasForged } = attemptClientSuppliedScope(protocol, ORG_A, ORG_B, 0)
  return scopeWasForged ? ['a client-requested scope WAS honoured instead of the authenticated session scope'] : []
}

function checkClientCannotChooseTicketScope(): IdempotencyCaseResult {
  const caseId = 'client-cannot-choose-ticket-scope'
  const controls = [
    controlExpectsViolations(
      'nc-client-supplied-scope-honoured',
      'an adapter that forwards a client-supplied scope into issue() must be caught by this same evaluator',
      () => evaluateClientCannotChooseScope('client-supplied-scope-honoured'),
    ),
  ]
  const violations = evaluateClientCannotChooseScope()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a caller-requested scope is never honoured — the ticket is always scoped to the authenticated session' }, controls)
}

/* -------------------------------------------------------------------------- */
/* feature-flag-off-blocks-issuance                                           */
/* -------------------------------------------------------------------------- */

function checkFeatureFlagOffBlocksIssuance(): IdempotencyCaseResult {
  const caseId = 'feature-flag-off-blocks-issuance'
  if (stellaConfig.isGroundedQueryEnabled) {
    return withControls(
      {
        caseId, ok: false, outcome: 'system-error',
        detail: 'STELLA_GROUNDED_QUERY_ENABLED is true in this environment — this harness cannot assume its own default and fails closed rather than passing on an unverified flag',
      },
      [],
    )
  }
  return withControls(
    {
      caseId, ok: true, outcome: 'pass',
      detail: 'STELLA_GROUNDED_QUERY_ENABLED is false; the real server action (app/actions/stella/grounded-query.ts step 1) gates on this before auth, quota or any ticket-protocol call, so a false flag means zero ticket operations happen at all',
    },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* ticket-lifecycle-events-carry-no-secrets                                   */
/* -------------------------------------------------------------------------- */

const TICKET_EVENT_NAMES = [
  'operation_ticket_issued', 'operation_ticket_bound', 'operation_ticket_expired',
  'grounded_query_reserved', 'grounded_query_completed', 'grounded_query_aborted', 'grounded_query_retried',
  'quota_consumed', 'quota_reuse_detected', 'replay_rejected',
] as const

function buildRepresentativeTicketEvent(eventName: (typeof TICKET_EVENT_NAMES)[number]) {
  const base = { eventName, timestamp: '2026-08-05T00:00:00.000Z', organizationId: ORG_A.organizationId, requestId: 'req-idempotency-1' }
  switch (eventName) {
    case 'operation_ticket_issued':
    case 'operation_ticket_bound':
    case 'operation_ticket_expired':
    case 'grounded_query_reserved':
    case 'grounded_query_aborted':
      return { ...base, ticketId: 'ticket-1' }
    case 'grounded_query_completed':
    case 'quota_consumed':
    case 'quota_reuse_detected':
      return { ...base, ticketId: 'ticket-1', chargeId: 'charge-1' }
    case 'grounded_query_retried':
      return { ...base, ticketId: 'ticket-1', attempt: 2 }
    case 'replay_rejected':
      return { ...base, ticketId: 'ticket-1', reasonCode: 'query_mismatch' }
  }
}

function checkTicketLifecycleEventsCarryNoSecrets(): IdempotencyCaseResult {
  const caseId = 'ticket-lifecycle-events-carry-no-secrets'
  const violations: string[] = []
  for (const name of TICKET_EVENT_NAMES) {
    if (!STELLA_OBSERVABILITY_EVENT_NAMES.includes(name)) {
      violations.push(`"${name}" is not declared in STELLA_OBSERVABILITY_EVENT_NAMES`)
      continue
    }
    const result = validateObservabilityEvent(buildRepresentativeTicketEvent(name))
    if (!result.ok) violations.push(`${name}: ${result.violations.join(' | ')}`)
  }
  const controls = [
    controlExpectsVerdict(
      'nc-ticket-event-query-text-rejected',
      'a ticket event carrying the raw query text must be rejected by the SAME observability contract every other Stella event uses',
      () => !validateObservabilityEvent({ ...buildRepresentativeTicketEvent('grounded_query_completed'), query: 'texto completo de la consulta del usuario' }).ok,
      true,
    ),
  ]
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: `all ${TICKET_EVENT_NAMES.length} ticket-lifecycle events validate clean against the shared observability contract` }, controls)
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

const CASES: Record<string, () => IdempotencyCaseResult> = {
  'first-execution-charges-once': checkFirstExecutionChargesOnce,
  'retry-same-ticket-same-query-charges-once': checkRetrySameTicketSameQueryChargesOnce,
  'new-ticket-same-query-text-charges-again': checkNewTicketSameQueryTextChargesAgain,
  'same-ticket-different-query-text-rejected': checkSameTicketDifferentQueryTextRejected,
  'cross-organization-ticket-rejected': checkCrossOrganizationTicketRejected,
  'cross-project-ticket-rejected': checkCrossProjectTicketRejected,
  'cross-actor-ticket-rejected': checkCrossActorTicketRejected,
  'expired-ticket-rejected-not-charged': checkExpiredTicketRejectedNotCharged,
  'nonexistent-ticket-rejected': checkNonexistentTicketRejected,
  'failure-before-reserve-charges-nothing': checkFailureBeforeReserveChargesNothing,
  'failure-after-reserve-charges-nothing-until-retried': checkFailureAfterReserveChargesNothingUntilRetried,
  'explicit-abort-charges-nothing-definitively': checkExplicitAbortChargesNothingDefinitively,
  'retry-after-abort-rejected': checkRetryAfterAbortRejected,
  'retry-after-complete-is-free': checkRetryAfterCompleteIsFree,
  'concurrent-same-ticket-charges-once': checkConcurrentSameTicketChargesOnce,
  'concurrent-distinct-tickets-last-unit-charges-once': checkConcurrentDistinctTicketsLastUnitChargesOnce,
  'client-cannot-choose-idempotency-key': checkClientCannotChooseIdempotencyKey,
  'client-cannot-choose-ticket-scope': checkClientCannotChooseTicketScope,
  'feature-flag-off-blocks-issuance': checkFeatureFlagOffBlocksIssuance,
  'ticket-lifecycle-events-carry-no-secrets': checkTicketLifecycleEventsCarryNoSecrets,
}

export class IdempotencyHarnessError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'IdempotencyHarnessError'
  }
}

function assertCasesMatchMatrix(): void {
  const matrixIds = new Set(IDEMPOTENCY_MATRIX.map((e) => e.caseId))
  const caseIds = new Set(Object.keys(CASES))
  for (const id of matrixIds) if (!caseIds.has(id)) throw new IdempotencyHarnessError(`matrix entry "${id}" has no implemented case`)
  for (const id of caseIds) if (!matrixIds.has(id)) throw new IdempotencyHarnessError(`implemented case "${id}" has no matrix entry`)
}

export interface IdempotencyEvalSummary {
  harnessVersion: string
  matrixVersion: string
  totalCases: number
  passed: number
  failed: number
  negativeControlsRun: number
  negativeControlsUndetected: number
  tautologicalCases: string[]
}

export interface IdempotencyEvalRun {
  summary: IdempotencyEvalSummary
  results: IdempotencyCaseResult[]
}

/** Deterministic — no Date.now()/Math.random() anywhere in the reference
 *  model or the cases above; two calls produce byte-identical output. */
export function runIdempotencyEvalHarness(): IdempotencyEvalRun {
  validateIdempotencyMatrix(IDEMPOTENCY_MATRIX)
  assertCasesMatchMatrix()

  const results = IDEMPOTENCY_MATRIX.map((entry) => CASES[entry.caseId]!())
  const negativeControlsRun = results.reduce((n, r) => n + r.negativeControls.length, 0)
  const negativeControlsUndetected = results.reduce((n, r) => n + r.negativeControls.filter((c) => !c.detected).length, 0)
  const tautologicalCases = results.filter((r) => r.detail.startsWith('TAUTOLOGICAL')).map((r) => r.caseId)

  const summary: IdempotencyEvalSummary = {
    harnessVersion: IDEMPOTENCY_HARNESS_VERSION,
    matrixVersion: IDEMPOTENCY_MATRIX_VERSION,
    totalCases: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    negativeControlsRun,
    negativeControlsUndetected,
    tautologicalCases,
  }

  return { summary, results }
}

export function idempotencyEvalFailureReasons(summary: IdempotencyEvalSummary): string[] {
  const reasons: string[] = []
  if (summary.failed > 0) reasons.push(`${summary.failed}/${summary.totalCases} idempotency cases failed`)
  if (summary.negativeControlsUndetected > 0) reasons.push(`${summary.negativeControlsUndetected} negative control(s) failed to detect their mutation`)
  if (summary.tautologicalCases.length > 0) reasons.push(`tautological case(s): ${summary.tautologicalCases.join(', ')}`)
  return reasons
}
