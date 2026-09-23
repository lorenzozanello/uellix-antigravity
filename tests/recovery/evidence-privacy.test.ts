// @vitest-environment node
// tests/recovery/evidence-privacy.test.ts — OR-N12 (row contents entering
// evidence -> RED), SENT-RESTORE-ERROR-ROW at the unit level.

import { describe, expect, it } from 'vitest'

import { BACKUP_PACKET_SHAPE, validateBackupPacket } from '../../scripts/recovery/artifact-packet'
import { CENSUS_SHAPE } from '../../scripts/recovery/catalog-census'
import { extractSqlstate, findForbiddenSubstrings, summarizeStderr, validateEvidence } from '../../scripts/recovery/evidence-privacy'
import { samplePacket, sampleCensus } from './sample-evidence'

const CANARY = 'CANARY-ROW-VALUE-MEMBER-1-9b0d'

describe('evidence grammar', () => {
  it('the sample packet and census are grammar-valid', () => {
    expect(validateEvidence(sampleCensus(), CENSUS_SHAPE)).toEqual([])
    expect(validateEvidence(samplePacket(), BACKUP_PACKET_SHAPE)).toEqual([])
    expect(validateBackupPacket(samplePacket())).toEqual([])
  })

  it('OR-N12: an extra key carrying a sample row is refused', () => {
    const p = { ...samplePacket(), sample_rows: [{ display: CANARY }] }
    expect(validateBackupPacket(p).map((v) => v.path)).toContain('$.backup_packet.sample_rows')
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

  it('OR-N12: a missing key is a violation (an omitted field reads as a passed field)', () => {
    const p = samplePacket() as unknown as Record<string, unknown>
    delete p.no_intervening_mutation
    expect(validateBackupPacket(p)).toContainEqual({ path: '$.backup_packet.no_intervening_mutation', problem: expect.stringContaining('absent') })
  })

  it('OR-N12: a negative or fractional count is refused', () => {
    const census = sampleCensus()
    census.row_counts[1].rows = -1
    census.row_counts[2].rows = 2.5
    expect(validateEvidence(census, CENSUS_SHAPE)).toHaveLength(2)
  })

  it('findForbiddenSubstrings: second layer over the serialized evidence, keys included', () => {
    expect(findForbiddenSubstrings(JSON.stringify(samplePacket()), [CANARY])).toEqual([])
    expect(findForbiddenSubstrings(JSON.stringify({ [CANARY]: 1 }), [CANARY])).toEqual([CANARY])
    expect(findForbiddenSubstrings('abc', [''])).toEqual([])
  })
})

describe('tool stderr never survives as text', () => {
  const stderr = [
    'pg_restore: error: COPY failed for table "fixture_member": ERROR:  new row for relation "fixture_member" violates check constraint "no_canary"',
    `DETAIL:  Failing row contains (1, 1, ${CANARY}, 2026-09-23 20:00:35+00).`,
  ].join('\n')

  it('summarizeStderr keeps digest, line count and class only', () => {
    const s = summarizeStderr(stderr)
    expect(Object.keys(s).sort()).toEqual(['stderr_class', 'stderr_lines', 'stderr_sha256'])
    expect(s.stderr_class).toBe('ERROR')
    expect(s.stderr_lines).toBe(2)
    expect(JSON.stringify(s)).not.toContain(CANARY)
  })

  it('classifies empty, notice, warning and fatal output', () => {
    expect(summarizeStderr('').stderr_class).toBe('EMPTY')
    expect(summarizeStderr('NOTICE:  x').stderr_class).toBe('NOTICE_ONLY')
    expect(summarizeStderr('WARNING:  x').stderr_class).toBe('WARNING')
    expect(summarizeStderr('FATAL:  28P01').stderr_class).toBe('FATAL')
  })

  it('extractSqlstate reads the VERBOSITY=sqlstate form only', () => {
    expect(extractSqlstate('ERROR:  42501\n')).toBe('42501')
    expect(extractSqlstate('psql:<stdin>:3: ERROR:  42501')).toBe('42501')
    expect(extractSqlstate('ERROR:  permission denied for schema public')).toBeNull()
  })
})
