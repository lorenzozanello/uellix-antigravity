// tests/custody/d1-dag-amendment-v106.test.ts
//
// v1.0.6 changes no node and no edge. It rules on AC-1..AC-3, pins the AC-1
// SQL, supersedes PMR-8 by PMR-9, and adds PMR-10. What it declares must be
// what the code reads and does.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_SOURCES, deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { CONJUNCT_EVALUATORS, effectiveRulings, readChain } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { P1_STATEMENTS } from '@/db/custody/p1-reads'
import { COMMIT_UNKNOWN_TOKEN } from '@/db/custody/mint-route-b-contract'

const ROOT = process.cwd()
const FILE = join(ROOT, 'docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.6.json')
const text = readFileSync(FILE, 'utf8')
const a = JSON.parse(text) as Record<string, unknown> & {
  NEW_NODES: unknown[]
  NEW_EDGES: unknown[]
  AUTHORITY_CONFLICT_RULINGS: Record<string, { kind: string; outcome: string }>
  SUCCESSOR_AUTHORIZED_SQL: { AC1_TABLE_PRIVILEGES: { sql: string } }
  COMMIT_OUTCOME_MODEL: { token: string }
  CERTIFICATION_EVENT_CONTRACT: { authorized_post_certification_delta: string }
}
// Measured through v1.0.6 itself (the pattern of v1.0.5's test): a later amendment has its own file,
// and this one keeps certifying the graph and the chain as they stood when v1.0.6 was written.
const V106 = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.6.json' as const
const facts = deriveGraphFacts({ throughSource: V106 })
const chain = readChain(ROOT, GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V106) + 1))

describe('v1.0.6 leaves the graph as it was', () => {
  it('reads seven sources, adds nothing, fails nothing, keeps HC-1 immediately before N11', () => {
    expect(facts.sourcesRead).toHaveLength(7)
    expect(facts.failures).toEqual([])
    expect(a.NEW_NODES).toEqual([])
    expect(a.NEW_EDGES).toEqual([])
    expect([facts.nodeCount, facts.edgeCount, facts.acyclic]).toEqual([32, 45, true])
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
  })
})

describe('the rulings, as the chain reader sees them', () => {
  it('separates owner policy (AC-1, AC-3) from the technical ruling (AC-2)', () => {
    expect(a.AUTHORITY_CONFLICT_RULINGS['AC-1']!.kind).toBe('OWNER_POLICY_DECISION')
    expect(a.AUTHORITY_CONFLICT_RULINGS['AC-3']!.kind).toBe('OWNER_POLICY_DECISION')
    expect(a.AUTHORITY_CONFLICT_RULINGS['AC-2']!.kind).toBe('TECHNICAL_AUTHORITY_RULING')
  })
  it('every declared conflict has exactly one active ruling, and the owner record confirms the owner ones', () => {
    const { active, reasons } = effectiveRulings(chain)
    expect(reasons).toEqual([])
    expect(Object.keys(active).sort()).toEqual(['AC-1', 'AC-2', 'AC-3'])
    expect(active['AC-1']!.ownerRecordConfirms).toBe(true)
    expect(active['AC-3']!.ownerRecordConfirms).toBe(true)
  })
  it('pins exactly the SQL the implementation issues for AC-1', () => {
    expect(chain.successorSql.AC1_TABLE_PRIVILEGES).toBe(P1_STATEMENTS.TABLE_PRIVILEGES.sql)
  })
  it('the effective N10 conjuncts are v1.0.5 minus PMR-8 plus PMR-9 and PMR-10, each with an evaluator', () => {
    expect(chain.chainErrors).toEqual([])
    expect(chain.conjunctIds).not.toContain('PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS')
    expect(chain.conjunctIds).toEqual(expect.arrayContaining(['PMR-9_CANDIDATE_CERTIFIED', 'PMR-10_RULINGS_MATCH_IMPLEMENTATION', 'PMR-7_NO_OPEN_AUTHORITY_CONFLICT']))
    for (const id of chain.conjunctIds) expect(CONJUNCT_EVALUATORS[id], id).toBeDefined()
  })
  it('names the same COMMIT-unknown token the contract emits, and the event delta rule', () => {
    expect(a.COMMIT_OUTCOME_MODEL.token).toBe(COMMIT_UNKNOWN_TOKEN)
    expect(a.CERTIFICATION_EVENT_CONTRACT.authorized_post_certification_delta).toMatch(/Exactly ONE added file/)
  })
  it('records no vault locator and no credential-shaped text', () => {
    expect(text).not.toMatch(/UELLIX-D1-AUDITOR-|UELLIX-N05-SENTINEL-[0-9A-F]{6,}/)
    expect(text).not.toMatch(/postgres(?:ql)?:\/\//i)
  })
})

describe('the chain reader fails closed', () => {
  const base = { ...chain }
  it('CONTROL successor-ruling-ignored: without v1.0.6, AC-1..AC-3 are open again', () => {
    const upTo105 = readChain(ROOT, [
      'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json',
      'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.1.json',
      'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.2.json',
      'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.3.json',
      'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.4.json',
      'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json',
    ])
    expect(effectiveRulings(upTo105).reasons).toEqual(['authority conflict AC-1 has no ruling in the chain', 'authority conflict AC-2 has no ruling in the chain', 'authority conflict AC-3 has no ruling in the chain'])
  })
  it('a missing successor source is a chain error', () => {
    expect(readChain(ROOT, ['FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v9.9.9.json']).chainErrors).toHaveLength(1)
  })
  it('contradictory rulings, an unknown conflict id, and an unconfirmed owner claim are all refused', () => {
    const extra = { source: 'x', kind: 'OWNER_POLICY_DECISION', outcome: 'SOMETHING_ELSE', ownerRecordConfirms: true }
    expect(effectiveRulings({ ...base, rulings: { ...base.rulings, 'AC-1': [...base.rulings['AC-1']!, extra] } }).reasons).toContain('authority conflict AC-1 has contradictory rulings')
    expect(effectiveRulings({ ...base, rulings: { ...base.rulings, 'AC-9': [extra] } }).reasons).toContain('a ruling names AC-9, which no amendment declared')
    const unconfirmed = { ...base.rulings['AC-3']![0]!, ownerRecordConfirms: false }
    expect(effectiveRulings({ ...base, rulings: { ...base.rulings, 'AC-3': [unconfirmed] } }).reasons).toContain('ruling on AC-3 claims an owner decision the owner record does not carry')
  })
})
