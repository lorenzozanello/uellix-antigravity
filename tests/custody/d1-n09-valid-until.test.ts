// @vitest-environment node
// tests/custody/d1-n09-valid-until.test.ts
//
// N09's arithmetic and N31's bounds, pinned before N08's operand exists. The
// instants below are TEST FIXTURES for the arithmetic, not planned times.

import { describe, expect, it } from 'vitest'
import { checkPlannedRemoval, computeValidUntilUtc, parseUtcInstant } from '@/scripts/custody/d1-n09-valid-until'

describe('N09: planned FINAL WITNESS + 24 hours, exact UTC', () => {
  it('adds exactly twenty-four hours and answers in UTC', () => {
    expect(computeValidUntilUtc('2030-01-01T10:15:00Z')).toBe('2030-01-02T10:15:00.000Z')
  })

  it('crosses month and leap-day boundaries by calendar, not by guess', () => {
    expect(computeValidUntilUtc('2028-02-28T23:30:00Z')).toBe('2028-02-29T23:30:00.000Z')
    expect(computeValidUntilUtc('2030-12-31T12:00:00Z')).toBe('2031-01-01T12:00:00.000Z')
  })

  it.each([
    ['a bare date', '2030-01-01'],
    ['a local time with no zone', '2030-01-01T10:15:00'],
    ['a numeric offset', '2030-01-01T10:15:00+02:00'],
    ['an impossible calendar date', '2030-02-30T10:15:00Z'],
    ['free text', 'tomorrow morning'],
  ])('refuses %s instead of filling in a time', (_label, input) => {
    expect(() => computeValidUntilUtc(input)).toThrow()
  })

  it('accepts seconds and milliseconds when given', () => {
    expect(parseUtcInstant('x', '2030-01-01T10:15:30.250Z').toISOString()).toBe('2030-01-01T10:15:30.250Z')
  })
})

describe('N31 against N08 and N09: independent, bounded, never rewritten', () => {
  it('accepts a removal between the witness and the expiry, and does not equate it to the expiry', () => {
    const r = checkPlannedRemoval({ plannedFinalWitnessUtc: '2030-01-01T10:00:00Z', plannedRemovalUtc: '2030-01-01T18:00:00Z' })
    expect(r.ok).toBe(true)
    expect(r.expiryUtc).toBe('2030-01-02T10:00:00.000Z')
    expect(r.mustBeRemovedNoLaterThanUtc).toBe('2030-01-01T18:00:00.000Z')
  })

  it('refuses a removal earlier than the planned witness', () => {
    const r = checkPlannedRemoval({ plannedFinalWitnessUtc: '2030-01-01T10:00:00Z', plannedRemovalUtc: '2030-01-01T09:59:00Z' })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toContain('EARLIER')
  })

  it('reports a removal after the expiry and bounds it by the expiry without rewriting the owner datum', () => {
    const r = checkPlannedRemoval({ plannedFinalWitnessUtc: '2030-01-01T10:00:00Z', plannedRemovalUtc: '2030-01-03T00:00:00Z' })
    expect(r.ok).toBe(false)
    expect(r.mustBeRemovedNoLaterThanUtc).toBe('2030-01-02T10:00:00.000Z')
    expect(r.problems.join(' ')).toContain('hard outer bound')
  })

  it('refuses a date-only planned removal: N31 requires an exact UTC instant', () => {
    expect(() => checkPlannedRemoval({ plannedFinalWitnessUtc: '2030-01-01T10:00:00Z', plannedRemovalUtc: '2030-01-02' })).toThrow()
  })
})
