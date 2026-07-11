// lib/reports/pdf/report-data.test.ts
import { describe, it, expect } from 'vitest'
import { extractFunderBreakdown, buildEvidenceManifest } from './report-data'

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
