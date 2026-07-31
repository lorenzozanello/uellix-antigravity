import { describe, expect, it } from 'vitest'
import { collectCanonicalSourceFieldPaths, isCanonicalSourceFieldPath } from '../canonical-source-field-paths'

describe('collectCanonicalSourceFieldPaths', () => {
  it('collects concrete leaves in insertion order using bracket indexes', () => {
    const value = {
      narrativeSummary: '',
      calculationReadiness: { ready: false, blockingReasons: ['missing evidence'] },
      outcomesSnapshot: [{ id: 'outcome-1', name: 'Outcome' }],
      values: [0, false, null],
    }

    expect(collectCanonicalSourceFieldPaths(value)).toEqual([
      'narrativeSummary',
      'calculationReadiness.ready',
      'calculationReadiness.blockingReasons[0]',
      'outcomesSnapshot[0].id',
      'outcomesSnapshot[0].name',
      'values[0]',
      'values[1]',
      'values[2]',
    ])
  })

  it('omits undefined and inherited properties, keeps container paths out, and never mutates input', () => {
    const prototype = { inherited: 'not-owned' }
    const value = Object.assign(Object.create(prototype), {
      defined: 0,
      absent: undefined,
      nested: [[{ value: '' }]],
    })
    const before = structuredClone(value)

    expect(collectCanonicalSourceFieldPaths(value)).toEqual(['defined', 'nested[0][0].value'])
    expect(value).toEqual(before)
  })

  it('builds a request-local catalog for each distinct structure', () => {
    expect(collectCanonicalSourceFieldPaths({ outcomesSnapshot: [{ id: 'outcome-1' }] })).toEqual(['outcomesSnapshot[0].id'])
  })

  // R1: an empty registered collection must still be citable, so the model
  // can ground statements about absence instead of citing nothing.
  describe('empty-collection sentinel leaves (R1)', () => {
    it('emits a citable `.empty` sentinel leaf for empty arrays and empty objects', () => {
      expect(collectCanonicalSourceFieldPaths({ outcomesSnapshot: [] })).toEqual(['outcomesSnapshot.empty'])
      expect(collectCanonicalSourceFieldPaths({ emptyObject: {} })).toEqual(['emptyObject.empty'])
    })

    it('emits sentinels for nested empty collections using their full path', () => {
      expect(collectCanonicalSourceFieldPaths({
        calculationReadiness: { ready: false, blockingReasons: [], warnings: [] },
      })).toEqual([
        'calculationReadiness.ready',
        'calculationReadiness.blockingReasons.empty',
        'calculationReadiness.warnings.empty',
      ])
      expect(collectCanonicalSourceFieldPaths({ nested: [[]] })).toEqual(['nested[0].empty'])
    })

    it('sentinel paths satisfy the canonical path pattern and never replace real leaves', () => {
      const paths = collectCanonicalSourceFieldPaths({ proxySummary: [], outcomesSnapshot: [{ id: 'outcome-1' }] })
      expect(paths).toEqual(['proxySummary.empty', 'outcomesSnapshot[0].id'])
      for (const path of paths) expect(isCanonicalSourceFieldPath(path)).toBe(true)
    })

    it('does not emit a sentinel for an empty root value', () => {
      expect(collectCanonicalSourceFieldPaths({})).toEqual([])
      expect(collectCanonicalSourceFieldPaths([])).toEqual([])
    })
  })
})
