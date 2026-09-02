// scripts/ods-integration-plan.ts — ODS-ACCEL-01 NODE 2, deterministic
// integration planner.
//
//   pnpm ops:integration-plan -- --source <ref> --target <ref> --base <ref>
//                                 --target-branch <branch> [--json]
//
// Mechanically derives what would need to move from a source ref into a
// target branch since a common base, and flags every file that changed on
// BOTH sides since base as SEMANTIC_REVIEW_REQUIRED — regardless of
// whether Git's own text merge would report the pair as conflict-free.
// AUTO_MERGE_CLEAN is not evidence of SEMANTICALLY_SAFE: a file can drift
// on both branches in ways that touch disjoint lines yet still each
// change the calling contract, so this tool never treats "no conflict
// markers" as a semantic verdict.
//
// Protected-path classification is imported from scripts/ods-scope.ts, not
// reimplemented — one source of truth for what counts as protected and for
// how the existing HPO-ODS-W2-01-style grant registry resolves.

import { spawnSync } from 'node:child_process'
import {
  DEFAULT_PROTECTED_PATTERNS,
  matchesAnyPattern,
  matchesAnyPatternCaseInsensitive,
  PROTECTED_GRANTS,
  type ProtectedGrant,
} from './ods-scope'

// ---------------------------------------------------------------------------
// Pure primitives.
// ---------------------------------------------------------------------------

export type ProtectedDisposition = 'AUTHORIZED' | 'WRONG_BRANCH' | 'NO_MATCHING_GRANT'
export type OverallProtectedDisposition = ProtectedDisposition | 'NOT_APPLICABLE'

export interface ProtectedFileDisposition {
  path: string
  disposition: ProtectedDisposition
  matchingGrant?: string
}

/**
 * Pure: classifies one protected path against the frozen PROTECTED_GRANTS
 * registry for a specific target branch. Never adjudicates or grants —
 * only reports what the existing registry would say. Priority when
 * multiple grants could apply: a grant matching both the path's pattern
 * AND the exact target branch wins as AUTHORIZED; otherwise a grant whose
 * pattern matches but whose branch does not is WRONG_BRANCH; otherwise
 * NO_MATCHING_GRANT.
 */
export function classifyProtectedFileDisposition(
  filePath: string,
  targetBranch: string,
  grants: ProtectedGrant[],
): ProtectedFileDisposition {
  const candidates = grants.filter((g) => matchesAnyPattern(filePath, g.patterns))
  const onTargetBranch = candidates.find((g) => g.branch === targetBranch)
  if (onTargetBranch) return { path: filePath, disposition: 'AUTHORIZED', matchingGrant: onTargetBranch.authorityId }
  if (candidates.length > 0) return { path: filePath, disposition: 'WRONG_BRANCH', matchingGrant: candidates[0].authorityId }
  return { path: filePath, disposition: 'NO_MATCHING_GRANT' }
}

/** Pure: most-restrictive-wins roll-up over the per-file dispositions. */
export function rollUpProtectedDisposition(dispositions: ProtectedFileDisposition[]): OverallProtectedDisposition {
  if (dispositions.length === 0) return 'NOT_APPLICABLE'
  if (dispositions.some((d) => d.disposition === 'NO_MATCHING_GRANT')) return 'NO_MATCHING_GRANT'
  if (dispositions.some((d) => d.disposition === 'WRONG_BRANCH')) return 'WRONG_BRANCH'
  return 'AUTHORIZED'
}

export interface IntegrationPlan {
  sourceRef: string
  targetRef: string
  baseRef: string
  targetBranch: string
  sourceChangedFiles: string[]
  targetChangedFiles: string[]
  integrationFileCount: number
  overlapFiles: string[]
  overlapFileCount: number
  protectedFiles: string[]
  protectedFileCount: number
  nonCanonicalProtectedPaths: string[]
  protectedFileDispositions: ProtectedFileDisposition[]
  currentProtectedAuthorityDisposition: OverallProtectedDisposition
  semanticReviewRequiredFiles: string[]
}

/**
 * Pure: builds the deterministic plan from two already-fetched changed-file
 * lists. No git call inside — testable with plain arrays.
 *
 * SEMANTIC_REVIEW_REQUIRED_FILES == overlapFiles by construction: this is
 * the SEMANTIC COLLISION RULE. A future "did Git report a conflict" signal
 * must never be added to narrow this set — that would silently reintroduce
 * AUTO_MERGE_CLEAN == SEMANTICALLY_SAFE.
 */
export function buildIntegrationPlan(
  sourceRef: string,
  targetRef: string,
  baseRef: string,
  targetBranch: string,
  sourceChangedFiles: string[],
  targetChangedFiles: string[],
  grants: ProtectedGrant[] = PROTECTED_GRANTS,
): IntegrationPlan {
  const source = [...new Set(sourceChangedFiles)].sort()
  const target = [...new Set(targetChangedFiles)].sort()
  const targetSet = new Set(target)
  const overlapFiles = source.filter((f) => targetSet.has(f))

  const protectedFiles = source.filter((f) => matchesAnyPattern(f, DEFAULT_PROTECTED_PATTERNS))
  const nonCanonicalProtectedPaths = source.filter(
    (f) => !matchesAnyPattern(f, DEFAULT_PROTECTED_PATTERNS) && matchesAnyPatternCaseInsensitive(f, DEFAULT_PROTECTED_PATTERNS),
  )
  const protectedFileDispositions = protectedFiles.map((f) => classifyProtectedFileDisposition(f, targetBranch, grants))

  return {
    sourceRef,
    targetRef,
    baseRef,
    targetBranch,
    sourceChangedFiles: source,
    targetChangedFiles: target,
    integrationFileCount: source.length,
    overlapFiles,
    overlapFileCount: overlapFiles.length,
    protectedFiles,
    protectedFileCount: protectedFiles.length,
    nonCanonicalProtectedPaths,
    protectedFileDispositions,
    currentProtectedAuthorityDisposition: rollUpProtectedDisposition(protectedFileDispositions),
    // SEMANTIC COLLISION RULE: identical to overlapFiles, deliberately not
    // filtered by any merge-cleanliness signal. See docstring above.
    semanticReviewRequiredFiles: overlapFiles,
  }
}

