// tests/sroi-parse-num.test.ts
// U1 (WS4) — characterization tests for the engine's numeric string parser.
// Written FIRST against the historical parseFloat-based implementation; the
// Decimal-based replacement must keep every one of these green (identical
// accepted formats, identical results for rejected input).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

// sroi-calculation.ts pulls the DB client and auth at module load — stub them
// out; parseNum itself is pure.
vi.mock('@/db/client', () => ({ db: {} }))
vi.mock('@/lib/auth/session', () => ({ requireOrganizationAccess: vi.fn() }))
vi.mock('@/lib/auth/permissions', () => ({ hasRole: vi.fn() }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})

import { parseNum } from '@/lib/pipeline/sroi-calculation'

describe('parseNum characterization (accepted formats pinned)', () => {
  it('returns 0 for null / undefined / empty string', () => {
    expect(parseNum(null)).toBe(0)
    expect(parseNum(undefined)).toBe(0)
    expect(parseNum('')).toBe(0)
  })

  it('parses plain integers and decimals', () => {
    expect(parseNum('0')).toBe(0)
    expect(parseNum('10')).toBe(10)
    expect(parseNum('10.5')).toBe(10.5)
    expect(parseNum('0.0001')).toBe(0.0001)
    expect(parseNum('1000000')).toBe(1000000)
  })

  it('parses signed values', () => {
    expect(parseNum('-3.25')).toBe(-3.25)
    expect(parseNum('+4.5')).toBe(4.5)
    expect(parseNum('-0')).toBe(-0)
  })

  it('tolerates leading and trailing whitespace', () => {
    expect(parseNum('  12.5')).toBe(12.5)
    expect(parseNum('12.5  ')).toBe(12.5)
    expect(parseNum('  12.5  ')).toBe(12.5)
    expect(parseNum('\t\n 7 ')).toBe(7)
  })

  it('whitespace-only input yields 0', () => {
    expect(parseNum('   ')).toBe(0)
    expect(parseNum('\t')).toBe(0)
  })

  it('parses the leading numeric prefix, ignoring trailing garbage (parseFloat legacy)', () => {
    expect(parseNum('12.5abc')).toBe(12.5)
    expect(parseNum('12,5')).toBe(12) // comma stops the parse — NOT a decimal comma
    expect(parseNum('100 USD')).toBe(100)
    expect(parseNum('5.')).toBe(5)
    expect(parseNum('0x10')).toBe(0) // hex is NOT accepted; parses the leading '0'
  })

  it('parses leading-dot decimals', () => {
    expect(parseNum('.5')).toBe(0.5)
    expect(parseNum('-.25')).toBe(-0.25)
  })

  it('parses scientific notation', () => {
    expect(parseNum('1e3')).toBe(1000)
    expect(parseNum('1E-2')).toBe(0.01)
    expect(parseNum('2.5e2')).toBe(250)
    expect(parseNum('1e')).toBe(1) // dangling exponent marker ignored
    expect(parseNum('1e+')).toBe(1)
  })

  it('returns 0 for non-numeric input', () => {
    expect(parseNum('abc')).toBe(0)
    expect(parseNum('NaN')).toBe(0)
    expect(parseNum('.')).toBe(0)
    expect(parseNum('-')).toBe(0)
    expect(parseNum('e5')).toBe(0)
    expect(parseNum(',5')).toBe(0)
  })

  it('preserves Infinity handling (parseFloat legacy)', () => {
    expect(parseNum('Infinity')).toBe(Infinity)
    expect(parseNum('-Infinity')).toBe(-Infinity)
    expect(parseNum('1e400')).toBe(Infinity) // double overflow
  })

  it('handles values beyond float64 decimal resolution consistently', () => {
    // Same nearest-double as parseFloat — the engine keeps exact strings in
    // Decimal; parseNum is only used for filters/validation display paths.
    expect(parseNum('0.1')).toBe(0.1)
    expect(parseNum('999999999999.9999')).toBe(999999999999.9999)
  })
})
