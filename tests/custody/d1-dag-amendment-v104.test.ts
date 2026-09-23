// tests/custody/d1-dag-amendment-v104.test.ts
//
// EVERY NUMBER THE v1.0.4 AMENDMENT DECLARES, RE-DERIVED FROM THE ARTIFACTS.
// And the ordering property the amendment exists for: N30 precedes N13 by an
// EDGE, while HC-1 still sits immediately before the mutation.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'

const RELEASE_DIR = join(process.cwd(), 'docs', 'ops', 'release')
const FILE = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.4.json'
const amendment = JSON.parse(readFileSync(join(RELEASE_DIR, FILE), 'utf8')) as {
  NEW_NODES: unknown[]
  NEW_EDGES: Array<{ id: string; from: string; to: string; kind: string }>
  PRECONDITION_SETS_WIDENED_BY_THESE_EDGES: Record<string, { amended?: string[] }>
  EXIT_SPLIT_N11: Record<string, string>
  RECOMPUTED_GRAPH: Record<string, unknown> & {
    REACHABILITY_PROPERTIES_BY_TRAVERSAL: Record<string, boolean | string>
    ORPHAN_AND_UNREACHABLE_DISCLOSURE: { ORPHAN_NODES_AFTER: string[]; UNREACHABLE_FROM_N01_AFTER: string[] }
  }
}
const facts = deriveGraphFacts()
const before = deriveGraphFacts({ throughSource: 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.3.json' })
const g = amendment.RECOMPUTED_GRAPH

describe('the amended graph', () => {
  it('reads all five sources and reports no failure', () => {
    expect(facts.sourcesMissing).toEqual([])
    expect(facts.sourcesRead).toHaveLength(5)
    expect(facts.failures).toEqual([])
    expect(facts.acyclic).toBe(true)
  })

  it('matches every count the amendment declares', () => {
    expect(g.NODE_COUNT_TOTAL).toBe(facts.nodeCount)
    expect(g.EDGE_COUNT_TOTAL).toBe(facts.edgeCount)
    expect(g.NODE_COUNT_BASE).toBe(before.nodeCount)
    expect(g.EDGE_COUNT_BASE).toBe(before.edgeCount)
    expect(g.HARD_EDGE_COUNT).toBe(facts.edgeKindCounts.HARD)
    expect(g.CONDITIONAL_EDGE_COUNT).toBe(facts.edgeKindCounts.CONDITIONAL)
    expect(g.TOPOLOGICAL_ORDER_LENGTH).toBe(facts.topologicalOrder.length)
    expect(String(g.TOPOLOGICAL_ORDER).split(' ')).toEqual([...facts.topologicalOrder])
    expect(g.SINK_NODES).toEqual([...facts.sinks])
    expect(g.DECLARED_PRECONDITION_WITHOUT_EDGE).toBe(facts.missingEdges.length)
    expect(g.INCOMING_EDGE_NOT_DECLARED_OR_WIDENED).toBe(facts.unexplainedIncoming.length)
    expect(g.ORPHAN_AND_UNREACHABLE_DISCLOSURE.ORPHAN_NODES_AFTER).toEqual([...facts.orphans])
    expect(g.ORPHAN_AND_UNREACHABLE_DISCLOSURE.UNREACHABLE_FROM_N01_AFTER).toEqual([...facts.unreachableFromN01])
  })

  it('matches every reachability property it claims, and each is computed', () => {
    for (const [key, value] of Object.entries(g.REACHABILITY_PROPERTIES_BY_TRAVERSAL)) {
      if (typeof value !== 'boolean') continue
      const label = key.replace(/_/g, ' ')
      expect(Object.keys(facts.reachability)).toContain(label)
      expect(facts.reachability[label]).toBe(value)
    }
  })
})

describe('the ordering the amendment exists for', () => {
  it('adds zero nodes and exactly one HARD edge, N30 -> N13', () => {
    expect(amendment.NEW_NODES).toEqual([])
    expect(amendment.NEW_EDGES.map((e) => `${e.from}->${e.to}:${e.kind}`)).toEqual(['N30->N13:HARD'])
  })

  it('makes N13 depend on N30 by traversal, which v1.0.3 did not', () => {
    expect(before.reachability['N13 reachable from N30']).toBe(false)
    expect(facts.reachability['N13 reachable from N30']).toBe(true)
  })

  it('widens N13 to {N11, N30} and that is what the edges produce', () => {
    expect(amendment.PRECONDITION_SETS_WIDENED_BY_THESE_EDGES.N13?.amended).toEqual(['N11', 'N30'])
    expect(hardPredecessorsOf('N13')).toEqual(['N11', 'N30'])
  })

  it('keeps HC-1 immediately before the mutation: N11 has exactly one predecessor, N10, and N10 exactly one successor', () => {
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
    expect(hardPredecessorsOf('N30')).toEqual(['N11', 'N29'])
    // By the edge set, never by position in an order.
    expect(facts.nodeIds.filter((n) => hardPredecessorsOf(n).includes('N10'))).toEqual(['N11'])
  })

  it('splits N11 into an act exit and a closure condition that still names KP-1 from the server', () => {
    expect(amendment.EXIT_SPLIT_N11.ACT_EXIT).toMatch(/ACCEPTED/)
    expect(amendment.EXIT_SPLIT_N11.CLOSURE_CONDITION).toMatch(/KP-1/)
    expect(amendment.EXIT_SPLIT_N11.CLOSURE_CONDITION).toMatch(/N30 ENTRY/)
  })

  it('records no vault locator and no credential-shaped text', () => {
    const text = readFileSync(join(RELEASE_DIR, FILE), 'utf8')
    expect(text).not.toMatch(/UELLIX-D1-AUDITOR-/)
    expect(text).not.toMatch(/postgres(?:ql)?:\/\//i)
  })
})

describe('the post-mint execution record', () => {
  const text = readFileSync(join(RELEASE_DIR, 'FIBDB053_D1_AUDITOR_POST_MINT_PATH_EXECUTION_RECORD_v1.0.0.json'), 'utf8')
  const rec = JSON.parse(text) as Record<string, unknown> & { HC1_STATUS: { HC1_AT_87520a97: string } }

  it('records HC-1 at 87520a97 as SPENT and zero real actions', () => {
    expect(rec.HC1_STATUS.HC1_AT_87520a97).toBe('SPENT')
    expect(rec.REAL_CREDENTIAL_ACTIONS_EXECUTED).toBe(0)
    expect(rec.DB_CONNECTIONS_EXECUTED).toBe(0)
  })

  it('records no vault locator, no sentinel entry name and no credential-shaped text', () => {
    expect(text).not.toMatch(/UELLIX-D1-AUDITOR-/)
    expect(text).not.toMatch(/UELLIX-N05-SENTINEL-[0-9A-F]{6,}/)
    expect(text).not.toMatch(/postgres(?:ql)?:\/\//i)
  })
})
