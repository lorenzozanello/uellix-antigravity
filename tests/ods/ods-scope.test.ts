// tests/ods/ods-scope.test.ts — ODS-C4 positive and negative controls.

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  matchesPattern,
  matchesAnyPattern,
  DEFAULT_PROTECTED_PATTERNS,
  classifyPaths,
  parseDiffNameStatusZ,
  parseStatusPorcelainZ,
  allTouchedPaths,
  collectChangedPaths,
  resolveProtectedGrant,
  getCurrentBranch,
  PROTECTED_GRANTS,
  type ProtectedGrant,
} from '../../scripts/ods-scope'
import { makeTempGitRepo, commitFile, cleanupTempGitRepo, git } from './git-fixture-helpers'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

describe('patternToRegExp / matchesPattern', () => {
  it('matches an exact literal path', () => {
    expect(matchesPattern('package.json', 'package.json')).toBe(true)
    expect(matchesPattern('package-lock.json', 'package.json')).toBe(false)
  })

  it('matches a trailing ** across any depth', () => {
    expect(matchesPattern('tests/ods/foo.test.ts', 'tests/ods/**')).toBe(true)
    expect(matchesPattern('tests/ods/nested/bar.ts', 'tests/ods/**')).toBe(true)
    expect(matchesPattern('tests/other/foo.ts', 'tests/ods/**')).toBe(false)
  })

  it('does not let ** cross a literal dot boundary incorrectly (dots are escaped)', () => {
    expect(matchesPattern('docs/ops/ods/ODS_V1_AUTHORITY_v1X0X0.json', 'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json')).toBe(false)
  })

  it('matchesAnyPattern is true if any pattern in the list matches', () => {
    expect(matchesAnyPattern('db/migrations/0001_x.sql', DEFAULT_PROTECTED_PATTERNS)).toBe(true)
    expect(matchesAnyPattern('lib/pipeline/x.ts', DEFAULT_PROTECTED_PATTERNS)).toBe(false)
  })
})

describe('classifyPaths', () => {
  const allowed = ['scripts/ods-scope.ts', 'tests/ods/**', 'package.json']

  it('PASS: only allowed paths classify as ok', () => {
    const result = classifyPaths(['scripts/ods-scope.ts', 'tests/ods/x.test.ts', 'package.json'], DEFAULT_PROTECTED_PATTERNS, allowed)
    expect(result.protectedViolations).toEqual([])
    expect(result.unauthorized).toEqual([])
    expect(result.ok.length).toBe(3)
  })

  it('NEGATIVE CONTROL: a protected db/prepared/** path is a violation even with no allowlist match needed', () => {
    const result = classifyPaths(['db/prepared/hosted/x.sql'], DEFAULT_PROTECTED_PATTERNS, allowed)
    expect(result.protectedViolations).toEqual(['db/prepared/hosted/x.sql'])
  })

  it('NEGATIVE CONTROL: a sealed docs/ops/fib/** path is a violation', () => {
    const result = classifyPaths(['docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md'], DEFAULT_PROTECTED_PATTERNS, allowed)
    expect(result.protectedViolations.length).toBe(1)
  })

  it('NEGATIVE CONTROL: the frozen ODS authority artifact is protected even though it is under docs/ops/ods/', () => {
    const result = classifyPaths(['docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'], DEFAULT_PROTECTED_PATTERNS, [
      ...allowed,
      'docs/ops/ods/**',
    ])
    // Even an allowlist that broadly covers docs/ops/ods/** cannot override
    // the exact-file protected pattern — protection is unconditional.
    expect(result.protectedViolations).toEqual(['docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'])
  })

  it('NEGATIVE CONTROL: an untracked path outside the allowlist is unauthorized', () => {
    const result = classifyPaths(['lib/admin/some-new-file.ts'], DEFAULT_PROTECTED_PATTERNS, allowed)
    expect(result.unauthorized).toEqual(['lib/admin/some-new-file.ts'])
  })

  it('deduplicates paths appearing more than once', () => {
    const result = classifyPaths(['package.json', 'package.json'], DEFAULT_PROTECTED_PATTERNS, allowed)
    expect(result.ok).toEqual(['package.json'])
  })
})

