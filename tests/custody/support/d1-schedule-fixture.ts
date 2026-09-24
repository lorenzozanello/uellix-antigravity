// tests/custody/support/d1-schedule-fixture.ts
//
// Writes a VALID schedule supersession (and the matching inventory values) into
// a disposable root — never into this repository. N09 is computed, never typed.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { deriveEffectiveSchedule, scheduleSupersessionPath } from '@/scripts/custody/d1-effective-schedule'
import { CUSTODY_INVENTORY } from '@/scripts/custody/d1-n06-closure'
import { computeValidUntilUtc } from '@/scripts/custody/d1-n09-valid-until'

export function supersessionBody(p: { supersedes: string; N08: string; N31: string; N09?: string }): Record<string, unknown> {
  const N09 = p.N09 ?? computeValidUntilUtc(p.N08)
  return {
    version: 'fixture',
    append_only: true,
    supersedes: p.supersedes,
    OWNER_INPUTS_SIGNED: { N08_PLANNED_FINAL_WITNESS: p.N08, N31_PLANNED_REMOVAL_INSTANT: p.N31, SIGNED: 'YES' },
    N08: { value: p.N08 },
    N31: { value: p.N31 },
    N09: { expiry_exact_utc: N09 },
    W_R_E_RELATION: { W: p.N08, R: p.N31, E: N09, W_le_R_le_E: true },
    fixture: 'DISPOSABLE_SCHEDULE_FIXTURE__NOT_AN_OWNER_INPUT',
  }
}

/** A valid next link of the effective schedule, plus the inventory values PRE-HC1 checks against it. */
export function writeValidScheduleChange(root: string, version: string, N08: string, N31: string): void {
  const supersedes = deriveEffectiveSchedule(root).source
  writeFileSync(join(root, scheduleSupersessionPath(version)), `${JSON.stringify(supersessionBody({ supersedes, N08, N31 }), null, 2)}\n`)
  const invPath = join(root, CUSTODY_INVENTORY)
  const inv = JSON.parse(readFileSync(invPath, 'utf8')) as { entries: Array<Record<string, unknown>> }
  inv.entries[0]!.expiry_exact_utc = computeValidUntilUtc(N08)
  inv.entries[0]!.planned_removal_date = N31
  writeFileSync(invPath, `${JSON.stringify(inv, null, 2)}\n`)
}
