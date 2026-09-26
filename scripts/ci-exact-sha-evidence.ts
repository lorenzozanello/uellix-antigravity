// scripts/ci-exact-sha-evidence.ts — FIS-01a exact-SHA CI binding evidence.
//
// Two responsibilities, both pure-function-first so
// tests/ci-exact-sha-binding.test.ts can exercise them without a live GitHub
// Actions run:
//
//   1. resolveExpectedSha — the CLOSED event-SHA resolver. Mirrors, as the
//      single canonical statement of the semantics, the bash case statement
//      in .github/workflows/ci.yml's "Resolve exact event SHA" step, which
//      must run BEFORE checkout (so it cannot itself be a tsx script — the
//      repository is not yet on disk at that point). The bash step and this
//      function are two renderings of the same closed rule set; the bash
//      step is asserted against by regex in the test file, and this function
//      is exercised directly.
//
//   2. buildEvidence (+ its helpers) — runs AFTER checkout, as the final
//      step of the job, and binds EVIDENCE_SHA/TREE/EVENT/REF/etc. into the
//      uploaded artifact. This part DOES run via tsx in CI, so it is
//      exercised both directly (unit tests with a fake git) and indirectly
//      (the script actually running in CI against the real repository).
//
// No OR-style fallback between two different events' SHA sources exists
// anywhere in this file's resolution logic: every event branches explicitly
// and every non-matching case throws.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export type EventName = 'pull_request' | 'push' | 'workflow_dispatch' | string

export interface ResolveInput {
  eventName: EventName
  /** github.ref, e.g. "refs/heads/main". Only consulted for push events. */
  ref: string
  /** github.event.pull_request.head.sha — empty/undefined if absent. */
  prHeadSha: string | undefined
  /** github.sha — the commit the workflow run itself was attached to. */
  githubSha: string | undefined
}

export interface ResolveResult {
  sha: string
  source: string
}

/** push events are only trusted on these exact refs. HPO-G-04 / OD-2. */
export const APPROVED_PUSH_REFS = ['refs/heads/main', 'refs/heads/integration/commercial-v1']

/**
 * The closed resolver (NC1..NC8, NC14). Every event name branches
 * explicitly; anything else throws. No OR-style fallback between sources
 * ever appears — each branch names exactly one source and validates it
 * before use.
 */
export function resolveExpectedSha(input: ResolveInput): ResolveResult {
  const { eventName, ref, prHeadSha, githubSha } = input

  if (eventName === 'pull_request') {
    if (!prHeadSha) {
      throw new Error('pull_request event missing github.event.pull_request.head.sha')
    }
    return { sha: prHeadSha, source: 'pull_request.head.sha' }
  }

  if (eventName === 'push') {
    if (!APPROVED_PUSH_REFS.includes(ref)) {
      throw new Error(`push event on unapproved ref "${ref}" (approved: ${APPROVED_PUSH_REFS.join(', ')})`)
    }
    if (!githubSha) {
      throw new Error('push event missing github.sha')
    }
    return { sha: githubSha, source: `github.sha (push:${ref})` }
  }

  if (eventName === 'workflow_dispatch') {
    if (!githubSha) {
      throw new Error('workflow_dispatch event missing github.sha')
    }
    return { sha: githubSha, source: 'github.sha (workflow_dispatch)' }
  }

  throw new Error(`unsupported event "${eventName}" — no resolver branch authorizes it`)
}

/** Runs a git subcommand, throwing on any non-zero exit (no swallowed errors). */
export type GitRunner = (args: string[]) => string

