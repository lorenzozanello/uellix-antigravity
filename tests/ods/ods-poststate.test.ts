// tests/ods/ods-poststate.test.ts — ODS-C3 positive and negative controls.
//
// Composition/propagation logic is tested with an injected fake runner (no
// real typecheck/test/secrets-scan/etc. process spawned per case — that
// would be slow and is exactly what composeSteps/runComposedSteps being pure
// and dependency-injected is for). The real subprocess path (quoting,
// pnpm-shim invocation) is proven separately with one real, cheap command.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { composeSteps, runComposedSteps, realRunner, type StepRunner } from '../../scripts/ods-poststate'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

describe('composeSteps', () => {
  it('always includes typecheck, secrets-scan, and authority-seal-verify', () => {
    const steps = composeSteps({ allow: [], tests: [], requireClean: false })
    const names = steps.map((s) => s.name)
    expect(names).toContain('typecheck')
    expect(names).toContain('secrets-scan')
    expect(names).toContain('authority-seal-verify')
  })

  it('does NOT run targeted tests when none are supplied — no forced full suite', () => {
    const steps = composeSteps({ allow: [], tests: [], requireClean: false })
    expect(steps.map((s) => s.name)).not.toContain('targeted-tests')
  })

  it('includes targeted-tests with exactly the supplied paths when --test is given', () => {
    const steps = composeSteps({ allow: [], tests: ['tests/ods/a.test.ts', 'tests/ods/b.test.ts'], requireClean: false })
    const step = steps.find((s) => s.name === 'targeted-tests')
    expect(step?.pnpmArgs).toEqual(['exec', 'vitest', 'run', 'tests/ods/a.test.ts', 'tests/ods/b.test.ts'])
  })

  it('includes ods-scope only when --base is supplied, forwarding base and every --allow', () => {
    const withoutBase = composeSteps({ allow: ['x'], tests: [], requireClean: false })
    expect(withoutBase.map((s) => s.name)).not.toContain('ods-scope')

    const withBase = composeSteps({ base: 'deadbeef', allow: ['scripts/a.ts', 'tests/ods/**'], tests: [], requireClean: false })
    const scopeStep = withBase.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).toEqual([
      'run',
      'ods:scope',
      '--',
      '--base',
      'deadbeef',
      '--allow',
      'scripts/a.ts',
      '--allow',
      'tests/ods/**',
    ])
  })

  it('includes clean-state only when --clean is supplied, reusing ods:prestate rather than reimplementing', () => {
    const withoutClean = composeSteps({ allow: [], tests: [], requireClean: false })
    expect(withoutClean.map((s) => s.name)).not.toContain('clean-state')

    const withClean = composeSteps({ allow: [], tests: [], requireClean: true })
    const cleanStep = withClean.find((s) => s.name === 'clean-state')
    expect(cleanStep?.pnpmArgs).toEqual(['run', 'ods:prestate', '--', '--clean'])
  })
})

describe('runComposedSteps — POSITIVE and NEGATIVE propagation, injected fake runner', () => {
  it('PASS when every composed step exits 0', () => {
    const steps = composeSteps({ base: 'deadbeef', allow: [], tests: ['t.ts'], requireClean: true })
    const runner: StepRunner = () => 0
    const { pass, results } = runComposedSteps(steps, runner, '/fake/cwd')
    expect(pass).toBe(true)
    expect(results.every((r) => r.exitCode === 0)).toBe(true)
  })

  it('NEGATIVE CONTROL: a failing typecheck/test step propagates FAIL', () => {
    const steps = composeSteps({ allow: [], tests: ['t.ts'], requireClean: false })
    const runner: StepRunner = (args) => (args.includes('vitest') ? 1 : 0)
    const { pass, results } = runComposedSteps(steps, runner, '/fake/cwd')
    expect(pass).toBe(false)
    expect(results.find((r) => r.name === 'targeted-tests')?.exitCode).toBe(1)
  })

  it('NEGATIVE CONTROL: a failing authority verifier propagates FAIL', () => {
    const steps = composeSteps({ allow: [], tests: [], requireClean: false })
    const runner: StepRunner = (args) => (args.includes('authority:seal:verify') ? 1 : 0)
    const { pass } = runComposedSteps(steps, runner, '/fake/cwd')
    expect(pass).toBe(false)
  })

  it('NEGATIVE CONTROL: a failing scope gate propagates FAIL', () => {
    const steps = composeSteps({ base: 'deadbeef', allow: [], tests: [], requireClean: false })
    const runner: StepRunner = (args) => (args.includes('ods:scope') ? 1 : 0)
    const { pass } = runComposedSteps(steps, runner, '/fake/cwd')
    expect(pass).toBe(false)
  })

  it('NEGATIVE CONTROL: dirty state with --clean propagates FAIL', () => {
    const steps = composeSteps({ allow: [], tests: [], requireClean: true })
    const runner: StepRunner = (args) => (args.includes('ods:prestate') ? 1 : 0)
    const { pass, results } = runComposedSteps(steps, runner, '/fake/cwd')
    expect(pass).toBe(false)
    expect(results.find((r) => r.name === 'clean-state')?.exitCode).toBe(1)
  })

  it('does NOT stop early: a failure in one step does not prevent later steps from running', () => {
    const calls: string[] = []
    const steps = composeSteps({ base: 'deadbeef', allow: [], tests: [], requireClean: true })
    const runner: StepRunner = (args) => {
      calls.push(args.join(' '))
      return args.includes('typecheck') ? 1 : 0
    }
    runComposedSteps(steps, runner, '/fake/cwd')
    expect(calls.length).toBe(steps.length)
  })

  it('never catches a failure and converts it to success', () => {
    const steps = composeSteps({ allow: [], tests: [], requireClean: false })
    const runner: StepRunner = () => 1
    const { pass } = runComposedSteps(steps, runner, '/fake/cwd')
    expect(pass).toBe(false)
  })
})

describe('realRunner — real subprocess, pnpm-shim + quoting proof', () => {
  it('invokes a real pnpm command and returns its exit code (pnpm --version, exit 0)', () => {
    // Not routed through composeSteps: this proves the shell-quoting/pnpm-shim
    // mechanism itself works on this platform, independent of which pnpm
    // script is named. `pnpm run` would need a matching script in cwd's
    // package.json, so this uses the always-available `--version` form via a
    // minimal direct check instead of round-tripping through composeSteps.
    // Single-string form, matching realRunner's own quoting strategy — an
    // args array with shell:true would trigger Node's DEP0190 warning.
    const res = spawnSync('pnpm --version', { cwd: REPO_ROOT, encoding: 'utf8', shell: true })
    expect(res.status).toBe(0)
  })

  it('realRunner surfaces a non-zero exit code for a failing real pnpm script', () => {
    // ods:scope with no --base is a real, fast, deterministic usage-error
    // exit (2) from this project's own gate — a real non-zero code
    // travelling all the way back through realRunner's quoting/shell path.
    const exitCode = realRunner(['run', 'ods:scope'], REPO_ROOT)
    expect(exitCode).toBe(2)
  })

  it('realRunner returns 0 for a real passing pnpm script', () => {
    const exitCode = realRunner(['run', 'authority:seal:verify'], REPO_ROOT)
    expect(exitCode).toBe(0)
  })
})
