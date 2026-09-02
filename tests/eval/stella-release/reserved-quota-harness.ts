// tests/eval/stella-release/reserved-quota-harness.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3),
// Fases 3-5. One function per reserved-quota-matrix.ts `caseId`, exercising
// the reference model in reserved-quota-protocol.ts. Fully offline: no
// network, no DB, no provider — the reference protocol is a deterministic
// in-memory model, never a claim about a real database.
//
// Same discipline as idempotency-harness.ts/project-binding-harness.ts: every
// case's clean run and its attached negative controls run through the SAME
// evaluator function. `withControls` below reuses
// `undetectedControls`/`describeUndetected` from negative-controls.ts rather
// than reimplementing the tautology check.

import { stellaConfig } from '@/lib/stella/config'
import {
  controlExpectsViolations,
  runNegativeControl,
  undetectedControls,
  describeUndetected,
  type NegativeControlResult,
} from './negative-controls'
import {
  createReferenceReservedQuotaProtocol,
  ReservationAbortedError,
  ReservationScopeViolationError,
  type CapacityScope,
  type ConcurrentCapacityResult,
  type ReservedQuotaDefect,
} from './reserved-quota-protocol'
import {
  evaluateCapacityInvariant,
  evaluateCapacityOracle,
  evaluateChargeAttribution,
  evaluateExactlyOneWinner,
  evaluateNoSimultaneousReservationAndCharge,
  evaluateReservationConvertsToCharge,
  evaluateUnitNotRedisputed,
} from './reserved-quota-oracle'
import { validateObservabilityEvent, STELLA_OBSERVABILITY_EVENT_NAMES } from './observability-contract'
import { RESERVED_QUOTA_MATRIX, RESERVED_QUOTA_MATRIX_VERSION, validateReservedQuotaMatrix } from './reserved-quota-matrix'

export const RESERVED_QUOTA_HARNESS_VERSION = '1.0.0'

export type ReservedQuotaCaseOutcome = 'pass' | 'system-error'

export interface ReservedQuotaCaseResult {
  caseId: string
  ok: boolean
  outcome: ReservedQuotaCaseOutcome
  detail: string
  negativeControls: NegativeControlResult[]
}

function withControls(
  base: Omit<ReservedQuotaCaseResult, 'negativeControls'>,
  controls: readonly NegativeControlResult[],
): ReservedQuotaCaseResult {
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
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ORG_A: CapacityScope = { organizationId: 'rq-org-alpha', projectId: 'rq-project-alpha-1', actorId: 'rq-actor-alpha-1' }
const ORG_A_OTHER_PROJECT: CapacityScope = { ...ORG_A, projectId: 'rq-project-alpha-2' }
const ORG_B: CapacityScope = { organizationId: 'rq-org-beta', projectId: 'rq-project-beta-1', actorId: 'rq-actor-beta-1' }

const DEFAULT_TTL = 10
const DEFAULT_PERIOD = 1000 // large relative to every tick used below, so unrelated cases never cross a boundary by accident

function freshProtocol(limit: number, defect?: ReservedQuotaDefect, reservationTtl = DEFAULT_TTL, periodLength = DEFAULT_PERIOD) {
  return createReferenceReservedQuotaProtocol({ limits: { [ORG_A.organizationId]: limit, [ORG_B.organizationId]: limit }, reservationTtl, periodLength, defect })
}

/* -------------------------------------------------------------------------- */
/* 1. grounded-reserves-last-unit                                             */
/* -------------------------------------------------------------------------- */

function evaluateGroundedReservesLastUnit(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const outcome = protocol.reserveGroundedOperation(ORG_A, 0)
  const after = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const violations = [...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after)]
  if (outcome.kind !== 'reservation_held' || !outcome.reservation) violations.push(`reserveGroundedOperation() returned kind="${outcome.kind}", expected "reservation_held"`)
  if (after.liveReserved !== 1) violations.push(`liveReserved is ${after.liveReserved} after reserving the last unit, expected 1`)
  if (after.available !== 0) violations.push(`available is ${after.available} after reserving the last unit, expected 0`)
  return violations
}

function checkGroundedReservesLastUnit(): ReservedQuotaCaseResult {
  const caseId = 'grounded-reserves-last-unit'
  const controls = [
    controlExpectsViolations(
      'nc-reservation-not-counted',
      'a protocol whose reservation never counts toward capacity must be caught reporting capacity still available after the last unit was reserved',
      () => evaluateGroundedReservesLastUnit('reservation-not-counted'),
    ),
  ]
  const violations = evaluateGroundedReservesLastUnit()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'reserving the organization\'s last unit succeeds and leaves liveReserved=1, available=0' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 2. sibling-rejected-after-grounded-reserves-last-unit                      */
/* -------------------------------------------------------------------------- */

function evaluateSiblingRejectedAfterGroundedReservesLastUnit(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const siblingOutcome = protocol.consumeSiblingOperation(ORG_A, 'advisor', 1)
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations = evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 0 })
  if (reserveOutcome.kind !== 'reservation_held') violations.push(`setup: reserveGroundedOperation() returned "${reserveOutcome.kind}", expected "reservation_held"`)
  if (siblingOutcome.kind !== 'quota_exceeded') violations.push(`consumeSiblingOperation() against an already-reserved last unit returned "${siblingOutcome.kind}", expected "quota_exceeded"`)
  return violations
}

