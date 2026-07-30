import { describe, expect, it } from 'vitest'
import { collectCanonicalSourceFieldPaths } from '../canonical-source-field-paths'

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

  it('omits undefined, empty containers, inherited properties, and container paths without mutating input', () => {
    const prototype = { inherited: 'not-owned' }
    const value = Object.assign(Object.create(prototype), {
      defined: 0,
      absent: undefined,
      emptyObject: {},
      emptyArray: [],
      nested: [[{ value: '' }]],
    })
    const before = structuredClone(value)

    expect(collectCanonicalSourceFieldPaths(value)).toEqual(['defined', 'nested[0][0].value'])
    expect(value).toEqual(before)
  })

  it('builds a request-local catalog for each distinct structure', () => {
    expect(collectCanonicalSourceFieldPaths({ outcomesSnapshot: [] })).toEqual([])
    expect(collectCanonicalSourceFieldPaths({ outcomesSnapshot: [{ id: 'outcome-1' }] })).toEqual(['outcomesSnapshot[0].id'])
  })
})
