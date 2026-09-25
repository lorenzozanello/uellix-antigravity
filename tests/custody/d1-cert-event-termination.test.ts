// @vitest-environment node
// tests/custody/d1-cert-event-termination.test.ts
//
// CERTIFICATION MUST TERMINATE — AND THIS TEST MUST SURVIVE IT TOO.
//
// A candidate is certified by adding ONE file (the candidate-specific event).
// Whatever the suite asserts about the live repository must therefore hold on
// the candidate AND on candidate + event. This test plays the certifier's move
// on a disposable real-git copy, with a SYNTHETIC event (never the real one):
//
//   A  the candidate, no event          -> PMR-9 unsatisfied, N10 NOT_READY
//   B  candidate + ONLY a correct event -> PMR-9 satisfied, N10 READY unless an
//                                          evidence-gated conjunct is open (see
//                                          OPEN_BY_DESIGN), and the COMPLETE
//                                          custody suite, THIS FILE INCLUDED, is
//                                          green at the successor
//   C  anything else after the event, a wrong event, or a schedule written
//      after certification            -> N10 NOT_READY
//
// The candidate is derived (support/d1-termination-repo.ts), so the file holds
// in both states. Recursion is bounded by an explicit marker: the nested run
// executes this file too, with UELLIX_D1_TERMINATION_NESTED=1, and in that
// mode it does everything except launch a further nested run. The marker is
// honoured only inside a termination copy, so it cannot switch the check off
// in the real repository or in CI.
//
// Suite success is read from the process exit code and a JSON reporter file,
// never from console text (CI #429 failed on ANSI-coloured output).

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { eventPathFor, evaluateCandidateBinding, gatherCandidateFacts } from '@/scripts/custody/d1-candidate-certification'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'
import { OEP1_EVIDENCE_PATTERN } from '@/scripts/custody/d1-mint-operator-evidence'
import { PATHS, evaluatePreHc1 } from '@/scripts/custody/d1-pre-hc1'
import { createTerminationRepo, type TerminationRepo } from './support/d1-termination-repo'
import { writeValidScheduleChange } from './support/d1-schedule-fixture'

const SOURCE = process.cwd()
const THIS_FILE = 'tests/custody/d1-cert-event-termination.test.ts'
const NESTED_MARKER = 'UELLIX_D1_TERMINATION_NESTED'
const NESTED = process.env[NESTED_MARKER] === '1'
const PMR9 = 'PMR-9_CANDIDATE_CERTIFIED'
const PMR14 = 'PMR-14_OEP1_PLAINTEXT_ELIMINATION_CLOSED'
/**
 * DAG v1.0.7/v1.0.8: a certified candidate may still be NOT_READY for ONE designed reason, derived here
 * WITHOUT the evaluator: the operator channel is certified BEFORE its OEP-1 probe runs (owner
 * decision OEP1_PROBE = C), so while no OEP-1 evidence file exists PMR-14 (which superseded PMR-13
 * in v1.0.8) is open by design.
 * Once the evidence exists this set is empty and B demands READY exactly as before.
 */
const OPEN_BY_DESIGN = (dir: string): string[] =>
  existsSync(join(dir, 'docs/ops/release')) && readdirSync(join(dir, 'docs/ops/release')).some((n) => OEP1_EVIDENCE_PATTERN.test(n)) ? [] : [PMR14]
const sorted = (x: readonly string[]) => [...x].sort()
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

interface JsonReport {
  success: boolean
  numTotalTests: number
  numFailedTests: number
  numFailedTestSuites: number
  testResults: Array<{ name: string; status: string; assertionResults: Array<{ status: string; fullName: string }> }>
}