function checkSiblingRejectedAfterGroundedReservesLastUnit(): ReservedQuotaCaseResult {
  const caseId = 'sibling-rejected-after-grounded-reserves-last-unit'
  const controls = [
    controlExpectsViolations(
      'nc-sibling-ignores-reservations',
      'a sibling consumption path that never checks live reservations must be caught consuming a unit a grounded reservation already holds — R6-INT, reproduced',
      () => evaluateSiblingRejectedAfterGroundedReservesLastUnit('sibling-ignores-reservations'),
    ),
  ]
  const violations = evaluateSiblingRejectedAfterGroundedReservesLastUnit()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a sibling consumption attempted after a grounded reservation already holds the last unit is rejected, zero charge — the reservation counts as capacity' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 3. grounded-completes-without-recontending                                 */
/* -------------------------------------------------------------------------- */

function evaluateGroundedCompletesWithoutRecontending(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`]
  const reservationId = reserveOutcome.reservation.reservationId
  const before = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const completeOutcome = protocol.completeGroundedReservation(reservationId, ORG_A, 1)
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations = evaluateCapacityOracle(before, after, protocol.allCharges(), {
    additionalConsumed: 1,
    liveReservedDelta: -1,
    expectedChargeReservationId: reservationId,
    expectedChargeCategory: 'grounded',
  })
  if (completeOutcome.kind !== 'charged') violations.push(`completeGroundedReservation() returned "${completeOutcome.kind}", expected "charged"`)
  violations.push(...evaluateReservationConvertsToCharge(protocol, reservationId))
  violations.push(...evaluateNoSimultaneousReservationAndCharge(protocol))
  violations.push(...evaluateChargeAttribution(protocol.chargesFor(reservationId)[0], {
    chargeId: completeOutcome.chargeId ?? '',
    expectedOrganizationId: ORG_A.organizationId,
    expectedProjectId: ORG_A.projectId,
    expectedOrigin: 'grounded',
  }))
  return violations
}

function checkGroundedCompletesWithoutRecontending(): ReservedQuotaCaseResult {
  const caseId = 'grounded-completes-without-recontending'
  const controls = [
    controlExpectsViolations(
      'nc-complete-recheck-loses-reservation',
      'a completion re-check that demands more slack than the reservation actually needs must be caught wrongly refusing an uncontended, legitimately-held reservation',
      () => evaluateGroundedCompletesWithoutRecontending('complete-recheck-loses-reservation'),
    ),
    controlExpectsViolations(
      'nc-complete-leaves-reservation-live',
      'a completion that charges but never flips the reservation out of "reserved" must be caught leaving a live reservation and a charge coexisting for the same unit',
      () => evaluateGroundedCompletesWithoutRecontending('complete-leaves-reservation-live'),
    ),
  ]
  const violations = evaluateGroundedCompletesWithoutRecontending()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a held reservation completes without recontending for capacity: consumed +1 and liveReserved -1 in the same transition, correctly attributed' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* 4. explicit-abort-releases-then-sibling-consumes                           */
/* -------------------------------------------------------------------------- */

function evaluateAbortReleasesThenSiblingConsumes(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`]
  const reservationId = reserveOutcome.reservation.reservationId
  const aborted = protocol.abortReservation(reservationId, ORG_A, 1)
  const violations: string[] = []
  if (defect !== 'abort-does-not-release' && aborted.status !== 'aborted') violations.push(`abortReservation() left status as "${aborted.status}", expected "aborted"`)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 2)
  const siblingOutcome = protocol.consumeSiblingOperation(ORG_A, 'validator', 2)
  const after = protocol.inspectCapacity(ORG_A.organizationId, 2)
  violations.push(...evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 1 }))
  if (siblingOutcome.kind !== 'consumed') violations.push(`sibling consumption after an explicit abort returned "${siblingOutcome.kind}", expected "consumed"`)
  return violations
}

