// tests/eval/stella-release/reserved-quota-oracle.test.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 4.
// Offline: no network, no DB, no provider.

import { describe, it, expect } from 'vitest'
import {
  evaluateCapacityInvariant,
  evaluateCapacityInvariantAcrossTransitions,
  evaluateChargeAttribution,
  evaluateExactlyOneWinner,
  evaluateNoSimultaneousReservationAndCharge,
  evaluateUnitNotRedisputed,
  inspectTransition,
} from './reserved-quota-oracle'
import { createReferenceReservedQuotaProtocol, type CapacitySnapshot, type ConcurrentCapacityResult } from './reserved-quota-protocol'

const ORG_ID = 'org-oracle-1'
const SNAPSHOT: CapacitySnapshot = { organizationId: ORG_ID, periodKey: 'p0', limit: 2, consumed: 1, liveReserved: 1, available: 0 }

describe('evaluateCapacityInvariant — Consumed + LiveReserved <= Limit', () => {
  it('a snapshot exactly at capacity is clean', () => {
    expect(evaluateCapacityInvariant(SNAPSHOT)).toEqual([])
  })

  it('flags an oversold snapshot', () => {
    const violations = evaluateCapacityInvariant({ ...SNAPSHOT, consumed: 2 })
    expect(violations.join(' ')).toMatch(/consumed\(2\) \+ liveReserved\(1\) > limit\(2\)/)
  })

  it('flags negative consumed/liveReserved as nonsensical, independent of the limit', () => {
    expect(evaluateCapacityInvariant({ ...SNAPSHOT, consumed: -1 }).join(' ')).toMatch(/consumed is negative/)
    expect(evaluateCapacityInvariant({ ...SNAPSHOT, liveReserved: -1 }).join(' ')).toMatch(/liveReserved is negative/)
  })
})

describe('evaluateCapacityInvariantAcrossTransitions — checks EVERY transition, not just the final one', () => {
  it('names the exact transition index of a transient oversell that "recovers" by the last snapshot', () => {
    const clean: CapacitySnapshot = { ...SNAPSHOT, consumed: 0, liveReserved: 0, available: 2 }
    const oversold: CapacitySnapshot = { ...SNAPSHOT, consumed: 3, liveReserved: 0, available: -1 }
    const recovered: CapacitySnapshot = { ...SNAPSHOT, consumed: 1, liveReserved: 0, available: 1 }
    const violations = evaluateCapacityInvariantAcrossTransitions([clean, oversold, recovered])
    expect(violations.length).toBe(1)
    expect(violations[0]).toMatch(/^\[transition 1\]/)
  })

  it('is clean across a sequence that never oversells', () => {
    const sequence: CapacitySnapshot[] = [0, 1, 2].map((consumed) => ({ ...SNAPSHOT, consumed, liveReserved: 0, available: 2 - consumed }))
    expect(evaluateCapacityInvariantAcrossTransitions(sequence)).toEqual([])
  })
})

describe('evaluateNoSimultaneousReservationAndCharge', () => {
  it('flags a reserved reservation that already carries a chargeId', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG_ID]: 5 }, reservationTtl: 10, periodLength: 1000, defect: 'complete-leaves-reservation-live' })
    const reserve = protocol.reserveGroundedOperation({ organizationId: ORG_ID, projectId: 'p1', actorId: 'a1' }, 0)
    protocol.completeGroundedReservation(reserve.reservation!.reservationId, { organizationId: ORG_ID, projectId: 'p1', actorId: 'a1' }, 1)
    const violations = evaluateNoSimultaneousReservationAndCharge(protocol)
    expect(violations.join(' ')).toMatch(/already carries chargeId/)
  })

  it('is clean on the healthy model', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG_ID]: 5 }, reservationTtl: 10, periodLength: 1000 })
    const reserve = protocol.reserveGroundedOperation({ organizationId: ORG_ID, projectId: 'p1', actorId: 'a1' }, 0)
    protocol.completeGroundedReservation(reserve.reservation!.reservationId, { organizationId: ORG_ID, projectId: 'p1', actorId: 'a1' }, 1)
    expect(evaluateNoSimultaneousReservationAndCharge(protocol)).toEqual([])
  })
})

