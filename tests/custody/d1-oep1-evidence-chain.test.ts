// tests/custody/d1-oep1-evidence-chain.test.ts
//
// R3-N-CHAIN (manifest amendment v1.0.2). OEP-1 evidence used to be "the highest
// version wins": a later PASS silently replaced an earlier FAIL. It is now ONE
// explicit append-only chain whose head must acknowledge every earlier record
// that did not close OEP-1.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { gatherOep1EvidenceFacts, oep1ChainReasons } from '@/scripts/custody/d1-mint-operator-evidence'

const P = (v: string) => `docs/ops/release/FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_v${v}.json`
const rec = (v: string, doc: Record<string, unknown>) => ({ path: P(v), doc })
const closed = (predecessor: string | null, acknowledged: Array<{ path: string; resolution: string }> = []) => ({ verdict: 'CLOSED', predecessor, acknowledged_non_closed: acknowledged })
const failed = (predecessor: string | null) => ({ verdict: 'NOT_CLOSED', predecessor, acknowledged_non_closed: [] })

describe('R3-N-CHAIN: the chain rules', () => {
  it('one CLOSED root is a chain of one, and its head is it', () => {
    const r = oep1ChainReasons([rec('1.0.0', closed(null))])
    expect(r).toEqual({ head: P('1.0.0'), chain: [{ path: P('1.0.0'), verdict: 'CLOSED' }], reasons: [] })
  })
  it('a FAIL followed by a CLOSED head that acknowledges it, with a resolution, is accepted', () => {
    const r = oep1ChainReasons([rec('1.0.0', failed(null)), rec('1.0.1', closed(P('1.0.0'), [{ path: P('1.0.0'), resolution: 'the hosted posture was corrected and re-observed' }]))])
    expect(r.reasons).toEqual([])
    expect(r.head).toBe(P('1.0.1'))
    expect(r.chain.map((c) => c.verdict)).toEqual(['NOT_CLOSED', 'CLOSED'])
  })
  it('a later PASS that does NOT name the earlier FAIL is refused (the old "highest version wins")', () => {
    const r = oep1ChainReasons([rec('1.0.0', failed(null)), rec('1.0.1', closed(P('1.0.0')))])
    expect(r.reasons.join(' ')).toMatch(/must acknowledge exactly the earlier non-CLOSED records/)
  })
  it('an INCONCLUSIVE record counts as non-CLOSED too', () => {
    const r = oep1ChainReasons([rec('1.0.0', { ...failed(null), verdict: 'INCONCLUSIVE' }), rec('1.0.1', closed(P('1.0.0')))])
    expect(r.reasons.join(' ')).toMatch(/must acknowledge exactly/)
  })
  it('an acknowledgement without a resolution is refused', () => {
    const r = oep1ChainReasons([rec('1.0.0', failed(null)), rec('1.0.1', closed(P('1.0.0'), [{ path: P('1.0.0'), resolution: ' ' }]))])
    expect(r.reasons.join(' ')).toMatch(/carries no resolution/)
  })
  it('acknowledging a record that DID close is refused (the set must be exact)', () => {
    const r = oep1ChainReasons([rec('1.0.0', closed(null)), rec('1.0.1', closed(P('1.0.0'), [{ path: P('1.0.0'), resolution: 'x' }]))])
    expect(r.reasons.join(' ')).toMatch(/must acknowledge exactly/)
  })
  it.each([
    ['two roots', [rec('1.0.0', closed(null)), rec('1.0.1', closed(null))], /2 roots/],
    ['a fork', [rec('1.0.0', failed(null)), rec('1.0.1', closed(P('1.0.0'))), rec('1.0.2', closed(P('1.0.0')))], /forks at/],
    ['a dangling predecessor', [rec('1.0.0', closed(null)), rec('1.0.1', closed(P('0.9.9')))], /does not exist/],
    ['a predecessor of a HIGHER version', [rec('1.0.1', closed(null)), rec('1.0.0', closed(P('1.0.1')))], /not an earlier version/],
    ['a record that does not name its predecessor', [rec('1.0.0', closed(null)), rec('1.0.1', { verdict: 'CLOSED', acknowledged_non_closed: [] })], /does not name its predecessor/],
    ['no root at all (a cycle)', [rec('1.0.0', closed(P('1.0.1'))), rec('1.0.1', closed(P('1.0.0')))], /0 roots/],
  ])('%s is refused', (_n, records, why) => {
    expect(oep1ChainReasons(records).reasons.join(' ')).toMatch(why)
  })
})

describe('R3-N-CHAIN: the facts gathered from disk evaluate the HEAD and carry the chain reasons', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })
  const repo = (files: Record<string, Record<string, unknown>>) => {
    const r = mkdtempSync(join(tmpdir(), 'd1-oep1-chain-'))
    roots.push(r)
    mkdirSync(join(r, 'docs', 'ops', 'release'), { recursive: true })
    for (const [v, doc] of Object.entries(files)) writeFileSync(join(r, P(v)), JSON.stringify(doc))
    return r
  }
  it('no evidence: no head, no chain reason', () => {
    expect(gatherOep1EvidenceFacts(repo({}))).toMatchObject({ path: null, evidence: null, chain: [], chainReasons: [] })
  })
  it('the head is the record no other names, not the highest version', () => {
    // 1.0.2 is the highest version but a second root; the chain 1.0.0 -> 1.0.1 has its own head.
    const f = gatherOep1EvidenceFacts(repo({ '1.0.0': failed(null), '1.0.1': closed(P('1.0.0'), [{ path: P('1.0.0'), resolution: 'r' }]), '1.0.2': closed(null) }))
    expect(f.chainReasons.join(' ')).toMatch(/2 roots/)
  })
  it('a later PASS over an unacknowledged FAIL: the head is evaluated and the chain reason travels with it', () => {
    const f = gatherOep1EvidenceFacts(repo({ '1.0.0': failed(null), '1.0.1': closed(P('1.0.0')) }))
    expect(f.path).toBe(P('1.0.1'))
    expect(f.evidence).toMatchObject({ verdict: 'CLOSED' })
    expect(f.chainReasons.join(' ')).toMatch(/must acknowledge exactly/)
  })
})