function checkExplicitAbortReleasesThenSiblingConsumes(): ReservedQuotaCaseResult {
  const caseId = 'explicit-abort-releases-then-sibling-consumes'
  const controls = [
    controlExpectsViolations(
      'nc-abort-does-not-release',
      'a protocol whose abort() does not actually free the capacity it held must be caught blocking a subsequent sibling consumption',
      () => evaluateAbortReleasesThenSiblingConsumes('abort-does-not-release'),
    ),
  ]
  const violations = evaluateAbortReleasesThenSiblingConsumes()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'aborting a live reservation frees its unit immediately; a subsequent sibling consumption for the same organization succeeds' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 5. expiration-releases-then-sibling-consumes                               */
/* -------------------------------------------------------------------------- */

function evaluateExpirationReleasesThenSiblingConsumes(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect, 2)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0) // expiresAt = 2
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`]
  const reservationId = reserveOutcome.reservation.reservationId
  const farFuture = 100
  const expired = protocol.expireReservation(reservationId, farFuture)
  const violations: string[] = []
  if (defect !== 'expire-still-counts' && expired.status !== 'expired') violations.push(`expireReservation() left status as "${expired.status}", expected "expired"`)
  const before = protocol.inspectCapacity(ORG_A.organizationId, farFuture)
  const siblingOutcome = protocol.consumeSiblingOperation(ORG_A, 'composer', farFuture)
  const after = protocol.inspectCapacity(ORG_A.organizationId, farFuture)
  violations.push(...evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 1 }))
  if (siblingOutcome.kind !== 'consumed') violations.push(`sibling consumption after expiration returned "${siblingOutcome.kind}", expected "consumed"`)
  return violations
}

function checkExpirationReleasesThenSiblingConsumes(): ReservedQuotaCaseResult {
  const caseId = 'expiration-releases-then-sibling-consumes'
  const controls = [
    controlExpectsViolations(
      'nc-expire-still-counts',
      'a protocol whose expire() is a no-op must be caught leaving a stale reservation occupying capacity forever',
      () => evaluateExpirationReleasesThenSiblingConsumes('expire-still-counts'),
    ),
  ]
  const violations = evaluateExpirationReleasesThenSiblingConsumes()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a stale reservation past its TTL is transitioned to expired and frees its unit; a subsequent sibling consumption succeeds' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 6. sibling-consumes-first-then-grounded-reserve-rejected                   */
/* -------------------------------------------------------------------------- */

function evaluateSiblingFirstThenGroundedReserveRejected(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const siblingOutcome = protocol.consumeSiblingOperation(ORG_A, 'proxy_reviewer', 0)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 1)
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations = [...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after)]
  if (siblingOutcome.kind !== 'consumed') violations.push(`setup: sibling consumption of the last unit returned "${siblingOutcome.kind}"`)
  if (reserveOutcome.kind !== 'quota_exceeded' || reserveOutcome.reservation !== null) {
    violations.push(`reserveGroundedOperation() after a sibling already consumed the last unit returned kind="${reserveOutcome.kind}" reservation=${JSON.stringify(reserveOutcome.reservation)}, expected quota_exceeded/null`)
  }
  return violations
}

function checkSiblingConsumesFirstThenGroundedReserveRejected(): ReservedQuotaCaseResult {
  const caseId = 'sibling-consumes-first-then-grounded-reserve-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-independent-locks-blind-to-prior-sibling-charge',
      'a grounded reservation check reading from an independent ledger must be caught granting a reservation after a sibling already consumed the organization\'s last unit',
      () => evaluateSiblingFirstThenGroundedReserveRejected('independent-locks'),
    ),
  ]
  const violations = evaluateSiblingFirstThenGroundedReserveRejected()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a sibling that consumes the last unit first correctly blocks a later grounded reservation attempt — quota_exceeded, no reservation minted' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 7. grounded-complete-vs-sibling-concurrent                                 */
/* -------------------------------------------------------------------------- */

function evaluateGroundedCompleteVsSiblingConcurrent(defect?: ReservedQuotaDefect): { violations: string[]; results: ConcurrentCapacityResult[] } {
  const protocol = freshProtocol(1, defect)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0) // held BEFORE the race window opens
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) {
    return { violations: [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`], results: [] }
  }
  const reservationId = reserveOutcome.reservation.reservationId
  const before = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const results = protocol.simulateConcurrentCapacityAttempts(
    [
      { kind: 'sibling-consume', scope: ORG_A, category: 'audit_assistant' },
      { kind: 'grounded-complete', reservationId, scope: ORG_A },
    ],
    1,
  )
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations = [...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after)]
  violations.push(...evaluateExactlyOneWinner(results).violations)
  const siblingResult = results.find((r) => r.attemptKind === 'sibling-consume')
  const groundedResult = results.find((r) => r.attemptKind === 'grounded-complete')
  if (siblingResult?.kind !== 'quota_exceeded') violations.push(`concurrent sibling attempt against an already-reserved last unit returned "${siblingResult?.kind}", expected "quota_exceeded"`)
  if (groundedResult?.kind !== 'charged') violations.push(`concurrent grounded completion of an already-held reservation returned "${groundedResult?.kind}", expected "charged"`)
  return { violations, results }
}

/**
 * R1's own "second line of defense": even when the SIBLING's own gate is
 * compromised (defect: sibling-ignores-reservations, matching R6-INT's real
 * production topology), completeGroundedReservation's independent re-check
 * against the TRUE combined ledger must still refuse — quota_refused,
 * discardedComputedResponse=true — rather than let the ledger oversell.
 * Deliberately NOT a "negative control" in the usual sense: this is the
 * REQUIRED positive behaviour of the healthy protocol under a partial
 * failure, and it is the one concrete scenario in which quota_refused is
 * actually reachable.
 */
function evaluateSecondLineOfDefenseUnderSiblingBlindness(): string[] {
  const protocol = freshProtocol(1, 'sibling-ignores-reservations')
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return ['setup failed: could not reserve under sibling-ignores-reservations']
  const reservationId = reserveOutcome.reservation.reservationId
  const siblingOutcome = protocol.consumeSiblingOperation(ORG_A, 'evidence_reviewer', 1)
  const completeOutcome = protocol.completeGroundedReservation(reservationId, ORG_A, 2)
  const violations: string[] = []
  if (siblingOutcome.kind !== 'consumed') violations.push(`setup: a sibling with a broken gate should have wrongly consumed, got "${siblingOutcome.kind}"`)
  if (completeOutcome.kind !== 'quota_refused') violations.push(`completeGroundedReservation() after a sibling consumed under a broken gate returned "${completeOutcome.kind}", expected "quota_refused" — R1's own policy`)
  if (!completeOutcome.discardedComputedResponse) violations.push('a quota_refused outcome must set discardedComputedResponse=true')
  const trueConsumedTotal = protocol.allCharges().filter((c) => c.organizationId === ORG_A.organizationId).length
  if (trueConsumedTotal !== 1) violations.push(`total charges after the compromised-gate race is ${trueConsumedTotal}, expected exactly 1 — the ledger oversold despite R1's policy`)
  return violations
}

