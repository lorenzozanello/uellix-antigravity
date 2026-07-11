// lib/reports/report-variants.test.ts
import { describe, it, expect } from 'vitest'
import {
  REPORT_VARIANTS,
  REPORT_VARIANT_LABEL,
  getVariantSectionTypes,
  getVariantAnnexes,
  isReportVariant,
} from './report-variants'

describe('report variants', () => {
  it('exposes funder, methodological and audit', () => {
    expect(REPORT_VARIANTS).toEqual(['funder', 'methodological', 'audit'])
    expect(REPORT_VARIANT_LABEL.funder).toBe('Financiador')
    expect(REPORT_VARIANT_LABEL.audit).toBe('Auditoría')
  })

  it('isReportVariant guards unknown values', () => {
    expect(isReportVariant('funder')).toBe(true)
    expect(isReportVariant('nonsense')).toBe(false)
  })

  describe('getVariantSectionTypes', () => {
    it('funder returns a curated executive subset (no deep methodology sections)', () => {
      const types = getVariantSectionTypes('funder', true)
      expect(types).toContain('executive_summary')
      expect(types).toContain('calculation_results')
      expect(types).toContain('funder_breakdown')
      expect(types).not.toContain('proxy_methodology')
      expect(types).not.toContain('sroi_filters')
    })

    it('funder omits funder_breakdown when not opted in', () => {
      expect(getVariantSectionTypes('funder', false)).not.toContain('funder_breakdown')
    })

    it('audit returns the full section set', () => {
      const types = getVariantSectionTypes('audit', true)
      expect(types).toContain('proxy_methodology')
      expect(types).toContain('sroi_filters')
      expect(types).toContain('theory_of_change')
      expect(types).toContain('funder_breakdown')
    })
  })

  describe('getVariantAnnexes', () => {
    it('funder shows funder breakdown + standards but not the evidence manifest', () => {
      expect(getVariantAnnexes('funder')).toEqual({
        funderBreakdown: true,
        evidenceManifest: false,
        standards: true,
      })
    })

    it('audit shows every annex', () => {
      expect(getVariantAnnexes('audit')).toEqual({
        funderBreakdown: true,
        evidenceManifest: true,
        standards: true,
      })
    })
  })
})
