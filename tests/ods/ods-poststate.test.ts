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
  type PoststateInput,
} from '../../scripts/ods-poststate'
import { git, makeTempGitRepo, commitFile, cleanupTempGitRepo } from './git-fixture-helpers'

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

// ---------------------------------------------------------------------------
// HPO-ODS-POSTSTATE-01 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json).
//
// ods:poststate never adjudicates the grant itself — it only forwards the
// exact --protected-authority identifier to its composed ods:scope step.
// A disposable temp-git-repo fixture (never the real Lane A worktree —
// no Wave 2 write is authorized) proves the EXACT args composeSteps
// produces, when actually given to the real ods:scope gate, behave
// correctly — not merely that the args look right in isolation.
// ---------------------------------------------------------------------------

describe('composeSteps — --protected-authority passthrough, pure', () => {
  it('forwards the exact identifier onto the composed ods-scope step only when supplied', () => {
    const steps = composeSteps({ base: 'deadbeef', allow: ['db/migrations/x.sql'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' })
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).toEqual([
      'run',
      'ods:scope',
      '--',
      '--base',
      'deadbeef',
      '--allow',
      'db/migrations/x.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])
  })

  it('omits --protected-authority from the ods-scope step when not supplied (preserves current behavior)', () => {
    const steps = composeSteps({ base: 'deadbeef', allow: ['x'], tests: [], requireClean: false })
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).not.toContain('--protected-authority')
  })

  it('never forwards the identifier to any OTHER composed step', () => {
    const steps = composeSteps({
      base: 'deadbeef',
      allow: ['db/migrations/x.sql'],
      tests: ['t.ts'],
      requireClean: true,
      protectedAuthority: 'HPO-ODS-W2-01',
    })
    for (const step of steps) {
      if (step.name === 'ods-scope') continue
      expect(step.pnpmArgs).not.toContain('--protected-authority')
      expect(step.pnpmArgs).not.toContain('HPO-ODS-W2-01')
    }
  })
})

describe('poststate --protected-authority CLI — missing-operand hardening', () => {
  const tsxCli = require.resolve('tsx/cli')
  const run = (args: string[]) => spawnSync(process.execPath, [tsxCli, 'scripts/ods-poststate.ts', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })

  it('trailing --protected-authority with nothing after it is a usage error, not silently NONE', () => {
    const res = run(['--base', 'deadbeef', '--allow', 'x', '--protected-authority'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('--protected-authority requires a value')
  })

  it('--protected-authority immediately followed by another recognized flag is rejected, not misparsed as a value', () => {
    const res = run(['--protected-authority', '--clean'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('--protected-authority requires a value')
  })

  it('--protected-authority without --base is a usage error (nothing to attach it to)', () => {
    const res = run(['--protected-authority', 'HPO-ODS-W2-01'])
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('ODS_POSTSTATE=USAGE_ERROR')
  })
})

describe('poststate protected-authority passthrough — real integration, disposable Wave-2-shaped fixture, PSA-1..PSA-5, PSA-P1..P3', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  /** Extracts the args a would compose for the ods-scope step, strips the 'run ods:scope --' wrapper, and runs the REAL ods-scope.ts against `cwd` — proving the exact composed args, not just their shape. */
  function runComposedOdsScopeDirectly(input: PoststateInput, cwd: string): { status: number | null; stdout: string } {
    const steps = composeSteps(input)
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    if (!scopeStep) throw new Error('composeSteps produced no ods-scope step for this input')
    const args = scopeStep.pnpmArgs.slice(3) // drop ['run', 'ods:scope', '--']
    const tsxCli = require.resolve('tsx/cli')
    const scriptAbsolutePath = path.join(REPO_ROOT, 'scripts', 'ods-scope.ts')
    const res = spawnSync(process.execPath, [tsxCli, scriptAbsolutePath, ...args], { cwd, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout }
  }

  function makeGrantedBranchRepo(): { dir: string; base: string } {
    const d = makeTempGitRepo()
    const base = commitFile(d, 'README.md', 'seed\n')
    git(d, ['checkout', '-b', 'codex/w2-methodology-objects-r1'])
    return { dir: d, base }
  }

  it('PSA-1: protected migration + ordinary allow but NO protected authority => scope sub-step FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base: g.base, allow: ['db/migrations/0100_fixture.sql'], tests: [], requireClean: false },
      dir,
    )
    expect(status).not.toBe(0)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('PSA-2: unknown protected authority => scope sub-step FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base: g.base, allow: ['db/migrations/0100_fixture.sql'], tests: [], requireClean: false, protectedAuthority: 'NOT-REAL' },
      dir,
    )
    expect(status).not.toBe(0)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('PSA-3: correct authority on the wrong branch => scope sub-step FAIL', () => {
    dir = makeTempGitRepo() // NOT checked out to codex/w2-methodology-objects-r1
    const base = commitFile(dir, 'README.md', 'seed\n')
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base, allow: ['db/migrations/0100_fixture.sql'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' },
      dir,
    )
    expect(status).not.toBe(0)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('PSA-4: correct authority but an ungranted protected path (db/prepared/ sibling) => scope sub-step FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared'), { recursive: true })
    commitFile(dir, 'db/prepared/sibling.sql', 'select 1;\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base: g.base, allow: ['db/prepared/sibling.sql'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' },
      dir,
    )
    expect(status).not.toBe(0)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/sibling.sql')
  })

  it('PSA-5: correct authority + granted path but missing ordinary task allow => scope sub-step FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base: g.base, allow: ['README.md'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' },
      dir,
    )
    expect(status).not.toBe(0)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('PSA-P1: correct branch + HPO-ODS-W2-01 + db/migrations/<fixture> + ordinary allow => scope sub-step PASS', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base: g.base, allow: ['db/migrations/0100_fixture.sql'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' },
      dir,
    )
    expect(status).toBe(0)
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })

  it('PSA-P2: same for db/prepared/journal/<fixture> => scope sub-step PASS', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/003_fixture.sql', 'select 1;\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      { base: g.base, allow: ['db/prepared/journal/003_fixture.sql'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' },
      dir,
    )
    expect(status).toBe(0)
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })

  it('PSA-P3: both granted surfaces together with exact task allows => scope sub-step PASS', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')
    commitFile(dir, 'db/prepared/journal/003_fixture.sql', 'select 1;\n')

    const { status, stdout } = runComposedOdsScopeDirectly(
      {
        base: g.base,
        allow: ['db/migrations/0100_fixture.sql', 'db/prepared/journal/003_fixture.sql'],
        tests: [],
        requireClean: false,
        protectedAuthority: 'HPO-ODS-W2-01',
      },
      dir,
    )
    expect(status).toBe(0)
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })
})

// ---------------------------------------------------------------------------
// COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M1).
//
// poststate does not resolve or union grants itself — it only has to widen
// its own CLI/composition to forward every supplied id to the composed
// ods:scope step, which remains the sole adjudicator. The deprecated
// scalar `protectedAuthority` field keeps every PSA-* test above working
// unchanged; `protectedAuthorities` is the new plural field, unioned with
// the scalar (not overriding it) so nothing regresses.
// ---------------------------------------------------------------------------

describe('composeSteps — multi-grant --protected-authority passthrough, pure (M1)', () => {
  it('M1-P1: a single id in the new plural field produces the exact same single flag as the deprecated scalar field', () => {
    const viaScalar = composeSteps({ base: 'deadbeef', allow: ['x'], tests: [], requireClean: false, protectedAuthority: 'HPO-ODS-W2-01' })
    const viaPlural = composeSteps({ base: 'deadbeef', allow: ['x'], tests: [], requireClean: false, protectedAuthorities: ['HPO-ODS-W2-01'] })
    expect(viaPlural.find((s) => s.name === 'ods-scope')?.pnpmArgs).toEqual(viaScalar.find((s) => s.name === 'ods-scope')?.pnpmArgs)
  })

  it('M1-P2/M1-P3: every id in the plural list is forwarded as its OWN --protected-authority flag, in order', () => {
    const steps = composeSteps({
      base: 'deadbeef',
      allow: ['x'],
      tests: [],
      requireClean: false,
      protectedAuthorities: ['HPO-ODS-W2-08', 'HPO-ODS-W2-09'],
    })
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).toEqual([
      'run', 'ods:scope', '--', '--base', 'deadbeef', '--allow', 'x',
      '--protected-authority', 'HPO-ODS-W2-08',
      '--protected-authority', 'HPO-ODS-W2-09',
    ])
  })

  it('M1-N3: a duplicated id in the plural list is forwarded twice, deterministically (ods:scope handles the union without double-counting)', () => {
    const steps = composeSteps({
      base: 'deadbeef', allow: ['x'], tests: [], requireClean: false,
      protectedAuthorities: ['HPO-ODS-W2-01', 'HPO-ODS-W2-01'],
    })
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    const occurrences = scopeStep!.pnpmArgs.filter((a) => a === 'HPO-ODS-W2-01').length
    expect(occurrences).toBe(2)
  })

  it('the deprecated scalar and the new plural field are UNIONED, not one overriding the other', () => {
    const steps = composeSteps({
      base: 'deadbeef', allow: ['x'], tests: [], requireClean: false,
      protectedAuthority: 'HPO-ODS-W2-08',
      protectedAuthorities: ['HPO-ODS-W2-09'],
    })
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).toEqual([
      'run', 'ods:scope', '--', '--base', 'deadbeef', '--allow', 'x',
      '--protected-authority', 'HPO-ODS-W2-08',
      '--protected-authority', 'HPO-ODS-W2-09',
    ])
  })

  it('omits --protected-authority entirely when neither field is supplied (preserves current behavior)', () => {
    const steps = composeSteps({ base: 'deadbeef', allow: ['x'], tests: [], requireClean: false })
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).not.toContain('--protected-authority')
  })

  it('never forwards any plural-list identifier to any OTHER composed step', () => {
    const steps = composeSteps({
      base: 'deadbeef', allow: ['x'], tests: ['t.ts'], requireClean: true,
      protectedAuthorities: ['HPO-ODS-W2-08', 'HPO-ODS-W2-09'],
    })
    for (const step of steps) {
      if (step.name === 'ods-scope') continue
      expect(step.pnpmArgs).not.toContain('--protected-authority')
      expect(step.pnpmArgs).not.toContain('HPO-ODS-W2-08')
      expect(step.pnpmArgs).not.toContain('HPO-ODS-W2-09')
    }
  })
})