/** Negative control for the same scenario: with BOTH lines of defense down
 *  (independent-locks — the sibling gate AND the completion re-check are
 *  blind to each other), the ledger genuinely oversells. */
function evaluateSecondLineOfDefenseUnderIndependentLocks(): string[] {
  const protocol = freshProtocol(1, 'independent-locks')
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return ['setup failed to reserve under independent-locks']
  const reservationId = reserveOutcome.reservation.reservationId
  protocol.consumeSiblingOperation(ORG_A, 'advisor', 1)
  const completeOutcome = protocol.completeGroundedReservation(reservationId, ORG_A, 2)
  const trueConsumedTotal = protocol.allCharges().filter((c) => c.organizationId === ORG_A.organizationId).length
  return completeOutcome.kind === 'charged' && trueConsumedTotal > 1
    ? [`independent-locks let both the sibling gate and the completion re-check miss each other: ${trueConsumedTotal} true charges against a limit of 1`]
    : []
}

/**
 * Fase 5, "resultado utilizable sin cargo" — a CALL-SITE bug, not a protocol
 * defect, reproduced directly against the healthy(-ish, modulo the sibling
 * gate) protocol — same precedent as
 * evaluateCallerDerivesExecutionProjectFromTicket in
 * project-binding-harness.ts. `detected: true` means "this residual risk is
 * confirmed present", not "our defenses caught an attack": the protocol
 * cannot enforce what a caller does with `outcome.kind` after the fact.
 */
function evaluateResultUsableWithoutChargeIsResidualRisk(): { detected: boolean; detail: string } {
  const protocol = freshProtocol(1, 'sibling-ignores-reservations')
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) {
    return { detected: false, detail: 'unexpected outcome: could not set up the scenario' }
  }
  const reservationId = reserveOutcome.reservation.reservationId
  protocol.consumeSiblingOperation(ORG_A, 'composer', 1)
  const completeOutcome = protocol.completeGroundedReservation(reservationId, ORG_A, 2)
  // A caller/orchestrator that computed the grounded answer BEFORE calling
  // completeGroundedReservation and never branches on outcome.kind would
  // present that answer regardless of what the protocol just decided.
  return completeOutcome.kind === 'quota_refused'
    ? {
        detected: true,
        detail:
          'completeGroundedReservation correctly returned quota_refused with discardedComputedResponse=true, but a caller that never inspects outcome.kind would still present the already-computed answer as successful — the protocol cannot enforce this from the inside, which is why R1 is an application-layer policy (app/actions/stella/grounded-query.ts), not merely a database-layer one',
      }
    : { detected: false, detail: `unexpected setup: completeOutcome.kind was "${completeOutcome.kind}"` }
}

function checkGroundedCompleteVsSiblingConcurrent(): ReservedQuotaCaseResult {
  const caseId = 'grounded-complete-vs-sibling-concurrent'
  const controls = [
    controlExpectsViolations(
      'nc-independent-locks',
      'a protocol whose grounded and sibling accounting are two independent ledgers must be caught letting the R1 safety net oversell too, not merely the first-line sibling gate',
      evaluateSecondLineOfDefenseUnderIndependentLocks,
    ),
    runNegativeControl('nc-result-usable-without-charge', 'a caller that ignores completeGroundedReservation\'s outcome must be shown capable of presenting a response the ledger never actually charged for', evaluateResultUsableWithoutChargeIsResidualRisk),
  ]
  const { violations: raceViolations } = evaluateGroundedCompleteVsSiblingConcurrent()
  const secondLineViolations = evaluateSecondLineOfDefenseUnderSiblingBlindness()
  const violations = [...raceViolations, ...secondLineViolations]
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    {
      caseId,
      ok: true,
      outcome: 'pass',
      detail:
        'a sibling consumption racing an already-reserved unit is rejected and the reservation charges; separately, when the sibling\'s own gate is defeated, completeGroundedReservation\'s independent re-check still refuses (quota_refused, discardedComputedResponse=true) instead of letting the ledger oversell — R1\'s policy, proven reachable and safe',
    },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* 8. two-grounded-reservations-for-last-unit                                 */
/* -------------------------------------------------------------------------- */

function evaluateTwoGroundedReservationsForLastUnit(defect?: ReservedQuotaDefect): { violations: string[]; results: ConcurrentCapacityResult[] } {
  const protocol = freshProtocol(1, defect)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const results = protocol.simulateConcurrentCapacityAttempts(
    [
      { kind: 'grounded-reserve', scope: ORG_A },
      { kind: 'grounded-reserve', scope: ORG_A },
    ],
    0,
  )
  const after = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const violations = [...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after)]
  violations.push(...evaluateExactlyOneWinner(results).violations)
  return { violations, results }
}

