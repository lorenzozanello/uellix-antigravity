// tests/ods/ods-prestate.test.ts — ODS-C1 positive and negative controls.
//
// Every case uses a disposable temporary git repository (never the real ODS
// worktree) so a "dirty worktree" negative control never touches real state.

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkBranch,
  checkHead,
  checkTree,
  checkClean,
  evaluatePrestate,
  fetchActual,
} from '../../scripts/ods-prestate'
import { makeTempGitRepo, commitFile, cleanupTempGitRepo, git } from './git-fixture-helpers'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

describe('pure checks', () => {
  it('checkBranch/Head/Tree PASS on match, FAIL on mismatch', () => {
    expect(checkBranch('main', 'main')).toBe(true)
    expect(checkBranch('main', 'other')).toBe(false)
    expect(checkHead('abc', 'abc')).toBe(true)
    expect(checkHead('abc', 'def')).toBe(false)
    expect(checkTree('abc', 'abc')).toBe(true)
    expect(checkTree('abc', 'def')).toBe(false)
  })

  it('checkClean PASS on empty porcelain output, FAIL on any status line', () => {
    expect(checkClean('')).toBe(true)
    expect(checkClean('   \n')).toBe(true)
    expect(checkClean(' M file.ts\n')).toBe(false)
  })
})

describe('evaluatePrestate', () => {
  const actual = { branch: 'main', head: 'headsha', tree: 'treesha', statusPorcelain: '' }

  it('USAGE ERROR when no assertion is supplied — never a vacuous PASS', () => {
    const result = evaluatePrestate({}, actual)
    expect(result.hasAssertions).toBe(false)
    expect(result.pass).toBe(false)
  })

  it('PASS when every supplied assertion matches', () => {
    const result = evaluatePrestate({ branch: 'main', head: 'headsha', tree: 'treesha', requireClean: true }, actual)
    expect(result.pass).toBe(true)
    expect(result.checks.map((c) => c.name)).toEqual(['PRESTATE_BRANCH', 'PRESTATE_HEAD', 'PRESTATE_TREE', 'PRESTATE_CLEAN'])
  })

  it('only evaluates checks the caller actually supplied', () => {
    const result = evaluatePrestate({ head: 'headsha' }, actual)
    expect(result.checks.map((c) => c.name)).toEqual(['PRESTATE_HEAD'])
  })

  it('NEGATIVE CONTROL: FAILS on a deliberately wrong expected HEAD', () => {
    const result = evaluatePrestate({ head: 'wrong-sha' }, actual)
    expect(result.pass).toBe(false)
  })

  it('NEGATIVE CONTROL: FAILS on a deliberately wrong expected branch', () => {
    const result = evaluatePrestate({ branch: 'wrong-branch' }, actual)
    expect(result.pass).toBe(false)
  })

  it('NEGATIVE CONTROL: FAILS on a deliberately wrong expected tree', () => {
    const result = evaluatePrestate({ tree: 'wrong-tree' }, actual)
    expect(result.pass).toBe(false)
  })

  it('NEGATIVE CONTROL: FAILS when clean is required but the worktree is dirty', () => {
    const result = evaluatePrestate({ requireClean: true }, { ...actual, statusPorcelain: ' M dirty.ts\n' })
    expect(result.pass).toBe(false)
  })

  it('does not evaluate an unrequested clean check even if the tree is dirty', () => {
    const result = evaluatePrestate({ branch: 'main' }, { ...actual, statusPorcelain: ' M dirty.ts\n' })
    expect(result.pass).toBe(true)
  })
})

describe('fetchActual + evaluatePrestate — real temporary git repo, POSITIVE and NEGATIVE', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  it('PASS: correct branch/head/tree/clean against a real fresh commit', () => {
    dir = makeTempGitRepo()
    const head = commitFile(dir, 'a.txt', 'hello\n')
    const tree = git(dir, ['rev-parse', 'HEAD^{tree}'])
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])

    const actual = fetchActual(dir)
    const result = evaluatePrestate({ branch, head, tree, requireClean: true }, actual)
    expect(result.pass).toBe(true)
  })

  it('NEGATIVE CONTROL: a dirty temporary worktree FAILS --clean', () => {
    dir = makeTempGitRepo()
    commitFile(dir, 'a.txt', 'hello\n')
    // Dirty the TEMP repo, never the real ODS worktree.
    writeFileSync(path.join(dir, 'a.txt'), 'mutated\n')

    const actual = fetchActual(dir)
    const result = evaluatePrestate({ requireClean: true }, actual)
    expect(result.pass).toBe(false)
  })

  it('NEGATIVE CONTROL: an untracked file in a temporary worktree FAILS --clean', () => {
    dir = makeTempGitRepo()
    commitFile(dir, 'a.txt', 'hello\n')
    writeFileSync(path.join(dir, 'untracked.txt'), 'new\n')

    const actual = fetchActual(dir)
    const result = evaluatePrestate({ requireClean: true }, actual)
    expect(result.pass).toBe(false)
  })
})

