// @vitest-environment node
// tests/custody/d1-n06-closure.test.ts
//
// N06's closure is EVALUATED, and this file holds the recorded verdict to the
// evaluation. Hand-editing the expiry, the removal instant, a predecessor
// state or the verdict in the record or the inventory turns this red.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CUSTODY_INVENTORY,
  deriveN06Fields,
  evaluateN06,
  evaluateN06InRepo,
  readRootClause,
  type NodeState,
} from '@/scripts/custody/d1-n06-closure'
import { computeValidUntilUtc } from '@/scripts/custody/d1-n09-valid-until'
import { hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'

const ROOT = resolve(__dirname, '..', '..')
const RECORD = 'docs/ops/release/FIBDB053_D1_AUDITOR_N06_CLOSURE_EXECUTION_RECORD_v1.0.0.json'
const record = JSON.parse(readFileSync(join(ROOT, RECORD), 'utf8'))
const inventory = JSON.parse(readFileSync(join(ROOT, CUSTODY_INVENTORY), 'utf8'))
const entry = inventory.entries[0] as Record<string, unknown>
const states = record.N06_EVALUATION.predecessor_states as Record<string, NodeState>
const W = record.N08.value as string

describe('the recorded N06 verdict is the evaluation', () => {
  it('re-evaluates the repository to the recorded status, holes and predecessors', () => {
    const ev = evaluateN06InRepo(ROOT, W, states)
    expect(ev.status).toBe(record.N06_STATUS)
    expect(ev.preMintHoles).toEqual(record.N06_EVALUATION.pre_mint_holes)
    expect(ev.hardPredecessors).toEqual(record.N06_EVALUATION.hard_predecessors_from_graph)
    expect(ev.status).toBe('SATISFIED')
  })

  it('derives eight fields from the root clause, seven pre-mint, mint_date the one excluded', () => {
    const fields = deriveN06Fields(readRootClause(ROOT))
    expect(fields).toHaveLength(8)
    expect(fields.filter((f) => !f.preMint).map((f) => f.field)).toEqual(['mint_date'])
  })

  it('reads the HARD predecessors from the graph, and they include both owner intakes', () => {
    const preds = hardPredecessorsOf('N06')
    expect(preds).toEqual(['N03', 'N05', 'N09', 'N31', 'N32'])
    expect(Object.keys(states).sort()).toEqual(preds)
  })
})

describe('N08, N09 and N31 in the inventory are exactly the bound and derived values', () => {
  it('holds the N09 derivation of the N08 instant, verbatim', () => {
    expect(W).toBe('2026-09-24T14:00:00Z')
    expect(entry.expiry_exact_utc).toBe(computeValidUntilUtc(W))
    expect(record.N09.expiry_exact_utc).toBe(entry.expiry_exact_utc)
    expect(new Date(entry.expiry_exact_utc as string).getTime() - Date.parse(W)).toBe(86_400_000)
  })

  it('holds the owner removal instant, distinct from the expiry and within [W, E]', () => {
    expect(entry.planned_removal_date).toBe('2026-09-24T18:00:00Z')
    expect(entry.planned_removal_date).not.toBe(entry.expiry_exact_utc)
    expect(record.W_R_E_RELATION.W_le_R_le_E).toBe(true)
  })

  it('never states that the FINAL WITNESS happened', () => {
    expect(record.FINAL_WITNESS_ACTUAL_EXECUTION).toMatch(/^NOT YET OCCURRED/)
    expect(record.N08.status).toContain('planned-witness scheduling only')
  })
})

describe('the evaluation fails closed (mutation controls)', () => {
  const base = { rootClause: readRootClause(ROOT), entry, plannedFinalWitnessUtc: W, predecessorStates: states, hardPredecessors: hardPredecessorsOf('N06') }
  const withEntry = (patch: Record<string, unknown>) => evaluateN06({ ...base, entry: { ...entry, ...patch } })

  it.each([
    ['a missing human custodian', { human_custodian: null }],
    ['an empty processes_or_environments', { processes_or_environments: [] }],
    ['a hand-edited expiry', { expiry_exact_utc: '2026-09-25T15:00:00.000Z' }],
    ['the expiry copied into the removal slot', { planned_removal_date: '2026-09-25T14:00:00.000Z', expiry_exact_utc: '2026-09-25T14:00:00.001Z' }],
    ['a removal before the witness', { planned_removal_date: '2026-09-24T13:59:59Z' }],
    ['a removal after the expiry', { planned_removal_date: '2026-09-25T14:00:01Z' }],
    ['a date-only removal', { planned_removal_date: '2026-09-24' }],
    ['a mint date before the mint', { mint_date: '2026-09-23' }],
    ['a connection string in the entry', { note: ['postgresql:', '//x:y', '@h/db'].join('') }],
  ])('refuses %s', (_label, patch) => {
    expect(withEntry(patch).status).toBe('NOT_SATISFIED')
  })

  it('refuses an unsatisfied HARD predecessor', () => {
    expect(evaluateN06({ ...base, predecessorStates: { ...states, N31: 'NOT_SATISFIED' } }).status).toBe('NOT_SATISFIED')
  })

  it('refuses to evaluate over an empty predecessor set', () => {
    expect(evaluateN06({ ...base, hardPredecessors: [] }).status).toBe('NOT_SATISFIED')
  })

  it('refuses a missing N08 instant', () => {
    expect(evaluateN06({ ...base, plannedFinalWitnessUtc: null }).status).toBe('NOT_SATISFIED')
  })

  it('throws on a root-clause phrase it does not know, instead of skipping it', () => {
    expect(() => deriveN06Fields('The entry records: the capability name, the favourite colour. Where x')).toThrow()
  })
})
