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

  it('matches the canonical 12-section report structure', () => {
    // A report draft is created with exactly these sections (see
    // createReportDraftFromRun) — the count is asserted there too; this
    // pins the shared constant so both can't drift apart silently.
    expect(SECTION_ORDER).toHaveLength(12)
  })
})
