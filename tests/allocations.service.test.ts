// tests/allocations.service.test.ts
// Fase 1c — funder↔outcome allocation cap math (pure).

import { describe, it, expect } from 'vitest'
import { sumPct, wouldExceedCap } from '@/lib/pipeline/allocations'

describe('sumPct', () => {
  it('sums percentage strings to 4dp', () => {
    expect(sumPct(['60', '30.5'])).toBe('90.5000')
  })
  it('returns 0.0000 for an empty list', () => {
    expect(sumPct([])).toBe('0.0000')
  })
})

describe('wouldExceedCap', () => {
  it('allows a new allocation that keeps the outcome at or under 100%', () => {
    expect(wouldExceedCap([], '50')).toBe(false)
    expect(wouldExceedCap(['60'], '40')).toBe(false) // exactly 100
    expect(wouldExceedCap(['30', '30'], '40')).toBe(false) // exactly 100
  })
  it('rejects a new allocation that pushes the outcome over 100%', () => {
    expect(wouldExceedCap(['60'], '41')).toBe(true)
    expect(wouldExceedCap(['50'], '50.0001')).toBe(true)
  })
})
