// @vitest-environment node
// tests/custody/d1-pre-hc1-post-mint.test.ts
//
// N10'S POST-MINT READINESS CONJUNCTS, AND THE NEGATIVE CONTROLS THAT SHOW
// THE EVALUATOR CAN SAY NO TO EACH OF THEM.
//
// Every control changes ONE gathered input and watches ONE conjunct fail. The
// positive control builds an input in which every conjunct holds, so the
// evaluator is also shown able to say yes: an evaluator that could only fail
// would be as self-fulfilling as one that could only pass.

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  CONJUNCT_EVALUATORS,
  evaluatePostMintConjuncts,
  gatherPostMintInputs,
  type PostMintInputs,
} from '@/scripts/custody/d1-pre-hc1-post-mint'
import { checkInventorySurfaces } from '@/scripts/custody/d1-delivery-matrix'
import { evaluatePreHc1, measureRepoFacts } from '@/scripts/custody/d1-pre-hc1'

const ROOT = process.cwd()
const REAL = gatherPostMintInputs(ROOT)

/** Every conjunct satisfied: the real inputs plus rulings for the open conflicts and a certification of the current blobs. */
const ALL_GOOD: PostMintInputs = {
  ...REAL,
  conflictRulings: Object.fromEntries(REAL.openConflicts.map((c) => [c, 'RULED (test fixture)'])),
  certifiedPairs: Object.entries(REAL.packageBlobs).map(([p, b]) => `${p}@${b}`),
}
const unsat = (i: PostMintInputs): readonly string[] => evaluatePostMintConjuncts(i).unsatisfied

describe('the repository as it stands', () => {
  it('reads eight conjuncts from DAG v1.0.5 and has an evaluator for each', () => {
    expect(REAL.conjunctIds).toHaveLength(8)
    for (const id of REAL.conjunctIds!) expect(CONJUNCT_EVALUATORS[id], id).toBeDefined()
  })
  it('is NOT_READY for exactly the two honest reasons: open authority conflicts and no certification of the current blobs', () => {
    expect(unsat(REAL)).toEqual(['PMR-7_NO_OPEN_AUTHORITY_CONFLICT', 'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS'])
  })
  it('and the whole PRE-HC1 evaluation therefore reports N10 NOT_READY', () => {
    const f = measureRepoFacts(ROOT, [], false)
    const ev = evaluatePreHc1(ROOT, { declaredBase: { branch: f.branch, head: f.head, tree: f.tree }, liveIntegration: false })
    expect(ev.n10.readiness).toBe('NOT_READY')
    expect(ev.n10.unsatisfied).toEqual(expect.arrayContaining(['PMR-7_NO_OPEN_AUTHORITY_CONFLICT', 'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS']))
  }, 120_000)
})

describe('the positive control', () => {
  it('with every conjunct input satisfied, nothing is unsatisfied', () => {
    expect(unsat(ALL_GOOD)).toEqual([])
  })
})

