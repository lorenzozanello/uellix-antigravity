// tests/eval/stella-release/e2e/ticket-protocol-journey-report.test.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 6.
// Offline: no network, no DB. This reducer is PREPARED, not executable — see
// the module header. These tests exercise only the reducer's own logic
// against synthetic reports, never a real journey (none exists yet).

import { describe, it, expect } from 'vitest'
import { evaluateTicketProtocolJourneyReadiness, type TicketProtocolJourneyReport } from './ticket-protocol-journey-report'

const CLEAN_REPORT: TicketProtocolJourneyReport = {
  containerNetworkMode: 'none',
  containerDestroyed: true,
  usedPersistentVolume: false,
  train4PackagesApplied: ['grounding_0002', 'grounding_0003', 'stella_0013', 'grounding_0004'],
  ticketPackageApplied: 'stella_00xx_operation_tickets',
  smallQuotaProvisioned: true,
  ticketIssuedViaRealFunction: true,
  operationCompletedViaRealFunction: true,
  retryChargedZeroAdditionalUnits: true,
  sameQueryNewOperationCharged: true,
  failureAndAbortChargedZero: true,
  crossProjectAttackRejected: true,
  concurrencyProducedExactlyOneCharge: true,
  providerCallCount: 0,
  observabilityEventSource: 'runtime-emitted',
  executionProjectAttributionEnforced: true,
  legacyTicketSignatureInvocable: false,
}

describe('evaluateTicketProtocolJourneyReadiness — the honest default on this branch', () => {
  it('with no report at all (every call on this branch): false, with a reason naming INT-INT-001 and the missing package', () => {
    const result = evaluateTicketProtocolJourneyReadiness(null)
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/INT-INT-001/)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/ticket package exists/)
  })

  it('with undefined: same as null', () => {
    expect(evaluateTicketProtocolJourneyReadiness(undefined).ticketProtocolJourneyReady).toBe(false)
  })
})

describe('evaluateTicketProtocolJourneyReadiness — fails closed on a synthetic PARTIAL report', () => {
  it('a hypothetically clean report (once a real journey exists) would be ready — proving the gate is reachable, not permanently unsatisfiable', () => {
    expect(evaluateTicketProtocolJourneyReadiness(CLEAN_REPORT)).toEqual({ ticketProtocolJourneyReady: true, missingForTicketProtocolJourney: [] })
  })

  it('rejects a persistent volume', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, usedPersistentVolume: true })
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/usedPersistentVolume/)
  })

  it('rejects a missing Train 4 package', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, train4PackagesApplied: ['grounding_0002'] })
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/grounding_0003/)
  })

  it('rejects an empty ticket package name', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, ticketPackageApplied: '' })
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/ticketPackageApplied is empty/)
  })

  it('rejects a nonzero provider call count', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, providerCallCount: 1 })
    expect(result.ticketProtocolJourneyReady).toBe(false)
  })

  it('rejects harness-constructed observability events', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, observabilityEventSource: 'harness-constructed' })
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/runtime, not constructed/)
  })

  it('rejects a same-query-new-operation stage that did not charge', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, sameQueryNewOperationCharged: false })
    expect(result.ticketProtocolJourneyReady).toBe(false)
  })

  it('rejects a concurrency stage that did not produce exactly one charge', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, concurrencyProducedExactlyOneCharge: false })
    expect(result.ticketProtocolJourneyReady).toBe(false)
  })
})

describe('evaluateTicketProtocolJourneyReadiness — Train 4.2, R2-INT (project attribution)', () => {
  it('rejects a report where execution-project attribution is not enforced', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, executionProjectAttributionEnforced: false })
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/R2-INT/)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/train 5/)
  })

  it('rejects a report where the legacy (project-blind) signature is still invocable — the inverse boolean', () => {
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, legacyTicketSignatureInvocable: true })
    expect(result.ticketProtocolJourneyReady).toBe(false)
    expect(result.missingForTicketProtocolJourney.join(' ')).toMatch(/legacyTicketSignatureInvocable is true/)
  })

  it('crossProjectAttackRejected and executionProjectAttributionEnforced are independent — a report cannot satisfy one to imply the other', () => {
    // crossProjectAttackRejected true (a ticket PRESENTED cross-project is
    // rejected) says nothing about a ticket whose OWN scope is presented
    // correctly but whose execution runs against a different project — the
    // two fields must both be required, neither implies the other.
    const result = evaluateTicketProtocolJourneyReadiness({ ...CLEAN_REPORT, crossProjectAttackRejected: true, executionProjectAttributionEnforced: false })
    expect(result.ticketProtocolJourneyReady).toBe(false)
  })
})
