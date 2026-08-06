// tests/eval/stella-release/reserved-quota-harness.test.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3).
// Offline: no network, no DB, no provider — the reference protocol is a
// deterministic in-memory model.

import { describe, it, expect } from 'vitest'
import { RESERVED_QUOTA_MATRIX, validateReservedQuotaMatrix } from './reserved-quota-matrix'
import { runReservedQuotaEvalHarness, reservedQuotaEvalFailureReasons } from './reserved-quota-harness'
import {
  createReferenceReservedQuotaProtocol,
  capacityScopesEqual,
  ReservationNotFoundError,
  ReservationScopeViolationError,
  ReservationAlreadyCompletedError,
  ReservationAbortedError,
  ReservationExpiredError,
  type CapacityScope,
} from './reserved-quota-protocol'
import { evaluateCapacityInvariant, evaluateCapacityOracle } from './reserved-quota-oracle'

const ORG: CapacityScope = { organizationId: 'org-rq', projectId: 'project-rq-1', actorId: 'actor-rq-1' }

describe('RESERVED_QUOTA_MATRIX — shape', () => {
  it('validates cleanly: 15 entries, 15 required categories, no duplicates', () => {
    expect(() => validateReservedQuotaMatrix(RESERVED_QUOTA_MATRIX)).not.toThrow()
    expect(RESERVED_QUOTA_MATRIX.length).toBe(15)
  })

  it('fails closed on a duplicated caseId', () => {
    const broken = [...RESERVED_QUOTA_MATRIX, RESERVED_QUOTA_MATRIX[0]!]
    expect(() => validateReservedQuotaMatrix(broken)).toThrow(/duplicated or missing caseId/)
  })

  it('fails closed on a missing required category', () => {
    const broken = RESERVED_QUOTA_MATRIX.filter((e) => e.category !== 'period-boundary-crossing')
    expect(() => validateReservedQuotaMatrix(broken)).toThrow(/missing required category/)
  })

  it('fails closed on a wrong total count', () => {
    // A 16th entry that reuses an ALREADY-covered category and a fresh
    // caseId — so neither the duplicate-id check nor the missing-category
    // check fires first, isolating the count check itself.
    const broken = [...RESERVED_QUOTA_MATRIX, { ...RESERVED_QUOTA_MATRIX[0]!, caseId: 'extra-case-for-count-test' }]
    expect(() => validateReservedQuotaMatrix(broken)).toThrow(/requires exactly 15/)
  })
})

describe('runReservedQuotaEvalHarness — the real, clean run', () => {
  const run = runReservedQuotaEvalHarness()

  it('every one of the 15 cases has exactly one matrix entry and vice versa (no drift)', () => {
    const caseIds = new Set(run.results.map((r) => r.caseId))
    const matrixIds = new Set(RESERVED_QUOTA_MATRIX.map((e) => e.caseId))
    expect(caseIds).toEqual(matrixIds)
  })

  it('15/15 cases pass, zero tautological, zero undetected negative controls', () => {
    const failing = run.results.filter((r) => !r.ok)
    expect(failing.map((r) => `${r.caseId}: ${r.detail}`)).toEqual([])
    expect(run.summary.tautologicalCases).toEqual([])
    expect(run.summary.negativeControlsUndetected).toBe(0)
  })

  it('ran at least 12 negative controls — Fase 5 requires one per named mutation', () => {
    expect(run.summary.negativeControlsRun).toBeGreaterThanOrEqual(12)
  })

  it('observability and feature-flag posture are both safe', () => {
    expect(run.summary.observabilitySafe).toBe(true)
    expect(run.summary.observabilityViolations).toEqual([])
    expect(run.summary.featureFlagSafe).toBe(true)
  })

  it('reservedQuotaEvalFailureReasons reports nothing on a clean run', () => {
    expect(reservedQuotaEvalFailureReasons(run.summary)).toEqual([])
  })

  it('is deterministic — two independent runs produce byte-identical summaries and results', () => {
    const second = runReservedQuotaEvalHarness()
    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(run.summary))
    expect(JSON.stringify(second.results)).toBe(JSON.stringify(run.results))
  })

  it('every case carries a non-trivial detail, never a bare boolean', () => {
    for (const result of run.results) expect(result.detail.length).toBeGreaterThan(10)
  })

  it('the R1 case (grounded-complete-vs-sibling-concurrent) carries the independent-locks and residual-risk call-site controls', () => {
    // nc-concurrent-double-charge is DELIBERATELY absent here: a reservation
    // already held before the race window opens cannot lose that unit to a
    // sibling under a "reads before writes" race, so attaching that control
    // to this case is tautological by construction — the harness itself
    // caught this (TAUTOLOGICAL system-error) during development; see
    // RELEASE.md's Train 4.3 section. The property IS covered, on the two
    // cases where it applies: two-grounded-reservations-for-last-unit and
    // two-siblings-for-last-unit.
    const case7 = run.results.find((r) => r.caseId === 'grounded-complete-vs-sibling-concurrent')!
    const controlIds = case7.negativeControls.map((c) => c.controlId)
    expect(controlIds).toEqual(expect.arrayContaining(['nc-independent-locks', 'nc-result-usable-without-charge']))
    expect(controlIds).not.toContain('nc-concurrent-double-charge')
    const residualRisk = case7.negativeControls.find((c) => c.controlId === 'nc-result-usable-without-charge')!
    expect(residualRisk.detected).toBe(true)
    expect(residualRisk.detail).toMatch(/quota_refused/)
  })
})

