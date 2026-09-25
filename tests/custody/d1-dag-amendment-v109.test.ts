// tests/custody/d1-dag-amendment-v109.test.ts
//
// DAG v1.0.9 (manifest amendment v1.0.2). v1.0.9 changes no node and no edge.
// It declares AC-8 (the operator channel authenticated nobody) with the
// owner's signed ruling VERIFY_FULL_PINNED_CA and adds PMR-15.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GRAPH_SOURCES, deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { CONJUNCT_EVALUATORS, effectiveRulings, evaluatePostMintConjuncts, gatherPostMintInputs, readChain } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'
import { caFileReasons } from '@/scripts/custody/d1-mint-operator-evidence'

const ROOT = process.cwd()
const V109 = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.9.json' as const
const text = readFileSync(join(ROOT, 'docs', 'ops', 'release', V109), 'utf8')
const a = JSON.parse(text) as { NEW_NODES: unknown[]; NEW_EDGES: unknown[]; AUTHORITY_CONFLICT_RULINGS: Record<string, { kind: string; outcome: string; source: string }> }
const OWNER = 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_TLS_TRUST_OWNER_DECISION_v1.0.0.json'
const PMR15 = 'PMR-15_OPERATOR_CHANNEL_SERVER_AUTHENTICATED'
const through = GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V109) + 1)

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function copyRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'd1-v109-'))
  roots.push(r)
  for (const d of ['docs/ops', 'scripts/custody']) cpSync(join(ROOT, d), join(r, d), { recursive: true })
  return r
}

describe('v1.0.9 leaves the graph and the schedule as they were', () => {
  it('is registered, adds no node and no edge, and keeps HC-1 immediately before N11', () => {
    expect(GRAPH_SOURCES).toContain(V109)
    const facts = deriveGraphFacts({ throughSource: V109 })
    expect(facts.failures).toEqual([])
    expect([facts.nodeCount, facts.edgeCount, facts.acyclic]).toEqual([32, 45, true])
    expect(a.NEW_NODES).toEqual([])
    expect(a.NEW_EDGES).toEqual([])
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
  })
  it('N08, N31 and N09 are the values ratified before this lane', () => {
    const s = deriveEffectiveSchedule(ROOT)
    expect([s.N08, s.N31, s.N09]).toEqual(['2026-09-28T14:00:00Z', '2026-09-28T18:00:00Z', '2026-09-29T14:00:00.000Z'])
  })
})

describe('the AC-8 ruling and PMR-15, as the chain reader sees them', () => {
  const chain = readChain(ROOT, through)
  it('declares AC-8 with one active OWNER ruling the SIGNED owner record confirms', () => {
    expect(chain.chainErrors).toEqual([])
    const { active, reasons } = effectiveRulings(chain)
    expect(reasons).toEqual([])
    expect(chain.declaredConflicts).toContain('AC-8')
    expect(active['AC-8']).toMatchObject({ kind: 'OWNER_POLICY_DECISION', outcome: 'VERIFY_FULL_PINNED_CA', ownerRecordConfirms: true })
    expect(a.AUTHORITY_CONFLICT_RULINGS['AC-8']!.source).toBe(OWNER)
  })
  it('PMR-15 is live, registered, and not live before v1.0.9', () => {
    expect(chain.conjunctIds).toContain(PMR15)
    expect(CONJUNCT_EVALUATORS[PMR15]).toBeDefined()
    expect(readChain(ROOT, GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V109))).conjunctIds).not.toContain(PMR15)
  })
  it('records no credential-shaped text in the amendment or the owner record', () => {
    for (const t of [text, readFileSync(join(ROOT, OWNER), 'utf8')]) {
      expect(t).not.toMatch(/postgres(?:ql)?:\/\/[^\s"]*@/i)
      expect(t).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    }
  })
})

describe('N-FORGED-RULING: an AC-8 ruling the owner record does not carry is not active', () => {
  it.each([
    ['an unsigned owner record', (d: Record<string, unknown>) => ({ ...d, SIGNED: 'NO' })],
    ['another policy', (d: Record<string, unknown>) => ({ ...d, 'AC-8': { TLS_TRUST_POLICY: 'REQUIRE' } })],
    ['AC-8 missing', (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'AC-8'))],
  ])('%s -> not active', (_n, forge) => {
    const r = copyRoot()
    const p = join(r, OWNER)
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { DECISIONS_VERBATIM: Record<string, unknown> }
    writeFileSync(p, JSON.stringify({ ...doc, DECISIONS_VERBATIM: forge(doc.DECISIONS_VERBATIM) }))
    const { active, reasons } = effectiveRulings(readChain(r, through))
    expect(active['AC-8']).toBeUndefined()
    expect(reasons.join(' ')).toMatch(/ruling on AC-8 claims an owner decision the owner record does not carry/)
  })
})

describe('the live state of this successor', () => {
  const inputs = gatherPostMintInputs(ROOT)
  const byId = Object.fromEntries(evaluatePostMintConjuncts(inputs).conjuncts.map((c) => [c.id, c]))
  it('PMR-15 holds on the repository (pinned project certificate, OC-13/OC-14) and PMR-10 maps AC-8', () => {
    expect(byId[PMR15]).toMatchObject({ satisfied: true, reasons: [] })
    expect(byId['PMR-10_RULINGS_MATCH_IMPLEMENTATION']).toMatchObject({ satisfied: true, reasons: [] })
  })
  it('PMR-15 fails when the repository copy of the trust root is altered', () => {
    const r = copyRoot()
    const ca = join(r, 'docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_TLS_TRUST_ROOT_bvyzblhqymxruxdguaee_v1.0.0.crt')
    writeFileSync(ca, `${readFileSync(ca, 'utf8')}\n`)
    // Measured on the altered copy, the CA facts carry the reason, and PMR-15 refuses on them.
    const caReasons = caFileReasons(r, inputs.operatorChannel.binding)
    expect(caReasons.join(' ')).toMatch(/bytes are not the pinned ones/)
    expect(CONJUNCT_EVALUATORS[PMR15]!({ ...inputs, operatorChannel: { ...inputs.operatorChannel, caReasons } })).toEqual(caReasons)
  })
})
