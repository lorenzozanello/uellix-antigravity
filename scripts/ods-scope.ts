// scripts/ods-scope.ts — ODS-C4, the explicit forbidden-scope/diff gate.
//
//   pnpm ods:scope --base <sha> --allow <path-or-pattern> [--allow ...]
//
// Deterministically proves a diff stays inside explicitly authorized
// surfaces. Covers committed changes since --base, staged changes,
// unstaged changes, and untracked files. Renames are checked on BOTH
// endpoints so a rename cannot smuggle a path across the boundary.
//
// Governance rule: a changed file is authorized ONLY if the caller
// explicitly allowed its path. Being changed is never itself permission.
// A fixed set of high-risk surfaces (authority documents, migrations,
// prepared SQL, the frozen ODS authority artifact) is protected by
// default — an ordinary --allow can never override that classification by
// itself.
//
// HPO-ODS-W2-01 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json):
// a protected path may be authorized ONLY via a --protected-authority id
// resolved against the repository-local PROTECTED_GRANTS registry below —
// never from a user-supplied pattern, an env var, a branch name alone, or
// the fact that a path was named in --allow. A grant is scoped to one
// branch and an exact set of protected patterns; the ordinary --allow
// list remains additionally mandatory for every granted path. Future
// waves require their own explicit HPO grant entry, not a broader one.

import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure primitives — pattern matching and path classification.
// ---------------------------------------------------------------------------

/** Supports exact literal paths and a trailing/embedded `**` (match any depth). No other glob syntax is needed by this gate's callers. */
export function patternToRegExp(pattern: string): RegExp {
  const segments = pattern.split('**')
  const escaped = segments
    .map((segment) =>
      segment
        .split('*')
        .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

export function matchesPattern(filePath: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(filePath)
}

export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p))
}

// HPO-ODS-C4-CASE-01 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json):
// case-insensitive DETECTION only, used to catch a path that is trying to
// enter a protected surface via a non-canonical casing on a case-sensitive
// host (e.g. DB/migrations/x.sql vs the canonical db/migrations/**).
// Authorization is never derived from this — see classifyPaths below.
export function matchesPatternCaseInsensitive(filePath: string, pattern: string): boolean {
  return new RegExp(patternToRegExp(pattern).source, 'i').test(filePath)
}

export function matchesAnyPatternCaseInsensitive(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPatternCaseInsensitive(filePath, p))
}

/**
 * Default-protected, high-risk surfaces. Unconditional: no --allow pattern
 * in this version of the gate can authorize a change here.
 */
export const DEFAULT_PROTECTED_PATTERNS: string[] = [
  'docs/ops/fib/**',
  'docs/ops/pc01b/**',
  'docs/ops/im01b/**',
  'db/migrations/**',
  'db/prepared/**',
  'db/baseline/**',
  'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json',
]

export interface ScopeClassification {
  protectedViolations: string[]
  unauthorized: string[]
  ok: string[]
  /** Subset of `ok` that was protected by default and authorized only via a resolved grant. */
  grantAuthorized: string[]
  /**
   * Case-insensitively inside a protected surface but NOT using its
   * canonical casing (e.g. DB/migrations/x.sql). Always a failure,
   * unconditionally — never authorizable, even under a valid grant. See
   * HPO-ODS-C4-CASE-01.
   */
  nonCanonicalProtectedPaths: string[]
}

/**
 * Pure: classifies a deduplicated path list against protected + allowed
 * patterns, and an optional already-resolved protected-surface grant.
 *
 * `grant` must already be branch-validated by the caller (see
 * `resolveProtectedGrant`) — this function only checks whether the
 * CONCRETE path matches one of the grant's own patterns, never the
 * broader default protected pattern that made the path protected in the
 * first place. That is what keeps a grant for db/prepared/journal/**
 * from ever authorizing db/prepared/sibling.sql: the sibling matches
 * DEFAULT_PROTECTED_PATTERNS' db/prepared/** but not the grant's own
 * narrower db/prepared/journal/**.
 *
 * Casing: a path that only enters a protected surface case-insensitively
 * (not via its canonical declared casing) is classified as
 * nonCanonicalProtectedPaths and fails unconditionally — checked BEFORE
 * the ordinary --allow branch, so it can never be authorized by any
 * combination of grant or --allow. Detection is case-insensitive;
 * authorization stays bound to the canonical concrete path only.
 */
