// tests/custody/d1-dag-amendment-v1010.test.ts
//
// DAG v1.0.10 (manifest amendment v1.0.3, R4-P-PMR16). v1.0.10 changes no node
// and no edge. It supersedes PMR-15 (partly declared) by PMR-16, whose every
// term is MEASURED: the certificate's bytes/DER/SPKI, what the trust text does
// with it, and what the launcher's CA check does with it. The declared portions
// are labelled DECLARED_NOT_MEASURED and are nonblocking for PMR-16.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GRAPH_SOURCES, deriveGraphFacts, hardPredecessorsOf } from '@/scripts/custody/d1-dag-validate'
import { CONJUNCT_EVALUATORS, evaluatePostMintConjuncts, gatherPostMintInputs, readChain } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'
import { caFileReasons } from '@/scripts/custody/d1-mint-operator-evidence'
import { measureServerAuthentication } from '@/scripts/custody/d1-server-auth-measure'
import { checkPlannedCa } from '@/scripts/custody/d1-mint-operator-launcher'
import { trustTextBehaviourReasons } from '@/scripts/custody/d1-tls-trust-harness'

const ROOT = process.cwd()
const V1010 = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.10.json' as const
const text = readFileSync(join(ROOT, 'docs', 'ops', 'release', V1010), 'utf8')
const a = JSON.parse(text) as {
  NEW_NODES: unknown[]
  NEW_EDGES: unknown[]
  N10_PRE_HC1_READINESS_CONJUNCTS_SUPERSEDED: Record<string, { superseded_by: string }>
  DECLARED_NOT_MEASURED: { portions: string[]; status: string }
}
const PMR15 = 'PMR-15_OPERATOR_CHANNEL_SERVER_AUTHENTICATED'
const PMR16 = 'PMR-16_OPERATOR_CHANNEL_SERVER_AUTHENTICATION_MEASURED'
const CA = join('docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_TLS_TRUST_ROOT_bvyzblhqymxruxdguaee_v1.0.0.crt')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function copyRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'd1-v1010-'))
  roots.push(r)
  for (const d of ['docs/ops', 'scripts/custody']) cpSync(join(ROOT, d), join(r, d), { recursive: true })
  return r
}

describe('v1.0.10 leaves the graph and the schedule as they were', () => {
  it('is registered last, adds no node and no edge, and keeps HC-1 immediately before N11', () => {
    expect(GRAPH_SOURCES.at(-1)).toBe(V1010)
    const facts = deriveGraphFacts({ throughSource: V1010 })
    expect(facts.failures).toEqual([])
    expect([facts.nodeCount, facts.edgeCount, facts.acyclic]).toEqual([32, 45, true])
    expect([a.NEW_NODES, a.NEW_EDGES]).toEqual([[], []])
    expect(hardPredecessorsOf('N11')).toEqual(['N10'])
  })
  it('N08, N31 and N09 are not moved', () => {
    const s = deriveEffectiveSchedule(ROOT)
    expect([s.N08, s.N31, s.N09]).toEqual(['2026-09-28T14:00:00Z', '2026-09-28T18:00:00Z', '2026-09-29T14:00:00.000Z'])
  })
  it('records no credential-shaped text', () => {
    expect(text).not.toMatch(/postgres(?:ql)?:\/\/[^\s"]*@/i)
    expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)
  })
})

describe('R4-P-PMR16: PMR-16 replaces PMR-15 in the chain', () => {
  const chain = readChain(ROOT, GRAPH_SOURCES)
  it('PMR-16 is live and registered; PMR-15 is superseded by it and no longer live', () => {
    expect(chain.chainErrors).toEqual([])
    expect(chain.conjunctIds).toContain(PMR16)
    expect(chain.conjunctIds).not.toContain(PMR15)
    expect(CONJUNCT_EVALUATORS[PMR16]).toBeDefined()
    expect(a.N10_PRE_HC1_READINESS_CONJUNCTS_SUPERSEDED[PMR15]!.superseded_by).toBe(PMR16)
    expect(readChain(ROOT, GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(V1010))).conjunctIds).toContain(PMR15)
  })
  it('labels the declared portions honestly and leaves them nonblocking', () => {
    expect(a.DECLARED_NOT_MEASURED.portions.join(' ')).toMatch(/policy[\s\S]*TLS_TRUST_POLICY[\s\S]*OC-13 and OC-14/)
    expect(a.DECLARED_NOT_MEASURED.status).toMatch(/^NONBLOCKING for PMR-16/)
  })
})

