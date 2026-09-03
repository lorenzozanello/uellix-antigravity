// scripts/ods-poststate.ts — ODS-C3, the explicit deterministic poststate
// orchestrator.
//
//   pnpm ods:poststate --base <sha> --allow <pattern> [--allow ...]
//                       [--test <path> ...] [--clean]
//                       [--protected-authority <id> ...]
//
// COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M1):
// --protected-authority may be repeated; every occurrence is forwarded as
// its own flag to the composed ods:scope step (see composeSteps), which
// remains the sole adjudicator of union/resolution semantics.
//
// One explicit endpoint that COMPOSES existing commands and the other ODS
// gates. It never reimplements their logic — typecheck stays tsc, secrets
// stays scripts/scan-secrets.ts, authority stays ODS-C2, scope stays ODS-C4,
// and the final clean-state check reuses ODS-C1 (pnpm ods:prestate --clean)
// rather than a second dirty-worktree implementation.
//
// Full-suite execution is deliberately NOT the default: `--test <path>` runs
// only the tests the caller's governed task actually requires. The full
// suite plus build remains a CI/merge-gate concern (.github/workflows/ci.yml).
//
// Fail-closed composition: every sub-gate always runs (for full diagnostic
// evidence in one pass — none of them are destructive), and the orchestrator
// fails if ANY of them failed. A failure is never caught and converted to
// success.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Pure composition logic — testable without spawning real processes.
// ---------------------------------------------------------------------------

export interface PoststateInput {
  base?: string
  allow: string[]
  tests: string[]
  requireClean: boolean
  /**
   * HPO-ODS-POSTSTATE-01: a bare identifier forwarded verbatim to the
   * composed ods:scope step. poststate never interprets or expands it —
   * ods:scope remains the sole adjudicator of authority validity, branch
   * binding, protected-pattern binding, the concrete changed path, and
   * ordinary task --allow.
   *
   * @deprecated kept only so existing single-id call sites/tests remain
   * unchanged. Prefer `protectedAuthorities`. If both are given, this id
   * is forwarded alongside every id in `protectedAuthorities` (union, not
   * override) — see composeSteps.
   */
  protectedAuthority?: string
  /**
   * COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M1):
   * zero or more bare identifiers, each forwarded verbatim as its own
   * --protected-authority flag to the composed ods:scope step. poststate
   * never interprets, expands, or unions them itself — ods:scope remains
   * the sole adjudicator (resolveProtectedGrants + classifyPaths); this
   * orchestrator only has to widen its own CLI to accumulate and forward
   * every occurrence instead of the last one winning.
   */
  protectedAuthorities?: string[]
}

export interface ComposedStep {
  name: string
  /** Full argv passed to `pnpm run ...` (excluding the leading "pnpm run"). */
  pnpmArgs: string[]
}

/** Pure: decides which steps to run and with what arguments. No process spawned here. */
export function composeSteps(input: PoststateInput): ComposedStep[] {
  const steps: ComposedStep[] = []

  steps.push({ name: 'typecheck', pnpmArgs: ['run', 'typecheck'] })

  if (input.tests.length > 0) {
    steps.push({ name: 'targeted-tests', pnpmArgs: ['exec', 'vitest', 'run', ...input.tests] })
  }

  steps.push({ name: 'secrets-scan', pnpmArgs: ['run', 'secrets:scan'] })
  steps.push({ name: 'authority-seal-verify', pnpmArgs: ['run', 'authority:seal:verify'] })

  if (input.base) {
    const scopeArgs = ['run', 'ods:scope', '--', '--base', input.base]
    for (const pattern of input.allow) scopeArgs.push('--allow', pattern)
    // Forwarded verbatim, only here — never to typecheck, tests, the
    // secrets scan, the authority verifier, or the clean-state step.
    // M1: the deprecated scalar and the new plural list are UNIONED (not
    // one overriding the other) so no existing single-id call site's
    // behavior changes when protectedAuthorities is simply absent.
    const protectedAuthorityIds = [...(input.protectedAuthority ? [input.protectedAuthority] : []), ...(input.protectedAuthorities ?? [])]
    for (const id of protectedAuthorityIds) scopeArgs.push('--protected-authority', id)
    steps.push({ name: 'ods-scope', pnpmArgs: scopeArgs })
  }

  if (input.requireClean) {
    steps.push({ name: 'clean-state', pnpmArgs: ['run', 'ods:prestate', '--', '--clean'] })
  }

  return steps
}

export interface StepResult extends ComposedStep {
  exitCode: number
}

export type StepRunner = (pnpmArgs: string[], cwd: string) => number

