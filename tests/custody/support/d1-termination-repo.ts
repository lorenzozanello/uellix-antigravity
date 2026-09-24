// tests/custody/support/d1-termination-repo.ts
//
// A DISPOSABLE COPY OF THIS REPOSITORY, AT THIS CANDIDATE, FOR THE
// CERTIFICATION-TERMINATION REGRESSION.
//
// The copy is a real git clone (objects shared with this repository through
// alternates, nothing copied back). If this checkout carries uncommitted
// changes — a mutation battery runs on a dirty tree — they are overlaid and
// committed in the copy, so the candidate there is exactly what is on disk
// here.
//
// The candidate is DERIVED, never assumed to be HEAD: if HEAD is the permitted
// certification-event-only successor of its parent (its whole diff is the one
// event file whose path is derived from that parent), the candidate is the
// parent; otherwise it is HEAD. So the same regression is valid on a candidate
// and on candidate + event (the state an independent certifier produces).
// A GitHub pull_request checkout is a merge commit (refs/pull/N/merge) whose
// tree equals the PR head; such a content-neutral merge is peeled to the
// parent it copies before the rule above is applied.
//
// The copy's origin is a second local bare clone whose integration branch is
// set to the frozen integration commit, so PRE-HC1's one network read
// (`ls-remote origin`) is answered locally and N01 can pass without network.
//
// Only synthetic events are ever written, and only inside the copy. Nothing
// here writes to this repository.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { derivePackageClosure } from '@/scripts/custody/d1-package-closure'
import { EVENT_CLASS, eventPathFor } from '@/scripts/custody/d1-candidate-certification'

export interface SourceCandidate {
  /** The commit whose content HEAD is (HEAD, or the parent a content-neutral merge copies). */
  readonly certifiedHead: string
  readonly candidate: string
  readonly state: 'CANDIDATE' | 'CANDIDATE_PLUS_EVENT'
  readonly peeledMerge: boolean
}

/** Derives the candidate a checkout stands for; `g` runs git in that checkout. */
export function deriveSourceCandidate(g: (...args: string[]) => string, head: string): SourceCandidate {
  const parentsOf = (c: string): string[] => g('rev-list', '--parents', '-n', '1', c).split(/\s+/).slice(1).filter(Boolean)
  let h = head
  let peeledMerge = false
  for (let i = 0; i < 4; i++) {
    const parents = parentsOf(h)
    if (parents.length < 2) break
    const tree = g('rev-parse', `${h}^{tree}`)
    const same = parents.filter((p) => g('rev-parse', `${p}^{tree}`) === tree)
    if (same.length === 0) break
    // GitHub orders the merge parents [base, head]: the last content-equal parent is the PR head.
    h = same[same.length - 1]!
    peeledMerge = true
  }
  const parents = parentsOf(h)
  const parent = parents.length === 1 ? parents[0]! : null
  const eventOnly = parent !== null && g('diff', '--name-status', '--no-renames', parent, h) === `A\t${eventPathFor(parent)}`
  return eventOnly ? { certifiedHead: h, candidate: parent!, state: 'CANDIDATE_PLUS_EVENT', peeledMerge } : { certifiedHead: h, candidate: h, state: 'CANDIDATE', peeledMerge }
}

export interface TerminationRepo {
  readonly dir: string
  readonly branch: string
  readonly candidate: string
  readonly candidateTree: string
  /** What the source checkout was: a candidate, or a candidate plus exactly its event. */
  readonly sourceState: 'CANDIDATE' | 'CANDIDATE_PLUS_EVENT'
  /** The commit whose content the source HEAD is (a content-neutral merge peeled). */
  readonly certifiedHead: string
  readonly peeledMerge: boolean
  /** The source's HEAD commit as cloned (before any overlay commit). */
  readonly sourceHead: string
  /** true when the source checkout carried uncommitted changes, overlaid as one commit. */
  readonly overlaid: boolean
  /** A directory beside the copy, for files that must not dirty it. */
  readonly scratch: string
  readonly g: (...args: string[]) => string
  /** Back to the candidate, with nothing staged or untracked. */
  readonly resetToCandidate: () => void
  readonly write: (rel: string, text: string) => void
  readonly commit: (msg: string) => string
  /** A correctly shaped, synthetic, candidate-specific certification event body. */
  readonly eventBody: (over?: Record<string, unknown>) => Record<string, unknown>
  /** Writes an event file at the path derived from `candidateCommit` (or at `path`). */
  readonly writeEvent: (body: Record<string, unknown>, path?: string) => string
  readonly dispose: () => void
}