describe('evaluateUnitNotRedisputed', () => {
  it('is clean when neither consumed nor liveReserved moved', () => {
    expect(evaluateUnitNotRedisputed(SNAPSHOT, SNAPSHOT)).toEqual([])
  })

  it('flags a moved consumed count', () => {
    const violations = evaluateUnitNotRedisputed(SNAPSHOT, { ...SNAPSHOT, consumed: 2 })
    expect(violations.join(' ')).toMatch(/consumed moved from 1 to 2/)
  })

  it('flags a moved liveReserved count', () => {
    const violations = evaluateUnitNotRedisputed(SNAPSHOT, { ...SNAPSHOT, liveReserved: 0 })
    expect(violations.join(' ')).toMatch(/liveReserved moved from 1 to 0/)
  })
})

describe('evaluateChargeAttribution', () => {
  it('flags a missing charge record', () => {
    const violations = evaluateChargeAttribution(undefined, { chargeId: 'x', expectedOrganizationId: 'a', expectedProjectId: 'b', expectedOrigin: 'grounded' })
    expect(violations.join(' ')).toMatch(/no charge record found/)
  })

  it('flags an organization/project/origin mismatch independently', () => {
    const charge = { chargeId: 'c1', organizationId: 'org-a', projectId: 'proj-a', origin: 'advisor' as const, reservationId: null, periodKey: 'p0' }
    const violations = evaluateChargeAttribution(charge, { chargeId: 'c1', expectedOrganizationId: 'org-b', expectedProjectId: 'proj-b', expectedOrigin: 'grounded' })
    expect(violations.length).toBe(3)
  })
})

describe('evaluateExactlyOneWinner', () => {
  const winner: ConcurrentCapacityResult = { attemptKind: 'grounded-complete', kind: 'charged', reservationId: 'r1', chargeId: 'c1', reason: null, discardedComputedResponse: false }
  const loser: ConcurrentCapacityResult = { attemptKind: 'sibling-consume', kind: 'quota_exceeded', category: 'advisor', chargeId: null, reason: 'quota_exceeded' }

  it('exactly one winner among a winner and a loser is clean', () => {
    const evaluation = evaluateExactlyOneWinner([winner, loser])
    expect(evaluation).toEqual({ winners: 1, losers: 1, unaccountedFor: 0, violations: [] })
  })

  it('flags two winners', () => {
    const evaluation = evaluateExactlyOneWinner([winner, { ...winner, reservationId: 'r2', chargeId: 'c2' }])
    expect(evaluation.violations.join(' ')).toMatch(/got 2/)
  })

  it('flags zero winners', () => {
    const evaluation = evaluateExactlyOneWinner([loser, loser])
    expect(evaluation.violations.join(' ')).toMatch(/got 0/)
  })
})

describe('inspectTransition — the ten Fase 4 dimensions in one call', () => {
  it('reports limit, consumed, liveReserved, expired and completed reservations correctly', () => {
    const protocol = createReferenceReservedQuotaProtocol({ limits: { [ORG_ID]: 3 }, reservationTtl: 10, periodLength: 1000 })
    const scope = { organizationId: ORG_ID, projectId: 'p1', actorId: 'a1' }
    const reserve = protocol.reserveGroundedOperation(scope, 0)
    protocol.completeGroundedReservation(reserve.reservation!.reservationId, scope, 1)
    protocol.consumeSiblingOperation(scope, 'advisor', 1)
    const inspection = inspectTransition(protocol, ORG_ID, protocol.inspectCapacity(ORG_ID, 1).periodKey, 3)
    expect(inspection.limit).toBe(3)
    expect(inspection.consumed).toBe(2)
    expect(inspection.liveReserved).toBe(0)
    expect(inspection.completedReservations).toBe(1)
    expect(inspection.expiredReservations).toBe(0)
    expect(inspection.charges.length).toBe(2)
  })
})