/** The COMPLETE custody suite of the copy, at its HEAD, read from exit code + JSON reporter. */
function runNestedCustodySuite(): { status: number | null; report: JsonReport | null; files: string[] } {
  const files = readdirSync(join(R.dir, 'tests/custody'))
    .filter((n) => n.endsWith('.test.ts'))
    .map((n) => `tests/custody/${n}`)
  const out = join(R.scratch, 'nested-report.json')
  const res = spawnSync(
    process.execPath,
    // A longer default per-test timeout only: this run competes with the parent suite for the machine.
    [join(R.dir, 'node_modules/vitest/vitest.mjs'), 'run', '--testTimeout=60000', '--reporter=json', `--outputFile=${out}`, ...files],
    {
      cwd: R.dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // No colour, whatever the parent's terminal or CI sets; nothing below reads console text anyway.
      env: { ...process.env, [NESTED_MARKER]: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    }
  )
  let report: JsonReport | null = null
  try {
    report = JSON.parse(readFileSync(out, 'utf8')) as JsonReport
  } catch {
    report = null
  }
  return { status: res.status, report, files }
}

describe('the certifier move terminates', () => {
  it('the copy starts from the derived candidate', () => {
    expect(FROZEN_INTEGRATION).toMatch(/^[0-9a-f]{40}$/)
    if (NESTED) expect(SOURCE, 'the nested marker is honoured only inside a termination copy').toMatch(/d1-termination-/)
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE, encoding: 'utf8' }).trim()
    expect(R.sourceHead).toBe(sourceHead)
    if (R.peeledMerge) expect(R.g('rev-parse', `${R.certifiedHead}^{tree}`)).toBe(R.g('rev-parse', `${sourceHead}^{tree}`))
    if (R.sourceState === 'CANDIDATE_PLUS_EVENT') {
      // Certified source: the candidate is the parent, and the certified head adds exactly its event.
      expect(R.candidate).toBe(R.g('rev-parse', `${R.certifiedHead}^`))
      expect(R.g('diff', '--name-status', '--no-renames', R.candidate, R.certifiedHead)).toBe(`A\t${eventPathFor(R.candidate)}`)
    } else if (!R.overlaid) {
      expect(R.candidate).toBe(R.certifiedHead)
    }
    expect(R.g('status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('A: at the candidate, with no event, PMR-9 (plus only what is open by design) is unsatisfied and N10 is NOT_READY', () => {
    R.resetToCandidate()
    expect(evaluateCandidateBinding(gatherCandidateFacts(R.dir)).eligible).toBe(false)
    // The schedule that will be executed is already in the candidate.
    const schedule = deriveEffectiveSchedule(R.dir)
    expect(schedule.errors).toEqual([])
    const ev = evaluateAt(R.candidate)
    expect(ev.n01.tokens).toEqual([])
    expect(ev.n10.readiness).toBe('NOT_READY')
    expect(sorted(ev.n10.unsatisfied)).toEqual(sorted([PMR9, ...OPEN_BY_DESIGN(R.dir)]))
  }, 180_000)

  it('B: schedule -> candidate -> ONLY a correct event: PMR-9 satisfied, N10 READY unless open by design, and the COMPLETE custody suite (this file included) green', () => {
    R.resetToCandidate()
    const scheduleAtCandidate = deriveEffectiveSchedule(R.dir)
    const successor = commitEventOnCandidate()
    // The event is the only change: no registry, record, schedule or authority write follows the certification.
    expect(R.g('diff', '--name-status', '--no-renames', R.candidate, successor)).toBe(`A\t${eventPathFor(R.candidate)}`)
    expect(deriveEffectiveSchedule(R.dir)).toEqual(scheduleAtCandidate)

    const binding = evaluateCandidateBinding(gatherCandidateFacts(R.dir))
    expect(binding.reasons).toEqual([])
    expect(binding.eligible).toBe(true)
    const ev = evaluateAt(successor)
    expect(ev.n01.tokens).toEqual([])
    const open = OPEN_BY_DESIGN(R.dir)
    expect(ev.n10).toEqual(open.length === 0 ? { readiness: 'READY_FOR_HUMAN_CONFIRMATION', unsatisfied: [] } : { readiness: 'NOT_READY', unsatisfied: open })

    if (NESTED) return // depth bound: the nested run is this very assertion, one level up

    const { status, report, files } = runNestedCustodySuite()
    expect(files).toContain(THIS_FILE)
    expect(files.length).toBeGreaterThan(20)
    expect(report, 'the nested run wrote no JSON report').not.toBeNull()
    const failed = report!.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => `${t.name}: ${a.fullName}`))
    expect(failed).toEqual([])
    expect(status).toBe(0)
    expect(report!.success).toBe(true)
    expect(report!.numFailedTests).toBe(0)
    expect(report!.numTotalTests).toBeGreaterThan(500)
    // Every file ran and passed — this one included, in nested mode.
    const byFile = new Map(report!.testResults.map((t) => [t.name.replace(/\\/g, '/').replace(/^.*\/tests\/custody\//, 'tests/custody/'), t]))
    expect([...byFile.keys()].sort()).toEqual([...files].sort())
    for (const [f, t] of byFile) expect(t.status, f).toBe('passed')
    expect(byFile.get(THIS_FILE)!.assertionResults.filter((a) => a.status === 'passed').length).toBeGreaterThan(10)
    // Running the suite left the successor as it was.
    expect(R.g('status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(R.g('rev-parse', 'HEAD')).toBe(successor)
  }, 900_000)
})

describe('C: anything but the event alone is NOT_READY', () => {
  const later = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().replace('.000Z', 'Z')
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

  it('candidate -> event -> a VALID schedule change: the certification no longer binds (NOT_READY by PMR-9, plus only what is open by design)', () => {
    commitEventOnCandidate()
    const s = deriveEffectiveSchedule(R.dir)
    writeValidScheduleChange(R.dir, '9.9.9', later(s.N08!, 1), later(s.N31!, 1))
    const head = R.commit('schedule written after certification')
    const moved = deriveEffectiveSchedule(R.dir)
    expect(moved.errors).toEqual([])
    expect(moved.N08).not.toBe(s.N08)
    // The schedule itself re-derives (N06/N09 hold); only the certification is lost.
    const n10 = evaluateAt(head).n10
    expect(n10.readiness).toBe('NOT_READY')
    expect(sorted(n10.unsatisfied)).toEqual(sorted([PMR9, ...OPEN_BY_DESIGN(R.dir)]))
  }, 180_000)

  it('event + an uncommitted edit -> NOT_READY', () => {
    const head = commitEventOnCandidate()
    appendFileSync(join(R.dir, 'tests/custody/d1-package-closure.test.ts'), '\n// uncommitted\n')
    const binding = evaluateCandidateBinding(gatherCandidateFacts(R.dir))
    expect(binding.eligible).toBe(false)
    expect(binding.reasons).toContain('the working tree carries uncommitted changes')
    expect(evaluateAt(head).n10.readiness).toBe('NOT_READY')
  }, 180_000)

  /** A commit with the candidate's own tree and parent that is NOT the candidate: a genuinely wrong candidate. */
  const sibling = (r: TerminationRepo) => r.g('commit-tree', r.candidateTree, '-p', `${r.candidate}^`, '-m', 'sibling of the candidate (disposable)')
  const parentOf = (r: TerminationRepo) => {
    const p = r.g('rev-parse', `${r.candidate}^`)
    if (p === r.candidate) throw new Error('parent equals candidate')
    return p
  }
  const wrongEvents: Array<[string, (r: TerminationRepo) => { over: Record<string, unknown>; path?: string }]> = [
    ['an event for a sibling of the candidate (same tree, not the candidate)', (r) => ({ over: { candidate_commit: sibling(r) } })],
    ['an event for the parent of the candidate', (r) => ({ over: { candidate_commit: parentOf(r), candidate_tree: r.g('rev-parse', `${parentOf(r)}^{tree}`) } })],
    ['an event for the candidate at the wrong path', (r) => ({ over: {}, path: eventPathFor(parentOf(r)) })],
    ['an event with the wrong tree', (r) => ({ over: { candidate_tree: r.g('rev-parse', `${parentOf(r)}^{tree}`) } })],
    ['a FAIL verdict', () => ({ over: { verdict_class: 'FAIL' } })],
    ['blocking_findings > 0', () => ({ over: { blocking_findings: 1 } })],
    ['a self-certification', () => ({ over: { certifier_is_not_the_author: false } })],
    ['a digest of a different package', () => ({ over: { package_closure_digest: '0'.repeat(64) } })],
  ]
  it.each(wrongEvents)('%s -> NOT_READY, and PMR-9 is the only reason beyond what is open by design', (_name, make) => {
    R.resetToCandidate()
    const { over, path } = make(R)
    expect(over.candidate_commit ?? R.candidate).toMatch(/^[0-9a-f]{40}$/)
    if (over.candidate_commit !== undefined) expect(over.candidate_commit).not.toBe(R.candidate)
    const head = commitEventOnCandidate(over, path)
    expect(evaluateCandidateBinding(gatherCandidateFacts(R.dir)).eligible).toBe(false)
    const n10 = evaluateAt(head).n10
    expect(n10.readiness).toBe('NOT_READY')
    expect(sorted(n10.unsatisfied)).toEqual(sorted([PMR9, ...OPEN_BY_DESIGN(R.dir)]))
  }, 180_000)
})