describe('reservedQuotaEvalFailureReasons — fails closed on a synthetic broken summary', () => {
  it('reports failed cases, undetected controls, tautological cases, observability and feature-flag posture independently', () => {
    const reasons = reservedQuotaEvalFailureReasons({
      harnessVersion: '1.0.0',
      matrixVersion: '1.0.0',
      totalCases: 15,
      passed: 13,
      failed: 2,
      negativeControlsRun: 12,
      negativeControlsUndetected: 1,
      tautologicalCases: ['some-case'],
      observabilitySafe: false,
      observabilityViolations: ['bad event'],
      featureFlagSafe: false,
      featureFlagViolations: ['flag on'],
    })
    expect(reasons).toEqual([
      '2/15 reserved-quota cases failed',
      '1 negative control(s) failed to detect their mutation',
      'tautological case(s): some-case',
      'observability not safe: bad event',
      'feature flag not safe: flag on',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* Direct reference-model tests — Fase 2/4's positive proofs, stated          */
/* explicitly rather than only via the case runner above.                     */
/* -------------------------------------------------------------------------- */

describe('createReferenceReservedQuotaProtocol — the core invariant, Fase 2/4', () => {
  it('Consumed + LiveReserved <= Limit holds after every verb in a realistic sequence', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 2 }, reservationTtl: 10, periodLength: 1000 })
    const snapshots = [protocol.inspectCapacity(ORG.organizationId, 0)]
    const reserve = protocol.reserveGroundedOperation(ORG, 0)
    snapshots.push(protocol.inspectCapacity(ORG.organizationId, 0))
    protocol.consumeSiblingOperation(ORG, 'advisor', 1)
    snapshots.push(protocol.inspectCapacity(ORG.organizationId, 1))
    expect(reserve.kind).toBe('reservation_held')
    protocol.completeGroundedReservation(reserve.reservation!.reservationId, ORG, 2)
    snapshots.push(protocol.inspectCapacity(ORG.organizationId, 2))
    for (const snapshot of snapshots) expect(evaluateCapacityInvariant(snapshot)).toEqual([])
  })

  it('completing a reservation converts it into a charge, and no reservation/charge coexist', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    const reserve = protocol.reserveGroundedOperation(ORG, 0)
    const before = protocol.inspectCapacity(ORG.organizationId, 1)
    const outcome = protocol.completeGroundedReservation(reserve.reservation!.reservationId, ORG, 1)
    const after = protocol.inspectCapacity(ORG.organizationId, 1)
    expect(outcome.kind).toBe('charged')
    expect(evaluateCapacityOracle(before, after, protocol.allCharges(), { additionalConsumed: 1, liveReservedDelta: -1 })).toEqual([])
    const reservation = protocol.allReservations().find((r) => r.reservationId === reserve.reservation!.reservationId)!
    expect(reservation.status).toBe('completed')
    expect(protocol.chargesFor(reservation.reservationId).length).toBe(1)
  })

  it('reserveGroundedOperation rejects when Consumed + LiveReserved already equals Limit', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 1 }, reservationTtl: 10, periodLength: 1000 })
    const first = protocol.reserveGroundedOperation(ORG, 0)
    expect(first.kind).toBe('reservation_held')
    const second = protocol.reserveGroundedOperation(ORG, 1)
    expect(second.kind).toBe('quota_exceeded')
    expect(second.reservation).toBeNull()
  })

  it('consumeSiblingOperation never accepts a caller-supplied idempotency-style shortcut — it always mints its own chargeId', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    const a = protocol.consumeSiblingOperation(ORG, 'advisor', 0)
    const b = protocol.consumeSiblingOperation(ORG, 'advisor', 1)
    expect(a.chargeId).not.toBe(b.chargeId)
    expect(a.kind).toBe('consumed')
    expect(b.kind).toBe('consumed')
  })

  it('capacityScopesEqual compares all three axes', () => {
    expect(capacityScopesEqual(ORG, { ...ORG })).toBe(true)
    expect(capacityScopesEqual(ORG, { ...ORG, projectId: 'other' })).toBe(false)
    expect(capacityScopesEqual(ORG, { ...ORG, organizationId: 'other' })).toBe(false)
    expect(capacityScopesEqual(ORG, { ...ORG, actorId: 'other' })).toBe(false)
  })
})