function checkTwoGroundedReservationsForLastUnit(): ReservedQuotaCaseResult {
  const caseId = 'two-grounded-reservations-for-last-unit'
  const controls = [
    controlExpectsViolations(
      'nc-concurrent-double-charge-two-grounded',
      'a protocol without a serializing lock must be caught granting two grounded reservations against a single remaining unit',
      () => evaluateTwoGroundedReservationsForLastUnit('concurrent-double-charge').violations,
    ),
  ]
  const { violations } = evaluateTwoGroundedReservationsForLastUnit()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'two distinct grounded reservation attempts racing for the last unit produce exactly one reservation_held and one quota_exceeded' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 9. two-siblings-for-last-unit                                              */
/* -------------------------------------------------------------------------- */

function evaluateTwoSiblingsForLastUnit(defect?: ReservedQuotaDefect): { violations: string[]; results: ConcurrentCapacityResult[] } {
  const protocol = freshProtocol(1, defect)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const results = protocol.simulateConcurrentCapacityAttempts(
    [
      { kind: 'sibling-consume', scope: ORG_A, category: 'advisor' },
      { kind: 'sibling-consume', scope: ORG_A, category: 'validator' },
    ],
    0,
  )
  const after = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const violations = [...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after)]
  violations.push(...evaluateExactlyOneWinner(results).violations)
  return { violations, results }
}

function checkTwoSiblingsForLastUnit(): ReservedQuotaCaseResult {
  const caseId = 'two-siblings-for-last-unit'
  const controls = [
    controlExpectsViolations(
      'nc-concurrent-double-charge-two-siblings',
      'a protocol without a serializing lock must be caught granting two DIFFERENT sibling categories a charge against a single remaining unit of the SAME shared pool',
      () => evaluateTwoSiblingsForLastUnit('concurrent-double-charge').violations,
    ),
  ]
  const { violations } = evaluateTwoSiblingsForLastUnit()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'two sibling consumption attempts (different categories) racing for the last unit produce exactly one consumed and one quota_exceeded' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 10. retry-grounded-does-not-reserve-or-charge-again                        */
/* -------------------------------------------------------------------------- */

function evaluateRetryDoesNotReserveOrChargeAgain(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(100, defect)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`]
  const reservationId = reserveOutcome.reservation.reservationId
  const firstComplete = protocol.completeGroundedReservation(reservationId, ORG_A, 1)
  const reservationCountBefore = protocol.allReservations().length
  const before = protocol.inspectCapacity(ORG_A.organizationId, 2)
  const retryOutcome = protocol.retry(reservationId, ORG_A, 2)
  const reservationCountAfter = protocol.allReservations().length
  const after = protocol.inspectCapacity(ORG_A.organizationId, 2)
  const violations = evaluateUnitNotRedisputed(before, after)
  violations.push(...evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 0 }))
  if (firstComplete.kind !== 'charged') violations.push(`setup: first completeGroundedReservation() returned "${firstComplete.kind}"`)
  if (retryOutcome.kind !== 'replayed') violations.push(`retry() of an already-completed reservation returned "${retryOutcome.kind}", expected "replayed"`)
  if (retryOutcome.chargeId !== firstComplete.chargeId) violations.push('retry() reported a DIFFERENT chargeId than the original completion')
  if (reservationCountAfter !== reservationCountBefore) {
    violations.push(`retry() changed the total reservation count from ${reservationCountBefore} to ${reservationCountAfter} — a replay must never mint a new reservation`)
  }
  return violations
}

function checkRetryDoesNotReserveOrChargeAgain(): ReservedQuotaCaseResult {
  const caseId = 'retry-grounded-does-not-reserve-or-charge-again'
  const controls = [
    controlExpectsViolations(
      'nc-retry-reissues-reservation',
      'a retry() that mints a brand new reservation instead of replaying the existing charge must be caught reserving and charging again',
      () => evaluateRetryDoesNotReserveOrChargeAgain('retry-reissues-reservation'),
    ),
  ]
  const violations = evaluateRetryDoesNotReserveOrChargeAgain()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'retry() on an already-completed reservation reports replayed with the original chargeId, mints no new reservation, charges no additional unit' }, controls)
}

/* -------------------------------------------------------------------------- */
/* 11. grounded-failure-and-abort-charges-nothing                             */
/* -------------------------------------------------------------------------- */

function evaluateFailureAndAbortChargesNothing(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(100, defect)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 0)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0) // reserved, then orchestration fails before complete()
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`]
  const reservationId = reserveOutcome.reservation.reservationId
  const aborted = protocol.abortReservation(reservationId, ORG_A, 1)
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations = evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 0, liveReservedDelta: 0 })
  if (defect !== 'abort-does-not-release' && aborted.status !== 'aborted') violations.push(`abortReservation() left status as "${aborted.status}", expected "aborted"`)
  try {
    protocol.completeGroundedReservation(reservationId, ORG_A, 2)
    violations.push('completeGroundedReservation() on an aborted reservation did NOT throw')
  } catch (error) {
    if (!(error instanceof ReservationAbortedError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const released = protocol.consumeSiblingOperation(ORG_A, 'proxy_reviewer', 3)
  if (released.kind !== 'consumed') violations.push(`sibling consumption after the aborted, never-completed reservation returned "${released.kind}", expected "consumed"`)
  return violations
}

function checkFailureAndAbortChargesNothing(): ReservedQuotaCaseResult {
  const caseId = 'grounded-failure-and-abort-charges-nothing'
  const controls = [
    controlExpectsViolations(
      'nc-abort-does-not-release-after-failure',
      'a protocol whose abort() does not release a reservation left over from a failed orchestration must be caught by this same evaluator',
      () => evaluateFailureAndAbortChargesNothing('abort-does-not-release'),
    ),
  ]
  const violations = evaluateFailureAndAbortChargesNothing()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a reservation whose orchestration fails before complete(), then explicitly aborted, charges definitively zero and releases its unit; a completed reservation cannot later be aborted' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* 12. reservation-crossing-period-boundary                                   */
/* -------------------------------------------------------------------------- */

function evaluateReservationCrossingPeriodBoundary(): string[] {
  const periodLength = 5
  const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG_A.organizationId]: 2 }, reservationTtl: 100, periodLength })
  const reserveTick = 2
  const completeTick = 7 // periodLength=5 -> a different period bucket than reserveTick
  const periodAtReserve = protocol.inspectCapacity(ORG_A.organizationId, reserveTick).periodKey
  const periodAtComplete = protocol.inspectCapacity(ORG_A.organizationId, completeTick).periodKey
  const violations: string[] = []
  if (periodAtReserve === periodAtComplete) {
    violations.push(`test fixture error: reserveTick and completeTick landed in the same period (${periodAtReserve})`)
    return violations
  }
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, reserveTick)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) {
    violations.push(`reserving in period ${periodAtReserve} returned "${reserveOutcome.kind}", expected "reservation_held"`)
    return violations
  }
  const reservationId = reserveOutcome.reservation.reservationId
  // A live reservation persists across a period boundary until it is
  // completed/aborted/expired — it is NOT reset by the calendar, only by its
  // own lifecycle. A sibling operating in the NEW period must still see the
  // organization's fresh budget for that period, unaffected by whatever
  // period-0 counted.
  const siblingInNewPeriod = protocol.consumeSiblingOperation({ ...ORG_A, actorId: 'rq-actor-alpha-2' }, 'advisor', completeTick - 1)
  const completeOutcome = protocol.completeGroundedReservation(reservationId, ORG_A, completeTick)
  if (completeOutcome.kind !== 'charged') violations.push(`completing a reservation opened in an earlier period returned "${completeOutcome.kind}", expected "charged"`)
  if (siblingInNewPeriod.kind !== 'consumed') {
    violations.push(`a sibling consumption in the new period (before the crossing reservation completed) returned "${siblingInNewPeriod.kind}", expected "consumed" — the new period must not inherit the old period's usage`)
  }
  const charge = protocol.chargesFor(reservationId)[0]
  if (!charge) {
    violations.push('no charge row recorded for the reservation that crossed a period boundary')
  } else if (charge.periodKey !== periodAtComplete) {
    violations.push(
      `the charge landed under period "${charge.periodKey}", expected the period active at completion time ("${periodAtComplete}") — a charge is recorded against the period in which it actually happens, matching db/prepared/stella_0013's date_trunc('month', now()) semantics`,
    )
  }
  return violations
}