// ---------------------------------------------------------------------------
// Git-backed I/O.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function changedFilesSince(cwd: string, base: string, ref: string): string[] {
  const res = git(cwd, ['diff', '--name-only', '--find-renames', base, ref])
  if (res.code !== 0) throw new Error(`git diff --name-only ${base} ${ref} failed: ${res.stderr}`)
  return res.stdout.split('\n').filter((l) => l.length > 0)
}

export function buildIntegrationPlanFromRepo(
  cwd: string,
  sourceRef: string,
  targetRef: string,
  baseRef: string,
  targetBranch: string,
): IntegrationPlan {
  const sourceChangedFiles = changedFilesSince(cwd, baseRef, sourceRef)
  const targetChangedFiles = changedFilesSince(cwd, baseRef, targetRef)
  return buildIntegrationPlan(sourceRef, targetRef, baseRef, targetBranch, sourceChangedFiles, targetChangedFiles)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface PlanArgs {
  source?: string
  target?: string
  base?: string
  targetBranch?: string
  json: boolean
}

const RECOGNIZED_FLAGS = new Set(['--source', '--target', '--base', '--target-branch', '--json'])

function looksLikeMissingOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): PlanArgs {
  const args: PlanArgs = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--json') {
      args.json = true
      continue
    }
    if (!RECOGNIZED_FLAGS.has(arg)) {
      console.error(`ops:integration-plan: unrecognized argument "${arg}"`)
      process.exit(2)
    }
    const value = argv[i + 1]
    if (looksLikeMissingOperand(value)) {
      console.error(`ops:integration-plan: ${arg} requires a value`)
      process.exit(2)
    }
    i++
    if (arg === '--source') args.source = value
    else if (arg === '--target') args.target = value
    else if (arg === '--base') args.base = value
    else if (arg === '--target-branch') args.targetBranch = value
  }
  return args
}

function stableStringify(plan: IntegrationPlan): string {
  return JSON.stringify(plan, null, 2)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const missing = (['source', 'target', 'base', 'targetBranch'] as const).filter((k) => !args[k])
  if (missing.length > 0) {
    console.error(`ops:integration-plan: missing required flag(s): ${missing.map((k) => `--${k === 'targetBranch' ? 'target-branch' : k}`).join(', ')}`)
    console.log('ODS_INTEGRATION_PLAN=USAGE_ERROR')
    process.exit(2)
  }

  const cwd = process.cwd()
  const plan = buildIntegrationPlanFromRepo(cwd, args.source as string, args.target as string, args.base as string, args.targetBranch as string)

  if (args.json) {
    console.log(stableStringify(plan))
    process.exit(0)
  }

  const lines: string[] = []
  lines.push(`SOURCE_REF=${plan.sourceRef}`)
  lines.push(`TARGET_REF=${plan.targetRef}`)
  lines.push(`BASE_REF=${plan.baseRef}`)
  lines.push(`TARGET_BRANCH=${plan.targetBranch}`)
  lines.push(`SOURCE_CHANGED_FILES=${plan.sourceChangedFiles.length}`)
  lines.push(`TARGET_CHANGED_FILES=${plan.targetChangedFiles.length}`)
  lines.push(`INTEGRATION_FILE_COUNT=${plan.integrationFileCount}`)
  lines.push(`OVERLAP_FILE_COUNT=${plan.overlapFileCount}`)
  for (const f of plan.overlapFiles) lines.push(`OVERLAP_FILE=${f}`)
  lines.push(`PROTECTED_FILE_COUNT=${plan.protectedFileCount}`)
  for (const f of plan.protectedFiles) lines.push(`PROTECTED_FILE=${f}`)
  for (const f of plan.nonCanonicalProtectedPaths) lines.push(`NON_CANONICAL_PROTECTED_PATH=${f}`)
  lines.push(`CURRENT_PROTECTED_AUTHORITY_DISPOSITION=${plan.currentProtectedAuthorityDisposition}`)
  for (const d of plan.protectedFileDispositions) {
    lines.push(`PROTECTED_FILE_DISPOSITION=${d.path}=${d.disposition}${d.matchingGrant ? ` (${d.matchingGrant})` : ''}`)
  }
  lines.push(`SEMANTIC_REVIEW_REQUIRED_COUNT=${plan.semanticReviewRequiredFiles.length}`)
  for (const f of plan.semanticReviewRequiredFiles) lines.push(`SEMANTIC_REVIEW_REQUIRED_FILE=${f}`)
  lines.push('ODS_INTEGRATION_PLAN=REPORTED')
  console.log(lines.join('\n'))
  process.exit(0)
}

// Only when run as a script — tests/ods/ods-integration-plan.test.ts
// imports the pure functions above. See scripts/authority-seal-verify.ts
// for why argv is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-integration-plan.ts')

if (invokedDirectly) main()