describe('the live, measured state of PMR-16', () => {
  const inputs = gatherPostMintInputs(ROOT)
  const byId = Object.fromEntries(evaluatePostMintConjuncts(inputs).conjuncts.map((c) => [c.id, c]))
  const binding = inputs.operatorChannel.binding!
  it('holds on the repository: the certificate, the trust text and the launcher check all measure clean', () => {
    expect(inputs.operatorChannel.caReasons).toEqual([])
    expect(inputs.operatorChannel.serverAuthReasons).toEqual([])
    expect(byId[PMR16]).toMatchObject({ satisfied: true, reasons: [] })
  })
  it('fails when the repository copy of the trust root is altered (certificate AND behaviour)', () => {
    const r = copyRoot()
    writeFileSync(join(r, CA), `${readFileSync(join(r, CA), 'utf8')}\n`)
    const caReasons = caFileReasons(r, binding)
    const serverAuthReasons = measureServerAuthentication(r, binding, 'db.pmr16.invalid')
    expect(caReasons.join(' ')).toMatch(/bytes are not the pinned ones/)
    // The measured behaviour sees it too: neither the trust text nor the launcher accepts the altered bytes.
    expect(serverAuthReasons.join(' ')).toMatch(/PMR-16:/)
    expect(CONJUNCT_EVALUATORS[PMR16]!({ ...inputs, operatorChannel: { ...inputs.operatorChannel, caReasons, serverAuthReasons } })).toEqual([...caReasons, ...serverAuthReasons])
  })
  it('fails on a measured failure alone (the pin the binding names is not the certificate)', () => {
    const wrongPin = { ...binding, tls: { ...binding.tls!, ca_raw_sha256: 'f'.repeat(64) } }
    const serverAuthReasons = measureServerAuthentication(ROOT, wrongPin, 'db.pmr16.invalid')
    expect(serverAuthReasons.length).toBeGreaterThan(0)
    expect(CONJUNCT_EVALUATORS[PMR16]!({ ...inputs, operatorChannel: { ...inputs.operatorChannel, serverAuthReasons } })).toEqual(serverAuthReasons)
  })
  it('R4-P-PMR16 sees a launcher CA check that accepts other bytes or a missing file, and one that refuses the pin', () => {
    const real = { checkCa: checkPlannedCa, trustText: trustTextBehaviourReasons }
    expect(measureServerAuthentication(ROOT, binding, 'db.pmr16.invalid', real)).toEqual([])
    const lenient = measureServerAuthentication(ROOT, binding, 'db.pmr16.invalid', { ...real, checkCa: () => undefined })
    expect(lenient).toEqual(['PMR-16: the launcher accepts CA bytes that are not the pin', 'PMR-16: the launcher accepts a missing CA file'])
    const refusing = measureServerAuthentication(ROOT, binding, 'db.pmr16.invalid', {
      ...real,
      checkCa: () => {
        throw Object.assign(new Error('x'), { code: 'CHANNEL_CA_MISMATCH' })
      },
    })
    expect(refusing).toContain('PMR-16: the launcher refuses the pinned project certificate')
  })
  it('R4-P-PMR16 sees trust text that misbehaves', () => {
    const r = measureServerAuthentication(ROOT, binding, 'db.pmr16.invalid', { checkCa: checkPlannedCa, trustText: () => ['the anchor is not the pinned certificate'] })
    expect(r).toEqual(['PMR-16: the anchor is not the pinned certificate'])
  })
  it('refuses to measure without a binding', () => {
    expect(measureServerAuthentication(ROOT, null, null)).toEqual(['PMR-16: no pinned trust root to measure against'])
  })
})
