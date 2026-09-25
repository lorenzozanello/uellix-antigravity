// scripts/custody/d1-candidate-certification.ts
//
// B-2: IS HEAD THE CANDIDATE AN INDEPENDENT CERTIFIER CERTIFIED?
//
// The recertification demonstrated a survivor: change a consumer, rewrite the
// closure blobs in the author's own record, and PRE-HC1 said READY with the
// suite green. The defect was WHO wrote the reference being compared against.
// Here the reference is git object identity, which no author controls after
// the fact:
//
//   - a certification EVENT names a candidate commit and its tree (DAG v1.0.6
//     CERTIFICATION_EVENT_CONTRACT), at a path derived from that commit;
//   - HEAD must BE that commit, or a descendant whose only change is the
//     addition of that event file (the event cannot be inside the commit it
//     certifies, so it necessarily lands after it);
//   - the working tree must carry no change, and the derived package digest
//     must equal the digest the certifier recorded.
//
// Any other change after certification — code, authority, record, test,
// config — makes HEAD a new candidate that needs its own event. Nothing an
// author writes inside the candidate can stand in for the certifier's event.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CERTIFICATION_EVENT_PATTERN, derivePackageClosure } from './d1-package-closure'

export const EVENT_DIR = 'docs/ops/release'
export const EVENT_CLASS = 'D1_PREHC1_PACKAGE_INDEPENDENT_CERTIFICATION'
export const TERMINAL_PASS_CLASSES: readonly string[] = ['PASS', 'PASS_WITH_NONBLOCKING_FINDINGS']

export function eventPathFor(candidateCommit: string): string {
  return `${EVENT_DIR}/FIBDB053_D1_AUDITOR_PREHC1_PACKAGE_CERTIFICATION_${candidateCommit.slice(0, 12)}_v1.0.0.json`
}

export interface CertificationEvent {
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}

/** Everything the predicate needs, gathered once so every negative control can change one field. */
export interface CandidateFacts {
  readonly headCommit: string
  readonly headTree: string
  readonly workingTreeClean: boolean
  readonly currentDigest: string
  readonly events: readonly CertificationEvent[]
  /** Per candidate commit named by an event: what git says about it. */
  readonly git: Readonly<
    Record<
      string,
      {
        readonly exists: boolean
        readonly tree: string | null
        readonly isAncestorOfHead: boolean
        /** `git diff --name-status <candidate> HEAD`, as [status, path] pairs. */
        readonly deltaToHead: readonly (readonly [string, string])[]
      }
    >
  >
}

export interface CandidateVerdict {
  readonly eligible: boolean
  readonly certifiedBy: string | null
  readonly reasons: readonly string[]
}

const HEX40 = /^[0-9a-f]{40}$/

