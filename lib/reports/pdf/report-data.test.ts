// lib/reports/pdf/report-data.test.ts
import { describe, it, expect } from 'vitest'
import { extractFunderBreakdown, buildEvidenceManifest, extractFxTrail, extractLineItems } from './report-data'

describe('extractFunderBreakdown', () => {
  it('extracts rows and unattributed value from a snapshot', () => {
    const snapshot = {
      fundersBreakdown: [
        { funderName: 'Fundación A', funderType: 'foundation', investmentUsd: '1000', attributedNsvUsd: '3000', sroiRatio: '3' },
        { funderName: 'Corp B', funderType: 'corporate', investmentUsd: '500', attributedNsvUsd: '750', sroiRatio: '1.5' },
      ],
      unattributedNsvUsd: '250',
    }
    const result = extractFunderBreakdown(snapshot)
    expect(result).not.toBeNull()
    expect(result!.rows).toHaveLength(2)
    expect(result!.rows[0].funderName).toBe('Fundación A')
    expect(result!.unattributedNsvUsd).toBe('250')
  })

  it('returns null when there is no funder breakdown', () => {
    expect(extractFunderBreakdown({ sroiRatio: '2' })).toBeNull()
    expect(extractFunderBreakdown({ fundersBreakdown: [] })).toBeNull()
    expect(extractFunderBreakdown(null)).toBeNull()
    expect(extractFunderBreakdown('garbage')).toBeNull()
  })

  it('skips malformed rows without throwing', () => {
    const snapshot = {
      fundersBreakdown: [
        { funderName: 'Ok', funderType: 'foundation', investmentUsd: '1', attributedNsvUsd: '2', sroiRatio: '2' },
        { nonsense: true },
      ],
    }
    const result = extractFunderBreakdown(snapshot)
    expect(result!.rows).toHaveLength(1)
    expect(result!.unattributedNsvUsd).toBeNull()
  })
})

describe('extractFxTrail', () => {
  it('extracts investments and flags non-USD conversions', () => {
    const snapshot = {
      investments: [
        { amount: '5000000', currency: 'COP', amountUsd: '1250', year: 2025 },
        { amount: '1000', currency: 'USD', amountUsd: '1000', year: 2025 },
      ],
    }
    const result = extractFxTrail(snapshot)
    expect(result).not.toBeNull()
    expect(result!.rows).toHaveLength(2)
    expect(result!.rows[0].converted).toBe(true)
    expect(result!.rows[0].amountUsd).toBe('1250')
    expect(result!.rows[1].converted).toBe(false)
  })

  it('returns null when there are no investments', () => {
    expect(extractFxTrail({ sroiRatio: '2' })).toBeNull()
    expect(extractFxTrail({ investments: [] })).toBeNull()
    expect(extractFxTrail(null)).toBeNull()
  })

  it('skips malformed investment rows', () => {
    const result = extractFxTrail({
      investments: [{ amount: '10', currency: 'USD', amountUsd: '10', year: 2025 }, { bad: true }],
    })
    expect(result!.rows).toHaveLength(1)
  })
})

describe('extractLineItems', () => {
  const snap = {
    assignments: [
      {
        outcomeId: 'aaaaaaaa-1111-2222-3333-444444444444',
        proxyId: 'bbbbbbbb-5555-6666-7777-888888888888',
        quantity: '100',
        proxyValue: '50',
        grossValue: '5000',
        adjustedValue: '3600',
        filters: { deadweightPct: '10', attributionPct: '80', displacementPct: '5', dropoffPct: '0', durationYears: 1 },
      },
    ],
  }

  it('extracts computation rows with a short reference and folded adjustments', () => {
    const result = extractLineItems(snap)
    expect(result).not.toBeNull()
    expect(result!.rows).toHaveLength(1)
    expect(result!.rows[0].outcomeRef).toBe('aaaaaaaa')
    expect(result!.rows[0].grossValue).toBe('5000')
    expect(result!.rows[0].adjustedValue).toBe('3600')
    expect(result!.rows[0].adjustments).toContain('DW 10%')
    expect(result!.truncated).toBe(false)
  })

  it('caps rows and flags truncation', () => {
    const many = { assignments: Array.from({ length: 60 }, () => snap.assignments[0]) }
    const result = extractLineItems(many, 30)
    expect(result!.rows).toHaveLength(30)
    expect(result!.truncated).toBe(true)
  })

  it('returns null when there are no assignments', () => {
    expect(extractLineItems({})).toBeNull()
    expect(extractLineItems({ assignments: [] })).toBeNull()
    expect(extractLineItems(null)).toBeNull()
  })
})

describe('buildEvidenceManifest', () => {
  it('truncates hashes and preserves order', () => {
    const rows = buildEvidenceManifest([
      { title: 'Doc 1', type: 'file', status: 'approved', contentHash: 'abcdef0123456789ffff' },
      { title: 'URL', type: 'url', status: 'draft', contentHash: null },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].hashShort).toBe('abcdef012345')
    expect(rows[1].hashShort).toBeNull()
  })
})
