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
// prepared SQL, the frozen ODS authority artifact) is protected
// unconditionally — no --allow pattern can override them in this version.
// Authorizing a change to one of them requires a future explicit HPO
// authority update to this script, not a flag.

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
}

/** Pure: classifies a deduplicated path list against protected + allowed patterns. */
export function classifyPaths(paths: string[], protectedPatterns: string[], allowedPatterns: string[]): ScopeClassification {
  const protectedViolations: string[] = []
  const unauthorized: string[] = []
  const ok: string[] = []

  for (const p of new Set(paths)) {
    if (matchesAnyPattern(p, protectedPatterns)) {
      protectedViolations.push(p)
    } else if (!matchesAnyPattern(p, allowedPatterns)) {
      unauthorized.push(p)
    } else {
      ok.push(p)
    }
  }

  return { protectedViolations, unauthorized, ok }
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
}

function parseArgs(argv: string[]): ScopeArgs {
  const result: ScopeArgs = { allow: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // see scripts/ods-prestate.ts for why
    if (arg === '--base') result.base = argv[++i]
    else if (arg === '--allow') result.allow.push(argv[++i])
    else {
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
  const changed = collectChangedPaths(cwd, args.base)
  const unique = [...new Set(changed)]
  const result = classifyPaths(unique, DEFAULT_PROTECTED_PATTERNS, args.allow)

  const lines: string[] = []
  lines.push(`SCOPE_BASE=${args.base}`)
  lines.push(`CHANGED_FILE_COUNT=${unique.length}`)
  for (const p of result.protectedViolations) lines.push(`PROTECTED_PATH_VIOLATION=${p}`)
  for (const p of result.unauthorized) lines.push(`UNAUTHORIZED_PATH=${p}`)
  lines.push(`PROTECTED_PATH_VIOLATIONS=${result.protectedViolations.length}`)
  lines.push(`UNAUTHORIZED_PATHS=${result.unauthorized.length}`)

  const pass = result.protectedViolations.length === 0 && result.unauthorized.length === 0
  lines.push(`ODS_SCOPE=${pass ? 'PASS' : 'FAIL'}`)
  console.log(lines.join('\n'))
  process.exit(pass ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-scope.test.ts imports the pure
// functions above. See scripts/authority-seal-verify.ts for why argv is
// checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-scope.ts')

if (invokedDirectly) main()
