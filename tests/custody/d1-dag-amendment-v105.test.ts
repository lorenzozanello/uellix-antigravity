// tests/custody/d1-dag-amendment-v105.test.ts
//
// v1.0.5 changes no node and no edge. What it declares — N10's post-mint
// readiness conjuncts and the open authority conflicts — must match what the
// code evaluates and what the code blocks, id for id.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { CONJUNCT_EVALUATORS } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { AUTHORITY_CONFLICTS, P1_STATEMENTS } from '@/db/custody/p1-reads'
import { ROUTE_B_DELTAS } from '@/db/custody/mint-route-b-contract'

const FILE = join(process.cwd(), 'docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json')
const text = readFileSync(FILE, 'utf8')
const a = JSON.parse(text) as {
  NEW_NODES: unknown[]
  NEW_EDGES: unknown[]
  N10_PRE_HC1_READINESS_CONJUNCTS: Array<{ id: string }>
  AUTHORITY_CONFLICTS_OPEN: Array<{ id: string }>
  AUTHORITY_CONFLICT_RULINGS: Record<string, string>
  RECOMPUTED_GRAPH: { NODE_COUNT_TOTAL: number; EDGE_COUNT_TOTAL: number; HARD_EDGE_COUNT: number; CONDITIONAL_EDGE_COUNT: number; ACYCLIC: boolean; REACHABILITY_PROPERTIES_BY_TRAVERSAL: Record<string, boolean> }
}
const facts = deriveGraphFacts()
const before = deriveGraphFacts({ throughSource: 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.4.json' })

describe('v1.0.5 leaves the graph as v1.0.4 made it', () => {
  it('reads six sources, adds nothing, fails nothing', () => {
    expect(facts.sourcesRead).toHaveLength(6)
    expect(facts.failures).toEqual([])
    expect(a.NEW_NODES).toEqual([])
    expect(a.NEW_EDGES).toEqual([])
    expect(facts.nodeCount).toBe(before.nodeCount)
    expect(facts.edgeCount).toBe(before.edgeCount)
  })
  it('declares the counts and reachability the validator derives', () => {
    const g = a.RECOMPUTED_GRAPH
    expect([g.NODE_COUNT_TOTAL, g.EDGE_COUNT_TOTAL, g.HARD_EDGE_COUNT, g.CONDITIONAL_EDGE_COUNT, g.ACYCLIC]).toEqual([
      facts.nodeCount,
      facts.edgeCount,
      facts.edgeKindCounts.HARD,
      facts.edgeKindCounts.CONDITIONAL,
      facts.acyclic,
    ])
    for (const [k, v] of Object.entries(g.REACHABILITY_PROPERTIES_BY_TRAVERSAL)) expect(facts.reachability[k.replace(/_/g, ' ')], k).toBe(v)
  })
  it('keeps HC-1 immediately upstream of the mutation and N30 upstream of every in-DAG consumer', () => {
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
    expect(facts.nodeIds.filter((n) => hardPredecessorsOf(n).includes('N10'))).toEqual(['N11'])
    for (const n of ['N13', 'N14', 'N21', 'N22', 'N23']) expect(facts.reachability[`${n} reachable from N30`], n).toBe(true)
  })
})

describe('what v1.0.5 declares is what the code does', () => {
  it('every declared N10 conjunct has a registered evaluator, and every evaluator is declared', () => {
    expect(a.N10_PRE_HC1_READINESS_CONJUNCTS.map((c) => c.id).sort()).toEqual(Object.keys(CONJUNCT_EVALUATORS).sort())
  })
  it('the open conflicts are exactly the ones the read set blocks or narrows, and none is ruled here', () => {
    expect(a.AUTHORITY_CONFLICTS_OPEN.map((c) => c.id)).toEqual(AUTHORITY_CONFLICTS.map((c) => c.id))
    expect(a.AUTHORITY_CONFLICT_RULINGS).toEqual({})
    const blocking = new Set(Object.values(P1_STATEMENTS).map((s) => s.blockedBy).filter((b) => b !== null))
    expect([...blocking].sort()).toEqual(['AC-1', 'AC-3'])
  })
  it('names each Route B delta for ruling', () => {
    for (const d of ROUTE_B_DELTAS) expect(text).toContain(d.id)
  })
  it('records no vault locator and no credential-shaped text', () => {
    expect(text).not.toMatch(/UELLIX-D1-AUDITOR-|UELLIX-N05-SENTINEL-[0-9A-F]{6,}/)
    expect(text).not.toMatch(/postgres(?:ql)?:\/\//i)
  })
})