describe('createReferenceReservedQuotaProtocol — structural errors thrown, never swallowed', () => {
  it('completeGroundedReservation/abortReservation throw ReservationNotFoundError for an unknown id', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    expect(() => protocol.completeGroundedReservation('nope', ORG, 0)).toThrow(ReservationNotFoundError)
    expect(() => protocol.abortReservation('nope', ORG, 0)).toThrow(ReservationNotFoundError)
  })

  it('completeGroundedReservation/abortReservation throw ReservationScopeViolationError for a foreign scope', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    const reserve = protocol.reserveGroundedOperation(ORG, 0)
    const foreign = { ...ORG, projectId: 'other-project' }
    expect(() => protocol.completeGroundedReservation(reserve.reservation!.reservationId, foreign, 1)).toThrow(ReservationScopeViolationError)
  })

  it('abortReservation throws ReservationAlreadyCompletedError on a completed reservation', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    const reserve = protocol.reserveGroundedOperation(ORG, 0)
    protocol.completeGroundedReservation(reserve.reservation!.reservationId, ORG, 1)
    expect(() => protocol.abortReservation(reserve.reservation!.reservationId, ORG, 2)).toThrow(ReservationAlreadyCompletedError)
  })

  it('completeGroundedReservation throws ReservationAbortedError on an aborted reservation', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    const reserve = protocol.reserveGroundedOperation(ORG, 0)
    protocol.abortReservation(reserve.reservation!.reservationId, ORG, 1)
    expect(() => protocol.completeGroundedReservation(reserve.reservation!.reservationId, ORG, 2)).toThrow(ReservationAbortedError)
  })

  it('completeGroundedReservation throws ReservationExpiredError past the TTL', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 2, periodLength: 1000 })
    const reserve = protocol.reserveGroundedOperation(ORG, 0)
    expect(() => protocol.completeGroundedReservation(reserve.reservation!.reservationId, ORG, 5)).toThrow(ReservationExpiredError)
  })

  it('retry never throws — every failure mode is a rejected outcome with a reason', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG.organizationId]: 5 }, reservationTtl: 10, periodLength: 1000 })
    expect(() => protocol.retry('nope', ORG, 0)).not.toThrow()
    const outcome = protocol.retry('nope', ORG, 0)
    expect(outcome.kind).toBe('rejected')
    expect(outcome.reason).toBe('reservation_not_found')
  })
})
