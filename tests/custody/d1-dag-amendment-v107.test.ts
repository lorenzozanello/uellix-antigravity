// tests/custody/d1-dag-amendment-v107.test.ts
//
// DAG v1.0.7 (manifest FIBDB-053-D1-MINT-OPERATOR-CHANNEL-SUCCESSOR-R1: P-7,
// P-8, N-SURFACE-OMITTED, N-FORGED-RULING, and the live state of PMR-11..13).
// v1.0.7 changes no node and no edge. It declares AC-4..AC-6 with the owner's
// signed rulings and adds three N10 conjuncts: the operator channel is bound,
// the operator credential is inventoried, and OEP-1 is closed.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GRAPH_SOURCES, deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { CONJUNCT_EVALUATORS, effectiveRulings, evaluatePostMintConjuncts, gatherPostMintInputs, readChain } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { checkOperatorCredentialSection, deriveOperatorCredentialSurfaces } from '@/scripts/custody/d1-delivery-matrix'
import { evaluateN06InRepo, type NodeState } from '@/scripts/custody/d1-n06-closure'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'
import { OPERATOR_CHANNEL_CONTRACT, OEP1_DERIVED_MATERIAL_SETTINGS, OEP1_EXPECTED_CLIENT_SETTINGS, OEP1_PROBE_STATEMENTS } from '@/db/custody/mint-operator-channel'
import { readEffectiveChannelAuthority, workingTreeSource } from '@/scripts/custody/d1-mint-operator-evidence'

const ROOT = process.cwd()
const V107 = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.7.json' as const
const RELEASE = join(ROOT, 'docs', 'ops', 'release')
const text = readFileSync(join(RELEASE, V107), 'utf8')
const a = JSON.parse(text) as { NEW_NODES: unknown[]; NEW_EDGES: unknown[]; AUTHORITY_CONFLICT_RULINGS: Record<string, { kind: string; outcome: string; source: string }> }
const OWNER = 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_OWNER_DECISION_v1.0.0.json'
const AUTHORITY = 'docs/ops/release/FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_EXECUTION_AUTHORITY_v1.0.0.json'
const INVENTORY = 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'
const through = GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V107) + 1)

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function copyRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'd1-v107-'))
  roots.push(r)
  for (const d of ['docs/ops', 'scripts/custody']) cpSync(join(ROOT, d), join(r, d), { recursive: true })
  return r
}

describe('v1.0.7 leaves the graph as it was', () => {
  it('is registered, adds no node and no edge, and keeps HC-1 immediately before N11', () => {
    expect(GRAPH_SOURCES).toContain(V107)
    const facts = deriveGraphFacts({ throughSource: V107 })
    expect(facts.failures).toEqual([])
    expect([facts.nodeCount, facts.edgeCount, facts.acyclic]).toEqual([32, 45, true])
    expect(a.NEW_NODES).toEqual([])
    expect(a.NEW_EDGES).toEqual([])
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
  })
})