describe('negative controls (one input each)', () => {
  const cases: Array<[string, Partial<PostMintInputs>, string | string[]]> = [
    // The owner record carries both the route and the PASSWORD NULL decision, so its absence fails both.
    ['owner decision record missing', { ownerDecision: null }, ['PMR-1_MINT_ROUTE_RATIFIED', 'PMR-3_PASSWORD_NULL_SEMANTICS']],
    ['mint route different from the ratified one', { ownerDecision: { ...REAL.ownerDecision!, D1_MINT_ROUTE: 'A_MANAGEMENT_PLANE' } }, 'PMR-1_MINT_ROUTE_RATIFIED'],
    ['owner decision unsigned', { ownerDecision: { ...REAL.ownerDecision!, SIGNED: 'NO' } }, 'PMR-1_MINT_ROUTE_RATIFIED'],
    ['operator tool infeasible', { operatorToolFeasibility: { verdict: 'STOP_OPERATOR_TOOL_DEPENDENCY_GAP', driver: 'pg' } }, 'PMR-2_OPERATOR_TOOL_FEASIBLE'],
    ['driver no longer resolvable', { driverResolvable: false }, 'PMR-2_OPERATOR_TOOL_FEASIBLE'],
    ['PASSWORD NULL semantics missing', { ownerDecision: { ...REAL.ownerDecision!, D1_PASSWORD_NULL_REQUIRES_SEPARATE_HUMAN_CONFIRMATION: '' } }, 'PMR-3_PASSWORD_NULL_SEMANTICS'],
    ['N06 on an old topology', { inventorySurfaceReasons: ['processes_or_environments omits surface MINT_OPERATOR_TRANSIENT_SURFACE'] }, 'PMR-4_N06_REDERIVED_FOR_TOPOLOGY'],
    ['N13 consumer absent', { entryFilesPresent: { ...REAL.entryFilesPresent, 'scripts/custody/d1-auditor-n13-consumer.ts': false } }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['N14 consumer absent', { entryFilesPresent: { ...REAL.entryFilesPresent, 'scripts/custody/d1-auditor-n14-consumer.ts': false } }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['N22 consumer absent', { entryFilesPresent: { ...REAL.entryFilesPresent, 'scripts/custody/d1-auditor-n22-consumer.ts': false } }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['N14 consumer not built', { productionEntryPoints: REAL.productionEntryPoints.filter((p) => !p.includes('n14')) }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['one required delivery has no consumer', { deliveryGaps: ['N14 opens a session as uellix_auditor and has no registered consumer'] }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['one topology demonstration missing', { demonstrations: Object.fromEntries(Object.entries(REAL.demonstrations).filter(([k]) => k !== 'DL-N22')) }, 'PMR-6_TOPOLOGY_DEMONSTRATED_PER_CONSUMER'],
    ['a demonstration on a closure that has since changed', { currentClosureBlobs: { ...REAL.currentClosureBlobs, 'DL-N14': { ...REAL.currentClosureBlobs['DL-N14'], 'db/custody/p1-reads.ts': '0'.repeat(40) } } }, 'PMR-6_TOPOLOGY_DEMONSTRATED_PER_CONSUMER'],
    ['a demonstration that did not reach SATISFIED_CANDIDATE', { demonstrations: { ...REAL.demonstrations, 'DL-N13': { ...REAL.demonstrations['DL-N13']!, overall: 'NOT_SATISFIED' } } }, 'PMR-6_TOPOLOGY_DEMONSTRATED_PER_CONSUMER'],
    ['one conflict unruled', { conflictRulings: { 'AC-1': 'x', 'AC-2': 'x' } }, 'PMR-7_NO_OPEN_AUTHORITY_CONFLICT'],
    ['certification of a stale blob', { certifiedPairs: ALL_GOOD.certifiedPairs.map((p) => (p.startsWith('db/custody/p1-reads.ts@') ? `db/custody/p1-reads.ts@${'1'.repeat(40)}` : p)) }, 'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS'],
  ]
  it.each(cases)('%s -> only its conjunct fails', (_name, change, conjunct) => {
    expect(unsat({ ...ALL_GOOD, ...change })).toEqual(Array.isArray(conjunct) ? conjunct : [conjunct])
  })
  it('no conjunct list, or an unregistered id, is NOT_READY', () => {
    expect(unsat({ ...ALL_GOOD, conjunctIds: null })).toHaveLength(1)
    expect(unsat({ ...ALL_GOOD, conjunctIds: [] })).toHaveLength(1)
    expect(unsat({ ...ALL_GOOD, conjunctIds: [...ALL_GOOD.conjunctIds!, 'PMR-9_UNKNOWN'] })).toEqual(['PMR-9_UNKNOWN'])
  })
})

describe('the inputs are measured, not asserted', () => {
  it('the inventory at the lane base (old topology) fails the surface check', () => {
    const old = JSON.parse(
      execFileSync('git', ['show', '3def3c5b7b82747a3d4533aa6badccb0043cffff:docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'], { cwd: ROOT, encoding: 'utf8' })
    ) as { entries: Array<Record<string, unknown>> }
    const reasons = checkInventorySurfaces(ROOT, old.entries[0]!.processes_or_environments)
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons).toContain('processes_or_environments omits surface MINT_OPERATOR_TRANSIENT_SURFACE')
  })
  it('the current inventory lists every derived surface and delivery', () => {
    expect(REAL.inventorySurfaceReasons).toEqual([])
    expect(REAL.deliveries.map((d) => d.id)).toEqual(['DL-N13', 'DL-N14', 'DL-N21', 'DL-N22', 'DL-N23', 'DL-FINAL-WITNESS'])
  })
  it('a stale declared base stops N01 and keeps N10 NOT_READY', () => {
    const f = measureRepoFacts(ROOT, [], false)
    const ev = evaluatePreHc1(ROOT, { declaredBase: { branch: f.branch, head: '0'.repeat(40), tree: f.tree }, liveIntegration: false })
    expect(ev.n01.status).toBe('STOP')
    expect(ev.n10.readiness).toBe('NOT_READY')
  }, 120_000)
})
