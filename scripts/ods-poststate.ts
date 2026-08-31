// scripts/ods-poststate.ts — ODS-C3, the explicit deterministic poststate
// orchestrator.
//
//   pnpm ods:poststate --base <sha> --allow <pattern> [--allow ...]
//                       [--test <path> ...] [--clean]
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

// ---------------------------------------------------------------------------
// Pure composition logic — testable without spawning real processes.
// ---------------------------------------------------------------------------

export interface PoststateInput {
  base?: string
  allow: string[]
  tests: string[]
  requireClean: boolean
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

export function realRunner(pnpmArgs: string[], cwd: string): number {
  const command = ['pnpm', ...pnpmArgs].map(quoteShellArg).join(' ')
  const res = spawnSync(command, { cwd, stdio: 'inherit', shell: true })
  return res.status ?? 1
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): PoststateInput {
  const input: PoststateInput = { allow: [], tests: [], requireClean: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue // see scripts/ods-prestate.ts for why
    if (arg === '--base') input.base = argv[++i]
    else if (arg === '--allow') input.allow.push(argv[++i])
    else if (arg === '--test') input.tests.push(argv[++i])
    else if (arg === '--clean') input.requireClean = true
    else {
      console.error(`ods:poststate: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return input
}

function main(): void {
  const input = parseArgs(process.argv.slice(2))
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
