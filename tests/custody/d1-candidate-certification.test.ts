// @vitest-environment node
// tests/custody/d1-candidate-certification.test.ts
//
// B-2 REGRESSION, ON REAL GIT REPOSITORIES.
//
// The recertification's survivor: change an execution-relevant consumer file,
// rewrite the author's own closure_blobs, and PRE-HC1 said READY. Here a small
// repository is built in a temporary directory (outside this one), and the
// predicate is asked, with real commits and real trees, whether HEAD is the
// candidate an independent event certified. Each scenario is one git state.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { closureDigest } from '@/scripts/custody/d1-package-closure'
import { eventPathFor, evaluateCandidateBinding, gatherCandidateFacts } from '@/scripts/custody/d1-candidate-certification'

// Every case spawns a dozen git processes; under a parallel run (the
// termination regression runs a nested suite) 5s is not enough. Time only —
// no assertion changes.
vi.setConfig({ testTimeout: 60_000 })

const CONSUMER = 'scripts/custody/d1-consumer-shell.ts'
const RECORD = 'docs/ops/release/FIBDB053_D1_AUDITOR_X_EXECUTION_RECORD_v1.0.0.json'

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'd1-candidate-'))
  const g = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  g('init', '-q')
  g('config', 'user.name', 'harness')
  g('config', 'user.email', 'harness@invalid')
  g('config', 'core.autocrlf', 'false')
  const write = (p: string, s: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), s)
  }
  const commit = (msg: string): string => {
    g('add', '-A')
    g('commit', '-q', '-m', msg)
    return g('rev-parse', 'HEAD')
  }
  /** The package digest for this tiny repository: every tracked file except certification events. */
  const digest = (r: string): string => {
    const files = execFileSync('git', ['ls-files'], { cwd: r, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '' && !/PREHC1_PACKAGE_CERTIFICATION_/.test(f))
    const blobs = Object.fromEntries(files.map((f) => [f, execFileSync('git', ['hash-object', '--', f], { cwd: r, encoding: 'utf8' }).trim()]))
    return closureDigest(blobs)
  }
  const event = (cand: string, over: Record<string, unknown> = {}, path = eventPathFor(cand)) => {
    write(
      path,
      JSON.stringify({
        event_class: 'D1_PREHC1_PACKAGE_INDEPENDENT_CERTIFICATION',
        candidate_commit: cand,
        candidate_tree: 'candidate_tree' in over ? over.candidate_tree : g('rev-parse', `${cand}^{tree}`),
        verdict: 'D1_PREHC1_PACKAGE_RECERT_PASS',
        verdict_class: 'PASS',
        blocking_findings: 0,
        package_closure_digest: digest(root),
        certifier_is_not_the_author: true,
        ...over,
      })
    )
    return path
  }
  const verdict = () => evaluateCandidateBinding(gatherCandidateFacts(root, digest))
  return { root, g, write, commit, event, verdict, digest }
}

function certified() {
  const r = repo()
  r.write(CONSUMER, 'export const shell = 1\n')
  r.write(RECORD, JSON.stringify({ closure_blobs: { [CONSUMER]: 'aaaa' } }))
  const cand = r.commit('candidate')
  return { ...r, cand }
}

describe('a certified candidate', () => {
  it('HEAD == candidate, with its event not yet committed, is NOT eligible (the working tree is dirty)', () => {
    const r = certified()
    r.event(r.cand)
    expect(r.verdict().eligible).toBe(false)
  })
  it('candidate + exactly its event -> eligible', () => {
    const r = certified()
    r.event(r.cand)
    r.commit('event')
    const v = r.verdict()
    expect(v).toMatchObject({ eligible: true, certifiedBy: eventPathFor(r.cand) })
  })
})

describe('B-2 REGRESSION: the recertification survivor', () => {
  it('consumer code changed + closure_blobs rewritten, in the same commit -> NOT_READY until a NEW event certifies the new candidate', () => {
    const r = certified()
    r.event(r.cand)
    r.commit('event')
    r.write(CONSUMER, 'export const shell = 2 // behaviour changed\n')
    r.write(RECORD, JSON.stringify({ closure_blobs: { [CONSUMER]: 'bbbb (rewritten by the author)' } }))
    const next = r.commit('change consumer and rewrite the record')
    const v = r.verdict()
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/differs from the certified candidate by more than the event/)
    // Only an independent event for the NEW candidate restores eligibility.
    r.event(next)
    r.commit('event for the new candidate')
    expect(r.verdict().eligible).toBe(true)
  })
})

describe('negative controls', () => {
  it('candidate + event + a later code edit -> NOT_READY', () => {
    const r = certified()
    r.event(r.cand)
    r.commit('event')
    r.write('scripts/custody/other.ts', 'export {}\n')
    r.commit('uncertified edit')
    expect(r.verdict().eligible).toBe(false)
  })
  it('an uncommitted edit after certification -> NOT_READY', () => {
    const r = certified()
    r.event(r.cand)
    r.commit('event')
    r.write(CONSUMER, 'export const shell = 3\n')
    expect(r.verdict().eligible).toBe(false)
  })
  it('an event at a path not derived from its candidate -> NOT_READY', () => {
    const r = certified()
    r.event(r.cand, {}, 'docs/ops/release/FIBDB053_D1_AUDITOR_PREHC1_PACKAGE_CERTIFICATION_000000000000_v1.0.0.json')
    r.commit('misplaced event')
    expect(r.verdict().eligible).toBe(false)
  })
  it('an event that certifies the PARENT of HEAD\'s candidate -> NOT_READY', () => {
    const r = certified()
    r.write(CONSUMER, 'export const shell = 4\n')
    r.commit('child')
    r.event(r.cand)
    r.commit('event for the parent')
    expect(r.verdict().eligible).toBe(false)
  })
  it('a tree that does not match the candidate -> NOT_READY', () => {
    const r = certified()
    r.event(r.cand, { candidate_tree: 'f'.repeat(40) })
    r.commit('event')
    expect(r.verdict().reasons.join(' ')).toMatch(/candidate_tree does not match/)
  })
  it('a candidate that does not exist -> NOT_READY', () => {
    const r = certified()
    const ghost = 'e'.repeat(40)
    r.event(ghost, { candidate_tree: 'f'.repeat(40) })
    r.commit('event for nothing')
    expect(r.verdict().eligible).toBe(false)
  })
  it.each([
    [{ blocking_findings: 1 }, /blocking_findings is 1/],
    [{ verdict_class: 'FAIL' }, /not a terminal PASS class/],
    [{ event_class: 'SOMETHING_ELSE' }, /wrong event_class/],
    [{ certifier_is_not_the_author: false }, /certifier_is_not_the_author/],
    [{ package_closure_digest: '0'.repeat(64) }, /package_closure_digest differs/],
  ] as const)('event %j -> NOT_READY', (over, why) => {
    const r = certified()
    r.event(r.cand, over)
    r.commit('event')
    const v = r.verdict()
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(why)
  })
  it('two events that disagree about one candidate -> NOT_READY', () => {
    const r = certified()
    r.event(r.cand)
    r.commit('pass event')
    const f = gatherCandidateFacts(r.root, r.digest)
    const contradicting = { path: 'docs/ops/release/x.json', body: { ...f.events[0]!.body, verdict_class: 'FAIL' } }
    expect(evaluateCandidateBinding({ ...f, events: [...f.events, contradicting] }).reasons.join(' ')).toMatch(/disagree/)
  })
  it('no event at all -> NOT_READY', () => {
    const r = certified()
    expect(r.verdict().reasons).toContain('no certification event exists for any candidate')
  })
})
