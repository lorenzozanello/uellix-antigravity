// scripts/custody/d1-effective-schedule.ts
//
// THE EFFECTIVE D-1 SCHEDULE (N08 / N31 / N09), FROM AN APPEND-ONLY CHAIN.
//
// The first schedule was bound in the N06 closure record. That record is
// append-only, so a fresh owner schedule cannot overwrite it; it is SUPERSEDED
// by a schedule-supersession record, and each later one supersedes the one
// before it:
//
//   N06 closure record  <-  SCHEDULE_SUPERSESSION_v1.0.0  <-  v1.0.1  <- ...
//
// The effective schedule is the last link. Every link is re-checked, never
// trusted: N08 and N31 must be the owner's signed values verbatim, N09 must be
// computeValidUntilUtc(N08) (never chosen), N31 must lie in [N08, N09], and
// each record must supersede exactly the link before it. Any break is an error
// and PRE-HC1 fails closed on it.
//
// Ordering: the schedule is part of the certified package (docs/ops/release is
// inside the package closure), so it must be final BEFORE a candidate is
// certified. A schedule written after the certification event changes HEAD by
// more than the event and makes N10 NOT_READY until a new candidate is
// certified — by design (termination regression, case C).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkPlannedRemoval, computeValidUntilUtc, parseUtcInstant } from './d1-n09-valid-until'

export const SCHEDULE_DIR = 'docs/ops/release'
export const SCHEDULE_BASE = `${SCHEDULE_DIR}/FIBDB053_D1_AUDITOR_N06_CLOSURE_EXECUTION_RECORD_v1.0.0.json`
export const SCHEDULE_SUCCESSOR = /^FIBDB053_D1_AUDITOR_SCHEDULE_SUPERSESSION_v(\d+)\.(\d+)\.(\d+)\.json$/

export function scheduleSupersessionPath(version: string): string {
  return `${SCHEDULE_DIR}/FIBDB053_D1_AUDITOR_SCHEDULE_SUPERSESSION_v${version}.json`
}

export interface EffectiveSchedule {
  /** Planned FINAL WITNESS (W), owner datum. */
  readonly N08: string | null
  /** Planned removal (R), owner datum. */
  readonly N31: string | null
  /** Expiry (E), computeValidUntilUtc(N08). */
  readonly N09: string | null
  /** The record the effective values come from. */
  readonly source: string
  /** Every link, base first. */
  readonly chain: readonly string[]
  readonly errors: readonly string[]
}

interface ScheduleDoc {
  readonly append_only?: unknown
  readonly supersedes?: unknown
  readonly OWNER_INPUTS_SIGNED?: { readonly N08_PLANNED_FINAL_WITNESS?: unknown; readonly N31_PLANNED_REMOVAL_INSTANT?: unknown; readonly SIGNED?: unknown }
  readonly N08?: { readonly value?: unknown }
  readonly N31?: { readonly value?: unknown }
  readonly N09?: { readonly expiry_exact_utc?: unknown }
}

function readDoc(root: string, rel: string): ScheduleDoc | null {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8')) as ScheduleDoc
  } catch {
    return null
  }
}

/** The checks every link must pass, base included. */
function checkLink(rel: string, d: ScheduleDoc): { n08: string | null; n31: string | null; n09: string | null; errors: string[] } {
  const errors: string[] = []
  const n08 = typeof d.N08?.value === 'string' ? d.N08.value : null
  const n31 = typeof d.N31?.value === 'string' ? d.N31.value : null
  const n09 = typeof d.N09?.expiry_exact_utc === 'string' ? d.N09.expiry_exact_utc : null
  const owner = d.OWNER_INPUTS_SIGNED
  if (d.append_only !== true) errors.push(`${rel} is not append-only`)
  if (owner?.SIGNED !== 'YES') errors.push(`${rel} does not carry the owner's signed inputs`)
  if (n08 === null || owner?.N08_PLANNED_FINAL_WITNESS !== n08) errors.push(`${rel}: N08 is not the owner's signed value verbatim`)
  if (n31 === null || owner?.N31_PLANNED_REMOVAL_INSTANT !== n31) errors.push(`${rel}: N31 is not the owner's signed value verbatim`)
  if (n08 !== null) {
    try {
      parseUtcInstant('N08', n08)
      if (n09 !== computeValidUntilUtc(n08)) errors.push(`${rel}: N09 ${String(n09)} is not computeValidUntilUtc(N08) = ${computeValidUntilUtc(n08)}`)
      if (n31 !== null) {
        const r = checkPlannedRemoval({ plannedFinalWitnessUtc: n08, plannedRemovalUtc: n31 })
        errors.push(...r.problems.map((p) => `${rel}: ${p}`))
      }
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`)
    }
  }
  return { n08, n31, n09, errors }
}

export function deriveEffectiveSchedule(root: string): EffectiveSchedule {
  const errors: string[] = []
  const base = readDoc(root, SCHEDULE_BASE)
  if (base === null) return { N08: null, N31: null, N09: null, source: SCHEDULE_BASE, chain: [], errors: [`the schedule base ${SCHEDULE_BASE} cannot be read`] }
  let current = { rel: SCHEDULE_BASE, ...checkLink(SCHEDULE_BASE, base) }
  errors.push(...current.errors)
  const chain = [SCHEDULE_BASE]

  const dir = join(root, SCHEDULE_DIR)
  const successors = (existsSync(dir) ? readdirSync(dir) : [])
    .map((n) => ({ n, m: SCHEDULE_SUCCESSOR.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map(({ n, m }) => ({ rel: `${SCHEDULE_DIR}/${n}`, key: [Number(m[1]), Number(m[2]), Number(m[3])] }))
    .sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.key[2]! - b.key[2]!)
  const seen = new Set<string>()
  for (const s of successors) {
    const k = s.key.join('.')
    if (seen.has(k)) errors.push(`schedule version ${k} appears more than once`)
    seen.add(k)
    const d = readDoc(root, s.rel)
    if (d === null) {
      errors.push(`${s.rel} is named as a schedule supersession and is not JSON`)
      continue
    }
    if (d.supersedes !== current.rel) errors.push(`${s.rel} supersedes ${String(d.supersedes)}, not the link before it (${current.rel})`)
    const link = checkLink(s.rel, d)
    errors.push(...link.errors)
    current = { rel: s.rel, ...link }
    chain.push(s.rel)
  }
  return { N08: current.n08, N31: current.n31, N09: current.n09, source: current.rel, chain, errors }
}