/** Pure given a runner: executes every composed step and aggregates. Never stops early — full diagnostic evidence in one pass. */
export function runComposedSteps(steps: ComposedStep[], runner: StepRunner, cwd: string): { results: StepResult[]; pass: boolean } {
  const results: StepResult[] = steps.map((step) => ({ ...step, exitCode: runner(step.pnpmArgs, cwd) }))
  return { results, pass: results.every((r) => r.exitCode === 0) }
}

// ---------------------------------------------------------------------------
// Real process execution.
//
// pnpm is a .cmd/.ps1 shim on Windows: spawning it as a bare executable
// with an args array and no shell fails with ENOENT (measured directly in
// this environment). shell:true with an ARGS ARRAY triggers Node's DEP0190
// warning because array elements are joined unescaped; passing the fully
// assembled, individually-quoted command as a SINGLE STRING to shell:true
// avoids that path entirely and was verified not to warn.
// ---------------------------------------------------------------------------

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_.\-/:]+$/.test(arg)) return arg
  if (arg.includes('"')) throw new Error(`ods:poststate: unsupported argument containing a double quote: ${arg}`)
  return `"${arg}"`
}

// ---------------------------------------------------------------------------
// HPO-ODS-TOOLCHAIN-02 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json).
// Refines HPO-ODS-TOOLCHAIN-01 (v1.0.1); does not revoke it.
//
// v1.0.1 proved only that node_modules/typescript/package.json exists and
// declares name "typescript", then still ran the governed typecheck via
// `pnpm run typecheck` (PATH/bin-shim resolution). Measured directly
// before this refinement: a fixture with that exact genuine-looking
// package.json but NO compiler entry at all (neither node_modules/.bin/tsc
// nor node_modules/typescript/bin/tsc) still passed the v1.0.1 check, and
// `pnpm run typecheck` in that same directory returned exit 0 via an
// ambient global tsc. Proving the PACKAGE exists is not proving the
// COMPILER THAT RAN was local.
//
// Fix: resolve the local compiler ENTRY explicitly (not the .bin shim,
// which may legitimately be absent even with a valid local package), and
// execute it directly via the current Node runtime — no shell, no PATH,
// no bin-shim resolution, nothing left to fool it.
// ---------------------------------------------------------------------------

const LOCAL_TYPESCRIPT_PACKAGE_RELATIVE = 'node_modules/typescript/package.json'
const LOCAL_TYPESCRIPT_COMPILER_RELATIVE = 'node_modules/typescript/bin/tsc'

export interface LocalCompilerResolution {
  present: boolean
  reason?: string
  packagePath?: string
  version?: string
  compilerEntry?: string
}

/**
 * Pure (aside from the fs reads): proves the local TypeScript package's
 * identity AND that its compiler entry exists as a file — not merely that
 * a directory or package.json exists. Repo-relative paths are returned
 * (never absolute) to avoid leaking host-specific noise into evidence.
 */
export function resolveLocalCompiler(repoRoot: string): LocalCompilerResolution {
  const packageAbsolute = path.join(repoRoot, LOCAL_TYPESCRIPT_PACKAGE_RELATIVE)
  if (!existsSync(packageAbsolute)) {
    return { present: false, reason: `${LOCAL_TYPESCRIPT_PACKAGE_RELATIVE} not found — run: pnpm install --frozen-lockfile` }
  }
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(packageAbsolute, 'utf8'))
  } catch {
    return { present: false, reason: `${LOCAL_TYPESCRIPT_PACKAGE_RELATIVE} exists but is not valid JSON` }
  }
  const name = (pkg as { name?: unknown } | null)?.name
  if (name !== 'typescript') {
    return { present: false, reason: `${LOCAL_TYPESCRIPT_PACKAGE_RELATIVE} does not declare package name "typescript" (found: ${JSON.stringify(name)})` }
  }
  const version = (pkg as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || version.length === 0) {
    return { present: false, reason: `${LOCAL_TYPESCRIPT_PACKAGE_RELATIVE} does not declare a non-empty string version (found: ${JSON.stringify(version)})` }
  }
  const compilerAbsolute = path.join(repoRoot, LOCAL_TYPESCRIPT_COMPILER_RELATIVE)
  let compilerIsFile = false
  try {
    compilerIsFile = statSync(compilerAbsolute).isFile()
  } catch {
    compilerIsFile = false
  }
  if (!compilerIsFile) {
    return {
      present: false,
      reason: `${LOCAL_TYPESCRIPT_COMPILER_RELATIVE} not found as a file — the local TypeScript package is present but its compiler entry is not`,
    }
  }
  return { present: true, packagePath: LOCAL_TYPESCRIPT_PACKAGE_RELATIVE, version, compilerEntry: LOCAL_TYPESCRIPT_COMPILER_RELATIVE }
}