describe('ods:prestate — real CLI, POSITIVE integration control against the actual ODS worktree', () => {
  it('PASS when the caller supplies the actual current branch/HEAD/tree and requires clean', () => {
    const branch = git(REPO_ROOT, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const head = git(REPO_ROOT, ['rev-parse', 'HEAD'])
    const tree = git(REPO_ROOT, ['rev-parse', 'HEAD^{tree}'])
    const tsxCli = require.resolve('tsx/cli')

    const res = spawnSync(
      process.execPath,
      [tsxCli, 'scripts/ods-prestate.ts', '--branch', branch, '--head', head, '--tree', tree],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('PRESTATE_BRANCH=PASS')
    expect(res.stdout).toContain('PRESTATE_HEAD=PASS')
    expect(res.stdout).toContain('PRESTATE_TREE=PASS')
    expect(res.stdout).toContain('ODS_PRESTATE=PASS')
  })

  it('NEGATIVE CONTROL: real CLI FAILS on a deliberately wrong --head', () => {
    const tsxCli = require.resolve('tsx/cli')
    const res = spawnSync(process.execPath, [tsxCli, 'scripts/ods-prestate.ts', '--head', '0000000000000000000000000000000000000000'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('PRESTATE_HEAD=FAIL')
    expect(res.stdout).toContain('ODS_PRESTATE=FAIL')
  })

  it('real CLI exits 2 (usage error) with zero assertions supplied', () => {
    const tsxCli = require.resolve('tsx/cli')
    const res = spawnSync(process.execPath, [tsxCli, 'scripts/ods-prestate.ts'], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('ODS_PRESTATE=USAGE_ERROR')
  })

  // ODS-05 independent audit: `--head <valid-sha> --branch` (a trailing
  // flag with no operand) previously left expected.branch === undefined,
  // which evaluatePrestate cannot distinguish from "branch was never
  // asked to be checked" — so a real prestate call with a genuinely
  // malformed --branch could still print ODS_PRESTATE=PASS. Reproduced
  // here exactly as measured, then proven fixed.
  describe('malformed trailing-operand invocations MUST NOT silently pass (ODS-05)', () => {
    const tsxCli = require.resolve('tsx/cli')
    const run = (args: string[]) =>
      spawnSync(process.execPath, [tsxCli, 'scripts/ods-prestate.ts', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })

    it("reproduces the auditor's exact case: --head <valid-sha> --branch (trailing, no operand)", () => {
      const res = run(['--head', git(REPO_ROOT, ['rev-parse', 'HEAD']), '--branch'])
      expect(res.status).not.toBe(0)
      expect(res.stdout).not.toContain('ODS_PRESTATE=PASS')
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--branch requires a value')
    })

    it('MALFORMED CONTROL: trailing --branch with nothing after it exits 2', () => {
      const res = run(['--branch'])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--branch requires a value')
    })

    it('MALFORMED CONTROL: trailing --head with nothing after it exits 2', () => {
      const res = run(['--head'])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--head requires a value')
    })

    it('MALFORMED CONTROL: trailing --tree with nothing after it exits 2', () => {
      const res = run(['--tree'])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--tree requires a value')
    })

    it('a value flag immediately followed by another recognized flag is rejected, not misparsed as a value', () => {
      const res = run(['--branch', '--head', '0000000000000000000000000000000000000000'])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--branch requires a value')
    })

    it('a value flag immediately followed by --clean is rejected, not misparsed as a value', () => {
      const res = run(['--head', '--clean'])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--head requires a value')
    })

    it('a value flag immediately followed by the pnpm "--" separator is rejected', () => {
      const res = run(['--head', '--'])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain('--head requires a value')
    })

    it('CONTROL: a valid complete invocation (branch/head/tree) still PASSES', () => {
      // Deliberately omits --clean: this suite runs mid-development, when
      // the real worktree legitimately has uncommitted changes (see the
      // equivalent choice in the ODS-02 positive control above).
      const branch = git(REPO_ROOT, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const head = git(REPO_ROOT, ['rev-parse', 'HEAD'])
      const tree = git(REPO_ROOT, ['rev-parse', 'HEAD^{tree}'])
      const res = run(['--branch', branch, '--head', head, '--tree', tree])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ODS_PRESTATE=PASS')
    })
  })
})
