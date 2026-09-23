// @vitest-environment node
// tests/custody/d1-pre-hc1.test.ts
//
// The pre-HC-1 evaluators: every mutation the convergence lane is required to
// kill, plus the repository-level evaluations that do not depend on the
// worktree being clean.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PATHS,
  deriveUpstreamStates,
  evaluateN01,
  evaluateN02,
  evaluateN03,
  evaluateN04,
  evaluateN07,
  evaluateN10,
  measureRepoFacts,
  type BlobPin,
  type NodeState,
  type RepoFacts,
} from '@/scripts/custody/d1-pre-hc1'
import { hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'

const ROOT = resolve(__dirname, '..', '..')
const read = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T
const ratification = read<{ CANDIDATE_BINDING: { effective_package: BlobPin[] }; ratifications: Array<Record<string, unknown>> }>(PATHS.ratification)
const BINDING = ratification.CANDIDATE_BINDING.effective_package
const FROZEN = '537487ac7b102d51f553fcb8f5cfe19614e113d8'
const BASE = { branch: 'b', head: 'h'.repeat(40), tree: 't'.repeat(40) }
const MECH: BlobPin = { path: 'mech.json', blob_sha: 'm'.repeat(40) }
const PARENT: BlobPin = { path: PATHS.ratification, blob_sha: 'p'.repeat(40) }

function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  const blobs: Record<string, string> = { [MECH.path]: MECH.blob_sha, [PARENT.path]: PARENT.blob_sha }
  for (const b of BINDING) blobs[b.path] = b.blob_sha
  return { ...BASE, clean: true, integrationRef: FROZEN, blobs, ...over }
}

describe('N01 is a machine gate that goes RED on any stale or drifted fact', () => {
  const n01 = (f: RepoFacts) => evaluateN01({ facts: f, declaredBase: BASE, frozenIntegration: FROZEN, candidateBinding: BINDING })

  it('passes on the declared base with all six bindings', () => {
    expect(n01(facts()).status).toBe('PASS')
  })

  it.each([
    ['a stale base (HEAD moved)', { head: 'x'.repeat(40) }, 'STOP_WRONG_HEAD'],
    ['another branch', { branch: 'other' }, 'STOP_WRONG_HEAD'],
    ['a different tree', { tree: 'y'.repeat(40) }, 'STOP_WRONG_TREE'],
    ['a dirty worktree', { clean: false }, 'STOP_DIRTY_WORKTREE'],
    ['integration moved past the frozen base', { integrationRef: 'z'.repeat(40) }, 'STOP_STALE_INTEGRATION'],
    ['an unmeasured integration ref', { integrationRef: null }, 'STOP_STALE_INTEGRATION'],
  ])('STOPs on %s', (_label, over, token) => {
    const r = n01(facts(over as Partial<RepoFacts>))
    expect(r.status).toBe('STOP')
    expect(r.tokens).toContain(token)
  })

  it('STOPs when one of the six ratification bindings drifted', () => {
    const f = facts()
    const drifted = { ...f, blobs: { ...f.blobs, [BINDING[2]!.path]: '0'.repeat(40) } }
    expect(n01(drifted).tokens).toContain('STOP_RATIFICATION_BINDING_MISMATCH')
  })
})

describe('N02 is valid only with an N01 measured at the SAME base', () => {
  const pass = evaluateN01({ facts: facts(), declaredBase: BASE, frozenIntegration: FROZEN, candidateBinding: BINDING })

  it('is SATISFIED with a fresh N01 and the certified mechanism in place', () => {
    expect(evaluateN02({ n01: pass, evaluatedAtHead: BASE.head, mechanism: MECH, parentRecord: PARENT, facts: facts() }).status).toBe('SATISFIED')
  })

  it('refuses a HISTORICAL N01 measured at another base', () => {
    const r = evaluateN02({ n01: pass, evaluatedAtHead: 'n'.repeat(40), mechanism: MECH, parentRecord: PARENT, facts: facts() })
    expect(r.status).toBe('NOT_SATISFIED')
    expect(r.reasons.join(' ')).toContain('historical N01')
  })

  it('refuses when N01 stopped', () => {
    const stopped = evaluateN01({ facts: facts({ clean: false }), declaredBase: BASE, frozenIntegration: FROZEN, candidateBinding: BINDING })
    expect(evaluateN02({ n01: stopped, evaluatedAtHead: BASE.head, mechanism: MECH, parentRecord: PARENT, facts: facts() }).status).toBe('NOT_SATISFIED')
  })

  it('refuses when the certified mechanism blob changed', () => {
    const f = facts()
    expect(evaluateN02({ n01: pass, evaluatedAtHead: BASE.head, mechanism: MECH, parentRecord: PARENT, facts: { ...f, blobs: { ...f.blobs, [MECH.path]: '1'.repeat(40) } } }).status).toBe('NOT_SATISFIED')
  })
})

