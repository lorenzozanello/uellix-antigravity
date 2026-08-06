// tests/eval/stella-release/e2e/reserved-quota-journey-report.test.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 8.
// Offline: no network, no DB. This reducer is PREPARED, not executable — see
// the module header. These tests exercise only the reducer's own logic
// against synthetic reports, never a real journey (none exists yet).

import { describe, it, expect } from 'vitest'
import { evaluateReservedQuotaJourneyReadiness, type ReservedQuotaJourneyReport } from './reserved-quota-journey-report'

const CLEAN_REPORT: ReservedQuotaJourneyReport = {
  containerNetworkMode: 'none',
  containerDestroyed: true,
  usedPersistentVolume: false,
  train4PackagesApplied: ['grounding_0002', 'grounding_0003', 'stella_0013', 'grounding_0004'],
  ticketPackagesApplied: ['stella_0014', 'stella_0015'],
  reservedQuotaPackageApplied: 'stella_00xx_reserved_quota_interference',
  organizationProvisioned: true,
  twoProjectsProvisioned: true,
  twoActorsProvisioned: true,
  oneUnitQuotaProvisioned: true,
  groundedTicketReservedViaRealFunction: true,
  siblingActionInvokedViaRealPath: true,
  concurrencyAcrossOperationsProducedExactlyOneCharge: true,
  abortReleasedCapacityForSibling: true,
  expirationReleasedCapacityForSibling: true,
  completionChargedWithoutRecontending: true,
  r1DiscardPolicyObservedOnRealRace: true,
  ledgerNeverExceededQuota: true,
  providerCallCount: 0,
  observabilityEventSource: 'runtime-emitted',
}

describe('evaluateReservedQuotaJourneyReadiness — the honest default on this branch', () => {
  it('with no report at all (every call on this branch): false, naming R6-INT and R1 and the missing package', () => {
    const result = evaluateReservedQuotaJourneyReadiness(null)
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/R6-INT/)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/R1/)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/scripts\/stella-reserved-quota-e2e\.sh/)
  })

  it('with undefined: same as null', () => {
    expect(evaluateReservedQuotaJourneyReadiness(undefined).reservedQuotaJourneyReady).toBe(false)
  })
})

describe('evaluateReservedQuotaJourneyReadiness — fails closed on a synthetic PARTIAL report', () => {
  it('a hypothetically clean report (once R6-INT closes and R1 ships) would be ready — proving the gate is reachable, not permanently unsatisfiable', () => {
    expect(evaluateReservedQuotaJourneyReadiness(CLEAN_REPORT)).toEqual({ reservedQuotaJourneyReady: true, missingForReservedQuotaJourney: [] })
  })

  it('rejects a persistent volume', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, usedPersistentVolume: true })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/usedPersistentVolume/)
  })

  it('rejects a missing Train 4 package', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, train4PackagesApplied: ['grounding_0002'] })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/grounding_0003/)
  })

  it('rejects a missing ticket package (stella_0014/stella_0015)', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, ticketPackagesApplied: ['stella_0014'] })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/stella_0015/)
  })

  it('rejects an empty reserved-quota package name', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, reservedQuotaPackageApplied: '' })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/reservedQuotaPackageApplied is empty/)
  })

  it('rejects a report where no real sibling action was invoked', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, siblingActionInvokedViaRealPath: false })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/siblingActionInvokedViaRealPath/)
  })

  it('rejects a report where R1\'s discard policy was never observed on a real race', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, r1DiscardPolicyObservedOnRealRace: false })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/r1DiscardPolicyObservedOnRealRace/)
  })

  it('rejects a ledger that exceeded quota', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, ledgerNeverExceededQuota: false })
    expect(result.reservedQuotaJourneyReady).toBe(false)
  })

  it('rejects a nonzero provider call count', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, providerCallCount: 1 })
    expect(result.reservedQuotaJourneyReady).toBe(false)
  })

  it('rejects harness-constructed observability events', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, observabilityEventSource: 'harness-constructed' })
    expect(result.reservedQuotaJourneyReady).toBe(false)
    expect(result.missingForReservedQuotaJourney.join(' ')).toMatch(/runtime, not constructed/)
  })

  it('rejects a concurrency-across-operations stage that did not produce exactly one charge', () => {
    const result = evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, concurrencyAcrossOperationsProducedExactlyOneCharge: false })
    expect(result.reservedQuotaJourneyReady).toBe(false)
  })

  it('rejects a report missing two projects or two actors', () => {
    expect(evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, twoProjectsProvisioned: false }).reservedQuotaJourneyReady).toBe(false)
    expect(evaluateReservedQuotaJourneyReadiness({ ...CLEAN_REPORT, twoActorsProvisioned: false }).reservedQuotaJourneyReady).toBe(false)
  })
})