describe('parseDiffNameStatusZ / parseStatusPorcelainZ / allTouchedPaths', () => {
  it('parses simple add/modify/delete records', () => {
    const raw = ['A', 'new.ts', 'M', 'changed.ts', 'D', 'removed.ts'].join('\0') + '\0'
    const entries = parseDiffNameStatusZ(raw)
    expect(entries).toEqual([
      { status: 'A', path: 'new.ts' },
      { status: 'M', path: 'changed.ts' },
      { status: 'D', path: 'removed.ts' },
    ])
  })

  it('parses a rename record with both old and new paths', () => {
    const raw = ['R100', 'old/path.ts', 'new/path.ts'].join('\0') + '\0'
    const entries = parseDiffNameStatusZ(raw)
    expect(entries).toEqual([{ status: 'R100', path: 'new/path.ts', oldPath: 'old/path.ts' }])
    expect(allTouchedPaths(entries)).toEqual(['new/path.ts', 'old/path.ts'])
  })

  it('parses porcelain status records including a rename', () => {
    const raw = ['?? untracked.ts', ' M modified.ts', 'R  new.ts', 'old.ts'].join('\0') + '\0'
    const entries = parseStatusPorcelainZ(raw)
    expect(entries).toEqual([
      { status: '??', path: 'untracked.ts' },
      { status: ' M', path: 'modified.ts' },
      { status: 'R ', path: 'new.ts', oldPath: 'old.ts' },
    ])
  })

  it('handles empty input', () => {
    expect(parseDiffNameStatusZ('')).toEqual([])
    expect(parseStatusPorcelainZ('')).toEqual([])
  })
})

describe('collectChangedPaths + classifyPaths — real temporary git repo, POSITIVE and NEGATIVE', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  it('PASS: a change confined to an allowed path', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    commitFile(dir, 'scripts/allowed.ts', 'export const x = 1\n')

    const changed = collectChangedPaths(dir, base)
    const result = classifyPaths(changed, DEFAULT_PROTECTED_PATTERNS, ['scripts/allowed.ts'])
    expect(result.protectedViolations).toEqual([])
    expect(result.unauthorized).toEqual([])
  })

  it('NEGATIVE CONTROL: an untracked unauthorized file FAILS', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    mkdirSync(path.join(dir, 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'lib', 'unexpected.ts'), 'export {}\n')

    const changed = collectChangedPaths(dir, base)
    const result = classifyPaths(changed, DEFAULT_PROTECTED_PATTERNS, ['scripts/allowed.ts'])
    expect(result.unauthorized).toContain('lib/unexpected.ts')
  })

  it('NEGATIVE CONTROL: a real git rename INTO a protected surface cannot bypass enforcement', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    // Rename an allowed file so its new path lands inside a protected surface.
    mkdirSync(path.join(dir, 'db', 'prepared'), { recursive: true })
    git(dir, ['mv', 'scripts/allowed.ts', 'db/prepared/smuggled.sql'])
    git(dir, ['commit', '-q', '-m', 'rename into protected surface'])

    const changed = collectChangedPaths(dir, base)
    const result = classifyPaths(changed, DEFAULT_PROTECTED_PATTERNS, ['scripts/allowed.ts', 'db/prepared/smuggled.sql'])
    expect(result.protectedViolations).toContain('db/prepared/smuggled.sql')
  })

  it('NEGATIVE CONTROL: a real git rename OUT OF a protected surface is still flagged on the old path', () => {
    dir = makeTempGitRepo()
    mkdirSync(path.join(dir, 'db', 'prepared'), { recursive: true })
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    const base = commitFile(dir, 'db/prepared/original.sql', 'select 1;\n')
    git(dir, ['mv', 'db/prepared/original.sql', 'scripts/renamed-out.ts'])
    git(dir, ['commit', '-q', '-m', 'rename out of protected surface'])

    const changed = collectChangedPaths(dir, base)
    const result = classifyPaths(changed, DEFAULT_PROTECTED_PATTERNS, ['scripts/renamed-out.ts', 'db/prepared/original.sql'])
    expect(result.protectedViolations).toContain('db/prepared/original.sql')
  })
})