const run = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()

export function createTerminationRepo(source: string, frozenIntegration: string): TerminationRepo {
  const base = mkdtempSync(join(tmpdir(), 'd1-termination-'))
  const dir = join(base, 'work')
  const bare = join(base, 'origin.git')
  const nodeModules = join(dir, 'node_modules')

  run(base, ['-c', 'core.autocrlf=false', 'clone', '-q', '--shared', source, dir])
  run(base, ['clone', '-q', '--bare', '--shared', source, bare])
  run(bare, ['update-ref', 'refs/heads/integration/commercial-v1', frozenIntegration])
  const g = (...args: string[]): string => run(dir, args)
  g('remote', 'set-url', 'origin', bare)
  g('config', 'user.name', 'termination-regression')
  g('config', 'user.email', 'termination-regression@invalid')
  g('config', 'core.autocrlf', 'false')

  // Overlay whatever the source checkout carries that HEAD does not.
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z', '--no-renames'], { cwd: source, encoding: 'utf8' })
    .split('\0')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3))
  for (const rel of dirty) {
    const from = join(source, rel)
    const to = join(dir, rel)
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    } else if (existsSync(to)) {
      rmSync(to)
    }
  }
  if (dirty.length > 0) {
    g('add', '-A')
    g('commit', '-q', '-m', 'candidate: source checkout with its uncommitted changes overlaid')
  }
  const branch = g('rev-parse', '--abbrev-ref', 'HEAD')
  const head = g('rev-parse', 'HEAD')
  const sourceHead = dirty.length > 0 ? g('rev-parse', 'HEAD^') : head
  const derived = deriveSourceCandidate(g, head)
  const candidate = derived.candidate
  const candidateTree = g('rev-parse', `${candidate}^{tree}`)

  // The test runner and its dependencies, without installing: a junction to the
  // source's node_modules (ignored by the copy's own /node_modules rule).
  symlinkSync(join(source, 'node_modules'), nodeModules, 'junction')

  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const commit = (msg: string): string => {
    g('add', '-A')
    g('commit', '-q', '-m', msg)
    return g('rev-parse', 'HEAD')
  }
  const eventBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    event_class: EVENT_CLASS,
    candidate_commit: candidate,
    candidate_tree: candidateTree,
    verdict: 'SYNTHETIC_DISPOSABLE_TERMINATION_REGRESSION_PASS',
    verdict_class: 'PASS',
    blocking_findings: 0,
    package_closure_digest: derivePackageClosure(dir).digest,
    certifier_is_not_the_author: true,
    fixture: 'DISPOSABLE_TERMINATION_REGRESSION__NOT_A_CERTIFICATION',
    ...over,
  })
  const writeEvent = (body: Record<string, unknown>, path?: string): string => {
    const p = path ?? eventPathFor(String(body.candidate_commit))
    write(p, `${JSON.stringify(body, null, 2)}\n`)
    return p
  }
  const resetToCandidate = (): void => {
    g('reset', '-q', '--hard', candidate)
    g('clean', '-q', '-fd')
  }
  const dispose = (): void => {
    // Remove the junction itself first, never what it points to.
    if (existsSync(nodeModules)) {
      try {
        unlinkSync(nodeModules)
      } catch {
        rmdirSync(nodeModules)
      }
    }
    rmSync(base, { recursive: true, force: true })
  }
  return {
    dir,
    branch,
    candidate,
    candidateTree,
    sourceState: derived.state,
    certifiedHead: derived.certifiedHead,
    peeledMerge: derived.peeledMerge,
    sourceHead,
    overlaid: dirty.length > 0,
    scratch: base,
    g,
    resetToCandidate,
    write,
    commit,
    eventBody,
    writeEvent,
    dispose,
  }
}
