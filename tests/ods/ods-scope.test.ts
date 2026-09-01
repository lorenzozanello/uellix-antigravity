// tests/ods/ods-scope.test.ts — ODS-C4 positive and negative controls.

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  matchesPattern,
  matchesAnyPattern,
  matchesAnyPatternCaseInsensitive,
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

  it('the frozen registry contains exactly the HPO-ODS-W2-01 grant, unchanged, plus the successor HPO-ODS-W2-02 grant', () => {
    expect(PROTECTED_GRANTS.length).toBe(2)
    expect(PROTECTED_GRANTS[0]).toEqual({
      authorityId: 'HPO-ODS-W2-01',
      branch: AUTHORIZED_BRANCH,
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    })
    const w2_02 = PROTECTED_GRANTS[1]
    expect(w2_02.authorityId).toBe('HPO-ODS-W2-02')
    expect(w2_02.branch).toBe('codex/u0-u9-reengineering-resume-r1')
    expect(w2_02.patterns.length).toBe(75)
    // No glob syntax anywhere in the W2-02 grant — every entry is an exact literal path.
    expect(w2_02.patterns.every((p) => !p.includes('*'))).toBe(true)
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

// ---------------------------------------------------------------------------
// HPO-ODS-C4-CASE-01 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json).
//
// Measured before implementing: matchesAnyPattern(path, DEFAULT_PROTECTED_PATTERNS)
// returned NOT-PROTECTED for DB/migrations/x.sql, db/Migrations/x.sql,
// DB/prepared/journal/x.sql and DB/baseline/x.sql — a case-variant path
// could avoid every protected classifier on a case-sensitive host, and the
// bypass is not limited to migrations: db/baseline/**, a surface no
// authority grants, was equally reachable via DB/baseline/. Detection
// becomes case-insensitive below; authorization stays bound to canonical
// concrete paths only — a non-canonical protected path FAILs even under a
// valid grant.
// ---------------------------------------------------------------------------

describe('case-insensitive protected-surface detection — pure, covers ALL DEFAULT_PROTECTED_PATTERNS', () => {
  // One representative non-canonical variant per pattern, matching the
  // exact 7 entries in DEFAULT_PROTECTED_PATTERNS at the time of writing.
  const NON_CANONICAL_CASES: Array<{ pattern: string; canonical: string; nonCanonical: string }> = [
    { pattern: 'docs/ops/fib/**', canonical: 'docs/ops/fib/x.md', nonCanonical: 'docs/OPS/fib/x.md' },
    { pattern: 'docs/ops/pc01b/**', canonical: 'docs/ops/pc01b/x.md', nonCanonical: 'docs/ops/PC01B/x.md' },
    { pattern: 'docs/ops/im01b/**', canonical: 'docs/ops/im01b/x.md', nonCanonical: 'docs/ops/IM01B/x.md' },
    { pattern: 'db/migrations/**', canonical: 'db/migrations/x.sql', nonCanonical: 'DB/migrations/x.sql' },
    { pattern: 'db/prepared/**', canonical: 'db/prepared/x.sql', nonCanonical: 'db/Prepared/x.sql' },
    { pattern: 'db/baseline/**', canonical: 'db/baseline/x.sql', nonCanonical: 'DB/baseline/x.sql' },
    {
      pattern: 'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json',
      canonical: 'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json',
      nonCanonical: 'docs/ops/ods/ods_v1_authority_v1.0.0.json',
    },
  ]

  it('DEFAULT_PROTECTED_PATTERNS has exactly the 7 patterns this suite exercises (guards against a silently added/removed surface)', () => {
    expect(DEFAULT_PROTECTED_PATTERNS).toEqual(NON_CANONICAL_CASES.map((c) => c.pattern))
  })

  it.each(NON_CANONICAL_CASES)('$pattern: canonical path is case-sensitively protected, non-canonical variant is not (raw matchesAnyPattern)', ({ canonical, nonCanonical }) => {
    expect(matchesAnyPattern(canonical, DEFAULT_PROTECTED_PATTERNS)).toBe(true)
    expect(matchesAnyPattern(nonCanonical, DEFAULT_PROTECTED_PATTERNS)).toBe(false)
  })

  it.each(NON_CANONICAL_CASES)('$pattern: the non-canonical variant IS caught case-insensitively', ({ nonCanonical }) => {
    expect(matchesAnyPatternCaseInsensitive(nonCanonical, DEFAULT_PROTECTED_PATTERNS)).toBe(true)
  })

  it.each(NON_CANONICAL_CASES)('$pattern: classifyPaths puts the non-canonical variant in nonCanonicalProtectedPaths, unconditionally', ({ nonCanonical }) => {
    const result = classifyPaths([nonCanonical], DEFAULT_PROTECTED_PATTERNS, [nonCanonical])
    expect(result.nonCanonicalProtectedPaths).toEqual([nonCanonical])
    expect(result.protectedViolations).toEqual([])
    expect(result.unauthorized).toEqual([])
    expect(result.ok).toEqual([])
  })
})

describe('classifyPaths — canonical casing vs authorization, CASE-1..CASE-6', () => {
  const grant: ProtectedGrant = {
    authorityId: 'HPO-ODS-W2-01',
    branch: 'codex/w2-methodology-objects-r1',
    patterns: ['db/migrations/**', 'db/prepared/journal/**'],
  }

  it('CASE-1: DB/migrations/file.sql FAILs (non-canonical), even with a matching --allow', () => {
    const result = classifyPaths(['DB/migrations/file.sql'], DEFAULT_PROTECTED_PATTERNS, ['DB/migrations/file.sql'])
    expect(result.nonCanonicalProtectedPaths).toEqual(['DB/migrations/file.sql'])
  })

  it('CASE-2: db/Migrations/file.sql FAILs (non-canonical)', () => {
    const result = classifyPaths(['db/Migrations/file.sql'], DEFAULT_PROTECTED_PATTERNS, ['db/Migrations/file.sql'])
    expect(result.nonCanonicalProtectedPaths).toEqual(['db/Migrations/file.sql'])
  })

  it('CASE-3: DB/prepared/journal/file.sql FAILs even with a VALID grant + matching ordinary --allow — the security-critical case', () => {
    const result = classifyPaths(
      ['DB/prepared/journal/file.sql'],
      DEFAULT_PROTECTED_PATTERNS,
      ['DB/prepared/journal/file.sql'],
      grant, // a genuinely valid, correctly-scoped grant
    )
    expect(result.nonCanonicalProtectedPaths).toEqual(['DB/prepared/journal/file.sql'])
    expect(result.grantAuthorized).toEqual([]) // never reaches grant authorization
    expect(result.ok).toEqual([])
  })

  it('CASE-4 (from the addendum, generalized to db/baseline/**): DB/baseline/file.sql FAILs — a surface NO authority grants, equally bypassable by case variant', () => {
    const result = classifyPaths(['DB/baseline/file.sql'], DEFAULT_PROTECTED_PATTERNS, ['DB/baseline/file.sql'], grant)
    expect(result.nonCanonicalProtectedPaths).toEqual(['DB/baseline/file.sql'])
  })

  it('CASE-5: canonical db/migrations/file.sql + valid authority + ordinary allow => PASS', () => {
    const result = classifyPaths(['db/migrations/file.sql'], DEFAULT_PROTECTED_PATTERNS, ['db/migrations/file.sql'], grant)
    expect(result.nonCanonicalProtectedPaths).toEqual([])
    expect(result.protectedViolations).toEqual([])
    expect(result.grantAuthorized).toEqual(['db/migrations/file.sql'])
    expect(result.ok).toEqual(['db/migrations/file.sql'])
  })

  it('CASE-6: canonical unprotected paths retain existing behavior (unaffected by the casing check)', () => {
    const allowed = classifyPaths(['lib/admin/x.ts'], DEFAULT_PROTECTED_PATTERNS, ['lib/admin/x.ts'])
    expect(allowed.ok).toEqual(['lib/admin/x.ts'])
    expect(allowed.nonCanonicalProtectedPaths).toEqual([])

    const unauthorized = classifyPaths(['lib/admin/x.ts'], DEFAULT_PROTECTED_PATTERNS, [])
    expect(unauthorized.unauthorized).toEqual(['lib/admin/x.ts'])
    expect(unauthorized.nonCanonicalProtectedPaths).toEqual([])
  })
})

describe('CASE-7: case-canonical enforcement does not weaken rename handling — real temporary git repo', () => {
  let dir: string
  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  it('a real git rename INTO a non-canonical-cased protected path is still caught, on the new path', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'scripts/allowed.ts', 'export {}\n')
    mkdirSync(path.join(dir, 'DB', 'migrations'), { recursive: true })
    git(dir, ['mv', 'scripts/allowed.ts', 'DB/migrations/smuggled.sql'])
    git(dir, ['commit', '-q', '-m', 'rename into non-canonical protected path'])

    const changed = collectChangedPaths(dir, base)
    const result = classifyPaths(changed, DEFAULT_PROTECTED_PATTERNS, ['scripts/allowed.ts', 'DB/migrations/smuggled.sql'])
    expect(result.nonCanonicalProtectedPaths).toContain('DB/migrations/smuggled.sql')
    expect(result.ok).not.toContain('DB/migrations/smuggled.sql')
  })

  it('a real git rename OUT OF a canonical protected surface into a non-canonical variant of another is still caught on both endpoints', () => {
    dir = makeTempGitRepo()
    mkdirSync(path.join(dir, 'db', 'baseline'), { recursive: true })
    const base = commitFile(dir, 'db/baseline/original.sql', 'select 1;\n')
    mkdirSync(path.join(dir, 'DB', 'migrations'), { recursive: true })
    git(dir, ['mv', 'db/baseline/original.sql', 'DB/migrations/renamed.sql'])
    git(dir, ['commit', '-q', '-m', 'rename across canonical/non-canonical protected surfaces'])

    const changed = collectChangedPaths(dir, base)
    const result = classifyPaths(changed, DEFAULT_PROTECTED_PATTERNS, ['db/baseline/original.sql', 'DB/migrations/renamed.sql'])
    // Old path: canonical protected, no grant -> protectedViolations.
    expect(result.protectedViolations).toContain('db/baseline/original.sql')
    // New path: non-canonical -> nonCanonicalProtectedPaths, never authorized.
    expect(result.nonCanonicalProtectedPaths).toContain('DB/migrations/renamed.sql')
  })
})

