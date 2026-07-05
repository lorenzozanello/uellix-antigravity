// tests/sroi-funders.service.test.ts
// Fase 1b — per-funder SROI breakdown (pure math, no DB).

import { describe, it, expect } from 'vitest'
import { computeFundersBreakdown } from '@/lib/pipeline/sroi-funders'

const FUNDERS = [
  { id: 'f1', name: 'Fundación A', funderType: 'foundation' },
  { id: 'f2', name: 'Empresa B', funderType: 'private' },
]

describe('computeFundersBreakdown', () => {
  it('attributes 100% of an outcome to its sole funder', () => {
    const { fundersBreakdown, unattributedNsvUsd } = computeFundersBreakdown({
      netSocialValueUsd: '1000.0000',
      outcomeNsvUsd: { 'out-1': '1000.0000' },
      investments: [{ funderId: 'f1', amountUsd: '500.0000' }],
      allocations: [{ outcomeId: 'out-1', funderId: 'f1', allocationPct: '100' }],
      funders: [FUNDERS[0]],
    })
    expect(fundersBreakdown).toHaveLength(1)
    expect(fundersBreakdown[0].attributedNsvUsd).toBe('1000.0000')
    expect(fundersBreakdown[0].investmentUsd).toBe('500.0000')
    expect(fundersBreakdown[0].sroiRatio).toBe('2.000000') // 1000 / 500
    expect(unattributedNsvUsd).toBe('0.0000')
  })

  it('leaves the unallocated remainder as unattributed value', () => {
    const { fundersBreakdown, unattributedNsvUsd } = computeFundersBreakdown({
      netSocialValueUsd: '1000.0000',
      outcomeNsvUsd: { 'out-1': '1000.0000' },
      investments: [{ funderId: 'f1', amountUsd: '250.0000' }],
      allocations: [{ outcomeId: 'out-1', funderId: 'f1', allocationPct: '40' }],
      funders: [FUNDERS[0]],
    })
    expect(fundersBreakdown[0].attributedNsvUsd).toBe('400.0000') // 40% of 1000
    expect(fundersBreakdown[0].sroiRatio).toBe('1.600000') // 400 / 250
    expect(unattributedNsvUsd).toBe('600.0000') // 1000 - 400
  })

  it('splits one outcome across two funders (60/40)', () => {
    const { fundersBreakdown, unattributedNsvUsd } = computeFundersBreakdown({
      netSocialValueUsd: '1000.0000',
      outcomeNsvUsd: { 'out-1': '1000.0000' },
      investments: [
        { funderId: 'f1', amountUsd: '300.0000' },
        { funderId: 'f2', amountUsd: '200.0000' },
      ],
      allocations: [
        { outcomeId: 'out-1', funderId: 'f1', allocationPct: '60' },
        { outcomeId: 'out-1', funderId: 'f2', allocationPct: '40' },
      ],
      funders: FUNDERS,
    })
    const f1 = fundersBreakdown.find(f => f.funderId === 'f1')!
    const f2 = fundersBreakdown.find(f => f.funderId === 'f2')!
    expect(f1.attributedNsvUsd).toBe('600.0000')
    expect(f1.sroiRatio).toBe('2.000000') // 600 / 300
    expect(f2.attributedNsvUsd).toBe('400.0000')
    expect(f2.sroiRatio).toBe('2.000000') // 400 / 200
    expect(unattributedNsvUsd).toBe('0.0000')
  })

  it('reports a funder with investment but no allocation as ratio 0 (legit, not an error)', () => {
    const { fundersBreakdown, unattributedNsvUsd } = computeFundersBreakdown({
      netSocialValueUsd: '1000.0000',
      outcomeNsvUsd: { 'out-1': '1000.0000' },
      investments: [{ funderId: 'f1', amountUsd: '500.0000' }],
      allocations: [],
      funders: [FUNDERS[0]],
    })
    expect(fundersBreakdown[0].attributedNsvUsd).toBe('0.0000')
    expect(fundersBreakdown[0].sroiRatio).toBe('0.000000')
    expect(unattributedNsvUsd).toBe('1000.0000') // nothing attributed
  })

  it('sums a funder’s attribution across multiple outcomes', () => {
    const { fundersBreakdown } = computeFundersBreakdown({
      netSocialValueUsd: '1500.0000',
      outcomeNsvUsd: { 'out-1': '1000.0000', 'out-2': '500.0000' },
      investments: [{ funderId: 'f1', amountUsd: '600.0000' }],
      allocations: [
        { outcomeId: 'out-1', funderId: 'f1', allocationPct: '50' },
        { outcomeId: 'out-2', funderId: 'f1', allocationPct: '100' },
      ],
      funders: [FUNDERS[0]],
    })
    // 50% of 1000 + 100% of 500 = 1000
    expect(fundersBreakdown[0].attributedNsvUsd).toBe('1000.0000')
    expect(fundersBreakdown[0].sroiRatio).toBe('1.666667') // 1000 / 600
  })
})
