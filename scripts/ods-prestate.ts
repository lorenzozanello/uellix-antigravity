// scripts/ods-prestate.ts — ODS-C1, the explicit deterministic prestate gate.
//
//   pnpm ods:prestate --branch <b> --head <sha> --tree <sha> --clean
//
// Moves branch/HEAD/tree/dirty-state verification out of LLM reasoning,
// where every prior certification round re-derived it by hand each session.
//
// Governance rule: the caller must supply the assertions relevant to its
// governed task. A supplied assertion is mandatory — a mismatch FAILS, it
// is never silently downgraded to a warning, and the expected value is
// NEVER inferred from the current state (that would make the gate check
// nothing). Running with zero assertions is a usage error, not a vacuous
// PASS, for the same reason.

import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure primitives.
// ---------------------------------------------------------------------------

export function checkBranch(current: string, expected: string): boolean {
  return current === expected
}

export function checkHead(current: string, expected: string): boolean {
  return current === expected
}

export function checkTree(current: string, expected: string): boolean {
  return current === expected
}

/** `statusPorcelain` is the raw output of `git status --porcelain`. */
export function checkClean(statusPorcelain: string): boolean {
  return statusPorcelain.trim().length === 0
}

export interface PrestateExpectations {
  branch?: string
  head?: string
  tree?: string
  requireClean?: boolean
}

export interface PrestateActual {
  branch: string
  head: string
  tree: string
  statusPorcelain: string
}

export interface PrestateCheckOutcome {
  name: string
  performed: boolean
  pass: boolean
}

export interface PrestateResult {
  checks: PrestateCheckOutcome[]
  /** false when no assertion was supplied at all — a usage error, not a semantic FAIL. */
  hasAssertions: boolean
  pass: boolean
}

/** Pure: runs exactly the checks the caller asked for against already-fetched actual state. */
export function evaluatePrestate(expected: PrestateExpectations, actual: PrestateActual): PrestateResult {
  const checks: PrestateCheckOutcome[] = []

  if (expected.branch !== undefined) {
    checks.push({ name: 'PRESTATE_BRANCH', performed: true, pass: checkBranch(actual.branch, expected.branch) })
  }
  if (expected.head !== undefined) {
    checks.push({ name: 'PRESTATE_HEAD', performed: true, pass: checkHead(actual.head, expected.head) })
  }
  if (expected.tree !== undefined) {
    checks.push({ name: 'PRESTATE_TREE', performed: true, pass: checkTree(actual.tree, expected.tree) })
  }
  if (expected.requireClean) {
    checks.push({ name: 'PRESTATE_CLEAN', performed: true, pass: checkClean(actual.statusPorcelain) })
  }

  const hasAssertions = checks.length > 0
  return { checks, hasAssertions, pass: hasAssertions && checks.every((c) => c.pass) }
}

// ---------------------------------------------------------------------------
// Git-backed I/O — isolated so pure logic above is testable without a repo.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function fetchActual(cwd: string): PrestateActual {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}'])
  const status = git(cwd, ['status', '--porcelain'])
  if (branch.code !== 0 || head.code !== 0 || tree.code !== 0 || status.code !== 0) {
    throw new Error(
      `ods:prestate could not read git state at ${cwd}: ${[branch, head, tree, status].map((r) => r.stderr).join(' | ')}`,
    )
  }
  return {
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    statusPorcelain: status.stdout,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): PrestateExpectations {
  const expected: PrestateExpectations = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm forwards a literal "--" separator into argv on this project's
    // pnpm version (`pnpm run ods:prestate -- --head X` puts "--" itself in
    // argv, unlike plain npm). Skip it rather than treat it as unrecognized.
    if (arg === '--') continue
    if (arg === '--branch') expected.branch = argv[++i]
    else if (arg === '--head') expected.head = argv[++i]
    else if (arg === '--tree') expected.tree = argv[++i]
    else if (arg === '--clean') expected.requireClean = true
    else {
      console.error(`ods:prestate: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return expected
}

function main(): void {
  const expected = parseArgs(process.argv.slice(2))
  const actual = fetchActual(process.cwd())
  const result = evaluatePrestate(expected, actual)

  const lines: string[] = []
  lines.push(`CURRENT_BRANCH=${actual.branch}`)
  lines.push(`CURRENT_HEAD=${actual.head}`)
  lines.push(`CURRENT_TREE=${actual.tree}`)

  if (!result.hasAssertions) {
    lines.push('ODS_PRESTATE=USAGE_ERROR')
    lines.push('  no assertion supplied — pass at least one of --branch/--head/--tree/--clean')
    console.log(lines.join('\n'))
    process.exit(2)
  }

  for (const check of result.checks) {
    lines.push(`${check.name}=${check.pass ? 'PASS' : 'FAIL'}`)
  }
  lines.push(`ODS_PRESTATE=${result.pass ? 'PASS' : 'FAIL'}`)
  console.log(lines.join('\n'))
  process.exit(result.pass ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-prestate.test.ts imports the pure
// functions above. See scripts/authority-seal-verify.ts for why argv is
// checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-prestate.ts')

if (invokedDirectly) main()