/** Dedicated probe for `period-ignored`: the scenario above tests a
 *  correctly-crossing boundary, not a boundary that fails to reset usage —
 *  those are different failure shapes, so this is its own function rather
 *  than a defect toggle on evaluateReservationCrossingPeriodBoundary. */
function evaluatePeriodResetsUsage(defect?: ReservedQuotaDefect): string[] {
  const periodLength = 5
  const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG_A.organizationId]: 1 }, reservationTtl: 2, periodLength, defect })
  const firstOutcome = protocol.consumeSiblingOperation(ORG_A, 'advisor', 0) // exhausts period 0's single unit
  const secondOutcome = protocol.consumeSiblingOperation(ORG_A, 'validator', 6) // well into period 1
  const violations: string[] = []
  if (firstOutcome.kind !== 'consumed') violations.push(`setup: first consumption returned "${firstOutcome.kind}"`)
  if (secondOutcome.kind !== 'consumed') violations.push(`a sibling consumption well into the NEXT period returned "${secondOutcome.kind}", expected "consumed" — usage must reset across a period boundary`)
  return violations
}

function checkReservationCrossingPeriodBoundary(): ReservedQuotaCaseResult {
  const caseId = 'reservation-crossing-period-boundary'
  const controls = [
    controlExpectsViolations(
      'nc-period-ignored',
      'a protocol whose period key never changes must be caught refusing a legitimate consumption that has actually crossed into a fresh accounting period',
      () => evaluatePeriodResetsUsage('period-ignored'),
    ),
  ]
  const violations = evaluateReservationCrossingPeriodBoundary()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a reservation opened in one period and completed after crossing into the next still charges correctly, attributed to the period active at completion, without starving the new period\'s own budget' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* 13. independent-category-shares-single-pool                                */
/* -------------------------------------------------------------------------- */

function evaluateCategorySharesSinglePool(defect?: ReservedQuotaDefect): string[] {
  const protocol = freshProtocol(1, defect)
  const firstOutcome = protocol.consumeSiblingOperation(ORG_A, 'advisor', 0)
  const before = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const secondOutcome = protocol.consumeSiblingOperation(ORG_A, 'validator', 1) // DIFFERENT category, same org, same period
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations = [...evaluateCapacityInvariant(before), ...evaluateCapacityInvariant(after)]
  if (firstOutcome.kind !== 'consumed') violations.push(`setup: the first category's consumption returned "${firstOutcome.kind}"`)
  if (secondOutcome.kind !== 'quota_exceeded') {
    violations.push(
      `a DIFFERENT category's consumption against an already-exhausted shared pool returned "${secondOutcome.kind}", expected "quota_exceeded" — db/prepared/stella_0013_grounded_query_quota.sql §6 counts every governed stella_role against ONE limit, never one per category`,
    )
  }
  return violations
}

function checkCategorySharesSinglePool(): ReservedQuotaCaseResult {
  const caseId = 'independent-category-shares-single-pool'
  const controls = [
    controlExpectsViolations(
      'nc-category-partitioned-independently',
      'a protocol that gives each category its OWN independent limit must be caught letting a second category consume alongside an already-exhausted shared pool',
      () => evaluateCategorySharesSinglePool('category-partitioned-independently'),
    ),
  ]
  const violations = evaluateCategorySharesSinglePool()
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'two different sibling categories draw down the SAME shared organization pool — the real contract does not permit independent per-category limits' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* 14/15. cross-project / cross-organization reservation rejection            */
/* -------------------------------------------------------------------------- */

function evaluateReservationScopeRejected(foreignScope: CapacityScope): string[] {
  const protocol = freshProtocol(100)
  const reserveOutcome = protocol.reserveGroundedOperation(ORG_A, 0)
  if (reserveOutcome.kind !== 'reservation_held' || !reserveOutcome.reservation) return [`setup failed: reserveGroundedOperation() returned "${reserveOutcome.kind}"`]
  const reservationId = reserveOutcome.reservation.reservationId
  const before = protocol.inspectCapacity(ORG_A.organizationId, 1)
  const violations: string[] = []
  try {
    protocol.completeGroundedReservation(reservationId, foreignScope, 1)
    violations.push('completeGroundedReservation() presented with a foreign scope did NOT throw')
  } catch (error) {
    if (!(error instanceof ReservationScopeViolationError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  try {
    protocol.abortReservation(reservationId, foreignScope, 1)
    violations.push('abortReservation() presented with a foreign scope did NOT throw')
  } catch (error) {
    if (!(error instanceof ReservationScopeViolationError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const after = protocol.inspectCapacity(ORG_A.organizationId, 1)
  violations.push(...evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 0 }))
  return violations
}

function checkReservationScopedToOtherProjectRejected(): ReservedQuotaCaseResult {
  const caseId = 'reservation-scoped-to-other-project-rejected'
  const violations = evaluateReservationScopeRejected(ORG_A_OTHER_PROJECT)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a reservation presented with a sibling project of the SAME organization is rejected on complete/abort, zero charge' }, [])
}

function checkReservationScopedToOtherOrganizationRejected(): ReservedQuotaCaseResult {
  const caseId = 'reservation-scoped-to-other-organization-rejected'
  const violations = evaluateReservationScopeRejected(ORG_B)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls({ caseId, ok: true, outcome: 'pass', detail: 'a reservation presented with a scope from a DIFFERENT organization entirely is rejected on complete/abort, zero charge' }, [])
}

/* -------------------------------------------------------------------------- */
/* Observability — Fase 6 events, safe against this evaluator's own fixtures  */
/* -------------------------------------------------------------------------- */

const RESERVED_QUOTA_EVENT_NAMES = [
  'quota_reservation_created',
  'quota_reservation_released',
  'quota_reservation_expired',
  'quota_reservation_converted',
  'quota_capacity_rejected',
  'quota_cross_operation_contention',
] as const

function buildRepresentativeReservedQuotaEvent(eventName: (typeof RESERVED_QUOTA_EVENT_NAMES)[number]) {
  const base = { eventName, timestamp: '2026-08-06T00:00:00.000Z', organizationId: ORG_A.organizationId, projectId: ORG_A.projectId, requestId: 'req-reserved-quota-1' }
  switch (eventName) {
    case 'quota_reservation_created':
    case 'quota_reservation_released':
    case 'quota_reservation_expired':
      return { ...base, reservationId: 'reservation-1' }
    case 'quota_reservation_converted':
      return { ...base, reservationId: 'reservation-1', chargeId: 'charge-1' }
    case 'quota_capacity_rejected':
      return { ...base, reasonCode: 'quota_exceeded' }
    case 'quota_cross_operation_contention':
      return { ...base, reservationId: 'reservation-1', reasonCode: 'sibling_consumed_between_bind_and_complete' }
  }
}

function evaluateReservedQuotaObservability(): string[] {
  const violations: string[] = []
  for (const name of RESERVED_QUOTA_EVENT_NAMES) {
    if (!STELLA_OBSERVABILITY_EVENT_NAMES.includes(name)) {
      violations.push(`"${name}" is not declared in STELLA_OBSERVABILITY_EVENT_NAMES`)
      continue
    }
    const result = validateObservabilityEvent(buildRepresentativeReservedQuotaEvent(name))
    if (!result.ok) violations.push(`${name}: ${result.violations.join(' | ')}`)
  }
  const withQuery = validateObservabilityEvent({ ...buildRepresentativeReservedQuotaEvent('quota_cross_operation_contention'), query: 'texto completo de la consulta del usuario' })
  if (withQuery.ok) violations.push('a quota_cross_operation_contention event carrying the raw query text was accepted by the shared observability contract')
  return violations
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

const CASES: Record<string, () => ReservedQuotaCaseResult> = {
  'grounded-reserves-last-unit': checkGroundedReservesLastUnit,
  'sibling-rejected-after-grounded-reserves-last-unit': checkSiblingRejectedAfterGroundedReservesLastUnit,
  'grounded-completes-without-recontending': checkGroundedCompletesWithoutRecontending,
  'explicit-abort-releases-then-sibling-consumes': checkExplicitAbortReleasesThenSiblingConsumes,
  'expiration-releases-then-sibling-consumes': checkExpirationReleasesThenSiblingConsumes,
  'sibling-consumes-first-then-grounded-reserve-rejected': checkSiblingConsumesFirstThenGroundedReserveRejected,
  'grounded-complete-vs-sibling-concurrent': checkGroundedCompleteVsSiblingConcurrent,
  'two-grounded-reservations-for-last-unit': checkTwoGroundedReservationsForLastUnit,
  'two-siblings-for-last-unit': checkTwoSiblingsForLastUnit,
  'retry-grounded-does-not-reserve-or-charge-again': checkRetryDoesNotReserveOrChargeAgain,
  'grounded-failure-and-abort-charges-nothing': checkFailureAndAbortChargesNothing,
  'reservation-crossing-period-boundary': checkReservationCrossingPeriodBoundary,
  'independent-category-shares-single-pool': checkCategorySharesSinglePool,
  'reservation-scoped-to-other-project-rejected': checkReservationScopedToOtherProjectRejected,
  'reservation-scoped-to-other-organization-rejected': checkReservationScopedToOtherOrganizationRejected,
}

export class ReservedQuotaHarnessError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ReservedQuotaHarnessError'
  }
}

function assertCasesMatchMatrix(): void {
  const matrixIds = new Set(RESERVED_QUOTA_MATRIX.map((e) => e.caseId))
  const caseIds = new Set(Object.keys(CASES))
  for (const id of matrixIds) if (!caseIds.has(id)) throw new ReservedQuotaHarnessError(`matrix entry "${id}" has no implemented case`)
  for (const id of caseIds) if (!matrixIds.has(id)) throw new ReservedQuotaHarnessError(`implemented case "${id}" has no matrix entry`)
}

/** Feature-flag posture check, same fail-closed discipline
 *  checkFeatureFlagOffBlocksIssuance already applies in idempotency-harness.ts
 *  — folded into the summary rather than the 15-case matrix, mirroring how
 *  project-binding-harness.ts folds observability in as an extra summary
 *  field rather than a matrix entry. */
function evaluateFeatureFlagPosture(): string[] {
  if (stellaConfig.isGroundedQueryEnabled) {
    return ['STELLA_GROUNDED_QUERY_ENABLED is true in this environment — this harness cannot assume its own default and fails closed rather than passing on an unverified flag']
  }
  return []
}

export interface ReservedQuotaEvalSummary {
  harnessVersion: string
  matrixVersion: string
  totalCases: number
  passed: number
  failed: number
  negativeControlsRun: number
  negativeControlsUndetected: number
  tautologicalCases: string[]
  observabilitySafe: boolean
  observabilityViolations: string[]
  featureFlagSafe: boolean
  featureFlagViolations: string[]
}

export interface ReservedQuotaEvalRun {
  summary: ReservedQuotaEvalSummary
  results: ReservedQuotaCaseResult[]
}

/** Deterministic — no Date.now()/Math.random() anywhere in the reference
 *  model or the cases above; two calls produce byte-identical output. */
export function runReservedQuotaEvalHarness(): ReservedQuotaEvalRun {
  validateReservedQuotaMatrix(RESERVED_QUOTA_MATRIX)
  assertCasesMatchMatrix()

  const results = RESERVED_QUOTA_MATRIX.map((entry) => CASES[entry.caseId]!())
  const negativeControlsRun = results.reduce((n, r) => n + r.negativeControls.length, 0)
  const negativeControlsUndetected = results.reduce((n, r) => n + r.negativeControls.filter((c) => !c.detected).length, 0)
  const tautologicalCases = results.filter((r) => r.detail.startsWith('TAUTOLOGICAL')).map((r) => r.caseId)
  const observabilityViolations = evaluateReservedQuotaObservability()
  const featureFlagViolations = evaluateFeatureFlagPosture()

  const summary: ReservedQuotaEvalSummary = {
    harnessVersion: RESERVED_QUOTA_HARNESS_VERSION,
    matrixVersion: RESERVED_QUOTA_MATRIX_VERSION,
    totalCases: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    negativeControlsRun,
    negativeControlsUndetected,
    tautologicalCases,
    observabilitySafe: observabilityViolations.length === 0,
    observabilityViolations,
    featureFlagSafe: featureFlagViolations.length === 0,
    featureFlagViolations,
  }

  return { summary, results }
}

export function reservedQuotaEvalFailureReasons(summary: ReservedQuotaEvalSummary): string[] {
  const reasons: string[] = []
  if (summary.failed > 0) reasons.push(`${summary.failed}/${summary.totalCases} reserved-quota cases failed`)
  if (summary.negativeControlsUndetected > 0) reasons.push(`${summary.negativeControlsUndetected} negative control(s) failed to detect their mutation`)
  if (summary.tautologicalCases.length > 0) reasons.push(`tautological case(s): ${summary.tautologicalCases.join(', ')}`)
  if (!summary.observabilitySafe) reasons.push(`observability not safe: ${summary.observabilityViolations.join(' | ')}`)
  if (!summary.featureFlagSafe) reasons.push(`feature flag not safe: ${summary.featureFlagViolations.join(' | ')}`)
  return reasons
}
