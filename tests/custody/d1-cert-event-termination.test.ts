// @vitest-environment node
// tests/custody/d1-cert-event-termination.test.ts
//
// B-NEW-1 REGRESSION: CERTIFICATION MUST TERMINATE.
//
// The recertification of 3a5ac69d found a live-repository assertion that PMR-9
// is ALWAYS unsatisfied. At the author's candidate that is true and green; the
// moment an independent certifier adds the one event the contract asks for, it
// turns red — so a certified candidate could never be both READY and green.
//
// This test takes a disposable real-git copy of THIS candidate and plays the
// certifier's move with a SYNTHETIC event (never the real one):
//
//   A  the candidate, no event          -> PMR-9 unsatisfied, N10 NOT_READY
//   B  candidate + ONLY a correct event -> the custody suite stays GREEN,
//                                          PMR-9 satisfied, N10 READY
//   C  anything else after the event, or a wrong event -> N10 NOT_READY
//
// B is load-bearing: it is the only place where "the event is the one and only
// post-candidate materialization PMR-9 needs" is executed, not asserted.

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { eventPathFor, evaluateCandidateBinding, gatherCandidateFacts } from '@/scripts/custody/d1-candidate-certification'
import { PATHS, evaluatePreHc1 } from '@/scripts/custody/d1-pre-hc1'
import { createTerminationRepo, type TerminationRepo } from './support/d1-termination-repo'

const SOURCE = process.cwd()
const THIS_FILE = 'tests/custody/d1-cert-event-termination.test.ts'
const PMR9 = 'PMR-9_CANDIDATE_CERTIFIED'
const FROZEN_INTEGRATION =
  /= ([0-9a-f]{40})/.exec(String((JSON.parse(readFileSync(join(SOURCE, PATHS.capability), 'utf8')) as { AS_OF_INTEGRATION_REF: string }).AS_OF_INTEGRATION_REF))?.[1] ?? ''

let R: TerminationRepo

beforeAll(() => {
  R = createTerminationRepo(SOURCE, FROZEN_INTEGRATION)
}, 120_000)
afterAll(() => R?.dispose())

/** PRE-HC1 on the copy, with the base declared by the caller, and the integration read answered by the copy's local origin. */
function evaluateAt(head: string) {
  return evaluatePreHc1(R.dir, { declaredBase: { branch: R.branch, head, tree: R.g('rev-parse', `${head}^{tree}`) }, liveIntegration: true })
}

function commitEventOnCandidate(over: Record<string, unknown> = {}, path?: string): string {
  R.resetToCandidate()
  R.writeEvent(R.eventBody(over), path)
  return R.commit('synthetic certification event (disposable)')
}

