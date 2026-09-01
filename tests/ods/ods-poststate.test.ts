// tests/ods/ods-poststate.test.ts — ODS-C3 positive and negative controls.
//
// Composition/propagation logic is tested with an injected fake runner (no
// real typecheck/test/secrets-scan/etc. process spawned per case — that
// would be slow and is exactly what composeSteps/runComposedSteps being pure
// and dependency-injected is for). The real subprocess path (quoting,
// pnpm-shim invocation) is proven separately with one real, cheap command.

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  composeSteps,
  runComposedSteps,
  realRunner,
  resolveLocalCompiler,
  runLocalTypecheck,
  runGovernedTypecheck,
  type StepRunner,
} from '../../scripts/ods-poststate'

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

// ---------------------------------------------------------------------------
// HPO-ODS-TOOLCHAIN-02 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json).
// Refines HPO-ODS-TOOLCHAIN-01; does not revoke it.
//
// Measured directly before implementing: a fixture with a GENUINE-LOOKING
// node_modules/typescript/package.json (declaring name "typescript") but
// NO compiler entry at all still passed the v1.0.1 present-check, and
// `pnpm run typecheck` in that same directory returned exit 0 via an
// ambient global tsc. Proving the package exists is not proving the
// compiler that ran was local — these tests prove the stronger claim.
// ---------------------------------------------------------------------------

function writePackageJson(dir: string, contents: unknown): void {
  const nm = path.join(dir, 'node_modules', 'typescript')
  mkdirSync(nm, { recursive: true })
  writeFileSync(path.join(nm, 'package.json'), typeof contents === 'string' ? contents : JSON.stringify(contents))
}

function writeCompilerEntry(dir: string, scriptBody: string): void {
  const nm = path.join(dir, 'node_modules', 'typescript', 'bin')
  mkdirSync(nm, { recursive: true })
  writeFileSync(path.join(nm, 'tsc'), scriptBody)
}

/** A disposable fixture that reproduces "a fresh worktree with no `pnpm install` yet run" — a real package.json + tsconfig + source file, deliberately no node_modules. */
function makeToolchainAbsentFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ods-toolchain-fixture-'))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { typecheck: 'tsc --noEmit' } }))
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }))
  writeFileSync(path.join(dir, 'a.ts'), 'export const x: number = 1\n')
  return dir
}

describe('resolveLocalCompiler — pure filesystem check, TC2-1..TC2-4', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('POSITIVE: present=true for the real ODS project, with real identity fields', () => {
    const result = resolveLocalCompiler(REPO_ROOT)
    expect(result.present).toBe(true)
    expect(result.packagePath).toBe('node_modules/typescript/package.json')
    expect(result.compilerEntry).toBe('node_modules/typescript/bin/tsc')
    expect(typeof result.version).toBe('string')
    expect(result.version!.length).toBeGreaterThan(0)
  })

  it('TC2-1 (NEGATIVE): node_modules absent entirely', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-1-'))
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
    expect(result.reason).toContain('node_modules/typescript/package.json')
    expect(result.reason).toContain('pnpm install --frozen-lockfile')
  })

  it('TC2-2 (NEGATIVE): typescript directory exists but package.json is absent', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-2-'))
    mkdirSync(path.join(dir, 'node_modules', 'typescript'), { recursive: true })
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
    expect(result.reason).toContain('not found')
  })

  it('TC2-3 (NEGATIVE): malformed package.json (not JSON)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-3-badjson-'))
    writePackageJson(dir, 'not json')
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
    expect(result.reason).toContain('not valid JSON')
  })

  it('TC2-3 (NEGATIVE): wrong package name', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-3-wrongname-'))
    writePackageJson(dir, { name: 'not-typescript', version: '1.0.0' })
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
    expect(result.reason).toContain('not-typescript')
  })

  it('TC2-3 (NEGATIVE): missing/empty version', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-3-noversion-'))
    writePackageJson(dir, { name: 'typescript' })
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
    expect(result.reason).toContain('version')
  })

  it('TC2-4 (NEGATIVE): valid package metadata but compiler entry absent', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-4-'))
    writePackageJson(dir, { name: 'typescript', version: '5.9.3' })
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
    expect(result.reason).toContain('node_modules/typescript/bin/tsc')
    expect(result.reason).toContain('compiler entry is not')
  })

  it('TC2-4 (NEGATIVE): compiler entry path exists but is a directory, not a file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-4-dir-'))
    writePackageJson(dir, { name: 'typescript', version: '5.9.3' })
    mkdirSync(path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), { recursive: true })
    const result = resolveLocalCompiler(dir)
    expect(result.present).toBe(false)
  })
})

