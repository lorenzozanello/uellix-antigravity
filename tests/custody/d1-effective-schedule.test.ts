// @vitest-environment node
// tests/custody/d1-effective-schedule.test.ts
//
// THE EFFECTIVE SCHEDULE IS DERIVED FROM AN APPEND-ONLY CHAIN AND RE-CHECKED.
//
// The live assertions name no timestamp: they bind the owner's signed values
// of the effective link and the W <= R <= E relation. The pressure cases copy
// the release and staging directories to a temporary root and change one link.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SCHEDULE_BASE, deriveEffectiveSchedule, scheduleSupersessionPath } from '@/scripts/custody/d1-effective-schedule'
import { computeValidUntilUtc } from '@/scripts/custody/d1-n09-valid-until'
import { evaluateN06, readRootClause, type NodeState } from '@/scripts/custody/d1-n06-closure'
import { hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { deriveUpstreamStates } from '@/scripts/custody/d1-pre-hc1'
import { supersessionBody, writeValidScheduleChange } from './support/d1-schedule-fixture'

const ROOT = process.cwd()
const LIVE = deriveEffectiveSchedule(ROOT)
const LIVE_DOC = JSON.parse(readFileSync(join(ROOT, LIVE.source), 'utf8'))

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function copyRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'd1-schedule-'))
  roots.push(r)
  for (const d of ['docs/ops/release', 'docs/ops/staging']) cpSync(join(ROOT, d), join(r, d), { recursive: true })
  return r
}
const put = (r: string, rel: string, body: unknown) => writeFileSync(join(r, rel), typeof body === 'string' ? body : JSON.stringify(body))

describe('the effective schedule of this candidate', () => {
  it('is the last link of the chain, re-derived with no error', () => {
    expect(LIVE.errors).toEqual([])
    expect(LIVE.chain[0]).toBe(SCHEDULE_BASE)
    expect(LIVE.chain.length).toBeGreaterThanOrEqual(2)
    expect(LIVE.source).toBe(LIVE.chain[LIVE.chain.length - 1])
  })
  it('carries the owner-signed N08 and N31 verbatim and the MACHINE N09', () => {
    expect(LIVE.N08).toBe(LIVE_DOC.OWNER_INPUTS_SIGNED.N08_PLANNED_FINAL_WITNESS)
    expect(LIVE.N31).toBe(LIVE_DOC.OWNER_INPUTS_SIGNED.N31_PLANNED_REMOVAL_INSTANT)
    expect(LIVE.N09).toBe(computeValidUntilUtc(LIVE.N08!))
    expect(LIVE_DOC.N09.historical_n09_reused).toBe(false)
  })
  it('the base link\'s schedule is no longer the effective one (a fresh schedule superseded it)', () => {
    const base = JSON.parse(readFileSync(join(ROOT, SCHEDULE_BASE), 'utf8'))
    expect(LIVE.source).not.toBe(SCHEDULE_BASE)
    expect(LIVE.N09).not.toBe(base.N09.expiry_exact_utc)
  })
  it('states that the schedule precedes certification', () => {
    expect(LIVE_DOC.ORDERING.rule).toMatch(/^SCHEDULE_BEFORE_CERTIFICATION/)
  })
})

