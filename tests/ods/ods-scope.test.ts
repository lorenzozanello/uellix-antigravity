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

describe('ods:scope — real CLI, POSITIVE integration control against the actual ODS worktree', () => {
  it('PASS when the real change since the ODS-01 authority-freeze commit is confined to the ODS-02/ODS-03 surface so far', () => {
    const tsxCli = require.resolve('tsx/cli')
    const res = spawnSync(
      process.execPath,
      [
        tsxCli,
        'scripts/ods-scope.ts',
        '--base',
        '2aecf625a49ec673fd4185052e71ec6e5c750edf',
        '--allow',
        'scripts/authority-seal-verify.ts',
        '--allow',
        'scripts/ods-prestate.ts',
        '--allow',
        'scripts/ods-scope.ts',
        '--allow',
        'scripts/ods-poststate.ts',
        '--allow',
        'tests/ods/**',
        '--allow',
        'package.json',
        '--allow',
        'CLAUDE.md',
        '--allow',
        'AGENTS.md',
        '--allow',
        'docs/ops/ods/ODS_CONTEXT_CHECKPOINT_STANDARD_v1.0.0.md',
        '--allow',
        '.github/workflows/ci.yml',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
    expect(res.stdout).toContain('UNAUTHORIZED_PATHS=0')
    expect(res.stdout).toContain('ODS_SCOPE=PASS')
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