describe('B-NEW-1: the certifier move terminates', () => {
  it('the copy starts from the candidate', () => {
    expect(FROZEN_INTEGRATION).toMatch(/^[0-9a-f]{40}$/)
    if (R.candidateIsSourceHead) expect(R.candidate).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim())
    expect(R.g('status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('A: at the candidate, with no event, PMR-9 is the only unsatisfied thing and N10 is NOT_READY', () => {
    R.resetToCandidate()
    expect(evaluateCandidateBinding(gatherCandidateFacts(R.dir)).eligible).toBe(false)
    const ev = evaluateAt(R.candidate)
    expect(ev.n01.tokens).toEqual([])
    expect(ev.n10).toEqual({ readiness: 'NOT_READY', unsatisfied: [PMR9] })
  }, 180_000)

  it('B: the candidate plus ONLY a correctly shaped event -> PMR-9 satisfied, N10 READY, and the custody suite stays GREEN', () => {
    const successor = commitEventOnCandidate()
    // The event is the only change: no registry, record or authority write follows the certification.
    expect(R.g('diff', '--name-status', '--no-renames', R.candidate, successor)).toBe(`A\t${eventPathFor(R.candidate)}`)

    const binding = evaluateCandidateBinding(gatherCandidateFacts(R.dir))
    expect(binding.reasons).toEqual([])
    expect(binding.eligible).toBe(true)
    const ev = evaluateAt(successor)
    expect(ev.n01.tokens).toEqual([])
    expect(ev.n10).toEqual({ readiness: 'READY_FOR_HUMAN_CONFIRMATION', unsatisfied: [] })

    // The whole custody suite of the copy (this file excepted: it would recurse), run there, at the successor.
    const files = readdirSync(join(R.dir, 'tests/custody'))
      .filter((n) => n.endsWith('.test.ts'))
      .map((n) => `tests/custody/${n}`)
      .filter((p) => p !== THIS_FILE)
    expect(files.length).toBeGreaterThan(20)
    // A longer default per-test timeout only: this run competes with the parent suite for the machine.
    const res = spawnSync(process.execPath, [join(R.dir, 'node_modules/vitest/vitest.mjs'), 'run', '--testTimeout=60000', ...files], {
      cwd: R.dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const summary = `${res.stdout}\n${res.stderr}`.split('\n').filter((l) => /Test Files|Tests {2}|FAIL|✗|×/.test(l)).slice(0, 40).join('\n')
    expect(res.status, summary).toBe(0)
    expect(summary).toMatch(/Test Files {2}\d+ passed/)
    // Running the suite left the successor as it was.
    expect(R.g('status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(R.g('rev-parse', 'HEAD')).toBe(successor)
  }, 480_000)
})

describe('C: anything but the event alone is NOT_READY', () => {
  const afterEvent: Array<[string, (r: TerminationRepo) => void]> = [
    ['event + a code edit', (r) => appendFileSync(join(r.dir, 'scripts/custody/d1-pre-hc1-post-mint.ts'), '\n// post-certification edit\n')],
    ['event + an authority edit', (r) => appendFileSync(join(r.dir, 'docs/ops/release/FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.6.json'), '\n')],
    ['event + a test edit', (r) => appendFileSync(join(r.dir, 'tests/custody/d1-package-closure.test.ts'), '\n// post-certification edit\n')],
  ]
  it.each(afterEvent)('%s (committed) -> NOT_READY by PMR-9', (_name, edit) => {
    commitEventOnCandidate()
    edit(R)
    const head = R.commit('post-certification change')
    const ev = evaluateAt(head)
    expect(ev.n10.readiness).toBe('NOT_READY')
    expect(ev.n10.unsatisfied).toContain(PMR9)
  }, 180_000)

  it('event + an uncommitted edit -> NOT_READY', () => {
    const head = commitEventOnCandidate()
    appendFileSync(join(R.dir, 'tests/custody/d1-package-closure.test.ts'), '\n// uncommitted\n')
    const binding = evaluateCandidateBinding(gatherCandidateFacts(R.dir))
    expect(binding.eligible).toBe(false)
    expect(binding.reasons).toContain('the working tree carries uncommitted changes')
    expect(evaluateAt(head).n10.readiness).toBe('NOT_READY')
  }, 180_000)

  const wrongEvents: Array<[string, (r: TerminationRepo) => { over: Record<string, unknown>; path?: string }]> = [
    ['an event for the wrong candidate (the parent)', (r) => ({ over: { candidate_commit: r.g('rev-parse', `${r.candidate}^`), candidate_tree: r.g('rev-parse', `${r.candidate}~1^{tree}`) } })],
    ['an event for the candidate at the wrong path', (r) => ({ over: {}, path: eventPathFor(r.g('rev-parse', `${r.candidate}^`)) })],
    ['an event with the wrong tree', (r) => ({ over: { candidate_tree: r.g('rev-parse', `${r.candidate}~1^{tree}`) } })],
    ['a FAIL verdict', () => ({ over: { verdict_class: 'FAIL' } })],
    ['blocking_findings > 0', () => ({ over: { blocking_findings: 1 } })],
    ['a self-certification', () => ({ over: { certifier_is_not_the_author: false } })],
    ['a digest of a different package', () => ({ over: { package_closure_digest: '0'.repeat(64) } })],
  ]
  it.each(wrongEvents)('%s -> NOT_READY, and PMR-9 is the only reason', (_name, make) => {
    const { over, path } = make(R)
    const head = commitEventOnCandidate(over, path)
    expect(evaluateCandidateBinding(gatherCandidateFacts(R.dir)).eligible).toBe(false)
    expect(evaluateAt(head).n10).toEqual({ readiness: 'NOT_READY', unsatisfied: [PMR9] })
  }, 180_000)
})
