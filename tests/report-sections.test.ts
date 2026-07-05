// tests/report-sections.test.ts
// Locks the invariant that report section metadata stays internally
// consistent. The report draft creation (lib/pipeline/sroi-results.ts),
// the editable detail view, and the print/PDF view all rely on SECTION_META,
// SECTION_GROUPS and SECTION_ORDER agreeing — if they drift, a report ends
// up with sections a view doesn't render, or a view expects a section that
// was never created.
import { describe, it, expect } from 'vitest'
import {
  SECTION_META,
  SECTION_GROUPS,
  SECTION_ORDER,
  getInitialSectionTypes,
} from '@/lib/reports/report-sections'

describe('report section metadata invariants', () => {
  it('SECTION_ORDER is exactly the flattened group types, in group order', () => {
    const flattened = SECTION_GROUPS.flatMap((g) => g.types)
    expect(SECTION_ORDER).toEqual(flattened)
  })

  it('has no duplicate section types across groups', () => {
    const unique = new Set(SECTION_ORDER)
    expect(unique.size).toBe(SECTION_ORDER.length)
  })

  it('every grouped section type has a SECTION_META entry', () => {
    for (const type of SECTION_ORDER) {
      expect(SECTION_META[type], `missing META for "${type}"`).toBeDefined()
      expect(SECTION_META[type].label.length).toBeGreaterThan(0)
    }
  })

  it('every SECTION_META key is placed in exactly one group', () => {
    for (const key of Object.keys(SECTION_META)) {
      const groupsWithKey = SECTION_GROUPS.filter((g) => g.types.includes(key))
      expect(groupsWithKey.length, `"${key}" should be in exactly one group`).toBe(1)
    }
  })

  it('matches the canonical 13-section catalog (Fase 1f adds funder_breakdown)', () => {
    // The full catalog is 13; a given report only gets funder_breakdown when
    // it opts in — see getInitialSectionTypes below.
    expect(SECTION_ORDER).toHaveLength(13)
  })
})

describe('getInitialSectionTypes', () => {
  it('excludes funder_breakdown by default (12 sections)', () => {
    const types = getInitialSectionTypes(false)
    expect(types).toHaveLength(12)
    expect(types).not.toContain('funder_breakdown')
  })

  it('includes funder_breakdown when requested (13 sections)', () => {
    const types = getInitialSectionTypes(true)
    expect(types).toHaveLength(13)
    expect(types).toContain('funder_breakdown')
  })

  it('places funder_breakdown right after calculation_results', () => {
    const types = getInitialSectionTypes(true)
    const idx = types.indexOf('calculation_results')
    expect(types[idx + 1]).toBe('funder_breakdown')
  })
})
