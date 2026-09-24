// @vitest-environment node
// tests/recovery/evidence-privacy.test.ts — OR-N12 (row contents entering
// evidence -> RED) and NB-1 (the stderr confirmation oracle, closed).

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { validateBackupPacket } from '../../scripts/recovery/artifact-packet'
import { CENSUS_SHAPE } from '../../scripts/recovery/catalog-census'
import { classifyToolOutcome, extractSqlstate, findForbiddenSubstrings, sqlstateClass, TOOL_OUTCOME_SHAPE, validateEvidence } from '../../scripts/recovery/evidence-privacy'
import { INVARIANT_RESULT_SHAPE } from '../../scripts/recovery/post-restore-invariants'
import { RESTORE_STEP_SHAPE } from '../../scripts/recovery/restore-runner'
import { sampleCensus, samplePacket } from './sample-evidence'

const CANARY = 'CANARY-ROW-VALUE-MEMBER-1-9b0d'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('evidence grammar', () => {
  it('the sample packet and census are grammar-valid', () => {
    expect(validateEvidence(sampleCensus(), CENSUS_SHAPE)).toEqual([])
    expect(validateBackupPacket(samplePacket())).toEqual([])
  })

  it('OR-N12: an extra key carrying a sample row is refused, at top level and nested', () => {
    const top = { ...samplePacket(), sample_rows: [{ display: CANARY }] }
    expect(validateBackupPacket(top).map((v) => v.path)).toContain('$.backup_packet.sample_rows')
    const p = samplePacket()
    ;(p['the scope covered'] as unknown as Record<string, unknown>).sample_rows = [CANARY]
    expect(validateBackupPacket(p).map((v) => v.path)).toContain('$.backup_packet.the scope covered.sample_rows')
  })

  it('OR-N12: a count replaced by row text is refused', () => {
    const census = sampleCensus()
    ;(census.row_counts[0] as unknown as { rows: string }).rows = CANARY
    expect(validateEvidence(census, CENSUS_SHAPE).some((v) => v.path.endsWith('.rows'))).toBe(true)
  })

  it('OR-N12: row text in an identifier-typed field is refused', () => {
    const census = sampleCensus()
    census.relations[0].name = 'Ada Lovelace <ada@example.test>'
    census.roles_referenced.push(CANARY)
    const violations = validateEvidence(census, CENSUS_SHAPE)
    expect(violations.some((v) => v.path.includes('relations[0].name'))).toBe(true)
    expect(violations.some((v) => v.path.includes('roles_referenced'))).toBe(true)
  })

  it('OR-N12: a negative or fractional count is refused; a missing key is a violation', () => {
    const census = sampleCensus()
    census.row_counts[1].rows = -1
    census.row_counts[2].rows = 2.5
    expect(validateEvidence(census, CENSUS_SHAPE)).toHaveLength(2)
    const c2 = sampleCensus() as unknown as Record<string, unknown>
    delete c2.journal
    expect(validateEvidence(c2, CENSUS_SHAPE)).toContainEqual({ path: '$.journal', problem: expect.stringContaining('absent') })
  })

  it('fact grammar: invariant facts carrying row-shaped text are refused (quotes, spaces, parentheses)', () => {
    const base = { id: 'PRI-5', phase: 'READ_ONLY', predicate: 'PER_RELATION_ROW_COUNTS_EQUAL_AND_SOURCE_HAS_A_NON_EMPTY_RELATION', predicate_sha256: 'a'.repeat(64), census_sql_sha256: 'b'.repeat(64), verdict: 'PASS', reason_code: null, expected: ['public.fixture_org:rows=3'], observed: ['public.fixture_org:rows=3'] }
    expect(validateEvidence(base, INVARIANT_RESULT_SHAPE)).toEqual([])
    for (const bad of ["Failing row contains (1, 1, 'x')", 'Ada Lovelace', 'a"b', 'row(1)', 'x'.repeat(513)]) {
      expect(validateEvidence({ ...base, observed: [bad] }, INVARIANT_RESULT_SHAPE).length, bad).toBeGreaterThan(0)
    }
  })

  it('findForbiddenSubstrings: second layer over the serialized evidence, keys included', () => {
    expect(findForbiddenSubstrings(JSON.stringify(samplePacket()), [CANARY])).toEqual([])
    expect(findForbiddenSubstrings(JSON.stringify({ [CANARY]: 1 }), [CANARY])).toEqual([CANARY])
    expect(findForbiddenSubstrings('abc', [''])).toEqual([])
  })
})

