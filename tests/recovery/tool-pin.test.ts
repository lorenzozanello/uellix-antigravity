// @vitest-environment node
// tests/recovery/tool-pin.test.ts — OR-P3 and OR-N4 (unsupported tool skew -> RED).

import { describe, expect, it } from 'vitest'

import { evaluateToolPin, parseToolVersion, RECOVERY_TOOL_PIN, type ToolObservation } from '../../scripts/recovery/tool-pin'

const exact: ToolObservation = {
  imageId: RECOVERY_TOOL_PIN.imageId,
  pgDumpVersionLine: 'pg_dump (PostgreSQL) 17.6',
  pgRestoreVersionLine: 'pg_restore (PostgreSQL) 17.6',
  sourceServerVersionNum: 170006,
  substrateServerVersionNum: 170006,
  artifactDumpedBy: '17.6',
  artifactDumpedFrom: '17.6',
}
const ALL = Object.keys(exact) as Array<keyof ToolObservation>

describe('recovery tool pin', () => {
  it('pins the measured target build, not the governed rehearsal build', () => {
    expect(RECOVERY_TOOL_PIN.imageRef).toBe('public.ecr.aws/supabase/postgres:17.6.1.155')
    expect(RECOVERY_TOOL_PIN.imageId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(RECOVERY_TOOL_PIN.serverVersionNum).toBe(170006)
  })

  it('OR-P3: the exact pin is COMPATIBLE', () => {
    expect(evaluateToolPin(exact, ALL)).toEqual({ ok: true })
  })

  it.each([
    ['imageId', 'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453', 'TOOL_IMAGE_ID_MISMATCH'],
    ['pgDumpVersionLine', 'pg_dump (PostgreSQL) 16.9', 'TOOL_PG_DUMP_VERSION_SKEW'],
    ['pgDumpVersionLine', 'pg_dump (PostgreSQL) 17.7', 'TOOL_PG_DUMP_VERSION_SKEW'],
    ['pgRestoreVersionLine', 'pg_restore (PostgreSQL) 18.0', 'TOOL_PG_RESTORE_VERSION_SKEW'],
    ['pgRestoreVersionLine', 'pg_dump (PostgreSQL) 17.6', 'TOOL_PG_RESTORE_VERSION_SKEW'],
    ['sourceServerVersionNum', 170007, 'TOOL_SOURCE_SERVER_VERSION_SKEW'],
    ['sourceServerVersionNum', 160009, 'TOOL_SOURCE_SERVER_VERSION_SKEW'],
    ['substrateServerVersionNum', 170005, 'TOOL_SUBSTRATE_SERVER_VERSION_SKEW'],
    ['artifactDumpedBy', '16.4', 'TOOL_ARTIFACT_DUMPED_BY_SKEW'],
    ['artifactDumpedFrom', '17.5', 'TOOL_ARTIFACT_DUMPED_FROM_SKEW'],
  ] as const)('OR-N4: %s = %j is refused as %s', (field, value, code) => {
    const v = evaluateToolPin({ ...exact, [field]: value }, ALL)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.refusals).toEqual([{ code, field }])
  })

  it('OR-N4: a required observation that was not made is a refusal, never a pass', () => {
    for (const field of ALL) {
      for (const missing of [null, undefined, '']) {
        const v = evaluateToolPin({ ...exact, [field]: missing }, ALL)
        expect(v).toEqual({ ok: false, refusals: [{ code: 'TOOL_OBSERVATION_MISSING', field }] })
      }
    }
  })

  it('parseToolVersion accepts only the exact tool banner', () => {
    expect(parseToolVersion('pg_dump (PostgreSQL) 17.6', 'pg_dump')).toBe('17.6')
    expect(parseToolVersion('pg_dump (PostgreSQL) 17.6 (Debian 17.6-1)', 'pg_dump')).toBe('17.6')
    expect(parseToolVersion('pg_dumpall (PostgreSQL) 17.6', 'pg_dump')).toBeNull()
    expect(parseToolVersion('17.6', 'pg_dump')).toBeNull()
    expect(parseToolVersion(null, 'pg_restore')).toBeNull()
  })
})