describe('runLocalTypecheck / runGovernedTypecheck — TC2-5/TC2-6, real execution proof', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('TC2-5: a genuine local package+compiler with NO .bin shim, and a DIFFERENT global tsc available, executes the LOCAL compiler', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ods-tc2-5-'))
    const FIXTURE_VERSION = '9.9.9-local-fixture-distinct-from-global'
    writePackageJson(dir, { name: 'typescript', version: FIXTURE_VERSION })
    // A stub compiler entry: proves BY SIDE EFFECT that this exact file
    // executed (not a global tsc), by writing a marker into the fixture's
    // own cwd — deterministic, no unsafe filesystem operation, no reliance
    // on capturing an inherited child stdio stream.
    writeCompilerEntry(dir, "require('fs').writeFileSync('STUB_TSC_EXECUTED.marker', 'stub-executed')\nprocess.exit(0)\n")
    // Deliberately NO node_modules/.bin/tsc — proves the shim is not required.
    expect(existsSync(path.join(dir, 'node_modules', '.bin', 'tsc'))).toBe(false)

    // Sanity: a real global tsc exists and reports a DIFFERENT version —
    // if the guard ever fell through to it, the marker file would be
    // absent and this fixture's distinct version would not have been read.
    const globalVersion = spawnSync('tsc --version', { encoding: 'utf8', shell: true }).stdout.trim()
    expect(globalVersion).not.toContain(FIXTURE_VERSION)

    const resolution = resolveLocalCompiler(dir)
    expect(resolution.present).toBe(true)
    expect(resolution.version).toBe(FIXTURE_VERSION)

    const exitCode = runLocalTypecheck(dir, resolution.compilerEntry as string)
    expect(exitCode).toBe(0)
    const markerPath = path.join(dir, 'STUB_TSC_EXECUTED.marker')
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf8')).toBe('stub-executed')
  })

  it('TC2-6 (NEGATIVE): ambient/global tsc returns 0 in the fixture, but local compiler is unavailable => governed typecheck FAILs', () => {
    dir = makeToolchainAbsentFixture()

    // Confirm the ambient success this must NOT be fooled by.
    const ambient = spawnSync('pnpm run typecheck', { cwd: dir, encoding: 'utf8', shell: true })
    expect(ambient.status).toBe(0)

    // The governed path must fail regardless.
    expect(runGovernedTypecheck(dir)).not.toBe(0)
  })

  it('TC2-P (POSITIVE): real local installation — identity reported, local compiler executes, and PASSES', () => {
    const resolution = resolveLocalCompiler(REPO_ROOT)
    expect(resolution.present).toBe(true)
    const exitCode = runGovernedTypecheck(REPO_ROOT)
    expect(exitCode).toBe(0)
  }, 60_000)
})

describe('realRunner — governed typecheck routed through runGovernedTypecheck, TC-1/TC-2 equivalents', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('AMBIENT_COMPILER_CAN_INFLUENCE_GOVERNED_TYPECHECK=NO: realRunner blocks the false PASS this guards against', () => {
    dir = makeToolchainAbsentFixture()
    const unguarded = spawnSync('pnpm run typecheck', { cwd: dir, encoding: 'utf8', shell: true })
    expect(unguarded.status).toBe(0) // the false PASS, reproduced
    expect(realRunner(['run', 'typecheck'], dir)).not.toBe(0) // realRunner is not fooled
  })

  it('realRunner fails the typecheck step when the local toolchain is absent', () => {
    dir = makeToolchainAbsentFixture()
    expect(realRunner(['run', 'typecheck'], dir)).not.toBe(0)
  })

  it('realRunner executes the real local typecheck when the toolchain is present', () => {
    expect(realRunner(['run', 'typecheck'], REPO_ROOT)).toBe(0)
  }, 60_000)

  it('the compiler guard is scoped to the typecheck step only — other steps are unaffected', () => {
    dir = makeToolchainAbsentFixture()
    // ods:scope isn't gated by this guard at all; it simply isn't a
    // resolvable script in this bare fixture, which is a DIFFERENT,
    // unrelated failure mode (pnpm script-not-found).
    expect(realRunner(['run', 'ods:scope'], dir)).not.toBe(0)
  })
})

describe('local-compiler prerequisite failure propagates to overall pass=false', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('a single-step composition using the REAL runner against a compiler-absent fixture fails overall', () => {
    dir = makeToolchainAbsentFixture()
    const { pass, results } = runComposedSteps([{ name: 'typecheck', pnpmArgs: ['run', 'typecheck'] }], realRunner, dir)
    expect(pass).toBe(false)
    expect(results[0].exitCode).not.toBe(0)
  })
})
