// @vitest-environment node
// tests/infra-read/mutation-verdict.test.ts — the battery's own verdict logic (v1.0.5).
// The v1.0.4 battery reported a SURVIVED mutant as AS_EXPECTED; these pin that it cannot.

import { describe, it, expect } from 'vitest'
import { aggregate, classify, verdictOf } from '../../scripts/infra-read/mutation-verdict.mjs'

describe('mutation battery verdict logic', () => {
  it('SURVIVED is never AS_EXPECTED for a mutant expected to be KILLED', () => {
    expect(classify('KILLED', 'SURVIVED')).toBe('UNEXPECTED')
    expect(classify('KILLED', 'KILLED')).toBe('AS_EXPECTED')
  })
  it('ERROR (crash / timeout / no test summary) never counts as a kill', () => {
    expect(classify('KILLED', 'ERROR')).toBe('UNEXPECTED')
    expect(verdictOf(null, '')).toBe('ERROR')
    expect(verdictOf(1, 'npm ERR! something')).toBe('ERROR')
  })
  it('unknown expectations are UNEXPECTED (the v1.0.4 "RED" spelling is not accepted)', () => {
    expect(classify('RED', 'KILLED')).toBe('UNEXPECTED')
    expect(classify('RED', 'SURVIVED')).toBe('UNEXPECTED')
  })
  it('verdictOf reads the vitest summary', () => {
    expect(verdictOf(0, 'Tests  244 passed (244)')).toBe('SURVIVED')
    expect(verdictOf(1, ' Test Files  1 failed | 6 passed (7)\n      Tests  3 failed | 241 passed (244)')).toBe('KILLED')
  })
  it('the aggregate FAILS on a single survivor and on an empty battery', () => {
    const rows = [{ classification: classify('KILLED', 'KILLED') }, { classification: classify('KILLED', 'SURVIVED') }]
    expect(aggregate(rows)).toEqual({ total: 2, asExpected: 1, unexpected: 1, pass: false })
    expect(aggregate([]).pass).toBe(false)
    expect(aggregate([{ classification: 'AS_EXPECTED' }]).pass).toBe(true)
  })
})
