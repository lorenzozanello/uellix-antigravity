// @vitest-environment node
// tests/recovery/mutation-verdict.test.ts — OR-M-SELF, pure half: the battery's
// verdict logic can FAIL. (The live half is `mutation-battery.ts --self-test`,
// which feeds a REAL neutral edit and demands BATTERY=FAIL.)

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { MUTANTS, NEUTRAL_MUTANT } from '../../scripts/recovery/mutation-battery'
import { aggregateBattery, classifyMutant, observeVitest, type MutantOutcome } from '../../scripts/recovery/mutation-verdict'

const killed: MutantOutcome = { id: 'M', expect: 'KILLED', observed: 'KILLED', anchorFound: true, restoredByteIdentical: true }

describe('classifyMutant', () => {
  it('AS_EXPECTED only when observed === expected with anchor found and bytes restored', () => {
    expect(classifyMutant(killed)).toBe('AS_EXPECTED')
    expect(classifyMutant({ ...killed, observed: 'SURVIVED' })).toBe('UNEXPECTED')
    expect(classifyMutant({ ...killed, expect: 'SURVIVED', observed: 'SURVIVED' })).toBe('AS_EXPECTED')
  })

  it('ERROR is never a kill, whatever was expected', () => {
    expect(classifyMutant({ ...killed, observed: 'ERROR' })).toBe('UNEXPECTED')
    expect(classifyMutant({ ...killed, expect: 'SURVIVED', observed: 'ERROR' })).toBe('UNEXPECTED')
  })

  it('a missing anchor or a file not restored byte-identical is UNEXPECTED even if the tests went red', () => {
    expect(classifyMutant({ ...killed, anchorFound: false })).toBe('UNEXPECTED')
    expect(classifyMutant({ ...killed, restoredByteIdentical: false })).toBe('UNEXPECTED')
  })
})

describe('aggregateBattery', () => {
  it('one survivor fails the battery', () => {
    expect(aggregateBattery([killed, { ...killed, id: 'N', observed: 'SURVIVED' }], true)).toEqual({ battery: 'FAIL', reasons: ['UNEXPECTED_N'] })
  })
  it('an empty battery and a red baseline fail it', () => {
    expect(aggregateBattery([], true).battery).toBe('FAIL')
    expect(aggregateBattery([killed], false)).toEqual({ battery: 'FAIL', reasons: ['BASELINE_NOT_GREEN'] })
  })
  it('all as expected with a green baseline passes', () => {
    expect(aggregateBattery([killed], true)).toEqual({ battery: 'PASS', reasons: [] })
  })
})

describe('observeVitest', () => {
  it('KILLED needs a non-zero exit AND failing tests', () => {
    expect(observeVitest(1, ' Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)')).toBe('KILLED')
  })
  it('SURVIVED needs exit 0 AND passing tests with no failure', () => {
    expect(observeVitest(0, ' Test Files  1 passed (1)\n      Tests  12 passed (12)')).toBe('SURVIVED')
  })
  it('a load failure, a missing summary or a timeout is ERROR, not a kill', () => {
    expect(observeVitest(1, 'Error: Transform failed with 1 error\n Test Files  1 failed (1)\n      Tests  no tests')).toBe('ERROR')
    expect(observeVitest(null, '')).toBe('ERROR')
    expect(observeVitest(0, 'Tests  0 passed')).toBe('ERROR')
  })
  it('strips ANSI colour codes before reading the summary', () => {
    expect(observeVitest(1, '\x1b[31mTests\x1b[39m  \x1b[1m3 failed\x1b[22m | 4 passed')).toBe('KILLED')
  })
})

describe('battery definition', () => {
  const ROOT = path.resolve(import.meta.dirname, '../..')
  it('every edit anchor exists exactly once in its file, so every mutation is real and unambiguous', () => {
    for (const m of [...MUTANTS, NEUTRAL_MUTANT]) {
      for (const edit of m.edits) {
        const text = readFileSync(path.join(ROOT, edit.file), 'utf8')
        expect(text.split(edit.anchor).length - 1, `${m.id} in ${edit.file}`).toBe(1)
      }
    }
  })
  it('covers the manifest controls OR-M1..OR-M14 and every remediation class the recert named', () => {
    const ids = new Set(MUTANTS.map((m) => m.id.replace(/b$/, '')))
    for (let i = 1; i <= 14; i++) expect(ids.has(`OR-M${i}`), `OR-M${i}`).toBe(true)
    for (const id of ['B1-M1', 'B1-M2', 'B1-M3', 'NB1-M1', 'NB1-M2', 'NB2-M1', 'NB2-M2', 'NB2-M3', 'NB3-M1', 'NB3-M2', 'NB3-M3', 'NB3-M4', 'NB3-M5', 'NB3-M6', 'NB3-M7', 'NB6-M1']) {
      expect(ids.has(id), id).toBe(true)
    }
  })
  it('the neutral self-test mutant changes a comment only and is declared KILLED on purpose', () => {
    expect(NEUTRAL_MUTANT.edits).toHaveLength(1)
    expect(NEUTRAL_MUTANT.edits[0].anchor.startsWith('//')).toBe(true)
    expect(NEUTRAL_MUTANT.edits[0].replacement.startsWith('//')).toBe(true)
    expect(NEUTRAL_MUTANT.expect).toBe('KILLED')
  })
})