export function realGitRunner(cwd: string): GitRunner {
  return (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/**
 * TREE is derived from EVIDENCE_SHA directly (`<sha>^{tree}`), never from a
 * free-floating `HEAD^{tree}` computed as a separate call — the two could
 * diverge if HEAD moved between calls. Binding the revision into the same
 * command as the tree suffix makes that divergence structurally impossible.
 */
export function deriveTree(git: GitRunner, evidenceSha: string): string {
  return git(['rev-parse', `${evidenceSha}^{tree}`]).trim()
}

/** Throws if the working tree at HEAD is dirty. NC (implicit): a dirty tree at evidence time means the tree tested is not fully what HEAD records. */
export function assertCleanTree(git: GitRunner): void {
  // `git diff --quiet` exits non-zero on any difference; execFileSync throws
  // in that case, which is exactly the fail-closed behavior wanted here.
  git(['diff', '--quiet', 'HEAD', '--'])
}

export interface MergeRefCheck {
  /** "not_applicable" (non-pull_request events), "absent" (no merge ref reported), or "not_tested" (present and provably distinct from EVIDENCE_SHA). */
  status: 'not_applicable' | 'absent' | 'not_tested'
  mergeRefSha: string | null
}

/**
 * NC14: if the resolved/tested HEAD equals the synthetic merge-ref SHA,
 * that is exactly the failure this defense exists to catch — the workflow
 * would be silently testing the wrong tree. Throws in that case.
 */
export function checkMergeRefNotTested(eventName: EventName, evidenceSha: string, mergeRefSha: string | undefined): MergeRefCheck {
  if (eventName !== 'pull_request') {
    return { status: 'not_applicable', mergeRefSha: null }
  }
  if (!mergeRefSha) {
    return { status: 'absent', mergeRefSha: null }
  }
  if (mergeRefSha === evidenceSha) {
    throw new Error(`resolved HEAD ${evidenceSha} equals the synthetic PR merge-ref SHA ${mergeRefSha} — the merge ref must never be the tested identity`)
  }
  return { status: 'not_tested', mergeRefSha }
}

export interface EvidenceEnv {
  eventName: string
  ref: string
  expectedSha: string
  expectedSource: string
  mergeRefSha: string | undefined
  runId: string
  runAttempt: string
  workflowRef: string
}

export interface Evidence {
  EVIDENCE_SHA: string
  TREE: string
  EVENT: string
  REF: string
  EXPECTED_SOURCE: string
  MERGE_REF_SHA_NOT_TESTED: string
  RUN_ID: string
  RUN_ATTEMPT: string
  WORKFLOW_REF: string
}

/**
 * Assembles the evidence record. Order of operations matters:
 *   1. EVIDENCE_SHA is read fresh from git (HEAD), never trusted from env
 *      alone, and cross-checked against the resolver's EXPECTED_SHA (the
 *      workflow's separate "Verify checkout resolved exact SHA" step already
 *      enforces this identity too — this is defense in depth, not the only
 *      check).
 *   2. The working tree must be clean before anything is derived from it.
 *   3. TREE is derived bound to EVIDENCE_SHA (never HEAD as a separate call).
 *   4. The merge-ref defense runs last, since it can throw on its own.
 */
export function buildEvidence(git: GitRunner, env: EvidenceEnv): Evidence {
  const evidenceSha = git(['rev-parse', 'HEAD']).trim()
  if (evidenceSha !== env.expectedSha) {
    throw new Error(`checked-out HEAD ${evidenceSha} does not match resolved EXPECTED_SHA ${env.expectedSha}`)
  }

  assertCleanTree(git)

  const tree = deriveTree(git, evidenceSha)

  const mergeRefCheck = checkMergeRefNotTested(env.eventName, evidenceSha, env.mergeRefSha)

  return {
    EVIDENCE_SHA: evidenceSha,
    TREE: tree,
    EVENT: env.eventName,
    REF: env.ref,
    EXPECTED_SOURCE: env.expectedSource,
    MERGE_REF_SHA_NOT_TESTED: mergeRefCheck.status === 'not_tested' ? mergeRefCheck.mergeRefSha! : mergeRefCheck.status,
    RUN_ID: env.runId,
    RUN_ATTEMPT: env.runAttempt,
    WORKFLOW_REF: env.workflowRef,
  }
}

export function evidenceArtifactName(evidenceSha: string): string {
  return `exact-sha-evidence-${evidenceSha}`
}

function main(): void {
  const cwd = process.cwd()
  const git = realGitRunner(cwd)

  const env: EvidenceEnv = {
    eventName: process.env.EVENT_NAME ?? '',
    ref: process.env.REF ?? '',
    expectedSha: process.env.EXPECTED_SHA ?? '',
    expectedSource: process.env.EXPECTED_SOURCE ?? '',
    mergeRefSha: process.env.MERGE_REF_SHA || undefined,
    runId: process.env.RUN_ID ?? '',
    runAttempt: process.env.RUN_ATTEMPT ?? '',
    workflowRef: process.env.WORKFLOW_REF ?? '',
  }

  if (!env.expectedSha) {
    console.error('ci-exact-sha-evidence: EXPECTED_SHA env var is required (set by the workflow\'s resolve step)')
    process.exit(1)
  }

  const evidence = buildEvidence(git, env)
  const outPath = 'exact-sha-evidence.json'
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')

  console.log(`ci-exact-sha-evidence: wrote ${outPath}`)
  console.log(`  EVIDENCE_SHA=${evidence.EVIDENCE_SHA}`)
  console.log(`  TREE=${evidence.TREE}`)
  console.log(`  artifact name=${evidenceArtifactName(evidence.EVIDENCE_SHA)}`)
}

// Only when run as a script — tests/ci-exact-sha-binding.test.ts imports the
// pure functions above. See scripts/ods-scope.ts for the same argv-based
// guard and why import.meta.url is not used instead.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ci-exact-sha-evidence.ts')

if (invokedDirectly) {
  try {
    main()
  } catch (err) {
    console.error(`ci-exact-sha-evidence: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
