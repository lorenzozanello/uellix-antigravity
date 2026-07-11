// lib/taxonomies/seed-data.test.ts
import { describe, it, expect } from 'vitest'
import { TAXONOMY_SEED } from './seed-data'

describe('TAXONOMY_SEED', () => {
  it('seeds at least ODS and IRIS+ (roadmap minimum)', () => {
    const codes = TAXONOMY_SEED.map((c) => c.code)
    expect(codes).toContain('ODS')
    expect(codes).toContain('IRIS+')
  })

  it('has unique catalog codes', () => {
    const codes = TAXONOMY_SEED.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('seeds all 17 Sustainable Development Goals', () => {
    const ods = TAXONOMY_SEED.find((c) => c.code === 'ODS')
    expect(ods?.codes.length).toBe(17)
  })

  it('has unique, non-empty codes and labels within every catalog', () => {
    for (const catalog of TAXONOMY_SEED) {
      expect(catalog.name.length, `${catalog.code} name`).toBeGreaterThan(0)
      expect(catalog.version.length, `${catalog.code} version`).toBeGreaterThan(0)
      expect(catalog.codes.length, `${catalog.code} has codes`).toBeGreaterThan(0)
      const inner = catalog.codes.map((c) => c.code)
      expect(new Set(inner).size, `${catalog.code} duplicate codes`).toBe(inner.length)
      for (const item of catalog.codes) {
        expect(item.code.length, `${catalog.code} empty code`).toBeGreaterThan(0)
        expect(item.label.length, `${catalog.code}/${item.code} empty label`).toBeGreaterThan(0)
      }
    }
  })
})