describe('P-8: the rulings and conjuncts, as the chain reader sees them', () => {
  const chain = readChain(ROOT, through)
  it('declares AC-4..AC-6 and each has one active OWNER ruling the SIGNED owner record confirms', () => {
    expect(chain.chainErrors).toEqual([])
    const { active, reasons } = effectiveRulings(chain)
    expect(reasons).toEqual([])
    for (const id of ['AC-4', 'AC-5', 'AC-6']) {
      expect(chain.declaredConflicts).toContain(id)
      expect(active[id]!.kind).toBe('OWNER_POLICY_DECISION')
      expect(active[id]!.ownerRecordConfirms).toBe(true)
      expect(a.AUTHORITY_CONFLICT_RULINGS[id]!.source).toBe(OWNER)
    }
    expect([active['AC-4']!.outcome, active['AC-5']!.outcome, active['AC-6']!.outcome]).toEqual([
      'OPTION_A',
      'AUTHORIZE_NARROW_N11_OPERATOR_CREDENTIAL_EXCEPTION',
      'INVENTORY_EPHEMERAL_PARENT_LAUNCHER_AS_CREDENTIAL_BEARING_SURFACE',
    ])
  })
  it('adds PMR-11, PMR-12 and PMR-13, each with a registered evaluator', () => {
    for (const id of ['PMR-11_OPERATOR_CHANNEL_BOUND', 'PMR-12_OPERATOR_CREDENTIAL_INVENTORIED', 'PMR-13_OEP1_LOGGING_POSTURE_CLOSED']) {
      expect(chain.conjunctIds).toContain(id)
      expect(CONJUNCT_EVALUATORS[id], id).toBeDefined()
    }
  })
  it('records no credential-shaped text in the amendment, the owner record or the authority', () => {
    for (const t of [text, readFileSync(join(ROOT, OWNER), 'utf8'), readFileSync(join(ROOT, AUTHORITY), 'utf8')]) {
      expect(t).not.toMatch(/postgres(?:ql)?:\/\/[^\s"]*@/i)
      expect(t).not.toMatch(/UELLIX-D1-AUDITOR-|UELLIX-N05-SENTINEL-[0-9A-F]{6,}/)
    }
  })
  it('the EFFECTIVE authority (v1.0.0 as amended append-only by v1.0.1) states the implementation byte for byte', () => {
    // v1.0.0 is a sealed record of what 979b1440 implemented; it is not edited. The
    // sections the R2 amendment replaces are read through the supersedes chain.
    const eff = readEffectiveChannelAuthority(workingTreeSource(ROOT))
    expect(eff.errors).toEqual([])
    // Derived from the amendments on disk (a later amendment extends the chain; none is pinned as the last).
    const amendments = readdirSync(RELEASE)
      .filter((n) => /^FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_EXECUTION_AUTHORITY_AMENDMENT_v\d+\.\d+\.\d+\.json$/.test(n))
      .sort((x, y) => x.localeCompare(y, 'en', { numeric: true }))
      .map((n) => `docs/ops/release/${n}`)
    expect(eff.chain).toEqual([AUTHORITY, ...amendments])
    expect(eff.chain[1]).toBe('docs/ops/release/FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json')
    const doc = eff.doc as { CHANNEL_CONTRACT: { clause_ids: string[] }; OEP1_PROBE_CONTRACT: { expected_client_settings: unknown; derived_settings_list: string[]; statements: Record<string, string> } }
    expect(doc.CHANNEL_CONTRACT.clause_ids).toEqual(OPERATOR_CHANNEL_CONTRACT.map((c) => c.id))
    expect(doc.OEP1_PROBE_CONTRACT.derived_settings_list).toEqual([...OEP1_DERIVED_MATERIAL_SETTINGS])
    expect(doc.OEP1_PROBE_CONTRACT.expected_client_settings).toEqual(OEP1_EXPECTED_CLIENT_SETTINGS)
    expect(doc.OEP1_PROBE_CONTRACT.statements).toEqual(OEP1_PROBE_STATEMENTS)
  })
  it('the v1.0.0 record itself is unchanged history: it still states the ten clauses 979b1440 implemented', () => {
    const w2 = JSON.parse(readFileSync(join(ROOT, AUTHORITY), 'utf8')) as { CHANNEL_CONTRACT: { clause_ids: string[] } }
    expect(w2.CHANNEL_CONTRACT.clause_ids).toEqual(['OC-1', 'OC-2', 'OC-3', 'OC-4', 'OC-5', 'OC-6', 'OC-7', 'OC-8', 'OC-9', 'OC-10'])
  })
})

describe('N-FORGED-RULING: an owner ruling the owner record does not carry is not active', () => {
  it.each([
    ['an unsigned owner record', (d: Record<string, unknown>) => ({ ...d, SIGNED: 'NO' })],
    ['another AC-4 outcome', (d: Record<string, unknown>) => ({ ...d, 'AC-4': { OT3_CHANNEL: 'OPTION_B' } })],
    ['AC-6 missing', (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'AC-6'))],
  ])('%s -> PMR-7 reason', (_n, forge) => {
    const r = copyRoot()
    const p = join(r, OWNER)
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { DECISIONS_VERBATIM: Record<string, unknown> }
    writeFileSync(p, JSON.stringify({ ...doc, DECISIONS_VERBATIM: forge(doc.DECISIONS_VERBATIM) }))
    const { reasons } = effectiveRulings(readChain(r, through))
    expect(reasons.join(' ')).toMatch(/claims an owner decision the owner record does not carry/)
  })
})

describe('the live state of this successor', () => {
  const inputs = gatherPostMintInputs(ROOT)
  const byId = Object.fromEntries(evaluatePostMintConjuncts(inputs).conjuncts.map((c) => [c.id, c]))
  it('PMR-11 (channel bound) and PMR-12 (operator surfaces inventoried) hold', () => {
    expect(byId['PMR-11_OPERATOR_CHANNEL_BOUND']).toMatchObject({ satisfied: true, reasons: [] })
    expect(byId['PMR-12_OPERATOR_CREDENTIAL_INVENTORIED']).toMatchObject({ satisfied: true, reasons: [] })
  })
  it('PMR-13 is no longer a live conjunct (v1.0.8 supersedes it by PMR-14), and its evaluator can never say yes', () => {
    expect(byId['PMR-13_OEP1_LOGGING_POSTURE_CLOSED']).toBeUndefined()
    expect(byId['PMR-14_OEP1_PLAINTEXT_ELIMINATION_CLOSED']).toBeDefined()
    expect(CONJUNCT_EVALUATORS['PMR-13_OEP1_LOGGING_POSTURE_CLOSED']!(inputs)).toEqual(['PMR-13 is superseded by PMR-14_OEP1_PLAINTEXT_ELIMINATION_CLOSED (DAG v1.0.8) and cannot be satisfied on its own'])
  })
})

describe('P-7 / N-SURFACE-OMITTED: N06 checks the operator credential section', () => {
  const W = deriveEffectiveSchedule(ROOT).N08
  const states = { N03: 'SATISFIED', N05: 'SATISFIED', N09: 'SATISFIED', N31: 'SATISFIED', N32: 'SATISFIED' } as Record<string, NodeState>
  const withSection = (edit: (s: Record<string, unknown>) => Record<string, unknown> | undefined) => {
    const r = copyRoot()
    const p = join(r, INVENTORY)
    const inv = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const next = edit(inv.operator_credential as Record<string, unknown>)
    writeFileSync(p, JSON.stringify(next === undefined ? Object.fromEntries(Object.entries(inv).filter(([k]) => k !== 'operator_credential')) : { ...inv, operator_credential: next }))
    return evaluateN06InRepo(r, W, states)
  }
  it('the live inventory: N06 SATISFIED, with the operator section checked', () => {
    const ev = evaluateN06InRepo(ROOT, W, states)
    expect(ev.reasons).toEqual([])
    expect(ev.status).toBe('SATISFIED')
  })
  it.each([
    ['the parent launcher surface omitted', (s: Record<string, unknown>) => ({ ...s, processes_or_environments: (s.processes_or_environments as Array<{ surface: string }>).filter((x) => x.surface !== 'OPERATOR_CREDENTIAL_LAUNCHER_SURFACE') }), /omits surface OPERATOR_CREDENTIAL_LAUNCHER_SURFACE/],
    ['the tool surface omitted', (s: Record<string, unknown>) => ({ ...s, processes_or_environments: (s.processes_or_environments as Array<{ surface: string }>).filter((x) => x.surface !== 'OPERATOR_CREDENTIAL_TOOL_SURFACE') }), /omits surface OPERATOR_CREDENTIAL_TOOL_SURFACE/],
    ['an undeclared surface added', (s: Record<string, unknown>) => ({ ...s, processes_or_environments: [...(s.processes_or_environments as unknown[]), { surface: 'OPERATOR_PASSWORD_FILE' }] }), /lists OPERATOR_PASSWORD_FILE/],
    ['persistence other than NONE', (s: Record<string, unknown>) => ({ ...s, persistence: 'WCM' }), /persistence is not NONE/],
    ['the whole section removed', () => undefined, /no operator_credential section/],
  ])('%s -> N06 NOT_SATISFIED', (_n, edit, why) => {
    const ev = withSection(edit as (s: Record<string, unknown>) => Record<string, unknown> | undefined)
    expect(ev.status).toBe('NOT_SATISFIED')
    expect(ev.reasons.join(' ')).toMatch(why)
  })
  it('the derived operator surfaces are exactly two, the parent launcher first', () => {
    expect(deriveOperatorCredentialSurfaces().map((s) => s.surface)).toEqual(['OPERATOR_CREDENTIAL_LAUNCHER_SURFACE', 'OPERATOR_CREDENTIAL_TOOL_SURFACE'])
    expect(checkOperatorCredentialSection({ persistence: 'NONE', human_custodian: 'x', processes_or_environments: deriveOperatorCredentialSurfaces() })).toEqual([])
  })
})
