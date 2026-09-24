// tests/custody/d1-dag-amendment-v108.test.ts
//
// DAG v1.0.8 (manifest FIBDB-053-D1-MINT-OPERATOR-CHANNEL-SUCCESSOR-R2 amendment
// v1.0.1). v1.0.8 changes no node and no edge. It declares AC-7 (route B's
// plaintext reached the server's CONTEXT lines) with the owner's signed
// ruling CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER, adds PMR-14 and
// supersedes PMR-13 by it.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GRAPH_SOURCES, deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { CONJUNCT_EVALUATORS, effectiveRulings, evaluatePostMintConjuncts, gatherPostMintInputs, readChain } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'

const ROOT = process.cwd()
const V108 = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.8.json' as const
const text = readFileSync(join(ROOT, 'docs', 'ops', 'release', V108), 'utf8')
const a = JSON.parse(text) as { NEW_NODES: unknown[]; NEW_EDGES: unknown[]; AUTHORITY_CONFLICT_RULINGS: Record<string, { kind: string; outcome: string; source: string }> }
const OWNER = 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_N11_PASSWORD_TRANSPORT_OWNER_DECISION_v1.0.0.json'
const PMR13 = 'PMR-13_OEP1_LOGGING_POSTURE_CLOSED'
const PMR14 = 'PMR-14_OEP1_PLAINTEXT_ELIMINATION_CLOSED'
const through = GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V108) + 1)

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function copyRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'd1-v108-'))
  roots.push(r)
  for (const d of ['docs/ops', 'scripts/custody']) cpSync(join(ROOT, d), join(r, d), { recursive: true })
  return r
}

describe('v1.0.8 leaves the graph as it was', () => {
  it('is registered, adds no node and no edge, and keeps HC-1 immediately before N11', () => {
    expect(GRAPH_SOURCES).toContain(V108)
    const facts = deriveGraphFacts({ throughSource: V108 })
    expect(facts.failures).toEqual([])
    expect([facts.nodeCount, facts.edgeCount, facts.acyclic]).toEqual([32, 45, true])
    expect(a.NEW_NODES).toEqual([])
    expect(a.NEW_EDGES).toEqual([])
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
  })
  it('does not move the schedule: N08, N31 and N09 are the values ratified before this lane', () => {
    const s = deriveEffectiveSchedule(ROOT)
    expect([s.N08, s.N31, s.N09]).toEqual(['2026-09-28T14:00:00Z', '2026-09-28T18:00:00Z', '2026-09-29T14:00:00.000Z'])
  })
})

describe('the AC-7 ruling and the PMR-13 -> PMR-14 supersession, as the chain reader sees them', () => {
  const chain = readChain(ROOT, through)
  it('declares AC-7 with one active OWNER ruling the SIGNED owner record confirms', () => {
    expect(chain.chainErrors).toEqual([])
    const { active, reasons } = effectiveRulings(chain)
    expect(reasons).toEqual([])
    expect(chain.declaredConflicts).toContain('AC-7')
    expect(active['AC-7']).toMatchObject({ kind: 'OWNER_POLICY_DECISION', outcome: 'CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER', ownerRecordConfirms: true })
    expect(a.AUTHORITY_CONFLICT_RULINGS['AC-7']!.source).toBe(OWNER)
  })
  it('PMR-14 is live with a registered evaluator; PMR-13 is superseded and no longer live', () => {
    expect(chain.conjunctIds).toContain(PMR14)
    expect(chain.conjunctIds).not.toContain(PMR13)
    expect(CONJUNCT_EVALUATORS[PMR14]).toBeDefined()
    // Through v1.0.7 PMR-13 WAS live: the supersession is what removes it.
    expect(readChain(ROOT, GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V108))).conjunctIds).toContain(PMR13)
  })
  it('records no credential-shaped text in the amendment or the owner record', () => {
    for (const t of [text, readFileSync(join(ROOT, OWNER), 'utf8')]) {
      expect(t).not.toMatch(/postgres(?:ql)?:\/\/[^\s"]*@/i)
      expect(t).not.toMatch(/SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]{8,}\$/)
    }
  })
})

describe('N-FORGED-RULING: an AC-7 ruling the owner record does not carry is not active', () => {
  it.each([
    ['an unsigned owner record', (d: Record<string, unknown>) => ({ ...d, SIGNED: 'NO' })],
    ['another transport', (d: Record<string, unknown>) => ({ ...d, 'AC-7': { N11_PASSWORD_TRANSPORT: 'PLAINTEXT_SET_CONFIG' } })],
    ['AC-7 missing', (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'AC-7'))],
  ])('%s -> not active', (_n, forge) => {
    const r = copyRoot()
    const p = join(r, OWNER)
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { DECISIONS_VERBATIM: Record<string, unknown> }
    writeFileSync(p, JSON.stringify({ ...doc, DECISIONS_VERBATIM: forge(doc.DECISIONS_VERBATIM) }))
    const { active, reasons } = effectiveRulings(readChain(r, through))
    expect(active['AC-7']).toBeUndefined()
    expect(reasons.join(' ')).toMatch(/ruling on AC-7 claims an owner decision the owner record does not carry/)
  })
  it('a supersession naming a conjunct no amendment declares is a chain error', () => {
    const r = copyRoot()
    const p = join(r, 'docs', 'ops', 'release', V108)
    const doc = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    writeFileSync(p, JSON.stringify({ ...doc, N10_PRE_HC1_READINESS_CONJUNCTS_SUPERSEDED: { [PMR13]: { superseded_by: 'PMR-99_NOTHING' } } }))
    expect(readChain(r, through).chainErrors.join(' ')).toMatch(/superseded by PMR-99_NOTHING, which no amendment declares/)
  })
})

describe('the live state of this successor', () => {
  const inputs = gatherPostMintInputs(ROOT)
  const byId = Object.fromEntries(evaluatePostMintConjuncts(inputs).conjuncts.map((c) => [c.id, c]))
  it('PMR-10 (AC-7 ruling matches the implementation) holds', () => {
    expect(byId['PMR-10_RULINGS_MATCH_IMPLEMENTATION']).toMatchObject({ satisfied: true, reasons: [] })
  })
  it('PMR-14 is exactly what the OEP-1 v2 evidence on disk mechanically gives (never pinned to the pre-PHASE-2 state)', () => {
    const pmr14 = byId[PMR14]!
    if (inputs.operatorChannel.oep1.facts.evidence === null) expect(pmr14.satisfied).toBe(false)
    expect(pmr14.satisfied).toBe(pmr14.reasons.length === 0)
  })
})
