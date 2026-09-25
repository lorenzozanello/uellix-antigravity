// tests/custody/d1-oep1-evidence-chain.test.ts
//
// R4-N-CHAIN / R4-P-CHAIN / R4-N-O11 (owner R4, NB-2; manifest amendment
// v1.0.3). OEP-1 evidence is ONE digest-bound chain: record ids, content
// digests, predecessor id + digest, exact observation times, and verdicts
// RECOMPUTED from each link's own facts. A closing PASS must be observed after
// every link it supersedes and acknowledge, by id and digest, each earlier link
// that does not recompute to CLOSED. File names carry no authority; the history
// may not delete or modify an evidence file.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { OEP1_EXPECTED_CLIENT_SETTINGS } from '@/db/custody/mint-operator-channel'
import { discoverOep1RecordNames, gatherOep1EvidenceFacts, oep1ChainReasons, oep1RecordDigest, recomputedLinkVerdict, sealOep1Record, utcMillis, type Oep1RepoContext } from '@/scripts/custody/d1-mint-operator-evidence'
import { gatherPostMintInputs } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { unsealedOep1Evidence } from './support/oep1-evidence-fixture'

let CTX: Oep1RepoContext
beforeAll(() => {
  CTX = gatherPostMintInputs(process.cwd()).operatorChannel.oep1.ctx
}, 180_000)

const T = (h: number) => `2026-09-26T${String(h).padStart(2, '0')}:00:00.000Z`
const path = (v: string) => `docs/ops/release/FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_v${v}.json`
type Rec = { path: string; doc: Record<string, unknown> }
const link = (r: Rec) => ({ record_id: r.doc.record_id, content_digest: r.doc.content_digest })

/** A record whose facts recompute to CLOSED. */
function closed(id: string, at: string, predecessor: Rec | null, acknowledges: Array<{ r: Rec; resolution?: string }> = [], v = id): Rec {
  const doc = { ...unsealedOep1Evidence(CTX, at), record_id: id, predecessor: predecessor === null ? null : link(predecessor), acknowledges: acknowledges.map((a) => ({ ...link(a.r), resolution: a.resolution ?? 'the hosted posture was corrected and re-observed' })) }
  return { path: path(v), doc: sealOep1Record(doc) }
}
/** A record whose facts recompute to NOT_CLOSED (a startup GUC reached the session). */
function failed(id: string, at: string, predecessor: Rec | null, verdict = 'NOT_CLOSED', v = id): Rec {
  const base = unsealedOep1Evidence(CTX, at)
  const obs = base.observation as { client_settings: unknown[] }
  const doc = { ...base, record_id: id, predecessor: predecessor === null ? null : link(predecessor), acknowledges: [], observation: { ...obs, client_settings: [...OEP1_EXPECTED_CLIENT_SETTINGS, ['debug_print_parse', 'on']] }, verdict }
  return { path: path(v), doc: sealOep1Record(doc) }
}
const reasons = (...recs: Rec[]) => oep1ChainReasons(recs).reasons.join(' | ')

describe('R4-P-CHAIN: the chains that close', () => {
  it('one root whose facts recompute to CLOSED', () => {
    const a = closed('OEP1-1', T(1), null)
    const r = oep1ChainReasons([a])
    expect(r.reasons).toEqual([])
    expect(r.head).toBe(a.path)
    expect(r.chain).toEqual([{ path: a.path, recordId: 'OEP1-1', verdict: 'CLOSED', observedAt: T(1) }])
  })
  it('a FAIL superseded by a LATER head that recomputes to CLOSED and acknowledges it by id and digest', () => {
    const f = failed('OEP1-1', T(1), null)
    const h = closed('OEP1-2', T(2), f, [{ r: f }])
    const r = oep1ChainReasons([f, h])
    expect(r.reasons).toEqual([])
    expect(r.chain.map((c) => c.verdict)).toEqual(['NOT_CLOSED', 'CLOSED'])
  })
  it('file names carry no authority: a head in a LOWER-numbered file is still the head', () => {
    const f = failed('OEP1-1', T(1), null, 'NOT_CLOSED', '2.0.0')
    const h = closed('OEP1-2', T(2), f, [{ r: f }], '1.0.0')
    expect(oep1ChainReasons([f, h])).toMatchObject({ head: h.path, reasons: [] })
  })
})