// NC-3 (see docs/ops/ods/ODS_V1_EFFICIENCY_VALIDATION_v1.0.0.json,
// benchmark_f_negative_control_value): the previous positive control here
// pinned --base to the ODS-01 freeze commit and ran against REPO_ROOT — the
// REAL, still-evolving ods/v1 branch. Every later authorized commit (a new
// script, CLAUDE.md, the checkpoint standard, ci.yml, the efficiency
// artifact...) grew the real diff, so the hand-maintained --allow list had
// to be updated by hand each time or the test went stale — four times
// across ODS-02/03/04. That coupling is the defect; scripts/ods-scope.ts
// itself was correct every time.
//
// Fixed by exercising the real CLI against a disposable temporary git
// repository instead of REPO_ROOT. These fixtures create every file they
// reference and never read the real ods/v1 working tree, so a completely
// unrelated file landing on that branch in some future authorized task
// cannot make any test below stale — there is nothing for it to enumerate.
// The real branch's actual authorized surface is still verified, per task,
// by running `pnpm ods:scope --base <task-base> --allow <task-surface>`
// directly (see e.g. the ODS-04 final-validation commands) — that is a
// task-time check, not something a permanent unit test should encode.
describe('ods:scope — real CLI, self-contained temporary-repo fixtures (decoupled from the evolving real ODS branch)', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  function runRealCli(cwd: string, args: string[]): { status: number | null; stdout: string } {
    const tsxCli = require.resolve('tsx/cli')
    const scriptAbsolutePath = path.join(REPO_ROOT, 'scripts', 'ods-scope.ts')
    const res = spawnSync(process.execPath, [tsxCli, scriptAbsolutePath, ...args], { cwd, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout }
  }

  it('POSITIVE: PASS when a self-contained fixture change is confined to an allowed path', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    commitFile(dir, 'scripts/allowed.ts', 'export const x = 1\n')

    const { status, stdout } = runRealCli(dir, ['--base', base, '--allow', 'scripts/allowed.ts'])

    expect(status).toBe(0)
    expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
    expect(stdout).toContain('UNAUTHORIZED_PATHS=0')
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })

  it('REGRESSION GUARD: this fixture never reads REPO_ROOT, so a new file on the real ods/v1 branch cannot make it stale', () => {
    // The property NC-3 violated, made explicit and checkable: the temp
    // repo is a different directory than REPO_ROOT, and the only path ever
    // referenced anywhere in this describe block is 'scripts/allowed.ts' —
    // a path this test creates itself, not one read from the real branch.
    dir = makeTempGitRepo()
    expect(dir).not.toBe(REPO_ROOT)
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    const { status } = runRealCli(dir, ['--base', base, '--allow', 'scripts/allowed.ts'])
    expect(status).toBe(0)
  })

  it('NEGATIVE: an unauthorized untracked file FAILS', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    mkdirSync(path.join(dir, 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'lib', 'unexpected.ts'), 'export {}\n')

    const { status, stdout } = runRealCli(dir, ['--base', base, '--allow', 'scripts/allowed.ts'])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('UNAUTHORIZED_PATH=lib/unexpected.ts')
  })

  it('NEGATIVE: a protected db/prepared/** path FAILS even when named in --allow', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    commitFile(dir, 'db/prepared/change.sql', 'select 1;\n')

    // Naming the protected path explicitly in --allow must not override
    // DEFAULT_PROTECTED_PATTERNS — protection here is unconditional.
    const { status, stdout } = runRealCli(dir, ['--base', base, '--allow', 'scripts/allowed.ts', '--allow', 'db/prepared/change.sql'])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/change.sql')
  })

  it('NEGATIVE: a rename crossing into a protected surface FAILS on the new path', () => {
    dir = makeTempGitRepo()
    mkdirSync(path.join(dir, 'db', 'prepared'), { recursive: true })
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    git(dir, ['mv', 'scripts/allowed.ts', 'db/prepared/smuggled.sql'])
    git(dir, ['commit', '-q', '-m', 'rename into protected surface'])

    const { status, stdout } = runRealCli(dir, [
      '--base',
      base,
      '--allow',
      'scripts/allowed.ts',
      '--allow',
      'db/prepared/smuggled.sql',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/smuggled.sql')
  })

  it('NEGATIVE CONTROL: real CLI FAILS when the allowlist omits a real changed file', () => {
    const tsxCli = require.resolve('tsx/cli')
    const res = spawnSync(
      process.execPath,
      [tsxCli, 'scripts/ods-scope.ts', '--base', '2aecf625a49ec673fd4185052e71ec6e5c750edf', '--allow', 'package.json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('ODS_SCOPE=FAIL')
    expect(res.stdout).toMatch(/UNAUTHORIZED_PATH=/)
  })

  it('real CLI exits 2 with a usage error when --base is missing', () => {
    const tsxCli = require.resolve('tsx/cli')
    const res = spawnSync(process.execPath, [tsxCli, 'scripts/ods-scope.ts', '--allow', 'package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(res.status).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// HPO-ODS-W2-01 — protected-surface explicit grants
// (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json).
// ---------------------------------------------------------------------------

describe('resolveProtectedGrant — pure', () => {
  const AUTHORIZED_BRANCH = 'codex/w2-methodology-objects-r1'

  it('the frozen registry contains exactly the HPO-ODS-W2-01 grant', () => {
    expect(PROTECTED_GRANTS).toEqual([
      { authorityId: 'HPO-ODS-W2-01', branch: AUTHORIZED_BRANCH, patterns: ['db/migrations/**', 'db/prepared/journal/**'] },
    ])
  })

  it('resolves the known authority on its granted branch', () => {
    const result = resolveProtectedGrant('HPO-ODS-W2-01', AUTHORIZED_BRANCH)
    expect(result.grant).toBeDefined()
    expect(result.grant?.patterns).toEqual(['db/migrations/**', 'db/prepared/journal/**'])
  })

  it('NEGATIVE (PG-2 basis): an unknown authority id resolves to no grant', () => {
    const result = resolveProtectedGrant('NOT-A-REAL-AUTHORITY', AUTHORIZED_BRANCH)
    expect(result.grant).toBeUndefined()
  })

  it('NEGATIVE (PG-3 basis): the known authority on the wrong branch resolves to no grant', () => {
    const result = resolveProtectedGrant('HPO-ODS-W2-01', 'main')
    expect(result.grant).toBeUndefined()
  })

  it('no authority supplied resolves to no grant', () => {
    const result = resolveProtectedGrant(undefined, AUTHORIZED_BRANCH)
    expect(result.grant).toBeUndefined()
  })
})

describe('classifyPaths with a resolved grant — pure', () => {
  const grant: ProtectedGrant = {
    authorityId: 'HPO-ODS-W2-01',
    branch: 'codex/w2-methodology-objects-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  }
  const taskAllow = ['db/migrations/0099_x.sql', 'db/prepared/journal/x.sql']

  it('PG-P: grant covers the path AND ordinary --allow covers it => authorized', () => {
    const result = classifyPaths(['db/prepared/journal/x.sql'], DEFAULT_PROTECTED_PATTERNS, taskAllow, grant)
    expect(result.protectedViolations).toEqual([])
    expect(result.grantAuthorized).toEqual(['db/prepared/journal/x.sql'])
    expect(result.ok).toContain('db/prepared/journal/x.sql')
  })

  it('PG-1: no grant at all, even with a matching ordinary --allow => violation', () => {
    const result = classifyPaths(['db/prepared/journal/x.sql'], DEFAULT_PROTECTED_PATTERNS, taskAllow, undefined)
    expect(result.protectedViolations).toEqual(['db/prepared/journal/x.sql'])
    expect(result.grantAuthorized).toEqual([])
  })

  it('PG-5: grant covers the path but ordinary --allow does NOT => violation', () => {
    const result = classifyPaths(['db/prepared/journal/x.sql'], DEFAULT_PROTECTED_PATTERNS, ['db/migrations/0099_x.sql'], grant)
    expect(result.protectedViolations).toEqual(['db/prepared/journal/x.sql'])
  })

  it('PG-6 (subset escape): a grant for db/prepared/journal/** must NOT authorize a db/prepared/ sibling', () => {
    const result = classifyPaths(['db/prepared/sibling.sql'], DEFAULT_PROTECTED_PATTERNS, [...taskAllow, 'db/prepared/sibling.sql'], grant)
    expect(result.protectedViolations).toEqual(['db/prepared/sibling.sql'])
    expect(result.grantAuthorized).toEqual([])
  })

  it('PG-7: the grant must NOT authorize db/baseline/**', () => {
    const result = classifyPaths(['db/baseline/x.sql'], DEFAULT_PROTECTED_PATTERNS, [...taskAllow, 'db/baseline/x.sql'], grant)
    expect(result.protectedViolations).toEqual(['db/baseline/x.sql'])
  })

  it('PG-4: an ungranted protected pattern (docs/ops/fib/**) is refused even with this grant active', () => {
    const result = classifyPaths(
      ['docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md'],
      DEFAULT_PROTECTED_PATTERNS,
      [...taskAllow, 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md'],
      grant,
    )
    expect(result.protectedViolations).toEqual(['docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md'])
  })
})

describe('getCurrentBranch — real temp repo', () => {
  let dir: string
  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  it('reads the actual current branch, never a caller-supplied claim', () => {
    dir = makeTempGitRepo()
    commitFile(dir, 'a.txt', 'x\n')
    git(dir, ['checkout', '-b', 'codex/w2-methodology-objects-r1'])
    expect(getCurrentBranch(dir)).toBe('codex/w2-methodology-objects-r1')
  })
})

describe('ods:scope --protected-authority — real CLI, temporary-repo fixtures, PG-1..PG-7 and PG-P', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  function runRealCli(cwd: string, args: string[]): { status: number | null; stdout: string } {
    const tsxCli = require.resolve('tsx/cli')
    const scriptAbsolutePath = path.join(REPO_ROOT, 'scripts', 'ods-scope.ts')
    const res = spawnSync(process.execPath, [tsxCli, scriptAbsolutePath, ...args], { cwd, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout }
  }

  /** A temp repo already checked out to the grant's authorized branch, with one base commit. */
  function makeGrantedBranchRepo(): { dir: string; base: string } {
    const d = makeTempGitRepo()
    const base = commitFile(d, 'README.md', 'seed\n')
    git(d, ['checkout', '-b', 'codex/w2-methodology-objects-r1'])
    return { dir: d, base }
  }

  it('PG-P (POSITIVE): correct authority + correct branch + granted protected subset + ordinary --allow => PASS', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/fixture.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/prepared/journal/fixture.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(0)
    expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-01')
    expect(stdout).toContain('PROTECTED_AUTHORIZED_PATH_COUNT=1')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })

  it('PG-1 (NEGATIVE): protected path + normal --allow only (no --protected-authority) => FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/fixture.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, ['--base', g.base, '--allow', 'db/prepared/journal/fixture.sql'])

    expect(status).toBe(1)
    expect(stdout).toContain('PROTECTED_AUTHORITY=NONE')
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/journal/fixture.sql')
  })

  it('PG-2 (NEGATIVE): unknown protected authority => FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/fixture.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/prepared/journal/fixture.sql',
      '--protected-authority',
      'NOT-A-REAL-AUTHORITY',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('PG-3 (NEGATIVE): correct authority on the wrong branch => FAIL', () => {
    dir = makeTempGitRepo() // default branch, NOT codex/w2-methodology-objects-r1
    const base = commitFile(dir, 'README.md', 'seed\n')
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/fixture.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      base,
      '--allow',
      'db/prepared/journal/fixture.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('PG-4 (NEGATIVE): correct authority attempts an ungranted protected path (db/migrations vs a fib doc) => FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'docs', 'ops', 'fib'), { recursive: true })
    commitFile(dir, 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md', 'x\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md')
  })

  it('PG-5 (NEGATIVE): correct authority/grant but the protected path is missing from ordinary --allow => FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/fixture.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'README.md', // does NOT cover the changed protected path
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/journal/fixture.sql')
  })

  it('PG-6 (NEGATIVE, subset escape): grant for db/prepared/journal/** must NOT authorize db/prepared/sibling.sql', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared'), { recursive: true })
    commitFile(dir, 'db/prepared/sibling.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/prepared/sibling.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/sibling.sql')
  })

  it('PG-7 (NEGATIVE): the grant must NOT authorize db/baseline/**', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'baseline'), { recursive: true })
    commitFile(dir, 'db/baseline/x.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/baseline/x.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/baseline/x.sql')
  })

  it('realistic Wave-2-style control: db/migrations + db/prepared/journal together => PASS; adding a sibling => FAIL', () => {
    const g = makeGrantedBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/migrations/0100_fixture.sql', 'create table x();\n')
    commitFile(dir, 'db/prepared/journal/003_fixture.sql', 'select 1;\n')

    const passArgs = [
      '--base',
      g.base,
      '--allow',
      'db/migrations/0100_fixture.sql',
      '--allow',
      'db/prepared/journal/003_fixture.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ]
    const passResult = runRealCli(dir, passArgs)
    expect(passResult.status).toBe(0)
    expect(passResult.stdout).toContain('ODS_SCOPE=PASS')

    // Now add an ungranted sibling under db/prepared/ (outside journal/).
    commitFile(dir, 'db/prepared/sibling.sql', 'select 2;\n')
    const failResult = runRealCli(dir, [...passArgs, '--allow', 'db/prepared/sibling.sql'])
    expect(failResult.status).toBe(1)
    expect(failResult.stdout).toContain('ODS_SCOPE=FAIL')
    expect(failResult.stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/sibling.sql')
  })
})