/** Pure. Reasons are per event; eligibility needs ONE event to pass every check and no event to contradict it. */
export function evaluateCandidateBinding(f: CandidateFacts): CandidateVerdict {
  const reasons: string[] = []
  if (!f.workingTreeClean) reasons.push('the working tree carries uncommitted changes')
  if (f.events.length === 0) reasons.push('no certification event exists for any candidate')

  const passing: string[] = []
  const verdictsByCandidate = new Map<string, Set<string>>()
  for (const e of f.events) {
    const b = e.body
    const tag = e.path
    const cand = typeof b.candidate_commit === 'string' ? b.candidate_commit : ''
    const cls = typeof b.verdict_class === 'string' ? b.verdict_class : ''
    if (HEX40.test(cand)) {
      const s = verdictsByCandidate.get(cand) ?? new Set<string>()
      s.add(TERMINAL_PASS_CLASSES.includes(cls) && b.blocking_findings === 0 ? 'PASS' : 'NOT_PASS')
      verdictsByCandidate.set(cand, s)
    }
    const r: string[] = []
    if (b.event_class !== EVENT_CLASS) r.push('wrong event_class')
    if (!HEX40.test(cand)) r.push('candidate_commit is not 40 hex')
    else if (e.path !== eventPathFor(cand)) r.push('the event path is not the one derived from its candidate_commit')
    if (typeof b.candidate_tree !== 'string' || !HEX40.test(b.candidate_tree)) r.push('candidate_tree is not 40 hex')
    if (!TERMINAL_PASS_CLASSES.includes(cls)) r.push(`verdict_class ${cls || '(none)'} is not a terminal PASS class`)
    if (b.blocking_findings !== 0) r.push(`blocking_findings is ${String(b.blocking_findings)}, not 0`)
    if (b.certifier_is_not_the_author !== true) r.push('certifier_is_not_the_author is not true')
    const g = f.git[cand]
    if (g === undefined || !g.exists) r.push('the candidate commit does not exist in this repository')
    else {
      if (g.tree !== b.candidate_tree) r.push('candidate_tree does not match the tree of candidate_commit')
      const headIsCandidate = f.headCommit === cand
      const onlyEventAdded = g.isAncestorOfHead && g.deltaToHead.length === 1 && g.deltaToHead[0]![0] === 'A' && g.deltaToHead[0]![1] === e.path
      if (!headIsCandidate && !onlyEventAdded) {
        r.push(
          g.isAncestorOfHead
            ? `HEAD differs from the certified candidate by more than the event: ${g.deltaToHead.map(([s, p]) => `${s} ${p}`).join(', ') || '(nothing?)'}`
            : 'HEAD is not the certified candidate and does not descend from it'
        )
      }
    }
    if (b.package_closure_digest !== f.currentDigest) r.push('package_closure_digest differs from the digest of the package now')
    if (r.length === 0) passing.push(e.path)
    else reasons.push(...r.map((x) => `${tag}: ${x}`))
  }
  for (const [cand, verdicts] of verdictsByCandidate) {
    if (verdicts.size > 1) reasons.push(`two certification events disagree about candidate ${cand.slice(0, 12)}`)
  }
  const contradicted = [...verdictsByCandidate.values()].some((v) => v.size > 1)
  const eligible = f.workingTreeClean && passing.length > 0 && !contradicted
  return { eligible, certifiedBy: eligible ? passing[0]! : null, reasons: eligible ? [] : reasons }
}

const git = (root: string, args: readonly string[]): string => execFileSync('git', [...args], { cwd: root, encoding: 'utf8' }).trim()
const gitOk = (root: string, args: readonly string[]): boolean => {
  try {
    execFileSync('git', [...args], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Every event file in the event directory (by the contract's name pattern), parsed. */
export function readEvents(root: string): CertificationEvent[] {
  const dir = join(root, EVENT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((n) => `${EVENT_DIR}/${n}`)
    .filter((p) => CERTIFICATION_EVENT_PATTERN.test(p))
    .map((p) => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, unknown>
      } catch {
        body = { unparseable: true }
      }
      return { path: p, body }
    })
}

export function gatherCandidateFacts(root: string, digestOf: (root: string) => string = (r) => derivePackageClosure(r).digest): CandidateFacts {
  const headCommit = git(root, ['rev-parse', 'HEAD'])
  const headTree = git(root, ['rev-parse', 'HEAD^{tree}'])
  const workingTreeClean = git(root, ['status', '--porcelain', '--untracked-files=all']) === ''
  const events = readEvents(root)
  const facts: Record<string, CandidateFacts['git'][string]> = {}
  for (const e of events) {
    const cand = typeof e.body.candidate_commit === 'string' ? e.body.candidate_commit : ''
    if (!HEX40.test(cand) || facts[cand] !== undefined) continue
    const exists = gitOk(root, ['cat-file', '-e', `${cand}^{commit}`])
    facts[cand] = {
      exists,
      tree: exists ? git(root, ['rev-parse', `${cand}^{tree}`]) : null,
      isAncestorOfHead: exists && gitOk(root, ['merge-base', '--is-ancestor', cand, 'HEAD']),
      deltaToHead: exists
        ? git(root, ['diff', '--name-status', '--no-renames', cand, 'HEAD'])
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => {
              const [status, ...rest] = l.split('\t')
              return [status!.trim(), rest.join('\t').trim()] as const
            })
        : [],
    }
  }
  return { headCommit, headTree, workingTreeClean, currentDigest: digestOf(root), events, git: facts }
}