export function classifyPaths(
  paths: string[],
  protectedPatterns: string[],
  allowedPatterns: string[],
  grant?: ProtectedGrant,
): ScopeClassification {
  const protectedViolations: string[] = []
  const unauthorized: string[] = []
  const ok: string[] = []
  const grantAuthorized: string[] = []
  const nonCanonicalProtectedPaths: string[] = []

  for (const p of new Set(paths)) {
    if (matchesAnyPattern(p, protectedPatterns)) {
      // Protected by default (canonical casing). Authorized ONLY if the
      // grant's own (narrower) patterns cover this exact path AND the
      // ordinary task --allow also covers it — both mandatory, neither
      // can stand in for the other.
      const grantCovers = grant !== undefined && matchesAnyPattern(p, grant.patterns)
      const taskAllows = matchesAnyPattern(p, allowedPatterns)
      if (grantCovers && taskAllows) {
        ok.push(p)
        grantAuthorized.push(p)
      } else {
        protectedViolations.push(p)
      }
    } else if (matchesAnyPatternCaseInsensitive(p, protectedPatterns)) {
      // Case-insensitively protected but not canonically. Unconditional
      // failure — never reaches the grant/--allow branch below.
      nonCanonicalProtectedPaths.push(p)
    } else if (!matchesAnyPattern(p, allowedPatterns)) {
      unauthorized.push(p)
    } else {
      ok.push(p)
    }
  }

  return { protectedViolations, unauthorized, ok, grantAuthorized, nonCanonicalProtectedPaths }
}

// ---------------------------------------------------------------------------
// HPO-ODS-W2-01 — protected-surface explicit grants.
//
// A repository-local STATIC registry. No user-supplied arbitrary pattern
// can become authoritative: the only inputs a caller controls are which
// authority id to name and which branch they happen to be on, and both
// are checked against this fixed table, never trusted directly.
// ---------------------------------------------------------------------------

export interface ProtectedGrant {
  authorityId: string
  branch: string
  patterns: string[]
}

/**
 * Frozen by docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json,
 * HPO-ODS-W2-01. Exists only to permit FIB Wave 2 governed migration and
 * journal materialization. Future waves require their own explicit entry
 * here via a new HPO authority update — never a broadened existing one.
 */
export const PROTECTED_GRANTS: ProtectedGrant[] = [
  {
    authorityId: 'HPO-ODS-W2-01',
    branch: 'codex/w2-methodology-objects-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  },
]

export interface ProtectedGrantResolution {
  grant?: ProtectedGrant
  authorityId?: string
  reason: string
}

/**
 * Pure: resolves a --protected-authority id against PROTECTED_GRANTS and
 * the caller's already-known current branch. Returns `grant: undefined`
 * for every failure mode (absent, unknown, or branch-mismatched id) —
 * callers must not distinguish these for authorization purposes, only for
 * diagnostics, so a wrong-branch attempt fails exactly like no id at all.
 */
export function resolveProtectedGrant(authorityId: string | undefined, currentBranch: string): ProtectedGrantResolution {
  if (!authorityId) {
    return { reason: 'no --protected-authority supplied' }
  }
  const grant = PROTECTED_GRANTS.find((g) => g.authorityId === authorityId)
  if (!grant) {
    return { authorityId, reason: `unknown protected authority "${authorityId}"` }
  }
  if (grant.branch !== currentBranch) {
    return { authorityId, reason: `"${authorityId}" is granted on branch "${grant.branch}", not current branch "${currentBranch}"` }
  }
  return { grant, authorityId, reason: `"${authorityId}" resolved on branch "${currentBranch}"` }
}

// ---------------------------------------------------------------------------
// NUL-delimited git output parsing. Robust against filenames with spaces —
// a measured Windows/portability hazard for this project.
// ---------------------------------------------------------------------------

export interface ChangedPathEntry {
  status: string
  path: string
  oldPath?: string
}

/** Parses `git diff --name-status -z <a> <b>` output. Rename/copy records ("R###"/"C###") carry both old and new paths. */
export function parseDiffNameStatusZ(raw: string): ChangedPathEntry[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0)
  const entries: ChangedPathEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i++]
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i++]
      const newPath = tokens[i++]
      entries.push({ status, path: newPath, oldPath })
    } else {
      const p = tokens[i++]
      entries.push({ status, path: p })
    }
  }
  return entries
}

/** Parses `git status --porcelain=v1 --find-renames -z` output. */
export function parseStatusPorcelainZ(raw: string): ChangedPathEntry[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0)
  const entries: ChangedPathEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const record = tokens[i++]
    const xy = record.slice(0, 2)
    const p = record.slice(3)
    if (xy.includes('R') || xy.includes('C')) {
      const oldPath = tokens[i++]
      entries.push({ status: xy, path: p, oldPath })
    } else {
      entries.push({ status: xy, path: p })
    }
  }
  return entries
}

/** All paths a set of entries touches — both endpoints of a rename/copy included. */
export function allTouchedPaths(entries: ChangedPathEntry[]): string[] {
  const paths: string[] = []
  for (const e of entries) {
    paths.push(e.path)
    if (e.oldPath) paths.push(e.oldPath)
  }
  return paths
}