describe('N04 resolves the target BY REF and refuses every wrong target', () => {
  const good = {
    declaredRefs: { dag: 'bvyzblhqymxruxdguaee', inventory: 'bvyzblhqymxruxdguaee' },
    authorizedDirectHost: ['db', 'bvyzblhqymxruxdguaee', 'supabase', 'co'].join('.'),
    dagVetoedRef: 'ctaxtgujyyprgynmnvtq',
    declaredRoles: { inventory: 'uellix_auditor', constant: 'uellix_auditor' },
  }

  it('is SATISFIED on the staging ref, direct-db, and the auditor role', () => {
    const r = evaluateN04(good)
    expect(r.status).toBe('SATISFIED')
    expect(r.mechanism).toBe('direct-db')
  })

  it.each([
    ['the production ref declared', { declaredRefs: { dag: 'ctaxtgujyyprgynmnvtq', inventory: 'ctaxtgujyyprgynmnvtq' } }],
    ['two sources declaring different refs', { declaredRefs: { dag: 'bvyzblhqymxruxdguaee', inventory: 'ctaxtgujyyprgynmnvtq' } }],
    ['a host naming another project', { authorizedDirectHost: ['db', 'ctaxtgujyyprgynmnvtq', 'supabase', 'co'].join('.') }],
    ['the session pooler host', { authorizedDirectHost: 'aws-0-us-east-2.pooler.supabase.com' }],
    ['a non-Supabase host', { authorizedDirectHost: 'db.example.com' }],
    ['a wrong role', { declaredRoles: { inventory: 'uellix_app', constant: 'uellix_auditor' } }],
    ['a DAG veto list that disagrees with the code veto', { dagVetoedRef: 'aaaaaaaaaaaaaaaaaaaa' }],
  ])('refuses %s', (_label, over) => {
    expect(evaluateN04({ ...good, ...over }).status).toBe('NOT_SATISFIED')
  })
})

describe('N07 needs the rollback path AND the evidence destination', () => {
  const template = read<Record<string, unknown>>(PATHS.n07Template)
  const certified = { path: PATHS.n07Template, blob_sha: 'c'.repeat(40) }
  const schema = { path: PATHS.n07Schema, blob_sha: 's'.repeat(40) }
  const dag = read<{ DAG_NODES: { nodes: Array<{ id: string; act: string }> } }>(PATHS.dag)
  const act = dag.DAG_NODES.nodes.find((n) => n.id === 'N07')!.act
  const mnc = read<{ EVIDENCE_MATERIALIZATION: { MUST_NEVER_CONTAIN: string[] } }>(PATHS.capability).EVIDENCE_MATERIALIZATION.MUST_NEVER_CONTAIN
  const base = {
    template: template as never,
    measuredTemplateBlob: certified.blob_sha,
    measuredSchemaBlob: schema.blob_sha,
    certifiedTemplate: certified,
    certifiedSchema: schema,
    n07Act: act,
    mustNeverContain: mnc,
    evidenceDirEntries: ['2026-08-16-att_5878e6da-installer-identity.json'],
  }
  const rb = template.rollback_statements_pre_written as Record<string, Record<string, unknown>>

  it('is SATISFIED with the certified skeleton, the exact rollback set and a known destination', () => {
    expect(evaluateN07(base).status).toBe('SATISFIED')
  })

  it.each([
    ['the MR-1 rollback statement missing', { ...rb, mr1_rollback: { ...rb.mr1_rollback, statement: undefined } }],
    ['the MR-3 rollback statement softened', { ...rb, mr3_rollback: { ...rb.mr3_rollback, statement: 'REVOKE ALL ON SCHEMA uellix_stella_ops FROM uellix_auditor' } }],
    ['MR-2 claiming a rollback', { ...rb, mr2_compensating_action: { ...rb.mr2_compensating_action, rollback_possible: true } }],
    ['an MR-2 compensating action missing', { ...rb, mr2_compensating_action: { ...rb.mr2_compensating_action, statement_options: ['ROTATE AGAIN'] } }],
  ])('refuses %s', (_label, rollback) => {
    expect(evaluateN07({ ...base, template: { ...template, rollback_statements_pre_written: rollback } as never }).status).toBe('NOT_SATISFIED')
  })

  it('refuses a missing evidence destination', () => {
    expect(evaluateN07({ ...base, evidenceDirEntries: null }).status).toBe('NOT_SATISFIED')
  })

  it('refuses a destination with no dated attempt-scoped precedent to derive a name from', () => {
    expect(evaluateN07({ ...base, evidenceDirEntries: ['README.md'] }).status).toBe('NOT_SATISFIED')
  })

  it('refuses a skeleton that is not the certified blob', () => {
    expect(evaluateN07({ ...base, measuredTemplateBlob: 'd'.repeat(40) }).status).toBe('NOT_SATISFIED')
  })
})