describe('NB-1: tool stderr leaves no oracle', () => {
  const stderrFor = (pin: string) =>
    [
      'pg_restore: error: COPY failed for table "fixture_member": ERROR:  duplicate key value violates unique constraint "fixture_member_pin_key"',
      `DETAIL:  Key (pin)=(${pin}) already exists.`,
      `CONTEXT:  COPY fixture_member, line 1: "1	1	${CANARY}	${pin}"`,
    ].join('\n')

  it('a tool outcome is exactly {exit_code, diagnostic}: no digest, no line count, no text', () => {
    const o = classifyToolOutcome(1, stderrFor('4821'))
    expect(Object.keys(o).sort()).toEqual(['diagnostic', 'exit_code'])
    expect(validateEvidence(o, TOOL_OUTCOME_SHAPE)).toEqual([])
    const json = JSON.stringify(o)
    expect(json).not.toContain(CANARY)
    expect(json).not.toContain('4821')
    expect(json).not.toContain(sha(stderrFor('4821')))
  })

  it('the recert brute force: evidence is IDENTICAL for all 10 000 four-digit values, so no guess can be confirmed', () => {
    const seen = new Set<string>()
    for (let n = 0; n < 10000; n++) {
      const pin = String(n).padStart(4, '0')
      seen.add(JSON.stringify(classifyToolOutcome(1, stderrFor(pin))))
      seen.add(JSON.stringify({ step: 'PG_RESTORE', status: 'FAILED', exit_code: 1, diagnostic: classifyToolOutcome(1, stderrFor(pin)).diagnostic, input_sha256: null }))
    }
    expect(seen.size).toBe(2)
  })

  it('a restore step record validates with the closed diagnostic and refuses a stderr digest or text', () => {
    const step = { step: 'PG_RESTORE', status: 'FAILED', exit_code: 1, diagnostic: 'UNKNOWN', input_sha256: 'a'.repeat(64) }
    expect(validateEvidence(step, RESTORE_STEP_SHAPE)).toEqual([])
    expect(validateEvidence({ ...step, stderr_sha256: sha('x') }, RESTORE_STEP_SHAPE).length).toBeGreaterThan(0)
    expect(validateEvidence({ ...step, stderr: 'x' }, RESTORE_STEP_SHAPE).length).toBeGreaterThan(0)
    expect(validateEvidence({ ...step, diagnostic: 'Key (pin)=(4821)' }, RESTORE_STEP_SHAPE).length).toBeGreaterThan(0)
  })

  it('exit 0 is NONE whatever stderr says; free-text errors are UNKNOWN (fail closed)', () => {
    expect(classifyToolOutcome(0, 'WARNING: anything at all')).toEqual({ exit_code: 0, diagnostic: 'NONE' })
    expect(classifyToolOutcome(1, stderrFor('0000')).diagnostic).toBe('UNKNOWN')
    expect(classifyToolOutcome(null, '').diagnostic).toBe('UNKNOWN')
  })

  it('only a WHOLE tool-generated line yields a SQLSTATE (VERBOSITY=sqlstate form)', () => {
    expect(extractSqlstate('ERROR:  42501\n')).toBe('42501')
    expect(extractSqlstate('psql:<stdin>:3: ERROR:  42501')).toBe('42501')
    expect(extractSqlstate('ERROR:  permission denied for schema public')).toBeNull()
    expect(extractSqlstate(`DETAIL:  row contains ERROR:  42501 inside`)).toBeNull()
    expect(extractSqlstate('pg_restore: error: could not execute query: ERROR:  42501')).toBeNull()
  })

  it('SQLSTATE maps to a closed class; unlisted codes are UNKNOWN, never passed through', () => {
    expect(sqlstateClass('42501')).toBe('INSUFFICIENT_PRIVILEGE')
    expect(sqlstateClass('23505')).toBe('INTEGRITY_CONSTRAINT_VIOLATION')
    expect(sqlstateClass('42P01')).toBe('UNDEFINED_OBJECT')
    expect(sqlstateClass('42P06')).toBe('DUPLICATE_OBJECT')
    expect(sqlstateClass('28P01')).toBe('CONNECTION_OR_AUTHENTICATION_FAILURE')
    expect(sqlstateClass('XX000')).toBe('UNKNOWN')
    expect(sqlstateClass(null)).toBe('UNKNOWN')
  })
})
