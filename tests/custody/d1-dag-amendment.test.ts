// tests/custody/d1-dag-amendment.test.ts
//
// EVERY NUMBER THE v1.0.3 AMENDMENT DECLARES IS CHECKED AGAINST A
// RE-DERIVATION FROM THE ARTIFACTS THEMSELVES.
//
// Three defects in this package's history were arithmetic, not semantic: a
// count frozen against a tree that then moved (OF-N05-8); a classification
// step that dropped seven of eighteen files and froze 17 as a control's
// expected value (OF-N05-9); and a reachability property first computed from a
// position in a topological order, which is not unique and therefore cannot
// carry it. Each time, the number in the document was a number nobody re-ran.
//
// So the amendment cites `deriveGraphFacts()` and this file asserts that the
// citation is accurate. Editing a count in the JSON without changing the graph
// now goes red — which is the only version of "never hand-author a derivable
// count" that survives contact with a future lane in a hurry.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveGraphFacts } from '@/scripts/custody/d1-dag-validate'

const RELEASE_DIR = join(process.cwd(), 'docs', 'ops', 'release')

interface RecomputedGraph {
  NODE_COUNT_BASE: number
  NODE_COUNT_NEW: number
  NODE_COUNT_TOTAL: number
  EDGE_COUNT_BASE: number
  EDGE_COUNT_NEW: number
  EDGE_COUNT_TOTAL: number
  HARD_EDGE_COUNT: number
  CONDITIONAL_EDGE_COUNT: number
  ACYCLIC: boolean
  TOPOLOGICAL_ORDER_LENGTH: number
  TOPOLOGICAL_ORDER: string
  DUPLICATE_NODE_IDS: string[]
  DUPLICATE_EDGE_IDS: string[]
  DUPLICATE_EDGE_PAIRS: string[]
  EDGE_ENDPOINTS_NOT_DECLARED: string[]
  DECLARED_PRECONDITION_WITHOUT_EDGE: number
  INCOMING_EDGE_NOT_DECLARED_OR_WIDENED: number
  NODES_IN_A_CYCLE: string[]
  SINK_NODES: string[]
  REACHABILITY_PROPERTIES_BY_TRAVERSAL: Record<string, boolean | string>
  ORPHAN_AND_UNREACHABLE_DISCLOSURE: {
    ORPHAN_NODES_AFTER: string[]
    UNREACHABLE_FROM_N01_AFTER: string[]
  }
}