describe('ods:scope --protected-authority — missing-operand hardening (mechanical CLI hygiene)', () => {
  const tsxCli = require.resolve('tsx/cli')
  const run = (args: string[]) => spawnSync(process.execPath, [tsxCli, 'scripts/ods-scope.ts', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })

  it('trailing --protected-authority with nothing after it is a usage error, not silently NONE', () => {
    const res = run(['--base', 'deadbeef', '--allow', 'x', '--protected-authority'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('--protected-authority requires a value')
    expect(res.stdout).not.toContain('PROTECTED_AUTHORITY=NONE')
  })

  it('--protected-authority immediately followed by another recognized flag is rejected, not misparsed as a value', () => {
    const res = run(['--protected-authority', '--base', 'deadbeef'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('--protected-authority requires a value')
  })

  it('valid usage is preserved: a real identifier still resolves normally', () => {
    const res = run(['--base', 'deadbeef', '--allow', 'x', '--protected-authority', 'HPO-ODS-W2-01'])
    // Fails for an unrelated reason (base sha doesn't exist in REPO_ROOT),
    // but must reach that failure via normal resolution, not a usage error.
    expect(res.status).not.toBe(2)
  })
})

describe('ods:scope real CLI — NON_CANONICAL_PROTECTED_PATH output and overall FAIL, temp repo', () => {
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

  it('CASE-3 as a real end-to-end CLI run: valid grant + branch + non-canonical path => FAIL, NON_CANONICAL_PROTECTED_PATH reported', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'README.md', 'seed\n')
    git(dir, ['checkout', '-b', 'codex/w2-methodology-objects-r1'])
    mkdirSync(path.join(dir, 'DB', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'DB/prepared/journal/fixture.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      base,
      '--allow',
      'DB/prepared/journal/fixture.sql',
      '--protected-authority',
      'HPO-ODS-W2-01',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('NON_CANONICAL_PROTECTED_PATH=DB/prepared/journal/fixture.sql')
    expect(stdout).toContain('NON_CANONICAL_PROTECTED_PATHS=1')
  })

  it('CASE-5 as a real end-to-end CLI run: the canonical path (correct casing) PASSes under the same grant', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'README.md', 'seed\n')
    git(dir, ['checkout', '-b', 'codex/w2-methodology-objects-r1'])
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

    expect(status).toBe(0)
    expect(stdout).toContain('ODS_SCOPE=PASS')
    expect(stdout).toContain('NON_CANONICAL_PROTECTED_PATHS=0')
  })
})

// ---------------------------------------------------------------------------
// HPO-ODS-W2-02 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.3.json).
//
// A successor, additive grant transporting the already-closed final
// Wave2-B1 state onto codex/u0-u9-reengineering-resume-r1. Authorizes ONLY
// the 75 exact literal protected paths of that closed B1 state — no glob,
// no subset widening, no wildcard. Does not modify HPO-ODS-W2-01.
// ---------------------------------------------------------------------------

describe('ods:scope --protected-authority HPO-ODS-W2-02 — real CLI, temporary-repo fixtures', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  const w2_02 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-02')!
  const TARGET_BRANCH = 'codex/u0-u9-reengineering-resume-r1'

  function runRealCli(cwd: string, args: string[]): { status: number | null; stdout: string } {
    const tsxCli = require.resolve('tsx/cli')
    const scriptAbsolutePath = path.join(REPO_ROOT, 'scripts', 'ods-scope.ts')
    const res = spawnSync(process.execPath, [tsxCli, scriptAbsolutePath, ...args], { cwd, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout }
  }

  /** A temp repo checked out to the W2-02 target branch, with one base commit. */
  function makeTargetBranchRepo(): { dir: string; base: string } {
    const d = makeTempGitRepo()
    const base = commitFile(d, 'README.md', 'seed\n')
    git(d, ['checkout', '-b', TARGET_BRANCH])
    return { dir: d, base }
  }

  it('sanity: the frozen W2-02 grant is exactly 75 exact literal paths under db/migrations/** or db/prepared/journal/**', () => {
    expect(w2_02.patterns.length).toBe(75)
    for (const p of w2_02.patterns) {
      expect(p.startsWith('db/migrations/') || p.startsWith('db/prepared/journal/')).toBe(true)
      expect(p.includes('*')).toBe(false)
    }
  })

  it(
    'POSITIVE: all 75 granted B1 paths, changed together on the target branch, PASS under HPO-ODS-W2-02',
    () => {
      const g = makeTargetBranchRepo()
      dir = g.dir
      for (const p of w2_02.patterns) {
        mkdirSync(path.join(dir, path.dirname(p)), { recursive: true })
        writeFileSync(path.join(dir, p), `-- fixture for ${p}\n`)
      }
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-q', '-m', 'materialize all 75 granted B1 fixture paths in one commit'])

      const args = ['--base', g.base, '--protected-authority', 'HPO-ODS-W2-02']
      for (const p of w2_02.patterns) args.push('--allow', p)

      const { status, stdout } = runRealCli(dir, args)

      expect(status).toBe(0)
      expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-02')
      expect(stdout).toContain('CHANGED_FILE_COUNT=75')
      expect(stdout).toContain('PROTECTED_AUTHORIZED_PATH_COUNT=75')
      expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
      expect(stdout).toContain('NON_CANONICAL_PROTECTED_PATHS=0')
      expect(stdout).toContain('UNAUTHORIZED_PATHS=0')
      expect(stdout).toContain('ODS_SCOPE=PASS')
    },
    20000,
  )

  it('NEGATIVE (ungranted sibling migration): a migration path not in the 75 FAILs even with the correct authority + branch', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/9999_ungranted.sql', 'create table x();\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/migrations/9999_ungranted.sql',
      '--protected-authority',
      'HPO-ODS-W2-02',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/migrations/9999_ungranted.sql')
  })

  it('NEGATIVE (ungranted db/prepared sibling outside exact journal grants): FAILs — grant does not widen to a directory pattern', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    // Not one of the 75 exact granted journal filenames.
    commitFile(dir, 'db/prepared/journal/999_ungranted.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/prepared/journal/999_ungranted.sql',
      '--protected-authority',
      'HPO-ODS-W2-02',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/journal/999_ungranted.sql')
  })

  it('NEGATIVE (noncanonical casing): a case variant of a genuinely granted path still FAILs, unconditionally', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'DB', 'migrations'), { recursive: true })
    commitFile(dir, 'DB/migrations/0048_fib_evidence_versions.sql', 'create table x();\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'DB/migrations/0048_fib_evidence_versions.sql',
      '--protected-authority',
      'HPO-ODS-W2-02',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('NON_CANONICAL_PROTECTED_PATH=DB/migrations/0048_fib_evidence_versions.sql')
  })

  it('NEGATIVE (wrong branch): HPO-ODS-W2-02 on any branch other than codex/u0-u9-reengineering-resume-r1 FAILs', () => {
    dir = makeTempGitRepo() // default branch, not the W2-02 target branch
    const base = commitFile(dir, 'README.md', 'seed\n')
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0048_fib_evidence_versions.sql', 'create table x();\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      base,
      '--allow',
      'db/migrations/0048_fib_evidence_versions.sql',
      '--protected-authority',
      'HPO-ODS-W2-02',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it('NEGATIVE (future B2 path): a hypothetical future migration not among the 75 named B1 paths FAILs', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    // A plausible-looking future Wave-2-B2 migration filename, never granted.
    commitFile(dir, 'db/migrations/0053_fib_evidence_b2_future.sql', 'create table y();\n')

    const { status, stdout } = runRealCli(dir, [
      '--base',
      g.base,
      '--allow',
      'db/migrations/0053_fib_evidence_b2_future.sql',
      '--protected-authority',
      'HPO-ODS-W2-02',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/migrations/0053_fib_evidence_b2_future.sql')
  })

  it('REGRESSION: HPO-ODS-W2-01 still works exactly as before, unaffected by the HPO-ODS-W2-02 addition', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'README.md', 'seed\n')
    git(dir, ['checkout', '-b', 'codex/w2-methodology-objects-r1'])
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

    expect(status).toBe(0)
    expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-01')
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })

  it('REGRESSION: HPO-ODS-W2-01 identifier is refused on the HPO-ODS-W2-02 target branch (grants are not interchangeable across branches)', () => {
    const g = makeTargetBranchRepo()
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

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })
})
