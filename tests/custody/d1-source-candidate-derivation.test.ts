// @vitest-environment node
// tests/custody/d1-source-candidate-derivation.test.ts
//
// WHICH CANDIDATE DOES A CHECKOUT STAND FOR? Every shape the termination
// regression meets, in a tiny real repository: the author's branch, the
// certifier's successor, and the merge commit GitHub checks out for a
// pull_request run (refs/pull/N/merge: parents [base, head], tree = head).

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { eventPathFor } from '@/scripts/custody/d1-candidate-certification'
import { deriveSourceCandidate } from './support/d1-termination-repo'

vi.setConfig({ testTimeout: 60_000 })

const root = mkdtempSync(join(tmpdir(), 'd1-derive-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const g = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const write = (p: string, s: string) => {
  mkdirSync(dirname(join(root, p)), { recursive: true })
  writeFileSync(join(root, p), s)
}
const commit = (msg: string) => {
  g('add', '-A')
  g('commit', '-q', '-m', msg)
  return g('rev-parse', 'HEAD')
}
/** GitHub's test merge: a commit with head's tree and parents [base, head]. */
const githubMerge = (base: string, head: string) => g('commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'Merge into base (GitHub test merge)')

g('init', '-q')
g('config', 'user.name', 'derive')
g('config', 'user.email', 'derive@invalid')
g('config', 'core.autocrlf', 'false')
write('a.txt', 'base\n')
const BASE = commit('base')
write('a.txt', 'candidate\n')
const CAND = commit('candidate')
write(eventPathFor(CAND), '{}\n')
const SUCC = commit('event')

describe('deriveSourceCandidate', () => {
  it('the author branch: HEAD is the candidate', () => {
    expect(deriveSourceCandidate(g, CAND)).toEqual({ certifiedHead: CAND, candidate: CAND, state: 'CANDIDATE', peeledMerge: false })
  })
  it('the certifier successor: the candidate is the parent', () => {
    expect(deriveSourceCandidate(g, SUCC)).toEqual({ certifiedHead: SUCC, candidate: CAND, state: 'CANDIDATE_PLUS_EVENT', peeledMerge: false })
  })
  it('GitHub pull_request checkout of the candidate: the merge is peeled to the PR head', () => {
    expect(deriveSourceCandidate(g, githubMerge(BASE, CAND))).toEqual({ certifiedHead: CAND, candidate: CAND, state: 'CANDIDATE', peeledMerge: true })
  })
  it('GitHub pull_request checkout of candidate + event: peeled, then the event rule applies', () => {
    expect(deriveSourceCandidate(g, githubMerge(BASE, SUCC))).toEqual({ certifiedHead: SUCC, candidate: CAND, state: 'CANDIDATE_PLUS_EVENT', peeledMerge: true })
  })
  it('a merge that changes content is NOT peeled (it is its own candidate)', () => {
    g('checkout', '-q', BASE)
    write('b.txt', 'a tree neither parent has\n')
    const y = commit('other content')
    const m = g('commit-tree', `${y}^{tree}`, '-p', BASE, '-p', SUCC, '-m', 'content-changing merge')
    expect(deriveSourceCandidate(g, m)).toEqual({ certifiedHead: m, candidate: m, state: 'CANDIDATE', peeledMerge: false })
  })
  it('candidate + event + another change: not an event-only successor, so HEAD is a new candidate', () => {
    g('checkout', '-q', SUCC)
    write('a.txt', 'edited after the event\n')
    const edited = commit('edit')
    expect(deriveSourceCandidate(g, edited)).toMatchObject({ candidate: edited, state: 'CANDIDATE' })
  })
  it('an event file for ANOTHER commit is not the event-only successor of its parent', () => {
    g('checkout', '-q', CAND)
    write(eventPathFor(BASE), '{}\n')
    const wrong = commit('event for the wrong candidate')
    expect(deriveSourceCandidate(g, wrong)).toMatchObject({ candidate: wrong, state: 'CANDIDATE' })
  })
})