// ---------------------------------------------------------------------------
// Git-backed I/O.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Current branch, read fresh from git — never trusted from a caller-supplied claim. */
export function getCurrentBranch(cwd: string): string {
  const res = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (res.code !== 0) throw new Error(`git rev-parse --abbrev-ref HEAD failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** All paths touched since `base`: committed (base..HEAD), staged, unstaged, and untracked. */
export function collectChangedPaths(cwd: string, base: string): string[] {
  const committed = git(cwd, ['diff', '--name-status', '--find-renames', '-z', base, 'HEAD'])
  if (committed.code !== 0) throw new Error(`git diff --name-status ${base} HEAD failed: ${committed.stderr}`)

  // --untracked-files=all: without it, git summarizes a whole new untracked
  // directory as one entry (e.g. "lib/") instead of listing the files inside
  // it, which would let an unauthorized file hide behind an allowed sibling.
  const uncommitted = git(cwd, ['status', '--porcelain=v1', '--find-renames', '--untracked-files=all', '-z'])
  if (uncommitted.code !== 0) throw new Error(`git status --porcelain failed: ${uncommitted.stderr}`)

  return [...allTouchedPaths(parseDiffNameStatusZ(committed.stdout)), ...allTouchedPaths(parseStatusPorcelainZ(uncommitted.stdout))]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ScopeArgs {
  base?: string
  allow: string[]
  protectedAuthority?: string
}

// HPO-ODS-M1D CLI hygiene: recognized flags, used only to detect whether a
// --protected-authority operand slot was actually consumed by another flag
// rather than a real identifier. Scoped narrowly to this one flag per the
// authorizing addendum — --base/--allow's existing (weaker) operand
// handling is explicitly out of scope for this remediation.
const SCOPE_RECOGNIZED_FLAGS = new Set(['--base', '--allow', '--protected-authority'])

function looksLikeMissingProtectedAuthorityOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || SCOPE_RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): ScopeArgs {
  const result: ScopeArgs = { allow: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // see scripts/ods-prestate.ts for why
    if (arg === '--base') result.base = argv[++i]
    else if (arg === '--allow') result.allow.push(argv[++i])
    else if (arg === '--protected-authority') {
      const value = argv[i + 1]
      if (looksLikeMissingProtectedAuthorityOperand(value)) {
        console.error('ods:scope: --protected-authority requires a value')
        process.exit(2)
      }
      i++
      result.protectedAuthority = value
    } else {
      console.error(`ods:scope: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return result
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.base) {
    console.error('ods:scope: --base <sha> is required')
    console.log('ODS_SCOPE=USAGE_ERROR')
    process.exit(2)
  }

  const cwd = process.cwd()
  const currentBranch = getCurrentBranch(cwd)
  const grantResolution = resolveProtectedGrant(args.protectedAuthority, currentBranch)

  const changed = collectChangedPaths(cwd, args.base)
  const unique = [...new Set(changed)]
  const result = classifyPaths(unique, DEFAULT_PROTECTED_PATTERNS, args.allow, grantResolution.grant)

  const lines: string[] = []
  lines.push(`SCOPE_BASE=${args.base}`)
  lines.push(`CHANGED_FILE_COUNT=${unique.length}`)
  lines.push(`PROTECTED_AUTHORITY=${grantResolution.authorityId ?? 'NONE'}`)
  if (args.protectedAuthority) lines.push(`  ${grantResolution.reason}`)
  lines.push(`PROTECTED_AUTHORIZED_PATH_COUNT=${result.grantAuthorized.length}`)
  for (const p of result.protectedViolations) lines.push(`PROTECTED_PATH_VIOLATION=${p}`)
  for (const p of result.nonCanonicalProtectedPaths) lines.push(`NON_CANONICAL_PROTECTED_PATH=${p}`)
  for (const p of result.unauthorized) lines.push(`UNAUTHORIZED_PATH=${p}`)
  lines.push(`PROTECTED_PATH_VIOLATIONS=${result.protectedViolations.length}`)
  lines.push(`NON_CANONICAL_PROTECTED_PATHS=${result.nonCanonicalProtectedPaths.length}`)
  lines.push(`UNAUTHORIZED_PATHS=${result.unauthorized.length}`)

  const pass =
    result.protectedViolations.length === 0 && result.nonCanonicalProtectedPaths.length === 0 && result.unauthorized.length === 0
  lines.push(`ODS_SCOPE=${pass ? 'PASS' : 'FAIL'}`)
  console.log(lines.join('\n'))
  process.exit(pass ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-scope.test.ts imports the pure
// functions above. See scripts/authority-seal-verify.ts for why argv is
// checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-scope.ts')

if (invokedDirectly) main()