describe('poststate --protected-authority CLI — repeated flag accumulates (M1)', () => {
  const tsxCli = require.resolve('tsx/cli')
  const run = (args: string[]) => spawnSync(process.execPath, [tsxCli, 'scripts/ods-poststate.ts', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })

  it('a single --protected-authority still behaves exactly as a usage error path when supplied without --base', () => {
    const res = run(['--protected-authority', 'HPO-ODS-W2-08'])
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('ODS_POSTSTATE=USAGE_ERROR')
  })

  it('two repeated --protected-authority flags without --base is still the same usage error (accumulation does not change the guard)', () => {
    const res = run(['--protected-authority', 'HPO-ODS-W2-08', '--protected-authority', 'HPO-ODS-W2-09'])
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('ODS_POSTSTATE=USAGE_ERROR')
  })
})

describe('M1-E2E-POSTSTATE: ods:poststate forwards BOTH HPO-ODS-W2-08 and HPO-ODS-W2-09 to one canonical ods:scope invocation — real subprocess', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  /** Extracts the args composeSteps would compose for the ods-scope step, strips the 'run ods:scope --' wrapper, and runs the REAL ods-scope.ts against `cwd` — proving the exact composed multi-flag args, not just their shape. */
  function runComposedOdsScopeDirectly(input: PoststateInput, cwd: string): { status: number | null; stdout: string } {
    const steps = composeSteps(input)
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    if (!scopeStep) throw new Error('composeSteps produced no ods-scope step for this input')
    const args = scopeStep.pnpmArgs.slice(3) // drop ['run', 'ods:scope', '--']
    const tsxCli = require.resolve('tsx/cli')
    const scriptAbsolutePath = path.join(REPO_ROOT, 'scripts', 'ods-scope.ts')
    const res = spawnSync(process.execPath, [tsxCli, scriptAbsolutePath, ...args], { cwd, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout }
  }

  it('composeSteps alone: --base + repeated --protected-authority produces the exact ods-scope subprocess args ods:scope needs for the union proof', () => {
    const input: PoststateInput = {
      base: 'deadbeef',
      allow: ['a', 'b'],
      tests: [],
      requireClean: false,
      protectedAuthorities: ['HPO-ODS-W2-08', 'HPO-ODS-W2-09'],
    }
    const steps = composeSteps(input)
    const scopeStep = steps.find((s) => s.name === 'ods-scope')
    expect(scopeStep?.pnpmArgs).toEqual([
      'run', 'ods:scope', '--', '--base', 'deadbeef',
      '--allow', 'a', '--allow', 'b',
      '--protected-authority', 'HPO-ODS-W2-08',
      '--protected-authority', 'HPO-ODS-W2-09',
    ])
  })

  it('real ods:scope subprocess, invoked with the args composeSteps produced: the exact Wave2 reconciliation union PASSes in one poststate-composed run', () => {
    const d = makeTempGitRepo()
    const base = commitFile(d, 'README.md', 'seed\n')
    git(d, ['checkout', '-b', 'codex/commercial-v1-wave2-reconciliation-r1'])
    dir = d

    // A representative subset from each grant, including the one path the
    // real grants share (db/migrations/meta/_journal.json) — proves the
    // composed multi-flag call authorizes a real cross-grant union, not
    // just a single grant's own surface.
    const paths = [
      'db/migrations/0060_fib_outcome_monetization_dispositions_governance.sql', // W2-08 only
      'db/migrations/meta/_journal.json', // shared by both grants
      'db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql', // W2-09 only
    ]
    for (const p of paths) {
      mkdirSync(path.join(dir, path.dirname(p)), { recursive: true })
      writeFileSync(path.join(dir, p), `-- fixture for ${p}\n`)
    }
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'representative cross-grant fixture'])

    const input: PoststateInput = { base, allow: paths, tests: [], requireClean: false, protectedAuthorities: ['HPO-ODS-W2-08', 'HPO-ODS-W2-09'] }
    const { status, stdout } = runComposedOdsScopeDirectly(input, dir)

    expect(status).toBe(0)
    expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-08,HPO-ODS-W2-09')
    expect(stdout).toContain('ODS_SCOPE=PASS')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
  })
})