describe('R5-B / IP-4: only a canonical, possible UTC instant is a time', () => {
  it('utcMillis accepts the two canonical shapes and round-trips', () => {
    expect(utcMillis('2026-09-28T14:00:00Z')).toBe(Date.UTC(2026, 8, 28, 14, 0, 0))
    expect(utcMillis('2026-09-29T14:00:00.000Z')).toBe(Date.UTC(2026, 8, 29, 14, 0, 0, 0))
  })
  it.each([
    ['month 13', '2026-13-01T00:00:00Z'],
    ['day 00', '2026-09-00T00:00:00Z'],
    ['day 31 of September', '2026-09-31T00:00:00Z'],
    ['Feb 29 in a common year', '2027-02-29T00:00:00Z'],
    ['hour 24', '2026-09-28T24:00:00Z'],
    ['minute 60', '2026-09-28T14:60:00Z'],
    ['leap second :60', '2026-09-28T23:59:60Z'],
    ['no Z', '2026-09-28T14:00:00'],
    ['offset instead of Z', '2026-09-28T14:00:00+00:00'],
    ['one-digit fraction', '2026-09-28T14:00:00.5Z'],
    ['not a date', 'the day after N07'],
    ['non-string', 42 as unknown as string],
  ])('utcMillis rejects %s', (_n, bad) => {
    expect(utcMillis(bad)).toBeNull()
  })
  it('a leap year Feb 29 is accepted', () => {
    expect(utcMillis('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29, 0, 0, 0))
  })
  it('a SINGLE-record chain with an impossible timestamp MUST NOT close', () => {
    const a = closed('OEP1-1', '2026-13-01T00:00:00Z', null)
    const r = oep1ChainReasons([a])
    expect(r.reasons.join(' | ')).toMatch(/observed_at_utc is not an exact, possible, canonical UTC instant/)
  })
  it('a two-record chain cannot order itself by an impossible predecessor time', () => {
    const f = failed('OEP1-1', '2026-02-30T00:00:00Z', null)
    const h = closed('OEP1-2', T(2), f, [{ r: f }])
    expect(reasons(f, h)).toMatch(/is not an exact, possible, canonical UTC instant/)
  })
})

describe('R4-N-CHAIN: every weakened chain fails closed', () => {
  it('an earlier FAIL the head does not acknowledge stays blocking', () => {
    const f = failed('OEP1-1', T(1), null)
    expect(reasons(f, closed('OEP1-2', T(2), f))).toMatch(/must acknowledge exactly the earlier links that do not recompute to CLOSED \[OEP1-1\]/)
  })
  it('N-1: a head observed BEFORE the FAIL it supersedes is refused', () => {
    const f = failed('OEP1-1', T(5), null)
    const why = reasons(f, closed('OEP1-2', T(4), f, [{ r: f }]))
    expect(why).toMatch(/not observed strictly after its predecessor OEP1-1/)
    expect(why).toMatch(/head is not observed after OEP1-1/)
  })
  it('the same instant is not "after" (strict order)', () => {
    const f = failed('OEP1-1', T(5), null)
    expect(reasons(f, closed('OEP1-2', T(5), f, [{ r: f }]))).toMatch(/not observed strictly after/)
  })
  it('deletion: a predecessor that no longer exists', () => {
    const f = failed('OEP1-1', T(1), null)
    expect(reasons(closed('OEP1-2', T(2), f, [{ r: f }]))).toMatch(/names a predecessor that does not exist \(deleted\?\): OEP1-1/)
  })
  it('substitution: the predecessor re-sealed with other content no longer matches the digest its successor holds', () => {
    const f = failed('OEP1-1', T(1), null)
    const h = closed('OEP1-2', T(2), f, [{ r: f }])
    const swapped: Rec = { path: f.path, doc: sealOep1Record({ ...f.doc, observed_at_utc: T(0) }) }
    expect(reasons(swapped, h)).toMatch(/names OEP1-1 with another content digest \(substituted predecessor\)/)
  })
  it('alteration: a record whose content no longer matches its own content_digest', () => {
    const a = closed('OEP1-1', T(1), null)
    expect(reasons({ path: a.path, doc: { ...a.doc, operator_principal: 'someone_else' } })).toMatch(/does not match its content_digest/)
  })
  it('a fork: two records naming one predecessor', () => {
    const f = failed('OEP1-1', T(1), null)
    expect(reasons(f, closed('OEP1-2', T(2), f, [{ r: f }]), closed('OEP1-3', T(3), f, [{ r: f }]))).toMatch(/forks at OEP1-1/)
  })
  it('a cycle: no root at all', () => {
    const a = sealOep1Record({ ...unsealedOep1Evidence(CTX, T(1)), record_id: 'OEP1-1', predecessor: { record_id: 'OEP1-2', content_digest: 'a'.repeat(64) } })
    const b = sealOep1Record({ ...unsealedOep1Evidence(CTX, T(2)), record_id: 'OEP1-2', predecessor: { record_id: 'OEP1-1', content_digest: a.content_digest } })
    expect(reasons({ path: path('1'), doc: a }, { path: path('2'), doc: b })).toMatch(/0 roots/)
  })
  it('a verdict string its facts do not recompute to is refused (never trusted)', () => {
    expect(reasons(failed('OEP1-1', T(1), null, 'CLOSED'))).toMatch(/recorded verdict CLOSED is not what its facts recompute to \(NOT_CLOSED\)/)
  })
  it('a duplicated record_id is refused', () => {
    const a = closed('OEP1-1', T(1), null)
    expect(reasons(a, closed('OEP1-1', T(2), a, [], 'x'))).toMatch(/record_id OEP1-1 is used by more than one record/)
  })
  it('an acknowledgement with another digest is refused', () => {
    const f = failed('OEP1-1', T(1), null)
    const h = sealOep1Record({ ...closed('OEP1-2', T(2), f, [{ r: f }]).doc, acknowledges: [{ record_id: 'OEP1-1', content_digest: 'b'.repeat(64), resolution: 'r' }] })
    expect(reasons(f, { path: path('2'), doc: h })).toMatch(/acknowledges OEP1-1 with another content digest/)
  })
})

describe('R4-N-O11: a predecessor without a verdict and without facts is blocking', () => {
  const bare = (): Rec => ({ path: path('1'), doc: sealOep1Record({ record_id: 'OEP1-1', predecessor: null, observed_at_utc: T(1) }) })
  it('its facts recompute to NOT_CLOSED (nothing to recompute from is not a PASS)', () => {
    expect(recomputedLinkVerdict(bare().doc)).toBe('NOT_CLOSED')
  })
  it('unacknowledged it blocks the head; acknowledged by id and digest it is superseded', () => {
    const b = bare()
    expect(reasons(b, closed('OEP1-2', T(2), b))).toMatch(/must acknowledge exactly the earlier links that do not recompute to CLOSED \[OEP1-1\]/)
    const why = reasons(b, closed('OEP1-2', T(2), b, [{ r: b }]))
    expect(why).not.toMatch(/must acknowledge/)
    // its missing verdict string is itself reported: a link that records no verdict agrees with no recomputation
    expect(why).toMatch(/recorded verdict undefined is not what its facts recompute to/)
  })
})

describe('R4-N-CHAIN: the facts gathered from disk, with the history', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=d1', '-c', 'user.email=d1@chain.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' })
  const repo = (recs: Rec[]) => {
    const r = mkdtempSync(join(tmpdir(), 'd1-oep1-chain-'))
    roots.push(r)
    mkdirSync(join(r, 'docs', 'ops', 'release'), { recursive: true })
    git(r, 'init', '-q')
    writeFileSync(join(r, 'docs', 'ops', 'release', '.keep'), '')
    for (const x of recs) writeFileSync(join(r, x.path), JSON.stringify(x.doc))
    git(r, 'add', '.')
    git(r, 'commit', '-q', '-m', 'evidence')
    return r
  }
  it('no evidence: no head and no reason', () => {
    expect(gatherOep1EvidenceFacts(repo([]))).toMatchObject({ path: null, evidence: null, chain: [], chainReasons: [] })
  })
  it('a valid chain on disk: the head is evaluated, the chain carries recomputed verdicts', () => {
    const f = failed('OEP1-1', T(1), null, 'NOT_CLOSED', '1.0.0')
    const h = closed('OEP1-2', T(2), f, [{ r: f }], '1.0.1')
    const facts = gatherOep1EvidenceFacts(repo([f, h]))
    expect(facts.chainReasons).toEqual([])
    expect(facts.path).toBe(h.path)
    expect(facts.evidence).toMatchObject({ record_id: 'OEP1-2', content_digest: oep1RecordDigest(h.doc) })
  })
  it('an evidence file deleted in history is refused even when the remaining files look consistent', () => {
    const a = closed('OEP1-1', T(1), null, [], '1.0.0')
    const r = repo([a, closed('OEP1-2', T(2), a, [], '9.9.9')])
    unlinkSync(join(r, path('9.9.9')))
    git(r, 'commit', '-q', '-am', 'drop the head')
    expect(gatherOep1EvidenceFacts(r).chainReasons.join(' ')).toMatch(/deleted, modified or renamed in history/)
  })
  it('an evidence file modified in history is refused', () => {
    const a = closed('OEP1-1', T(1), null, [], '1.0.0')
    const r = repo([a])
    writeFileSync(join(r, a.path), JSON.stringify({ ...a.doc, note: 'edited in place' }))
    git(r, 'commit', '-q', '-am', 'edit in place')
    expect(gatherOep1EvidenceFacts(r).chainReasons.join(' ')).toMatch(/deleted, modified or renamed in history/)
  })
  it('outside a git work tree the history is unverifiable and that is a reason', () => {
    const r = mkdtempSync(join(tmpdir(), 'd1-oep1-nogit-'))
    roots.push(r)
    mkdirSync(join(r, 'docs', 'ops', 'release'), { recursive: true })
    const a = closed('OEP1-1', T(1), null, [], '1.0.0')
    writeFileSync(join(r, a.path), JSON.stringify(a.doc))
    // %TEMP% may itself be a git work tree on a workstation: a ceiling keeps git from climbing out.
    const prev = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = tmpdir()
    try {
      expect(gatherOep1EvidenceFacts(r).chainReasons.join(' ')).toMatch(/history cannot be read/)
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = prev
    }
  })
  it('R5-C: a case-only rename of a governed record (_v -> _V) is an integrity failure, not a silent removal of the FAIL', () => {
    const f = failed('OEP1-1', T(1), null, 'NOT_CLOSED', '1.0.0')
    const h = closed('OEP1-2', T(2), f, [{ r: f }], '1.0.1')
    const r = repo([f, h])
    // git tracks the exact lower-case path; only the on-disk casing of the FAIL changes.
    const lower = join(r, path('1.0.0'))
    renameSync(lower, join(r, 'docs', 'ops', 'release', 'FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_V1.0.0.json'))
    const disc = discoverOep1RecordNames(r)
    // Discovery is driven by the tracked case, so the FAIL is never dropped from the set; the divergence is reported.
    expect(disc.names).toContain('FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_v1.0.0.json')
    expect(disc.reasons.join(' ')).toMatch(/on-disk case is not its tracked case|missing from the working tree/)
    expect(gatherOep1EvidenceFacts(r).chainReasons.join(' ')).toMatch(/on-disk case is not its tracked case|missing from the working tree/)
  })
  it('R5-C: an untracked governed evidence file is refused (governed evidence must be tracked)', () => {
    const a = closed('OEP1-1', T(1), null, [], '1.0.0')
    const r = repo([a])
    writeFileSync(join(r, path('1.0.1')), JSON.stringify(closed('OEP1-2', T(2), a, [{ r: a }], '1.0.1').doc))
    const disc = discoverOep1RecordNames(r)
    expect(disc.names).toEqual(['FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_v1.0.0.json'])
    expect(disc.reasons.join(' ')).toMatch(/untracked OEP-1 evidence file is present/)
  })
  it('R5-C: a fully tracked, matching working tree raises no discovery reason', () => {
    const a = closed('OEP1-1', T(1), null, [], '1.0.0')
    expect(discoverOep1RecordNames(repo([a])).reasons).toEqual([])
  })
})