describe('N10 is READY at most, and never SATISFIED without HC-1', () => {
  const preds = hardPredecessorsOf('N10')
  const all = Object.fromEntries(preds.map((p) => [p, 'SATISFIED'])) as Record<string, NodeState>

  it('reads its seven HARD predecessors from the graph', () => {
    expect(preds).toEqual(['N02', 'N03', 'N04', 'N05', 'N06', 'N07', 'N09'])
  })

  it.each(['N02', 'N03', 'N04', 'N05', 'N06', 'N07', 'N09'])('is NOT_READY when %s alone is missing', (p) => {
    const r = evaluateN10({ states: { ...all, [p]: 'NOT_SATISFIED' }, hardPredecessors: preds, hc1Answer: null, postMintUnsatisfied: [] })
    expect(r.readiness).toBe('NOT_READY')
    expect(r.unsatisfied).toEqual([p])
  })

  it('is READY_FOR_HUMAN_CONFIRMATION, not SATISFIED, when every predecessor holds and no HC-1 answer exists', () => {
    expect(evaluateN10({ states: all, hardPredecessors: preds, hc1Answer: null, postMintUnsatisfied: [] }).readiness).toBe('READY_FOR_HUMAN_CONFIRMATION')
  })

  it('is NOT_READY when the post-mint conjuncts were not evaluated, or any is unsatisfied', () => {
    expect(evaluateN10({ states: all, hardPredecessors: preds, hc1Answer: null, postMintUnsatisfied: undefined }).readiness).toBe('NOT_READY')
    const r = evaluateN10({ states: all, hardPredecessors: preds, hc1Answer: null, postMintUnsatisfied: ['PMR-1_MINT_ROUTE_RATIFIED'] })
    expect(r).toEqual({ readiness: 'NOT_READY', unsatisfied: ['PMR-1_MINT_ROUTE_RATIFIED'] })
  })

  it('refuses to evaluate over an empty predecessor set', () => {
    expect(evaluateN10({ states: all, hardPredecessors: [], hc1Answer: null, postMintUnsatisfied: [] }).readiness).toBe('NOT_READY')
  })
})

describe('the repository itself', () => {
  it('re-derives N05, N06 and N09 from their own sources', () => {
    const u = deriveUpstreamStates(ROOT)
    expect(u.states).toEqual({ N05: 'SATISFIED', N06: 'SATISFIED', N09: 'SATISFIED' })
  })

  it('satisfies N03 from the ratification record and its bound blob', () => {
    const dag = read<{ CANDIDATE_BINDING_RE_DERIVED: { the_ratification_record_own_blob_at_this_parent: string } }>(PATHS.dag)
    const parent = { path: PATHS.ratification, blob_sha: dag.CANDIDATE_BINDING_RE_DERIVED.the_ratification_record_own_blob_at_this_parent.slice(0, 40) }
    const f = measureRepoFacts(ROOT, [PATHS.ratification], false)
    expect(evaluateN03({ ratificationRecord: ratification, parentRecord: parent, facts: f }).status).toBe('SATISFIED')
  })

  it('holds all six ratification bindings at HEAD (the N01 blob arm)', () => {
    const f = measureRepoFacts(ROOT, BINDING.map((b) => b.path), false)
    for (const b of BINDING) expect(f.blobs[b.path]).toBe(b.blob_sha)
  })
})