const amendment = JSON.parse(
  readFileSync(
    join(RELEASE_DIR, 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.3.json'),
    'utf8'
  )
) as {
  NEW_NODES: Array<{ id: string; plane: string; preconditions: string[]; tokens: string[] }>
  NEW_EDGES: Array<{ id: string; from: string; to: string; kind: string }>
  RECOMPUTED_GRAPH: RecomputedGraph
  PRECONDITION_SETS_WIDENED_BY_THESE_EDGES: Record<string, { amended?: string[] }>
}

// Measured through v1.0.3 itself: this file certifies the graph the v1.0.3
// amendment declared, and a later append must not change what it measures.
// The v1.0.4 graph has its own file, tests/custody/d1-dag-amendment-v104.test.ts.
const facts = deriveGraphFacts({
  throughSource: 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.3.json',
})
const g = amendment.RECOMPUTED_GRAPH

describe('the graph is structurally sound', () => {
  it('is acyclic with no duplicate or dangling anything', () => {
    expect(facts.acyclic).toBe(true)
    expect(facts.duplicateNodeIds).toEqual([])
    expect(facts.duplicateEdgeIds).toEqual([])
    expect(facts.duplicateEdgePairs).toEqual([])
    expect(facts.danglingEndpoints).toEqual([])
  })

  it('has every declared precondition backed by an edge', () => {
    expect(facts.missingEdges).toEqual([])
  })

  it('has every incoming edge either declared or recorded as a widening', () => {
    expect(facts.unexplainedIncoming).toEqual([])
  })

  it('reports no failures at all', () => {
    expect(facts.failures).toEqual([])
  })

  it('reads all four graph sources, so no amendment is silently skipped', () => {
    expect(facts.sourcesMissing).toEqual([])
    expect(facts.sourcesRead).toHaveLength(4)
  })
})

describe('the v1.0.3 amendment declares what the graph actually is', () => {
  it('matches on node and edge counts', () => {
    expect(g.NODE_COUNT_TOTAL).toBe(facts.nodeCount)
    expect(g.EDGE_COUNT_TOTAL).toBe(facts.edgeCount)
    expect(g.NODE_COUNT_BASE + g.NODE_COUNT_NEW).toBe(facts.nodeCount)
    expect(g.EDGE_COUNT_BASE + g.EDGE_COUNT_NEW).toBe(facts.edgeCount)
  })

  it('matches on the edge-kind split, and the split sums to the total', () => {
    expect(g.HARD_EDGE_COUNT).toBe(facts.edgeKindCounts.HARD)
    expect(g.CONDITIONAL_EDGE_COUNT).toBe(facts.edgeKindCounts.CONDITIONAL)
    expect(g.HARD_EDGE_COUNT + g.CONDITIONAL_EDGE_COUNT).toBe(facts.edgeCount)
  })

  it('matches on acyclicity and on the topological order, element for element', () => {
    expect(g.ACYCLIC).toBe(facts.acyclic)
    expect(g.TOPOLOGICAL_ORDER_LENGTH).toBe(facts.topologicalOrder.length)
    expect(g.TOPOLOGICAL_ORDER.split(' ')).toEqual([...facts.topologicalOrder])
  })

  it('matches on every emptiness claim', () => {
    expect(g.DUPLICATE_NODE_IDS).toEqual([...facts.duplicateNodeIds])
    expect(g.DUPLICATE_EDGE_IDS).toEqual([...facts.duplicateEdgeIds])
    expect(g.DUPLICATE_EDGE_PAIRS).toEqual([...facts.duplicateEdgePairs])
    expect(g.EDGE_ENDPOINTS_NOT_DECLARED).toEqual([...facts.danglingEndpoints])
    expect(g.NODES_IN_A_CYCLE).toEqual([])
    expect(g.DECLARED_PRECONDITION_WITHOUT_EDGE).toBe(facts.missingEdges.length)
    expect(g.INCOMING_EDGE_NOT_DECLARED_OR_WIDENED).toBe(facts.unexplainedIncoming.length)
  })

  it('matches on sinks, orphans and unreachability', () => {
    expect(g.SINK_NODES).toEqual([...facts.sinks])
    expect(g.ORPHAN_AND_UNREACHABLE_DISCLOSURE.ORPHAN_NODES_AFTER).toEqual([...facts.orphans])
    expect(g.ORPHAN_AND_UNREACHABLE_DISCLOSURE.UNREACHABLE_FROM_N01_AFTER).toEqual([
      ...facts.unreachableFromN01,
    ])
  })

  it('matches on every reachability property it claims', () => {
    const declared = g.REACHABILITY_PROPERTIES_BY_TRAVERSAL
    const label = (k: string): string => k.replace(/_/g, ' ').replace('reachable from', 'reachable from')
    for (const [key, value] of Object.entries(declared)) {
      if (typeof value !== 'boolean') continue
      expect(facts.reachability[label(key)], `${key} disagrees with the derivation`).toBe(value)
    }
    // Every declared property must correspond to one the validator computes;
    // a claim the validator does not check is a claim nobody checks.
    const booleanKeys = Object.entries(declared).filter(([, v]) => typeof v === 'boolean')
    expect(booleanKeys.length).toBeGreaterThan(0)
    for (const [key] of booleanKeys) {
      expect(Object.keys(facts.reachability)).toContain(label(key))
    }
  })
})

describe('N32 is declared the way the owner ratification says', () => {
  const n32 = amendment.NEW_NODES.find((n) => n.id === 'N32')

  it('exists, on the OWNER plane, with N03 as its only precondition', () => {
    expect(n32).toBeDefined()
    expect(n32?.plane).toBe('OWNER')
    expect(n32?.preconditions).toEqual(['N03'])
  })

  it('carries no fail-closed token, exactly as N08 and N31 do not', () => {
    expect(n32?.tokens).toEqual([])
  })

  it('adds exactly two HARD edges, into N32 and out of it to N06', () => {
    expect(amendment.NEW_EDGES).toHaveLength(2)
    expect(amendment.NEW_EDGES.every((e) => e.kind === 'HARD')).toBe(true)
    expect(amendment.NEW_EDGES.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      'N03->N32',
      'N32->N06',
    ])
  })

  it('widens N06 to five preconditions and weakens nothing', () => {
    const amended = amendment.PRECONDITION_SETS_WIDENED_BY_THESE_EDGES.N06?.amended
    expect(amended).toEqual(['N03', 'N05', 'N09', 'N31', 'N32'])
    // And the widened set is what the edge list actually produces.
    expect(facts.missingEdges).toEqual([])
  })
})

describe('no custodian is named anywhere in the write set', () => {
  const files = [
    join(RELEASE_DIR, 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.3.json'),
    join(
      process.cwd(),
      'docs',
      'ops',
      'owner-ratifications',
      'FIBDB053_D1_AUDITOR_N32_HUMAN_CUSTODIAN_INTAKE_OWNER_DECISION_v1.0.0.json'
    ),
  ]

  it.each(files)('%s carries no email address', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]{2,}/)
  })

  it.each(files)('%s carries no connection string or userinfo pair', (file) => {
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/postgres(?:ql)?:\/\//i)
    expect(text).not.toMatch(/\/\/[^\s/"]+:[^\s/"]+@/)
  })

  it.each(files)('%s declares no node satisfied', (file) => {
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/N0[5-9]\s+(?:is\s+)?(?:now\s+)?(?:SATISFIED|CLOSED|DISCHARGED)\b/)
  })
})