describe('changing N08/N31 with an otherwise valid schedule re-derives, it is not pinned', () => {
  it('a valid next link moves the effective values, and N06 evaluates SATISFIED around them', () => {
    const r = copyRoot()
    const N08 = new Date(Date.parse(LIVE.N08!) + 3 * 86_400_000).toISOString().replace('.000Z', 'Z')
    const N31 = new Date(Date.parse(N08) + 2 * 3_600_000).toISOString().replace('.000Z', 'Z')
    writeValidScheduleChange(r, '1.0.1', N08, N31)
    const eff = deriveEffectiveSchedule(r)
    expect(eff.errors).toEqual([])
    expect(eff).toMatchObject({ N08, N31, N09: computeValidUntilUtc(N08), source: scheduleSupersessionPath('1.0.1') })
    const inv = JSON.parse(readFileSync(join(r, 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'), 'utf8'))
    const states = JSON.parse(readFileSync(join(ROOT, SCHEDULE_BASE), 'utf8')).N06_EVALUATION.predecessor_states as Record<string, NodeState>
    const ev = evaluateN06({ rootClause: readRootClause(ROOT), entry: inv.entries[0], plannedFinalWitnessUtc: eff.N08, predecessorStates: states, hardPredecessors: hardPredecessorsOf('N06') })
    expect(ev.status).toBe('SATISFIED')
  })
})

describe('PRE-HC1 reads the EFFECTIVE schedule, not a fixed record', () => {
  it('on this candidate N05, N06 and N09 re-derive SATISFIED with no reason', () => {
    const up = deriveUpstreamStates(ROOT)
    expect(up.reasons).toEqual([])
    expect(up.states).toEqual({ N05: 'SATISFIED', N06: 'SATISFIED', N09: 'SATISFIED' })
  })
  it('a valid schedule change re-derives SATISFIED; an inventory left on the old schedule does not', () => {
    const r = copyRoot()
    for (const d of ['docs/ops/owner-ratifications', 'docs/ops/fib']) cpSync(join(ROOT, d), join(r, d), { recursive: true })
    const N08 = new Date(Date.parse(LIVE.N08!) + 86_400_000).toISOString().replace('.000Z', 'Z')
    const N31 = new Date(Date.parse(N08) + 3_600_000).toISOString().replace('.000Z', 'Z')
    writeValidScheduleChange(r, '1.0.1', N08, N31)
    expect(deriveUpstreamStates(r).states).toMatchObject({ N06: 'SATISFIED', N09: 'SATISFIED' })
    // Now put the inventory back on the previous schedule: both checks against the effective one fail.
    const inv = join(r, 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json')
    writeFileSync(inv, readFileSync(join(ROOT, 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json')))
    const stale = deriveUpstreamStates(r)
    expect(stale.states).toMatchObject({ N06: 'NOT_SATISFIED', N09: 'NOT_SATISFIED' })
    expect(stale.reasons.join(' ')).toMatch(/not the effective N31/)
  })
})

describe('every broken link is an error, never a silent pick', () => {
  const next = () => ({ supersedes: LIVE.source, N08: LIVE.N08!, N31: LIVE.N31! })
  const cases: Array<[string, (r: string) => void, RegExp]> = [
    ['a hand-chosen N09', (r) => put(r, scheduleSupersessionPath('1.0.1'), supersessionBody({ ...next(), N09: new Date(Date.parse(LIVE.N09!) + 3_600_000).toISOString() })), /is not computeValidUntilUtc\(N08\)/],
    ['N08 that is not the signed owner value', (r) => put(r, scheduleSupersessionPath('1.0.1'), { ...supersessionBody(next()), N08: { value: LIVE.N31 } }), /N08 is not the owner's signed value/],
    ['an unsigned link', (r) => put(r, scheduleSupersessionPath('1.0.1'), { ...supersessionBody(next()), OWNER_INPUTS_SIGNED: { ...supersessionBody(next()).OWNER_INPUTS_SIGNED as object, SIGNED: 'NO' } }), /does not carry the owner's signed inputs/],
    ['a link that skips the one before it', (r) => put(r, scheduleSupersessionPath('1.0.1'), supersessionBody({ ...next(), supersedes: SCHEDULE_BASE })), /not the link before it/],
    ['a duplicate version', (r) => put(r, 'docs/ops/release/FIBDB053_D1_AUDITOR_SCHEDULE_SUPERSESSION_v1.0.00.json', supersessionBody(next())), /appears more than once/],
    ['a removal before the witness', (r) => put(r, scheduleSupersessionPath('1.0.1'), supersessionBody({ ...next(), N31: new Date(Date.parse(LIVE.N08!) - 1000).toISOString() })), /EARLIER than the planned FINAL WITNESS/],
    ['a removal after the expiry', (r) => put(r, scheduleSupersessionPath('1.0.1'), supersessionBody({ ...next(), N31: new Date(Date.parse(LIVE.N09!) + 1000).toISOString() })), /LATER than the expiry/],
    ['a link that is not append-only', (r) => put(r, scheduleSupersessionPath('1.0.1'), { ...supersessionBody(next()), append_only: false }), /is not append-only/],
    ['a link that is not JSON', (r) => put(r, scheduleSupersessionPath('1.0.1'), 'not json'), /is not JSON/],
    ['a date-only N08', (r) => put(r, scheduleSupersessionPath('1.0.1'), supersessionBody({ ...next(), N08: LIVE.N08!.slice(0, 10), N09: 'x' })), /N08/],
  ]
  it.each(cases)('%s', (_name, change, why) => {
    const r = copyRoot()
    change(r)
    expect(deriveEffectiveSchedule(r).errors.join(' | ')).toMatch(why)
  })
})