/** Executes the resolved local compiler entry explicitly via the current Node runtime. No shell, no PATH, no bin shim. */
export function runLocalTypecheck(repoRoot: string, compilerEntryRelative: string): number {
  const compilerAbsolute = path.join(repoRoot, compilerEntryRelative)
  const res = spawnSync(process.execPath, [compilerAbsolute, '--noEmit'], { cwd: repoRoot, stdio: 'inherit' })
  return res.status ?? 1
}

/** Resolves then runs the governed typecheck: fails closed before spawning anything if the local compiler cannot be proven, and reports stable local-identity evidence on success. */
export function runGovernedTypecheck(repoRoot: string): number {
  const compiler = resolveLocalCompiler(repoRoot)
  if (!compiler.present) {
    console.error(`ods:poststate: local TypeScript compiler prerequisite failed — ${compiler.reason}`)
    return 1
  }
  console.log(`LOCAL_TYPESCRIPT_PACKAGE=${compiler.packagePath}`)
  console.log(`LOCAL_TYPESCRIPT_VERSION=${compiler.version}`)
  console.log(`LOCAL_TYPESCRIPT_COMPILER=${compiler.compilerEntry}`)
  return runLocalTypecheck(repoRoot, compiler.compilerEntry as string)
}

export function realRunner(pnpmArgs: string[], cwd: string): number {
  if (pnpmArgs[0] === 'run' && pnpmArgs[1] === 'typecheck') {
    return runGovernedTypecheck(cwd)
  }
  const command = ['pnpm', ...pnpmArgs].map(quoteShellArg).join(' ')
  const res = spawnSync(command, { cwd, stdio: 'inherit', shell: true })
  return res.status ?? 1
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// HPO-ODS-M1D CLI hygiene: recognized poststate flags, used only to detect
// whether a --protected-authority operand slot was actually consumed by
// another flag rather than a real identifier. Scoped narrowly to this one
// flag per the authorizing addendum — --base/--allow/--test's existing
// (weaker) operand handling is explicitly out of scope for this remediation.
const POSTSTATE_RECOGNIZED_FLAGS = new Set(['--base', '--allow', '--test', '--clean', '--protected-authority'])

function looksLikeMissingProtectedAuthorityOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || POSTSTATE_RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): PoststateInput {
  // The real CLI only ever populates the plural protectedAuthorities list
  // (M1); the deprecated scalar field exists solely for pre-existing
  // pure-object test literals that construct a PoststateInput directly.
  const input: PoststateInput = { allow: [], tests: [], requireClean: false, protectedAuthorities: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // see scripts/ods-prestate.ts for why
    if (arg === '--base') input.base = argv[++i]
    else if (arg === '--allow') input.allow.push(argv[++i])
    else if (arg === '--test') input.tests.push(argv[++i])
    else if (arg === '--clean') input.requireClean = true
    else if (arg === '--protected-authority') {
      const value = argv[i + 1]
      if (looksLikeMissingProtectedAuthorityOperand(value)) {
        console.error('ods:poststate: --protected-authority requires a value')
        process.exit(2)
      }
      i++
      // Repeatable: each occurrence appends one id (M1). A single
      // occurrence is byte-identical in effect to the prior scalar field.
      input.protectedAuthorities!.push(value)
    } else {
      console.error(`ods:poststate: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return input
}

function main(): void {
  const input = parseArgs(process.argv.slice(2))

  if ((input.protectedAuthorities?.length ?? 0) > 0 && !input.base) {
    console.error('ods:poststate: --protected-authority requires --base (it configures the composed ods:scope step, which only runs when --base is supplied)')
    console.log('ODS_POSTSTATE=USAGE_ERROR')
    process.exit(2)
  }

  const steps = composeSteps(input)
  const cwd = process.cwd()

  console.log(`ODS_POSTSTATE_STEPS=${steps.map((s) => s.name).join(',')}`)
  const { results, pass } = runComposedSteps(steps, realRunner, cwd)

  console.log('')
  for (const r of results) console.log(`STEP ${r.name}=${r.exitCode === 0 ? 'PASS' : 'FAIL'} (exit ${r.exitCode})`)
  console.log(`ODS_POSTSTATE=${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-poststate.test.ts imports the
// pure functions above. See scripts/authority-seal-verify.ts for why argv
// is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-poststate.ts')

if (invokedDirectly) main()
