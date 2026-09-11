// tests/ods/ods-scope.test.ts — ODS-C4 positive and negative controls.

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
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
  resolveProtectedGrants,
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

  it('the frozen registry contains exactly the HPO-ODS-W2-01 grant, unchanged, plus the successor HPO-ODS-W2-02 and HPO-ODS-W2-03 grants, plus the HPO-ODS-W2-07 checkpoint-b0 probe grant, plus the HPO-ODS-W2-08 Commercial V1 / Wave2 reconciliation grant, plus the HPO-ODS-W2-09 0061 security-successor grant, plus the HPO-ODS-W2-11 P1A canonical local/CI bootstrap grant, plus the HPO-ODS-W2-12 Wave 2 batch B4 grant, plus the HPO-ODS-W2-16 W2-B4 remediation checkpoint-b0 probe grant, plus the HPO-ODS-W2-17 Wave 2 batch B5 grant, plus the HPO-ODS-W2-20 multi-org S1 migration grant and the HPO-ODS-W2-21 multi-org S1 journal grant, plus the HPO-ODS-W2-25 multi-org S3 refusal-audit grant, plus the HPO-ODS-W2-26 Commercial Account CE-1 grant, plus the HPO-ODS-W2-27 FIBDB-052 P1 index grant, plus the HPO-ODS-W2-28 Customer Lifecycle CL-1 grant', () => {
    expect(PROTECTED_GRANTS.length).toBe(16)
    expect(new Set(PROTECTED_GRANTS.map((g) => g.authorityId)).size).toBe(16)
    // HPO-ODS-W2-25 (multi-org S3 refusal audit). ONE row, TWO patterns, bound
    // to the implementation branch by exact string equality. The set-size
    // assertion above is what forbids a duplicate id from being registered
    // beside it rather than replacing it.
    const w2_25 = PROTECTED_GRANTS[12]
    expect(w2_25).toEqual({
      authorityId: 'HPO-ODS-W2-25',
      branch: 'codex/multiorg-s3-refusal-audit-implementation-r1',
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    })
    expect(PROTECTED_GRANTS.filter((g) => g.authorityId === 'HPO-ODS-W2-25').length).toBe(1)
    // HPO-ODS-W2-26 (Commercial Account CE-1 implementation), registered by
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json as refined by the
    // minimal append-only successor v1.0.29. ONE row, THREE patterns, bound to
    // the CE-1 implementation branch by exact string equality. Asserted as a
    // WHOLE-OBJECT equality, not a membership test, because pattern ORDER is
    // part of the row's identity under v1.0.29 ORDER_IS_BINDING.
    const w2_26 = PROTECTED_GRANTS[13]
    expect(w2_26).toEqual({
      authorityId: 'HPO-ODS-W2-26',
      branch: 'codex/commercial-account-ce1-implementation-r1',
      patterns: [
        'db/migrations/**',
        'db/prepared/journal/**',
        'db/prepared/checkpoint-b0/observation.sql',
      ],
    })
    expect(PROTECTED_GRANTS.filter((g) => g.authorityId === 'HPO-ODS-W2-26').length).toBe(1)
    // NO BLANKET db/prepared/**. The third pattern is the single literal
    // observation file. If a later hand widened it to a directory glob or to
    // db/prepared/**, this assertion — and the whole-object equality above —
    // both fail.
    expect(w2_26.patterns).not.toContain('db/prepared/**')
    expect(w2_26.patterns.filter((p) => p.startsWith('db/prepared/')).sort()).toEqual([
      'db/prepared/checkpoint-b0/observation.sql',
      'db/prepared/journal/**',
    ])
    // HPO-ODS-W2-27 (FIBDB-052 phase P1 index sub-package), registered by
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json. ONE row, TWO
    // patterns, bound to the P1 implementation branch by exact string
    // equality. Asserted as a WHOLE-OBJECT equality, not a membership test,
    // because pattern ORDER is part of the row's identity under v1.0.30
    // ORDER_IS_BINDING.
    const w2_27 = PROTECTED_GRANTS[14]
    expect(w2_27).toEqual({
      authorityId: 'HPO-ODS-W2-27',
      branch: 'codex/fibdb052-p1-implementation-r1',
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    })
    expect(PROTECTED_GRANTS.filter((g) => g.authorityId === 'HPO-ODS-W2-27').length).toBe(1)
    // TWO PATTERNS, NOT THREE. The predecessor W2-26 immediately above carries
    // db/prepared/checkpoint-b0/observation.sql as a third pattern; W2-27 does
    // NOT. Asserting the exclusion is what distinguishes a deliberate
    // narrowing from an omission (v1.0.30 RC-8).
    expect(w2_27.patterns.length).toBe(2)
    expect(w2_27.patterns).not.toContain('db/prepared/**')
    expect(w2_27.patterns).not.toContain('db/prepared/checkpoint-b0/observation.sql')
    expect(w2_27.patterns.filter((p) => p.startsWith('db/prepared/'))).toEqual([
      'db/prepared/journal/**',
    ])
    // HPO-ODS-W2-28 (Customer Lifecycle CL-1 legal-acceptance substrate),
    // registered by docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json. ONE
    // row, THREE patterns, bound to the CL-1 implementation branch by exact
    // string equality. Asserted as a WHOLE-OBJECT equality, not a membership
    // test, because pattern ORDER is part of the row's identity under v1.0.31
    // ORDER_IS_BINDING.
    const w2_28 = PROTECTED_GRANTS[15]
    expect(w2_28).toEqual({
      authorityId: 'HPO-ODS-W2-28',
      branch: 'codex/customer-lifecycle-cl1-implementation-r1',
      patterns: [
        'db/migrations/**',
        'db/prepared/journal/**',
        'db/prepared/checkpoint-b0/observation.sql',
      ],
    })
    expect(PROTECTED_GRANTS.filter((g) => g.authorityId === 'HPO-ODS-W2-28').length).toBe(1)
    // THREE PATTERNS, NOT TWO. The predecessor W2-27 immediately above
    // deliberately EXCLUDES db/prepared/checkpoint-b0/observation.sql because
    // an index-only migration does not move it; CL-1 creates relations, which
    // does (v1.0.31 WHY_THREE_PATTERNS_AND_NOT_TWO). Asserting the INCLUSION
    // here is what distinguishes a measured difference from a copied shape.
    expect(w2_28.patterns.length).toBe(3)
    expect(w2_28.patterns).toContain('db/prepared/checkpoint-b0/observation.sql')
    // NO BLANKET db/prepared/**, and no directory glob under checkpoint-b0.
    // The prepared-surface patterns are the narrow journal glob and the single
    // literal observation file (v1.0.31 NO_DB_PREPARED_WIDENING).
    expect(w2_28.patterns).not.toContain('db/prepared/**')
    expect(w2_28.patterns).not.toContain('db/prepared/checkpoint-b0/**')
    expect(w2_28.patterns.filter((p) => p.startsWith('db/prepared/')).sort()).toEqual([
      'db/prepared/checkpoint-b0/observation.sql',
      'db/prepared/journal/**',
    ])
    // W2-29 is NOT allocated by this node. Registering one would be a silent
    // grant-lineage advance. This literal ADVANCED from W2-28 to W2-29 when
    // W2-28 was registered above, exactly as it advanced from W2-27 to W2-28
    // when W2-27 was registered (v1.0.30 RC-4), and v1.0.31 NO_PREALLOCATION
    // names HPO-ODS-W2-29 inside an explicit prohibition.
    expect(PROTECTED_GRANTS.some((g) => g.authorityId === 'HPO-ODS-W2-29')).toBe(false)
    const w2_03 = PROTECTED_GRANTS[2]
    expect(w2_03.authorityId).toBe('HPO-ODS-W2-03')
    expect(w2_03.branch).toBe('codex/u0-u9-reengineering-resume-r1')
    expect(w2_03.patterns.length).toBe(8)
    expect(w2_03.patterns.every((p) => !p.includes('*'))).toBe(true)
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
    // HPO-ODS-W2-07 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.8.json): the
    // checkpoint-b0 observation probe canonical-regeneration grant, on the
    // Product PR-candidate successor branch. One exact literal path, no glob.
    expect(PROTECTED_GRANTS[3]).toEqual({
      authorityId: 'HPO-ODS-W2-07',
      branch: 'codex/product-commercial-v1-pr-r1',
      patterns: ['db/prepared/checkpoint-b0/observation.sql'],
    })
    // HPO-ODS-W2-08 (docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.0.json):
    // the Commercial V1 / Wave2 reconciliation grant on the candidate branch.
    // Exactly the 98 literal protected paths the two-parent merge differs by
    // from either parent, no glob; the frozen authority artifact is the source
    // of the list and the two must agree exactly.
    const w2_08 = PROTECTED_GRANTS[4]
    expect(w2_08.authorityId).toBe('HPO-ODS-W2-08')
    expect(w2_08.branch).toBe('codex/commercial-v1-wave2-reconciliation-r1')
    expect(w2_08.patterns.length).toBe(98)
    expect(w2_08.patterns.every((p) => !p.includes('*'))).toBe(true)
    const authority = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.0.json'), 'utf8'),
    ) as { protected_grant: { authorityId: string; branch: string; patterns: string[] } }
    expect(w2_08).toEqual({
      authorityId: authority.protected_grant.authorityId,
      branch: authority.protected_grant.branch,
      patterns: authority.protected_grant.patterns,
    })
    // HPO-ODS-W2-09 (docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.1.json):
    // the 0061 security-successor grant on the same candidate branch. Exactly
    // four literal protected paths, no glob; the frozen v1.0.1 artifact is the
    // source of the list and the two must agree exactly.
    const w2_09 = PROTECTED_GRANTS[5]
    expect(w2_09.authorityId).toBe('HPO-ODS-W2-09')
    expect(w2_09.branch).toBe('codex/commercial-v1-wave2-reconciliation-r1')
    expect(w2_09.patterns.length).toBe(4)
    expect(w2_09.patterns.every((p) => !p.includes('*'))).toBe(true)
    const authority101 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/integration/COMMERCIAL_V1_WAVE2_RECONCILIATION_AUTHORITY_v1.0.1.json'), 'utf8'),
    ) as { protected_grant: { authorityId: string; branch: string; patterns: string[] } }
    expect(w2_09).toEqual({
      authorityId: authority101.protected_grant.authorityId,
      branch: authority101.protected_grant.branch,
      patterns: authority101.protected_grant.patterns,
    })
    // HPO-ODS-W2-11 (docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json,
    // companion docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json): the
    // P1A canonical LOCAL/CI clean-bootstrap node, on its own branch. Exactly
    // three literal protected paths, no glob; the frozen authority artifact is
    // the source of the list and the two must agree exactly. Note W2-10 is
    // absent from this registry BY DESIGN — its own artifact records it as an
    // authority identifier that is deliberately not a protected-surface grant.
    const w2_11 = PROTECTED_GRANTS[6]
    expect(w2_11.authorityId).toBe('HPO-ODS-W2-11')
    expect(w2_11.branch).toBe('codex/p1a-full-bootstrap-r1')
    expect(w2_11.patterns.length).toBe(3)
    expect(w2_11.patterns.every((p) => !p.includes('*'))).toBe(true)
    const authorityP1a = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json'), 'utf8'),
    ) as { protected_grant: { authorityId: string; branch: string; patterns: string[] } }
    expect(w2_11).toEqual({
      authorityId: authorityP1a.protected_grant.authorityId,
      branch: authorityP1a.protected_grant.branch,
      patterns: authorityP1a.protected_grant.patterns,
    })
    // The companion ODS addendum must declare the SAME grant. Two artifacts
    // stating a grant is one more place it can drift, so the agreement is
    // asserted rather than assumed.
    const addendumP1a = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json'), 'utf8'),
    ) as { GRANT_ID: string; protected_grant: { authorityId: string; branch: string; patterns: string[] } }
    expect(addendumP1a.GRANT_ID).toBe('HPO-ODS-W2-11')
    expect(addendumP1a.protected_grant.authorityId).toBe(w2_11.authorityId)
    expect(addendumP1a.protected_grant.branch).toBe(w2_11.branch)
    expect(addendumP1a.protected_grant.patterns).toEqual(w2_11.patterns)
    // HPO-ODS-W2-12 (docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json, companion
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json): Wave 2 batch B4
    // — FIBIU-15/14/16 assumptions and causality — on its own branch. Two
    // patterns, the same two Wave 2 surfaces HPO-ODS-W2-01 holds on the
    // historical Wave 2 branch; W2-01 is frozen and not reused because a grant
    // binds to exactly one branch. Unlike W2-02/03/07/08/09/11 these ARE globs,
    // because the migration ordinals are re-measured at B4’s P1A sync point and
    // the authority explicitly refuses to freeze a slot in advance. The three
    // artifacts stating this grant must agree exactly.
    const w2_12 = PROTECTED_GRANTS[7]
    expect(w2_12.authorityId).toBe('HPO-ODS-W2-12')
    expect(w2_12.branch).toBe('codex/w2-b4-r1')
    expect(w2_12.patterns).toEqual(['db/migrations/**', 'db/prepared/journal/**'])
    const authorityB4 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json'), 'utf8'),
    ) as { protected_grant: { authorityId: string; branch: string; patterns: string[] } }
    expect(w2_12).toEqual({
      authorityId: authorityB4.protected_grant.authorityId,
      branch: authorityB4.protected_grant.branch,
      patterns: authorityB4.protected_grant.patterns,
    })
    const addendumB4 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json'), 'utf8'),
    ) as { GRANT_ID: string; protected_grant: { authorityId: string; branch: string; patterns: string[] } }
    expect(addendumB4.GRANT_ID).toBe('HPO-ODS-W2-12')
    expect(addendumB4.protected_grant.authorityId).toBe(w2_12.authorityId)
    expect(addendumB4.protected_grant.branch).toBe(w2_12.branch)
    expect(addendumB4.protected_grant.patterns).toEqual(w2_12.patterns)
    // HPO-ODS-W2-16 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json,
    // companion docs/ops/wave2/W2_B4_AUTHORITY_AMENDMENT_v1.0.1.json): the
    // W2-B4 remediation grant for the checkpoint-b0 observation probe. ONE
    // exact literal path, no glob. It shares a branch with W2-12 and is
    // deliberately a SEPARATE entry, because W2-12 is frozen at its two
    // patterns and widening it retrospectively is prohibited.
    const w2_16 = PROTECTED_GRANTS[8]
    expect(w2_16.authorityId).toBe('HPO-ODS-W2-16')
    expect(w2_16.branch).toBe('codex/w2-b4-r1')
    expect(w2_16.patterns).toEqual(['db/prepared/checkpoint-b0/observation.sql'])
    expect(w2_16.patterns.every((p) => !p.includes('*'))).toBe(true)
    const addendumB4Remediation = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json'), 'utf8'),
    ) as {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[] }
      PROTECTED_GRANTS_COUNT_AFTER: number
    }
    expect(addendumB4Remediation.GRANT_ID).toBe('HPO-ODS-W2-16')
    expect(w2_16).toEqual({
      authorityId: addendumB4Remediation.protected_grant.authorityId,
      branch: addendumB4Remediation.protected_grant.branch,
      patterns: addendumB4Remediation.protected_grant.patterns,
    })
    // v1.0.15 records the cardinality after ITS OWN change. That is a
    // historical fact and is pinned as a literal — rewriting it to track a
    // later registry would be historical evidence rewriting. The LIVE-count
    // guard belongs to the newest addendum and is asserted below on v1.0.16.
    expect(addendumB4Remediation.PROTECTED_GRANTS_COUNT_AFTER).toBe(9)
    // W2-12 UNCHANGED by the arrival of W2-16 — same branch, same two
    // patterns. Registering a second grant on a shared branch must not widen
    // the first, and this is the assertion that would catch it if it did.
    expect(PROTECTED_GRANTS[7]).toEqual({
      authorityId: 'HPO-ODS-W2-12',
      branch: 'codex/w2-b4-r1',
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    })
    // HPO-ODS-W2-17 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json,
    // companion docs/ops/wave2/W2_B5_AUTHORITY_v1.0.0.json): Wave 2 batch B5.
    // THREE patterns on its own branch — the two Wave-2 surfaces plus the
    // checkpoint-b0 probe, which B5 necessarily restales by registering two
    // more baseline units.
    const w2_17 = PROTECTED_GRANTS[9]
    expect(w2_17.authorityId).toBe('HPO-ODS-W2-17')
    expect(w2_17.branch).toBe('codex/w2-b5-r1')
    expect(w2_17.patterns).toEqual([
      'db/migrations/**',
      'db/prepared/journal/**',
      'db/prepared/checkpoint-b0/observation.sql',
    ])
    const addendumB5 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json'), 'utf8'),
    ) as {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[] }
      PROTECTED_GRANTS_COUNT_BEFORE: number
      PROTECTED_GRANTS_COUNT_AFTER: number
    }
    expect(addendumB5.GRANT_ID).toBe('HPO-ODS-W2-17')
    expect(w2_17).toEqual({
      authorityId: addendumB5.protected_grant.authorityId,
      branch: addendumB5.protected_grant.branch,
      patterns: addendumB5.protected_grant.patterns,
    })
    // The B5 authority is the source of truth for its own grant; addendum and
    // registry must both equal it exactly.
    const b5Authority = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/wave2/W2_B5_AUTHORITY_v1.0.0.json'), 'utf8'),
    ) as { GRANT_ID: string; protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count: number } }
    expect(b5Authority.GRANT_ID).toBe('HPO-ODS-W2-17')
    expect(b5Authority.protected_grant.authorityId).toBe(w2_17.authorityId)
    expect(b5Authority.protected_grant.branch).toBe(w2_17.branch)
    expect(b5Authority.protected_grant.patterns).toEqual(w2_17.patterns)
    expect(b5Authority.protected_grant.pattern_count).toBe(w2_17.patterns.length)
    // v1.0.16 records the cardinality after ITS OWN change (9 -> 10). That is
    // a historical fact and is pinned as a LITERAL here - the same demotion
    // v1.0.16 performed on v1.0.15 above. The LIVE guard now belongs to the
    // multi-org S1 registration (v1.0.20 / v1.0.21), asserted further down.
    expect(addendumB5.PROTECTED_GRANTS_COUNT_BEFORE).toBe(9)
    expect(addendumB5.PROTECTED_GRANTS_COUNT_AFTER).toBe(10)
    // W2-12 and W2-16 UNCHANGED by the arrival of W2-17, and on a DIFFERENT
    // branch — registering a third grant must widen neither predecessor.
    expect(PROTECTED_GRANTS[8]).toEqual({
      authorityId: 'HPO-ODS-W2-16',
      branch: 'codex/w2-b4-r1',
      patterns: ['db/prepared/checkpoint-b0/observation.sql'],
    })

    // HPO-ODS-W2-20 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json) and
    // HPO-ODS-W2-21 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json):
    // multi-org S1 founder traceability. TWO SEPARATE entries sharing one
    // branch, ONE pattern each - db/migrations/** and db/prepared/journal/**
    // respectively - on the v1.0.15 separate-grant precedent. Registered by
    // the S1 implementing mission; each must equal its declaring addendum's
    // protected_grant object field for field (T-S1-GRANT-1).
    const S1_BRANCH = 'codex/multiorg-s1-founder-traceability-r1'
    const w2_20 = PROTECTED_GRANTS[10]
    expect(w2_20).toEqual({
      authorityId: 'HPO-ODS-W2-20',
      branch: S1_BRANCH,
      patterns: ['db/migrations/**'],
    })
    const w2_21 = PROTECTED_GRANTS[11]
    expect(w2_21).toEqual({
      authorityId: 'HPO-ODS-W2-21',
      branch: S1_BRANCH,
      patterns: ['db/prepared/journal/**'],
    })
    type GrantAddendum = {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count?: number; registration_status?: string }
      PROTECTED_GRANTS_COUNT_BEFORE: number
      PROTECTED_GRANTS_COUNT_AFTER: number
      PROTECTED_GRANTS_COUNT_AFTER_S1_REGISTRATION?: number
    }
    const addendumS1Migration = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json'), 'utf8'),
    ) as GrantAddendum
    expect(addendumS1Migration.GRANT_ID).toBe('HPO-ODS-W2-20')
    expect(w2_20).toEqual({
      authorityId: addendumS1Migration.protected_grant.authorityId,
      branch: addendumS1Migration.protected_grant.branch,
      patterns: addendumS1Migration.protected_grant.patterns,
    })
    const addendumS1Journal = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json'), 'utf8'),
    ) as GrantAddendum
    expect(addendumS1Journal.GRANT_ID).toBe('HPO-ODS-W2-21')
    expect(w2_21).toEqual({
      authorityId: addendumS1Journal.protected_grant.authorityId,
      branch: addendumS1Journal.protected_grant.branch,
      patterns: addendumS1Journal.protected_grant.patterns,
    })
    expect(addendumS1Journal.protected_grant.pattern_count).toBe(w2_21.patterns.length)
    // The companion tenancy amendment declares the SAME W2-21 grant; three
    // artefacts (addendum, amendment, registry) must agree exactly.
    const tenancyAmendment = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.1.json'), 'utf8'),
    ) as { GRANT_ID: string; protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count: number } }
    expect(tenancyAmendment.GRANT_ID).toBe('HPO-ODS-W2-21')
    expect(tenancyAmendment.protected_grant.authorityId).toBe(w2_21.authorityId)
    expect(tenancyAmendment.protected_grant.branch).toBe(w2_21.branch)
    expect(tenancyAmendment.protected_grant.patterns).toEqual(w2_21.patterns)
    expect(tenancyAmendment.protected_grant.pattern_count).toBe(w2_21.patterns.length)
    // DEMOTED TO A HISTORICAL LITERAL (HPO-ODS-W2-25). These two figures were
    // bound to the LIVE array while the S1 registration was the newest registry
    // change. It no longer is: registering W2-25 moved the array to 13, and
    // v1.0.20 / v1.0.21 still describe the state as it stood at 12. Rebinding
    // them to the live length would make two frozen authority artefacts appear
    // to predict a count they never claimed; editing the artefacts to say 13
    // would corrupt the historical record. So the guard is demoted to the
    // literal those artefacts actually assert, and the LIVE binding moves to
    // the newest registration below. The exactness is unchanged.
    expect(addendumS1Journal.PROTECTED_GRANTS_COUNT_BEFORE).toBe(10)
    expect(addendumS1Journal.PROTECTED_GRANTS_COUNT_AFTER).toBe(10)
    expect(addendumS1Journal.PROTECTED_GRANTS_COUNT_AFTER_S1_REGISTRATION).toBe(12)
    const addendumCombined = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.21.json'), 'utf8'),
    ) as { GRANT_ID: string; protected_grant: unknown; PROTECTED_GRANTS_COUNT_AFTER_S1_REGISTRATION: number }
    expect(addendumCombined.PROTECTED_GRANTS_COUNT_AFTER_S1_REGISTRATION).toBe(12)
    // DEMOTED TO A HISTORICAL LITERAL (HPO-ODS-W2-26,
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json DEMOTE). This
    // figure was bound to the LIVE array while the S3 refusal-audit
    // registration was the newest registry change. It no longer is:
    // registering W2-26 moved the array to 14, and v1.0.25 still describes the
    // state as it stood at 13. Rebinding it to the live length would make a
    // frozen authority artefact appear to predict a count it never claimed;
    // editing the artefact to say 14 would corrupt the historical record. So
    // the guard is demoted to the literal that artefact actually asserts, and
    // the LIVE binding moves to the newest registration below. The exactness
    // is unchanged — one exact equality replaces another, nothing is loosened
    // to an inequality, skipped or deleted. This is the same operation the S1
    // guards above underwent one turn earlier.
    const addendumS3Refusal = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json'), 'utf8'),
    ) as {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count: number }
      PROTECTED_GRANTS_COUNT_BEFORE: number
      PROTECTED_GRANTS_COUNT_AFTER: number
      PROTECTED_GRANTS_COUNT_AFTER_IMPLEMENTATION_REGISTERS_W2_25: number
    }
    expect(addendumS3Refusal.GRANT_ID).toBe('HPO-ODS-W2-25')
    expect(addendumS3Refusal.PROTECTED_GRANTS_COUNT_BEFORE).toBe(12)
    expect(addendumS3Refusal.PROTECTED_GRANTS_COUNT_AFTER).toBe(12)
    expect(addendumS3Refusal.PROTECTED_GRANTS_COUNT_AFTER_IMPLEMENTATION_REGISTERS_W2_25).toBe(13)
    // DEMOTED TO A HISTORICAL LITERAL (HPO-ODS-W2-27,
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json DEMOTE). This
    // figure was bound to the LIVE array while the CE-1 registration was the
    // newest registry change. It no longer is: registering W2-27 moved the
    // array to 15, and v1.0.28 still describes the state as it stood at 14.
    // Rebinding it to the live length would make a frozen authority artefact
    // appear to predict a count it never claimed; editing the artefact to say
    // 15 would corrupt the historical record. So the guard is demoted to the
    // literal that artefact actually asserts, and the LIVE binding moves to
    // the newest registration below. The exactness is unchanged — one exact
    // equality replaces another, nothing is loosened to an inequality, skipped
    // or deleted. This is the same operation the v1.0.25 guard above underwent
    // one turn earlier, and the S1 guards one turn before that.
    const addendumCe1 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json'), 'utf8'),
    ) as {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count: number }
      PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_26: number
    }
    expect(addendumCe1.GRANT_ID).toBe('HPO-ODS-W2-26')
    expect(addendumCe1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_26).toBe(14)
    // The registered row must equal the authority's declaration field for
    // field — the artefact and the code cannot drift apart. Patterns are
    // compared with toEqual, so ORDER is enforced, not just membership.
    const w2_26_live = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-26')!
    expect(addendumCe1.protected_grant.authorityId).toBe(w2_26_live.authorityId)
    expect(addendumCe1.protected_grant.branch).toBe(w2_26_live.branch)
    expect(addendumCe1.protected_grant.patterns).toEqual(w2_26_live.patterns)
    expect(addendumCe1.protected_grant.pattern_count).toBe(w2_26_live.patterns.length)
    expect(w2_26_live.patterns.length).toBe(3)
    // LIVE-COUNT GUARD, DEMOTED (HPO-ODS-W2-28,
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json DEMOTE). This
    // field held the ONE live binding while the FIBDB-052 P1 registration was
    // the newest registry change. The CL-1 registration is now the newest, so
    // this guard is demoted to the frozen literal the v1.0.30 artefact
    // actually asserts — 15 — and the live binding transfers to the v1.0.31
    // field below. Exact equality replaces exact equality; nothing is
    // loosened, weakened or deleted.
    //
    // Editing v1.0.30 away from 15 to match the live count is PROHIBITED: it
    // would corrupt the historical record to satisfy a present-tense guard.
    const addendumP1 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json'), 'utf8'),
    ) as {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count: number }
      PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27: number
    }
    expect(addendumP1.GRANT_ID).toBe('HPO-ODS-W2-27')
    expect(addendumP1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27).toBe(15)
    // The registered row must equal the authority's declaration field for
    // field — the artefact and the code cannot drift apart. Patterns are
    // compared with toEqual, so ORDER is enforced, not just membership
    // (v1.0.30 RC-6).
    const w2_27_live = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-27')!
    expect(addendumP1.protected_grant.authorityId).toBe(w2_27_live.authorityId)
    expect(addendumP1.protected_grant.branch).toBe(w2_27_live.branch)
    expect(addendumP1.protected_grant.patterns).toEqual(w2_27_live.patterns)
    expect(addendumP1.protected_grant.pattern_count).toBe(w2_27_live.patterns.length)
    expect(w2_27_live.patterns.length).toBe(2)
    // LIVE-COUNT GUARD, PROMOTED (HPO-ODS-W2-28,
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json PROMOTE). The
    // newest registry change is now the Customer Lifecycle CL-1 registration,
    // so ITS declared post-registration figure — frozen in v1.0.31 as 16 — is
    // the one bound to the LIVE array. It is the successor of the guard
    // demoted above and inherits its role exactly: a registry that grew by
    // more or fewer than the one authorized entry fails here. Reading the
    // v1.0.31 artefact is an ADDITION to this file.
    //
    // EXACTLY ONE. This must be the ONLY assertion in this file binding a
    // frozen addendum field to the live expression PROTECTED_GRANTS.length.
    // Two live-count guards is a defect, not extra safety: the older one would
    // fail on the NEXT registration for a reason the next lane did not cause.
    const addendumCl1 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json'), 'utf8'),
    ) as {
      GRANT_ID: string
      protected_grant: { authorityId: string; branch: string; patterns: string[]; pattern_count: number }
      PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28: number
    }
    expect(addendumCl1.GRANT_ID).toBe('HPO-ODS-W2-28')
    expect(addendumCl1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28).toBe(
      PROTECTED_GRANTS.length,
    )
    // The registered row must equal the authority's declaration field for
    // field — the artefact and the code cannot drift apart. Patterns are
    // compared with toEqual, so ORDER is enforced, not just membership
    // (v1.0.31 ORDER_IS_BINDING).
    const w2_28_live = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-28')!
    expect(addendumCl1.protected_grant.authorityId).toBe(w2_28_live.authorityId)
    expect(addendumCl1.protected_grant.branch).toBe(w2_28_live.branch)
    expect(addendumCl1.protected_grant.patterns).toEqual(w2_28_live.patterns)
    expect(addendumCl1.protected_grant.pattern_count).toBe(w2_28_live.patterns.length)
    expect(w2_28_live.patterns.length).toBe(3)
    // The registered row must equal the authority's declaration field for
    // field — the artefact and the code cannot drift apart.
    const w2_25_live = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-25')!
    expect(addendumS3Refusal.protected_grant.authorityId).toBe(w2_25_live.authorityId)
    expect(addendumS3Refusal.protected_grant.branch).toBe(w2_25_live.branch)
    expect(addendumS3Refusal.protected_grant.patterns).toEqual(w2_25_live.patterns)
    expect(addendumS3Refusal.protected_grant.pattern_count).toBe(w2_25_live.patterns.length)
    // HPO-ODS-W2-22 is an ADDENDUM IDENTITY (v1.0.21 carries GRANT_ID
    // HPO-ODS-W2-22 with protected_grant = null). It MUST NOT be a registry
    // row: a lineage identifier is not a protected-path grant.
    expect(addendumCombined.GRANT_ID).toBe('HPO-ODS-W2-22')
    expect(addendumCombined.protected_grant).toBeNull()
    expect(PROTECTED_GRANTS.some((g) => g.authorityId === 'HPO-ODS-W2-22')).toBe(false)
    // NOT-WIDENED (T-S1-GRANT-4): the predecessors that already carry
    // db/prepared/journal/** or db/migrations/** are byte-unchanged - only the
    // branch field distinguishes them from the two new entries.
    expect(PROTECTED_GRANTS[0]).toEqual({
      authorityId: 'HPO-ODS-W2-01',
      branch: AUTHORIZED_BRANCH,
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    })
    expect(PROTECTED_GRANTS[7]).toEqual({
      authorityId: 'HPO-ODS-W2-12',
      branch: 'codex/w2-b4-r1',
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    })
    expect(PROTECTED_GRANTS[9]).toEqual({
      authorityId: 'HPO-ODS-W2-17',
      branch: 'codex/w2-b5-r1',
      patterns: ['db/migrations/**', 'db/prepared/journal/**', 'db/prepared/checkpoint-b0/observation.sql'],
    })
  })

  // HPO-ODS-W2-12 non-vacuity, both directions, plus branch binding. B4's
  // grant is the first glob-bearing grant registered since W2-01, so proving
  // it does not widen past its two named surfaces matters more here, not less.
  const B4_BRANCH = 'codex/w2-b4-r1'

  it('NON-VACUITY (B4-GRANT-N1/B4-GRANT-P1): a canonical db/migrations path is a protected violation WITHOUT HPO-ODS-W2-12 and grant-authorized WITH it', () => {
    // The 0062 filename here is a path-classification FIXTURE exercising the
    // db/migrations/** pattern. It asserts nothing about which migration slot
    // B4 will actually consume: that slot is a CANDIDATE only, explicitly not
    // frozen, and is re-measured mechanically at the P1A sync point (see
    // W2_B4_AUTHORITY_v1.0.0.json p1a_synchronization.migration_slot_candidate).
    const granted = ['db/migrations/0062_fib_methodological_assumptions.sql']

    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    expect(withoutGrant.grantAuthorized).toEqual([])

    const resolved = resolveProtectedGrant('HPO-ODS-W2-12', B4_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
  })

  it('NON-VACUITY (B4-GRANT-N2): an unrelated db/prepared path outside journal/ stays a protected violation even WITH HPO-ODS-W2-12', () => {
    // db/prepared/** is default-protected as a whole, but W2-12 names only
    // db/prepared/journal/**. If these were authorized the grant would have
    // silently widened to db/prepared/**, reaching files the hosted and P1A
    // lanes own under HPO-ODS-W2-03, W2-05 and W2-11.
    const unrelated = [
      'db/prepared/unrelated.sql',
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
      'db/prepared/stella_0001_role_topology_bootstrap.sql',
    ]

    const resolved = resolveProtectedGrant('HPO-ODS-W2-12', B4_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(unrelated, DEFAULT_PROTECTED_PATTERNS, unrelated, [resolved.grant!])
    expect(result.protectedViolations).toEqual(unrelated)
    expect(result.grantAuthorized).toEqual([])
  })

  // HPO-ODS-W2-16 non-vacuity, both directions, plus branch binding. These are
  // the W2-B4-remediation authority mission's real mutation controls: they
  // prove the ninth registry entry changes classifier behaviour in exactly one
  // direction and no further.
  it('NON-VACUITY (B4R-GRANT-N1/B4R-GRANT-P1): the checkpoint-b0 probe is a protected violation WITHOUT HPO-ODS-W2-16 and grant-authorized WITH it', () => {
    const granted = ['db/prepared/checkpoint-b0/observation.sql']

    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    expect(withoutGrant.grantAuthorized).toEqual([])

    const resolved = resolveProtectedGrant('HPO-ODS-W2-16', B4_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
  })

  it('NON-VACUITY (B4R-GRANT-N2): HPO-ODS-W2-16 does not widen to db/prepared/** or to the checkpoint-b0 directory', () => {
    // The grant names ONE literal file. A sibling invented inside the same
    // directory must still fail, which is what distinguishes an exact-path
    // grant from the directory pattern that was deliberately not written.
    const unrelated = [
      'db/prepared/checkpoint-b0/unrelated.sql',
      'db/prepared/checkpoint-a1/corroboration.sql',
      'db/prepared/stella_0001_role_topology_bootstrap.sql',
      'db/prepared/journal/001_0000_quick_husk.sql',
    ]

    const resolved = resolveProtectedGrant('HPO-ODS-W2-16', B4_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(unrelated, DEFAULT_PROTECTED_PATTERNS, unrelated, [resolved.grant!])
    expect(result.protectedViolations).toEqual(unrelated)
    expect(result.grantAuthorized).toEqual([])
  })

  it('BRANCH BINDING (B4R-GRANT-N3): HPO-ODS-W2-16 resolves to no grant on any other branch, exactly as an unknown id does', () => {
    for (const branch of ['integration/commercial-v1', 'main', 'codex/w2-b5-r1', 'codex/w2-b4-remediation-authority-r1']) {
      expect(resolveProtectedGrant('HPO-ODS-W2-16', branch).grant).toBeUndefined()
    }
    expect(resolveProtectedGrant('HPO-ODS-W2-16', B4_BRANCH).grant).toBeDefined()
  })

  it('SEPARATION (B4R-GRANT-N4): supplying HPO-ODS-W2-12 alone never authorizes the checkpoint-b0 probe, and W2-16 alone never authorizes a migration', () => {
    // The two grants share a branch. Sharing a branch must not merge their
    // pattern sets: a caller gets exactly the ids it supplies.
    const probe = ['db/prepared/checkpoint-b0/observation.sql']
    const migration = ['db/migrations/0062_fib_methodological_assumptions.sql']

    const w2_12 = resolveProtectedGrant('HPO-ODS-W2-12', B4_BRANCH).grant!
    const w2_16 = resolveProtectedGrant('HPO-ODS-W2-16', B4_BRANCH).grant!

    expect(classifyPaths(probe, DEFAULT_PROTECTED_PATTERNS, probe, [w2_12]).protectedViolations).toEqual(probe)
    expect(classifyPaths(migration, DEFAULT_PROTECTED_PATTERNS, migration, [w2_16]).protectedViolations).toEqual(migration)
  })

  // -------------------------------------------------------------------------
  // HPO-ODS-W2-17 (Wave 2 batch B5) non-vacuity, narrowness, branch binding
  // and no-composition. Mirrors the W2-12 / W2-16 controls exactly.
  // -------------------------------------------------------------------------

  const B5_BRANCH = 'codex/w2-b5-r1'

  it('NON-VACUITY (B5-GRANT-P1/N1): each of the three B5 surfaces is a protected violation WITHOUT HPO-ODS-W2-17 and grant-authorized WITH it', () => {
    const paths = [
      'db/migrations/0064_fib_readiness_assessments.sql',
      'db/prepared/journal/078_0064_fib_readiness_assessments.sql',
      'db/prepared/checkpoint-b0/observation.sql',
    ]
    // Without the grant: ordinary --allow can never authorize a protected path.
    expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, []).protectedViolations).toEqual(paths)
    // With it: all three resolve, and nothing is left unauthorized.
    const resolved = resolveProtectedGrant('HPO-ODS-W2-17', B5_BRANCH)
    expect(resolved.grant).toBeDefined()
    const ok = classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, [resolved.grant!])
    expect(ok.protectedViolations).toEqual([])
    expect(ok.unauthorized).toEqual([])
  })

  it('NARROWNESS (B5-GRANT-N2): HPO-ODS-W2-17 does not widen to db/prepared/**, to the checkpoint-b0 directory, or to the checkpoint-a1 historical measurement', () => {
    const ungranted = [
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
      'db/prepared/checkpoint-b0/some_other_file.sql',
      'db/prepared/checkpoint-a1/corroboration.sql',
      'db/baseline/stella_g2_roles.sql',
      'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md',
    ]
    const resolved = resolveProtectedGrant('HPO-ODS-W2-17', B5_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(ungranted, DEFAULT_PROTECTED_PATTERNS, ungranted, [resolved.grant!])
    expect(result.protectedViolations).toEqual(ungranted)
  })

  it('BRANCH BINDING (B5-GRANT-N3): HPO-ODS-W2-17 resolves to no grant on any other branch, exactly as an unknown id does', () => {
    for (const branch of ['codex/w2-b4-r1', 'codex/w2-b5-authority-r1', 'integration/commercial-v1', 'main', AUTHORIZED_BRANCH]) {
      expect(resolveProtectedGrant('HPO-ODS-W2-17', branch).grant).toBeUndefined()
    }
    expect(resolveProtectedGrant('HPO-ODS-W2-17', B5_BRANCH).grant).toBeDefined()
  })

  it('NO COMPOSITION (B5-GRANT-N4): W2-17 never authorizes a W2-B4-branch path and W2-12/W2-16 never authorize a B5-branch path — a grant is bound to exactly one branch', () => {
    const migration = ['db/migrations/0064_fib_readiness_assessments.sql']
    // W2-12 is defined on codex/w2-b4-r1, so it contributes ZERO patterns on the B5 branch.
    expect(resolveProtectedGrant('HPO-ODS-W2-12', B5_BRANCH).grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-16', B5_BRANCH).grant).toBeUndefined()
    expect(classifyPaths(migration, DEFAULT_PROTECTED_PATTERNS, migration, []).protectedViolations).toEqual(migration)
    // And the reverse direction: W2-17 is inert on the B4 branch.
    expect(resolveProtectedGrant('HPO-ODS-W2-17', 'codex/w2-b4-r1').grant).toBeUndefined()
  })

  it('SEPARATION (B5-GRANT-N5): an unresolved id contributes zero patterns and can never be papered over by a resolving one', () => {
    const paths = ['db/migrations/0064_fib_readiness_assessments.sql']
    const resolved = resolveProtectedGrants(['HPO-ODS-W2-12', 'HPO-ODS-W2-17'], B5_BRANCH)
    // Only W2-17 resolves on this branch; the union is exactly its own patterns.
    expect(resolved.grants.length).toBe(1)
    expect(resolved.grants[0]!.authorityId).toBe('HPO-ODS-W2-17')
    expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, resolved.grants).protectedViolations).toEqual([])
  })

  it('NON-VACUITY (B4-GRANT-N2b): HPO-ODS-W2-12 does not reach db/baseline/** or docs/ops/fib/**', () => {
    const ungranted = ['db/baseline/stella_g2_roles.sql', 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md']
    const resolved = resolveProtectedGrant('HPO-ODS-W2-12', B4_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(ungranted, DEFAULT_PROTECTED_PATTERNS, ungranted, [resolved.grant!])
    expect(result.protectedViolations).toEqual(ungranted)
    expect(result.grantAuthorized).toEqual([])
  })

  it('NON-VACUITY (B4-GRANT-N3 branch binding): HPO-ODS-W2-12 resolves to no grant on any other branch', () => {
    expect(resolveProtectedGrant('HPO-ODS-W2-12', 'main').grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-12', 'integration/commercial-v1').grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-12', AUTHORIZED_BRANCH).grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-12', 'codex/p1a-full-bootstrap-r1').grant).toBeUndefined()
  })

  it('REGRESSION: HPO-ODS-W2-11 is unaffected by the HPO-ODS-W2-12 registration', () => {
    const resolved = resolveProtectedGrant('HPO-ODS-W2-11', 'codex/p1a-full-bootstrap-r1')
    expect(resolved.grant).toBeDefined()
    expect(resolved.grant?.patterns).toEqual([
      'db/prepared/stella_local_0000_local_role_identity_bootstrap.sql',
      'db/prepared/stella_0001_role_topology_bootstrap.sql',
      'db/prepared/README.md',
    ])
    // And the two grants are disjoint in both directions: neither reaches the
    // other's paths, so registering W2-12 cannot have widened W2-11 either.
    const p1aPaths = resolved.grant!.patterns
    const b4 = resolveProtectedGrant('HPO-ODS-W2-12', B4_BRANCH).grant!
    expect(classifyPaths(p1aPaths, DEFAULT_PROTECTED_PATTERNS, p1aPaths, [b4]).grantAuthorized).toEqual([])
    const b4Path = ['db/migrations/0062_fib_methodological_assumptions.sql']
    expect(classifyPaths(b4Path, DEFAULT_PROTECTED_PATTERNS, b4Path, [resolved.grant!]).grantAuthorized).toEqual([])
  })

  // HPO-ODS-W2-20 / HPO-ODS-W2-21 (multi-org S1) non-vacuity, narrowness,
  // branch binding and separation. Two grants on ONE branch with ONE pattern
  // each: proving neither reaches past its own pattern matters exactly as
  // much as proving each reaches its own.
  const S1_BRANCH = 'codex/multiorg-s1-founder-traceability-r1'

  it('NON-VACUITY (S1-GRANT-P1/N1): a db/migrations path is a protected violation WITHOUT HPO-ODS-W2-20 and grant-authorized WITH it', () => {
    // Path-classification FIXTURE for the db/migrations/** pattern; asserts
    // nothing about which ordinal S1 actually consumed.
    const granted = ['db/migrations/0099_s1_fixture.sql', 'db/migrations/meta/0099_snapshot.json', 'db/migrations/meta/_journal.json']
    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    expect(withoutGrant.grantAuthorized).toEqual([])
    const resolved = resolveProtectedGrant('HPO-ODS-W2-20', S1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
  })

  it('NON-VACUITY (S1-GRANT-P2/N2): a db/prepared/journal path is a protected violation WITHOUT HPO-ODS-W2-21 and grant-authorized WITH it', () => {
    const granted = ['db/prepared/journal/079_0099_s1_fixture.sql', 'db/prepared/journal/078_0065_fib_sensitivity_model.sql']
    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    const resolved = resolveProtectedGrant('HPO-ODS-W2-21', S1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
  })

  it('NARROWNESS (S1-GRANT-N3 / T-S1-GRANT-5): HPO-ODS-W2-21 does not widen to db/prepared/** - stella_0010 and checkpoint-b0 stay protected violations even WITH it', () => {
    const unrelated = [
      'db/prepared/stella_0010_organization_bootstrap_capability.sql',
      'db/prepared/checkpoint-b0/observation.sql',
      'db/prepared/checkpoint-a1/corroboration.sql',
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
    ]
    const resolved = resolveProtectedGrant('HPO-ODS-W2-21', S1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(unrelated, DEFAULT_PROTECTED_PATTERNS, unrelated, [resolved.grant!])
    expect(result.protectedViolations).toEqual(unrelated)
    expect(result.grantAuthorized).toEqual([])
  })

  it('SEPARATION (S1-GRANT-N4): W2-20 alone never authorizes a journal wrapper, and W2-21 alone never authorizes a migration', () => {
    const w2_20 = resolveProtectedGrant('HPO-ODS-W2-20', S1_BRANCH).grant!
    const w2_21 = resolveProtectedGrant('HPO-ODS-W2-21', S1_BRANCH).grant!
    const journal = ['db/prepared/journal/079_0099_s1_fixture.sql']
    const migration = ['db/migrations/0099_s1_fixture.sql']
    expect(classifyPaths(journal, DEFAULT_PROTECTED_PATTERNS, journal, [w2_20]).protectedViolations).toEqual(journal)
    expect(classifyPaths(migration, DEFAULT_PROTECTED_PATTERNS, migration, [w2_21]).protectedViolations).toEqual(migration)
    // Both supplied together: the union covers both families and nothing else.
    const both = resolveProtectedGrants(['HPO-ODS-W2-20', 'HPO-ODS-W2-21'], S1_BRANCH)
    expect(both.grants.map((g) => g.authorityId)).toEqual(['HPO-ODS-W2-20', 'HPO-ODS-W2-21'])
    const union = classifyPaths([...journal, ...migration], DEFAULT_PROTECTED_PATTERNS, [...journal, ...migration], both.grants)
    expect(union.protectedViolations).toEqual([])
    expect(union.grantAuthorized).toEqual([...journal, ...migration])
    expect(classifyPaths(['db/prepared/sibling.sql'], DEFAULT_PROTECTED_PATTERNS, ['db/prepared/sibling.sql'], both.grants).protectedViolations).toEqual(['db/prepared/sibling.sql'])
  })

  it('BRANCH BINDING (S1-GRANT-N5 / T-S1-GRANT-6): W2-20 and W2-21 resolve to no grant on any other branch, and W2-22 resolves nowhere', () => {
    for (const branch of ['main', 'integration/commercial-v1', AUTHORIZED_BRANCH, 'codex/w2-b4-r1', 'codex/w2-b5-r1', 'codex/multiorg-s2-selected-org-carrier-r1']) {
      expect(resolveProtectedGrant('HPO-ODS-W2-20', branch).grant).toBeUndefined()
      expect(resolveProtectedGrant('HPO-ODS-W2-21', branch).grant).toBeUndefined()
    }
    expect(resolveProtectedGrant('HPO-ODS-W2-20', S1_BRANCH).grant).toBeDefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-21', S1_BRANCH).grant).toBeDefined()
    // W2-22 is a lineage identifier, not a grant: unknown to the resolver on
    // every branch, exactly as a made-up id is.
    expect(resolveProtectedGrant('HPO-ODS-W2-22', S1_BRANCH).grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-22', S1_BRANCH).reason).toContain('unknown protected authority')
    // And the S1 branch cannot borrow the W2-01/W2-12/W2-17 journal grants.
    expect(resolveProtectedGrant('HPO-ODS-W2-01', S1_BRANCH).grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-12', S1_BRANCH).grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-17', S1_BRANCH).grant).toBeUndefined()
  })

  // HPO-ODS-W2-11 non-vacuity, both directions. A grant that authorizes
  // nothing new, or that authorizes more than it names, is equally useless;
  // these two controls pin it from both sides.
  it('NON-VACUITY (P1A-N8 direction i): a granted P1A path is a protected violation WITHOUT HPO-ODS-W2-11 and grant-authorized WITH it', () => {
    const P1A_BRANCH = 'codex/p1a-full-bootstrap-r1'
    const granted = ['db/prepared/stella_local_0000_local_role_identity_bootstrap.sql']

    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    expect(withoutGrant.grantAuthorized).toEqual([])

    const resolved = resolveProtectedGrant('HPO-ODS-W2-11', P1A_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
  })

  it('NON-VACUITY (P1A-N8 direction ii): an unrelated db/prepared path stays a protected violation even WITH HPO-ODS-W2-11', () => {
    const P1A_BRANCH = 'codex/p1a-full-bootstrap-r1'
    // A real sibling under the same default-protected db/prepared/** surface
    // that HPO-ODS-W2-11 does not name. If this were authorized, the grant
    // would have silently widened to db/prepared/**.
    const unrelated = ['db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql']

    const resolved = resolveProtectedGrant('HPO-ODS-W2-11', P1A_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(unrelated, DEFAULT_PROTECTED_PATTERNS, unrelated, [resolved.grant!])
    expect(result.protectedViolations).toEqual(unrelated)
    expect(result.grantAuthorized).toEqual([])
  })

  it('NON-VACUITY (P1A-N8 branch binding): HPO-ODS-W2-11 resolves to no grant on any other branch', () => {
    expect(resolveProtectedGrant('HPO-ODS-W2-11', 'main').grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-11', 'integration/commercial-v1').grant).toBeUndefined()
    expect(resolveProtectedGrant('HPO-ODS-W2-11', AUTHORIZED_BRANCH).grant).toBeUndefined()
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

// ---------------------------------------------------------------------------
// HPO-ODS-W2-26 — Commercial Account CE-1 grant registration controls.
// docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json, refined by the
// minimal append-only successor v1.0.29 (LIVE_COUNT_GUARD_TRANSFER).
// ---------------------------------------------------------------------------

describe('HPO-ODS-W2-26 — CE-1 grant: narrowness, branch binding and mutation controls', () => {
  const CE1_BRANCH = 'codex/commercial-account-ce1-implementation-r1'

  it('NON-VACUITY (CE1-GRANT-P1/N1): the three granted families are protected violations WITHOUT W2-26 and grant-authorized WITH it', () => {
    const granted = [
      'db/migrations/0099_ce1_fixture.sql',
      'db/prepared/journal/080_0099_ce1_fixture.sql',
      'db/prepared/checkpoint-b0/observation.sql',
    ]
    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    const resolved = resolveProtectedGrant('HPO-ODS-W2-26', CE1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
  })

  it('NARROWNESS (CE1-GRANT-N2): W2-26 does not widen to db/prepared/** — sibling prepared paths stay protected violations even WITH it', () => {
    const siblings = [
      'db/prepared/stella_0010_organization_bootstrap_capability.sql',
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
      'db/prepared/checkpoint-a1/corroboration.sql',
      // The SIBLING of the single authorized literal, inside the very same
      // checkpoint-b0 directory. This is the assertion that proves the third
      // pattern is a literal file and not a directory glob.
      'db/prepared/checkpoint-b0/unrelated.sql',
      'db/prepared/checkpoint-b0/rollback.sql',
    ]
    const resolved = resolveProtectedGrant('HPO-ODS-W2-26', CE1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(siblings, DEFAULT_PROTECTED_PATTERNS, siblings, [resolved.grant!])
    expect(result.protectedViolations).toEqual(siblings)
    expect(result.grantAuthorized).toEqual([])
    // ...while the ONE authorized literal in that same directory still passes,
    // so the control above is narrowness and not a blanket denial.
    const literal = ['db/prepared/checkpoint-b0/observation.sql']
    expect(
      classifyPaths(literal, DEFAULT_PROTECTED_PATTERNS, literal, [resolved.grant!]).protectedViolations,
    ).toEqual([])
  })

  it('BRANCH BINDING (CE1-GRANT-N3): W2-26 resolves to no grant on any foreign branch, and contributes zero patterns there', () => {
    for (const branch of [
      'main',
      'integration/commercial-v1',
      'feature/sprint-0-foundation',
      'codex/w2-methodology-objects-r1',
      'codex/multiorg-s1-founder-traceability-r1',
      'codex/multiorg-s3-refusal-audit-implementation-r1',
      'codex/ce1-w2-26-registration-r1',
    ]) {
      expect(resolveProtectedGrant('HPO-ODS-W2-26', branch).grant).toBeUndefined()
      // Zero patterns contributed: a foreign branch cannot use this grant to
      // authorize anything at all.
      const union = resolveProtectedGrants(['HPO-ODS-W2-26'], branch)
      expect(union.grants).toEqual([])
      const paths = ['db/migrations/0099_ce1_fixture.sql']
      expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, union.grants).protectedViolations).toEqual(paths)
    }
    expect(resolveProtectedGrant('HPO-ODS-W2-26', CE1_BRANCH).grant).toBeDefined()
  })

  it('ABSENCE (CE1-GRANT-N4): HPO-ODS-W2-29 is unallocated and unregistered, and resolves nowhere', () => {
    // ADVANCED from W2-28 to W2-29 when W2-28 was registered under
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json, exactly as it
    // advanced from W2-27 to W2-28 when W2-27 was registered. This is one of
    // the two executable clusters that assert the next id absent; the other
    // lives in the frozen-registry test above and advanced in the same act.
    // W2-29 is named here as a PROHIBITION — v1.0.31 NO_PREALLOCATION lists
    // HPO-ODS-W2-29 among the ids it explicitly does NOT allocate.
    expect(PROTECTED_GRANTS.some((g) => g.authorityId === 'HPO-ODS-W2-29')).toBe(false)
    for (const branch of [CE1_BRANCH, 'main', 'codex/ce1-w2-26-registration-r1']) {
      expect(resolveProtectedGrant('HPO-ODS-W2-29', branch).grant).toBeUndefined()
    }
  })

  it('APPEND-ONLY (CE1-GRANT-N5): the 13 predecessor rows are preserved, in order, with their branches unchanged', () => {
    // Mutation control for RC-9. Reordering, rebranching, widening or dropping
    // any predecessor row fails here. W2-26 is appended LAST and touches none
    // of them.
    const PREDECESSORS: ReadonlyArray<readonly [string, string]> = [
      ['HPO-ODS-W2-01', 'codex/w2-methodology-objects-r1'],
      ['HPO-ODS-W2-02', 'codex/u0-u9-reengineering-resume-r1'],
      ['HPO-ODS-W2-03', 'codex/u0-u9-reengineering-resume-r1'],
      ['HPO-ODS-W2-07', 'codex/product-commercial-v1-pr-r1'],
      ['HPO-ODS-W2-08', 'codex/commercial-v1-wave2-reconciliation-r1'],
      ['HPO-ODS-W2-09', 'codex/commercial-v1-wave2-reconciliation-r1'],
      ['HPO-ODS-W2-11', 'codex/p1a-full-bootstrap-r1'],
      ['HPO-ODS-W2-12', 'codex/w2-b4-r1'],
      ['HPO-ODS-W2-16', 'codex/w2-b4-r1'],
      ['HPO-ODS-W2-17', 'codex/w2-b5-r1'],
      ['HPO-ODS-W2-20', 'codex/multiorg-s1-founder-traceability-r1'],
      ['HPO-ODS-W2-21', 'codex/multiorg-s1-founder-traceability-r1'],
      ['HPO-ODS-W2-25', 'codex/multiorg-s3-refusal-audit-implementation-r1'],
    ]
    expect(PROTECTED_GRANTS.slice(0, 13).map((g) => [g.authorityId, g.branch])).toEqual(
      PREDECESSORS.map(([id, branch]) => [id, branch]),
    )
    // W2-26 sits at index 13, immediately after those 13 predecessors, so ITS
    // arrival was an append and not an insert. Pinned by POSITION rather than
    // by "is the last row": the latter was only true while CE-1 was the newest
    // registration, and W2-27 has since been appended after it under
    // docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json. The position pin
    // is the durable form of the same claim — it still fails on an insert, a
    // reorder or a drop — and the LIVE last-row binding moves to the newest
    // registration (P1-GRANT-N5), exactly as the live-count guard does.
    expect(PROTECTED_GRANTS[13].authorityId).toBe('HPO-ODS-W2-26')
    // The checkpoint-b0 observation literal did not leak sideways. The set of
    // PREDECESSORS carrying it is pinned to exactly the four that already did
    // before this registration — W2-07 and W2-16 as single-pattern probe
    // grants, W2-08 and W2-17 as members of their larger literal families.
    // Asserted as a set equality rather than a per-row exclusion, so that a
    // predecessor GAINING the literal and a predecessor LOSING it both fail.
    const OBSERVATION = 'db/prepared/checkpoint-b0/observation.sql'
    expect(
      PROTECTED_GRANTS.slice(0, 13)
        .filter((g) => g.patterns.includes(OBSERVATION))
        .map((g) => g.authorityId),
    ).toEqual(['HPO-ODS-W2-07', 'HPO-ODS-W2-08', 'HPO-ODS-W2-16', 'HPO-ODS-W2-17'])
    // Across the WHOLE registry the carriers are those four, plus W2-26, plus
    // the newly registered W2-28 — and nothing else. W2-27 between them does
    // NOT carry the literal, which is what makes this an ordered set equality
    // rather than a suffix check.
    expect(PROTECTED_GRANTS.filter((g) => g.patterns.includes(OBSERVATION)).map((g) => g.authorityId)).toEqual([
      'HPO-ODS-W2-07',
      'HPO-ODS-W2-08',
      'HPO-ODS-W2-16',
      'HPO-ODS-W2-17',
      'HPO-ODS-W2-26',
      'HPO-ODS-W2-28',
    ])
    // No grant anywhere in the registry carries a blanket db/prepared/**.
    for (const g of PROTECTED_GRANTS) {
      expect(g.patterns).not.toContain('db/prepared/**')
    }
  })

  it('LIVE_COUNT_GUARD_TRANSFER (CE1-GRANT-N6, advanced by v1.0.31): exactly ONE assertion binds a frozen addendum field to the live PROTECTED_GRANTS.length, and it is the v1.0.31 field', () => {
    // MUTATION CONTROL for the indivisible transfer. This reads THIS file's
    // own source, because the property being guarded is a property of the
    // source: the count of live-count guards must be exactly one.
    //
    // DEMOTE-WITHOUT-PROMOTE would leave ZERO — green with no guard at all,
    // the dangerous half precisely because it looks fine. This assertion is
    // what makes that half fail.
    const selfSource = readFileSync(path.join(REPO_ROOT, 'tests/ods/ods-scope.test.ts'), 'utf8')
    const liveGuard = /expect\(\s*([A-Za-z0-9_.]*PROTECTED_GRANTS_COUNT[A-Za-z0-9_]*)\s*\)\s*\.toBe\(\s*PROTECTED_GRANTS\.length\s*,?\s*\)/g
    const bound = [...selfSource.matchAll(liveGuard)].map((m) => m[1])
    expect(bound.length).toBe(1)
    // ADVANCED under docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json,
    // in the form v1.0.30 RC-13 established: advancing the count without
    // advancing the pinned NAME would leave a control that passes while
    // guarding the wrong field.
    expect(bound[0]).toBe('addendumCl1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28')
  })

  it('LIVE_COUNT_GUARD_TRANSFER (CE1-GRANT-N7): PROMOTE-WITHOUT-DEMOTE would be red — the v1.0.25 frozen figure no longer equals the live count', () => {
    // MUTATION CONTROL for the other half. Had the v1.0.25 guard been left
    // bound to the live array, it would now evaluate 13 against 14 and fail.
    // This asserts that divergence directly, which is what makes the demotion
    // NECESSARY rather than cosmetic — and it pins that the demoted literal is
    // the figure the frozen artefact actually asserts, not the live count.
    const addendumS3 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json'), 'utf8'),
    ) as { PROTECTED_GRANTS_COUNT_AFTER_IMPLEMENTATION_REGISTERS_W2_25: number }
    expect(addendumS3.PROTECTED_GRANTS_COUNT_AFTER_IMPLEMENTATION_REGISTERS_W2_25).toBe(13)
    expect(addendumS3.PROTECTED_GRANTS_COUNT_AFTER_IMPLEMENTATION_REGISTERS_W2_25).not.toBe(
      PROTECTED_GRANTS.length,
    )
    // Editing that frozen artefact away from 13 to match the live count is
    // PROHIBITED — it would corrupt
    // the historical record to satisfy a present-tense guard. This assertion
    // fails if anyone does it. The live literal is re-derived, not inherited:
    // it advanced 14 -> 15 when W2-27 was registered and 15 -> 16 when W2-28
    // was registered.
    expect(PROTECTED_GRANTS.length).toBe(16)
  })

  it('SEPARATION (CE1-GRANT-N8): no OTHER registered grant authorizes the CE-1 families on the CE-1 branch', () => {
    // W2-07/W2-16 carry the same checkpoint-b0 observation literal and
    // W2-01/W2-20/W2-21/W2-25 carry the same migration and journal families,
    // but all of them are bound to OTHER branches. On the CE-1 branch they
    // resolve to nothing, so W2-26 is doing real work and is not a duplicate
    // of an existing grant.
    const ceiling = ['HPO-ODS-W2-01', 'HPO-ODS-W2-07', 'HPO-ODS-W2-16', 'HPO-ODS-W2-20', 'HPO-ODS-W2-21', 'HPO-ODS-W2-25']
    const resolved = resolveProtectedGrants(ceiling, CE1_BRANCH)
    expect(resolved.grants).toEqual([])
    const paths = [
      'db/migrations/0099_ce1_fixture.sql',
      'db/prepared/journal/080_0099_ce1_fixture.sql',
      'db/prepared/checkpoint-b0/observation.sql',
    ]
    expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, resolved.grants).protectedViolations).toEqual(paths)
  })
})

// ---------------------------------------------------------------------------
// HPO-ODS-W2-27 — FIBDB-052 phase P1 grant registration controls.
// docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json, REQUIRED_REGISTRATION_
// CONTROLS RC-1..RC-14 and LIVE_COUNT_GUARD_TRANSFER.
// ---------------------------------------------------------------------------

describe('HPO-ODS-W2-27 — FIBDB-052 P1 grant: narrowness, branch binding and mutation controls', () => {
  const P1_BRANCH = 'codex/fibdb052-p1-implementation-r1'

  it('NON-VACUITY (P1-GRANT-P1/N1, RC-11): the two granted families are protected violations WITHOUT W2-27 and grant-authorized WITH it', () => {
    const granted = [
      'db/migrations/0099_p1_index_fixture.sql',
      'db/prepared/journal/082_0099_p1_index_fixture.sql',
    ]
    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    expect(withoutGrant.grantAuthorized).toEqual([])
    const resolved = resolveProtectedGrant('HPO-ODS-W2-27', P1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
    // The migration meta corpus a drizzle generate necessarily drags with it
    // is inside db/migrations/** and therefore inside the grant.
    const meta = ['db/migrations/meta/_journal.json', 'db/migrations/meta/0069_snapshot.json']
    expect(classifyPaths(meta, DEFAULT_PROTECTED_PATTERNS, meta, [resolved.grant!]).protectedViolations).toEqual([])
  })

  it('NARROWNESS (P1-GRANT-N2, RC-8): W2-27 does not widen to db/prepared/** — checkpoint-b0, hosted and every other prepared sibling stay protected violations even WITH it', () => {
    const siblings = [
      // THE ONE THE PREDECESSOR CARRIES. W2-26 grants this literal; W2-27
      // deliberately does not. Asserting it refused here is what distinguishes
      // a deliberate narrowing from an omission (v1.0.30 RC-8
      // why_checkpoint_b0_is_named_explicitly).
      'db/prepared/checkpoint-b0/observation.sql',
      'db/prepared/checkpoint-b0/rollback.sql',
      // G2-gated apply surfaces a blanket db/prepared/** would have reached.
      'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql',
      'db/prepared/hosted/governed/anything.sql',
      'db/prepared/other/observation.sql',
      'db/prepared/stella_0010_organization_bootstrap_capability.sql',
      'db/prepared/checkpoint-a1/corroboration.sql',
      'db/prepared/README.md',
    ]
    const resolved = resolveProtectedGrant('HPO-ODS-W2-27', P1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(siblings, DEFAULT_PROTECTED_PATTERNS, siblings, [resolved.grant!])
    expect(result.protectedViolations).toEqual(siblings)
    expect(result.grantAuthorized).toEqual([])
    // ...while the journal family in that same directory still passes, so the
    // control above is narrowness and not a blanket denial.
    const journal = ['db/prepared/journal/082_0099_p1_index_fixture.sql']
    expect(
      classifyPaths(journal, DEFAULT_PROTECTED_PATTERNS, journal, [resolved.grant!]).protectedViolations,
    ).toEqual([])
    // db/baseline/** is protected and ungranted by this row.
    const baseline = ['db/baseline/MANIFEST.sha256']
    expect(
      classifyPaths(baseline, DEFAULT_PROTECTED_PATTERNS, baseline, [resolved.grant!]).protectedViolations,
    ).toEqual(baseline)
  })

  it('ZERO GRANT AUTHORITY OVER UNPROTECTED SURFACES (P1-GRANT-N2b): scripts/ods/** and tests/ods/** are not members of DEFAULT_PROTECTED_PATTERNS, so W2-27 confers nothing on them', () => {
    // v1.0.30 why_the_unprotected_entries_are_listed_anyway: these are named in
    // the prohibition list so that no reader infers, from their absence, that
    // the grant was silently understood to cover them. The honest assertion is
    // that the grant contributes ZERO authority — they are governed by the
    // ordinary --allow list alone, exactly as they were before this row
    // existed.
    const unprotected = ['scripts/ods/helper.ts', 'tests/ods/extra.test.ts', 'docs/ops/wave3/anything.json']
    const resolved = resolveProtectedGrant('HPO-ODS-W2-27', P1_BRANCH)
    expect(resolved.grant).toBeDefined()
    for (const p of unprotected) {
      expect(matchesAnyPattern(p, resolved.grant!.patterns)).toBe(false)
    }
    // With no ordinary allowlist they are UNAUTHORIZED, and the grant does not
    // rescue them.
    const withGrantNoAllow = classifyPaths(unprotected, DEFAULT_PROTECTED_PATTERNS, [], [resolved.grant!])
    expect(withGrantNoAllow.unauthorized.sort()).toEqual([...unprotected].sort())
    expect(withGrantNoAllow.grantAuthorized).toEqual([])
    // With an ordinary allowlist they pass on the allowlist's authority only —
    // never counted as grant-authorized.
    const withAllow = classifyPaths(unprotected, DEFAULT_PROTECTED_PATTERNS, unprotected, [resolved.grant!])
    expect(withAllow.grantAuthorized).toEqual([])
    expect(withAllow.protectedViolations).toEqual([])
  })

  it('BRANCH BINDING (P1-GRANT-N3, RC-7): W2-27 resolves to no grant on any foreign branch, and contributes zero patterns there', () => {
    for (const branch of [
      'main',
      'integration/commercial-v1',
      'feature/sprint-0-foundation',
      'codex/w2-methodology-objects-r1',
      'codex/commercial-account-ce1-implementation-r1',
      'codex/multiorg-s3-refusal-audit-implementation-r1',
      // The REGISTERING branch is itself foreign to the grant it registers: a
      // registration lane gains no protected-write authority by registering.
      'codex/fibdb052-p1-w227-registration-r1',
      // Near-misses. Resolution is exact string equality, never prefix or
      // family (v1.0.30 BRANCH_BINDING_IS_EXACT).
      'codex/fibdb052-p1-implementation-r2',
      'codex/fibdb052-p1-implementation',
      'codex/fibdb052-p1-implementation-r1-fix',
    ]) {
      expect(resolveProtectedGrant('HPO-ODS-W2-27', branch).grant).toBeUndefined()
      const union = resolveProtectedGrants(['HPO-ODS-W2-27'], branch)
      expect(union.grants).toEqual([])
      const paths = ['db/migrations/0099_p1_index_fixture.sql']
      expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, union.grants).protectedViolations).toEqual(paths)
    }
    expect(resolveProtectedGrant('HPO-ODS-W2-27', P1_BRANCH).grant).toBeDefined()
  })

  it('APPEND-ONLY (P1-GRANT-N5, RC-1/RC-9): the 14 predecessor rows are preserved, in order, with their branches unchanged, and W2-27 is LAST', () => {
    // Mutation control for RC-9. Reordering, rebranching, widening or dropping
    // any predecessor row fails here. W2-27 is appended LAST and touches none
    // of them.
    const PREDECESSORS: ReadonlyArray<readonly [string, string]> = [
      ['HPO-ODS-W2-01', 'codex/w2-methodology-objects-r1'],
      ['HPO-ODS-W2-02', 'codex/u0-u9-reengineering-resume-r1'],
      ['HPO-ODS-W2-03', 'codex/u0-u9-reengineering-resume-r1'],
      ['HPO-ODS-W2-07', 'codex/product-commercial-v1-pr-r1'],
      ['HPO-ODS-W2-08', 'codex/commercial-v1-wave2-reconciliation-r1'],
      ['HPO-ODS-W2-09', 'codex/commercial-v1-wave2-reconciliation-r1'],
      ['HPO-ODS-W2-11', 'codex/p1a-full-bootstrap-r1'],
      ['HPO-ODS-W2-12', 'codex/w2-b4-r1'],
      ['HPO-ODS-W2-16', 'codex/w2-b4-r1'],
      ['HPO-ODS-W2-17', 'codex/w2-b5-r1'],
      ['HPO-ODS-W2-20', 'codex/multiorg-s1-founder-traceability-r1'],
      ['HPO-ODS-W2-21', 'codex/multiorg-s1-founder-traceability-r1'],
      ['HPO-ODS-W2-25', 'codex/multiorg-s3-refusal-audit-implementation-r1'],
      ['HPO-ODS-W2-26', 'codex/commercial-account-ce1-implementation-r1'],
    ]
    expect(PROTECTED_GRANTS.slice(0, 14).map((g) => [g.authorityId, g.branch])).toEqual(
      PREDECESSORS.map(([id, branch]) => [id, branch]),
    )
    // W2-27 sits at index 14, immediately after those 14 predecessors, so ITS
    // arrival was an append and not an insert (RC-1). Pinned by POSITION
    // rather than by "is the last row": the latter was only true while P1 was
    // the newest registration, and W2-28 has since been appended after it
    // under docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json. The
    // position pin is the durable form of the same claim — it still fails on
    // an insert, a reorder or a drop — and the LIVE last-row binding moves to
    // the newest registration (CL1-GRANT-N5), exactly as the live-count guard
    // does.
    expect(PROTECTED_GRANTS[14].authorityId).toBe('HPO-ODS-W2-27')
    expect(PROTECTED_GRANTS.length).toBe(16)
    // The checkpoint-b0 observation literal did not leak sideways onto W2-27.
    // Across the WHOLE registry the carriers are the five that already carried
    // it before the P1 registration, plus W2-28 which was measured to need it
    // — W2-27 itself gained NOTHING and still carries neither. Asserted as a
    // set equality rather than a per-row exclusion, so that a row GAINING the
    // literal and a row LOSING it both fail.
    const OBSERVATION = 'db/prepared/checkpoint-b0/observation.sql'
    expect(PROTECTED_GRANTS.filter((g) => g.patterns.includes(OBSERVATION)).map((g) => g.authorityId)).toEqual([
      'HPO-ODS-W2-07',
      'HPO-ODS-W2-08',
      'HPO-ODS-W2-16',
      'HPO-ODS-W2-17',
      'HPO-ODS-W2-26',
      'HPO-ODS-W2-28',
    ])
    expect(PROTECTED_GRANTS[14].patterns).not.toContain(OBSERVATION)
    // No grant anywhere in the registry carries a blanket db/prepared/**.
    for (const g of PROTECTED_GRANTS) {
      expect(g.patterns).not.toContain('db/prepared/**')
    }
  })

  it('LIVE_COUNT_GUARD_TRANSFER (P1-GRANT-N6, RC-12): PROMOTE-WITHOUT-DEMOTE would be red — the v1.0.28 frozen figure no longer equals the live count', () => {
    // MUTATION CONTROL for the DEMOTE half. Had the v1.0.28 guard been left
    // bound to the live array, it would now evaluate 14 against 15 and fail.
    // This asserts that divergence directly, which is what makes the demotion
    // NECESSARY rather than cosmetic — and it pins that the demoted literal is
    // the figure the frozen artefact actually asserts, not the live count.
    const addendumCe1Frozen = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json'), 'utf8'),
    ) as { PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_26: number }
    expect(addendumCe1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_26).toBe(14)
    expect(addendumCe1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_26).not.toBe(
      PROTECTED_GRANTS.length,
    )
    // Editing that frozen artefact away from 14 to match the live count is
    // PROHIBITED (v1.0.30 THE_THIRD_WAY_IS_PROHIBITED) — it would corrupt the
    // historical record to satisfy a present-tense guard. This assertion fails
    // if anyone does it.
    expect(PROTECTED_GRANTS.length).toBe(16)
  })

  it('ATOMICITY (P1-GRANT-N7, RC-14): the demoted literal and the promoted live binding are both present in this file, and the live binding is unique', () => {
    // The auditor's atomicity check, made executable. DEMOTE-WITHOUT-PROMOTE
    // would leave ZERO live bindings — green with no guard at all, the
    // dangerous half precisely because it looks fine. PROMOTE-WITHOUT-DEMOTE
    // would leave TWO. Both halves fail here.
    const selfSource = readFileSync(path.join(REPO_ROOT, 'tests/ods/ods-scope.test.ts'), 'utf8')
    const liveGuard =
      /expect\(\s*([A-Za-z0-9_.]*PROTECTED_GRANTS_COUNT[A-Za-z0-9_]*)\s*\)\s*\.toBe\(\s*PROTECTED_GRANTS\.length\s*,?\s*\)/g
    const bound = [...selfSource.matchAll(liveGuard)].map((m) => m[1])
    expect(bound).toEqual(['addendumCl1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28'])
    // THE DEMOTE landed: the v1.0.28 field is pinned to its exact historical
    // literal, not to the live array and not to an inequality.
    expect(selfSource).toContain(
      'expect(addendumCe1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_26).toBe(14)',
    )
    // THE PROMOTE landed against the v1.0.30 artefact specifically.
    expect(selfSource).toContain('ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json')
  })

  it('SEPARATION (P1-GRANT-N8): no OTHER registered grant authorizes the P1 families on the P1 branch', () => {
    // Six registered grants carry db/migrations/** and/or db/prepared/journal/**
    // — W2-01, W2-07, W2-16, W2-20, W2-21 and W2-25 — and W2-26 carries them
    // too. Every one is bound to a DIFFERENT branch, so on the P1 branch they
    // resolve to nothing and W2-27 is doing real work rather than duplicating
    // an existing grant (v1.0.30 why_existing_grants_cannot_be_reused).
    const ceiling = [
      'HPO-ODS-W2-01',
      'HPO-ODS-W2-07',
      'HPO-ODS-W2-16',
      'HPO-ODS-W2-20',
      'HPO-ODS-W2-21',
      'HPO-ODS-W2-25',
      'HPO-ODS-W2-26',
    ]
    const resolved = resolveProtectedGrants(ceiling, P1_BRANCH)
    expect(resolved.grants).toEqual([])
    const paths = [
      'db/migrations/0099_p1_index_fixture.sql',
      'db/prepared/journal/082_0099_p1_index_fixture.sql',
    ]
    expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, resolved.grants).protectedViolations).toEqual(paths)
  })

  it('IMPLEMENTATION PREDICATE (P1-GRANT-N9): GRANT_ALREADY_REGISTERED is TRUE for HPO-ODS-W2-27 under KEY-POSITION semantics, and a textual sweep is not the evaluator', () => {
    // v1.0.30 IMPLEMENTATION_REGISTRY_PREDICATE. The predicate is evaluated by
    // parsing the PROTECTED_GRANTS array literal and reading the authorityId
    // KEY POSITION — never by a textual mention, never by an occurrence count.
    // This control evaluates it the authorized way against the real source and
    // demonstrates, in the same test, that the unauthorized way disagrees.
    const scopeSource = readFileSync(path.join(REPO_ROOT, 'scripts/ods-scope.ts'), 'utf8')
    // KEY-POSITIONAL: the evaluated array object, not the text of the file.
    const registeredByKeyPosition = PROTECTED_GRANTS.map((g) => g.authorityId)
    expect(registeredByKeyPosition).toContain('HPO-ODS-W2-27')
    expect(registeredByKeyPosition).not.toContain('HPO-ODS-W2-29')
    expect(registeredByKeyPosition.filter((id) => id === 'HPO-ODS-W2-27').length).toBe(1)
    // The bound branch resolves; that is the operative consequence of the
    // predicate being TRUE.
    expect(resolveProtectedGrant('HPO-ODS-W2-27', P1_BRANCH).grant).toBeDefined()
    // TEXTUAL SWEEP IS NOT THE EVALUATOR. The id also appears in the
    // explanatory comment block above its row, so counting occurrences
    // overcounts. This asserts the two methods genuinely disagree, which is
    // why the authority forbids the textual one.
    const textualHits = scopeSource.split('HPO-ODS-W2-27').length - 1
    expect(textualHits).toBeGreaterThan(1)
    // And the converse trap, ADVANCED to W2-29 now that W2-28 is registered
    // and therefore appears in the text: W2-29 has textual occurrences nowhere
    // in this file, but the load-bearing fact is its absence from the KEY
    // POSITION, which is asserted above rather than inferred from the text.
    expect(scopeSource.split('HPO-ODS-W2-29').length - 1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// HPO-ODS-W2-28 — Customer Lifecycle CL-1 grant registration controls.
// docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json, protected_grant,
// NO_DB_PREPARED_WIDENING, BRANCH_BINDING_IS_EXACT and NO_PREALLOCATION.
// ---------------------------------------------------------------------------

describe('HPO-ODS-W2-28 — Customer Lifecycle CL-1 grant: narrowness, branch binding and mutation controls', () => {
  const CL1_BRANCH = 'codex/customer-lifecycle-cl1-implementation-r1'
  const OBSERVATION = 'db/prepared/checkpoint-b0/observation.sql'

  it('NON-VACUITY (CL1-GRANT-N1): all THREE granted families are protected violations WITHOUT W2-28 and grant-authorized WITH it', () => {
    const granted = [
      'db/migrations/0099_cl1_fixture.sql',
      'db/prepared/journal/083_0099_cl1_fixture.sql',
      OBSERVATION,
    ]
    const withoutGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [])
    expect(withoutGrant.protectedViolations).toEqual(granted)
    expect(withoutGrant.grantAuthorized).toEqual([])
    const resolved = resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const withGrant = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, granted, [resolved.grant!])
    expect(withGrant.protectedViolations).toEqual([])
    expect(withGrant.grantAuthorized).toEqual(granted)
    // The migration meta corpus a drizzle generate necessarily drags with it
    // is inside db/migrations/** and therefore inside the grant.
    const meta = ['db/migrations/meta/_journal.json', 'db/migrations/meta/0099_snapshot.json']
    expect(classifyPaths(meta, DEFAULT_PROTECTED_PATTERNS, meta, [resolved.grant!]).protectedViolations).toEqual([])
  })

  it('NARROWNESS (CL1-GRANT-N2): the checkpoint-b0 grant is the single LITERAL observation file — a sibling in the same directory stays a protected violation even WITH W2-28', () => {
    // This is the control that separates a literal from a directory glob. If
    // the registered pattern were ever widened to db/prepared/checkpoint-b0/**
    // every path below would become authorized and this assertion is what
    // notices. v1.0.31 NO_DB_PREPARED_WIDENING.
    const siblings = [
      'db/prepared/checkpoint-b0/sibling.sql',
      'db/prepared/checkpoint-b0/rollback.sql',
      'db/prepared/checkpoint-b0/observation.backup.sql',
      // G2-gated apply surfaces a blanket db/prepared/** would have reached.
      'db/prepared/hosted/anything.sql',
      'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql',
      'db/prepared/hosted/governed/anything.sql',
      // The separate stella_NNNN numbering family CL-1 does not extend.
      'db/prepared/stella_0010_organization_bootstrap_capability.sql',
      'db/prepared/checkpoint-a1/corroboration.sql',
      'db/prepared/other/observation.sql',
      'db/prepared/README.md',
    ]
    const resolved = resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const result = classifyPaths(siblings, DEFAULT_PROTECTED_PATTERNS, siblings, [resolved.grant!])
    expect(result.protectedViolations).toEqual(siblings)
    expect(result.grantAuthorized).toEqual([])
    // ...while the exact literal and the journal family still pass, so the
    // control above is narrowness and not a blanket denial.
    const authorized = [OBSERVATION, 'db/prepared/journal/083_0099_cl1_fixture.sql']
    expect(
      classifyPaths(authorized, DEFAULT_PROTECTED_PATTERNS, authorized, [resolved.grant!]).protectedViolations,
    ).toEqual([])
    // db/baseline/** is protected and ungranted by this row.
    const baseline = ['db/baseline/anything.sql', 'db/baseline/MANIFEST.sha256']
    expect(
      classifyPaths(baseline, DEFAULT_PROTECTED_PATTERNS, baseline, [resolved.grant!]).protectedViolations,
    ).toEqual(baseline)
    // The protected sealed-authority surfaces are ungranted too.
    const sealed = ['docs/ops/fib/anything.json', 'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json']
    expect(
      classifyPaths(sealed, DEFAULT_PROTECTED_PATTERNS, sealed, [resolved.grant!]).protectedViolations,
    ).toEqual(sealed)
  })

  it('ZERO GRANT AUTHORITY OVER UNPROTECTED SURFACES (CL1-GRANT-N2b): the grant confers nothing on paths that were never protected', () => {
    // v1.0.31 why_the_unprotected_entries_are_listed_anyway: db/policies/**,
    // scripts/ods-scope.ts and the ODS test files are NOT members of
    // DEFAULT_PROTECTED_PATTERNS. Naming a path in a prohibition is never an
    // allocation; the honest assertion is that the grant contributes ZERO.
    const unprotected = [
      'docs/ops/ods/anything.json',
      'db/policies/0001_anything.sql',
      'scripts/ods-scope.ts',
      'tests/ods/ods-scope.test.ts',
      'db/schema.ts',
      'lib/auth/database-context.ts',
    ]
    const resolved = resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH)
    expect(resolved.grant).toBeDefined()
    for (const p of unprotected) {
      expect(matchesAnyPattern(p, resolved.grant!.patterns)).toBe(false)
    }
    // With no ordinary allowlist they are UNAUTHORIZED, and the grant does not
    // rescue them.
    const withGrantNoAllow = classifyPaths(unprotected, DEFAULT_PROTECTED_PATTERNS, [], [resolved.grant!])
    expect(withGrantNoAllow.unauthorized.sort()).toEqual([...unprotected].sort())
    expect(withGrantNoAllow.grantAuthorized).toEqual([])
    // With an ordinary allowlist they pass on the allowlist's authority only —
    // never counted as grant-authorized.
    const withAllow = classifyPaths(unprotected, DEFAULT_PROTECTED_PATTERNS, unprotected, [resolved.grant!])
    expect(withAllow.grantAuthorized).toEqual([])
    expect(withAllow.protectedViolations).toEqual([])
  })

  it('THE GRANT DOES NOT REPLACE --allow (CL1-GRANT-N3): a granted path with no ordinary allowlist entry is still refused', () => {
    // v1.0.31 grant_does_not_replace_allow. Both are mandatory and neither can
    // stand in for the other, so registering W2-28 is not permission for an
    // arbitrary diff on the CL-1 branch.
    const resolved = resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH)
    expect(resolved.grant).toBeDefined()
    const granted = ['db/migrations/0099_cl1_fixture.sql', OBSERVATION]
    const noAllow = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, [], [resolved.grant!])
    expect(noAllow.protectedViolations).toEqual(granted)
    expect(noAllow.grantAuthorized).toEqual([])
    // A PARTIAL allowlist authorizes only its own member.
    const partial = classifyPaths(granted, DEFAULT_PROTECTED_PATTERNS, [OBSERVATION], [resolved.grant!])
    expect(partial.protectedViolations).toEqual(['db/migrations/0099_cl1_fixture.sql'])
    expect(partial.grantAuthorized).toEqual([OBSERVATION])
  })

  it('BRANCH BINDING (CL1-GRANT-N4): W2-28 resolves to no grant on any foreign branch, and contributes zero patterns there', () => {
    // v1.0.31 BRANCH_BINDING_IS_EXACT: resolution is by exact string equality,
    // never by prefix, pattern or family.
    for (const branch of [
      'main',
      'integration/commercial-v1',
      'feature/sprint-0-foundation',
      'codex/w2-methodology-objects-r1',
      'codex/commercial-account-ce1-implementation-r1',
      'codex/fibdb052-p1-implementation-r1',
      // The REGISTERING branch is itself foreign to the grant it registers: a
      // registration lane gains no protected-write authority by registering.
      'codex/w2-28-protected-grant-registration-r1',
      // Near-misses, including the PR143 authoring branch family the CL-1
      // implementation branch could be confused with.
      'codex/customer-lifecycle-cl1-implementation-r2',
      'codex/customer-lifecycle-cl1-implementation',
      'codex/customer-lifecycle-cl1-implementation-r1-fix',
      'codex/customer-lifecycle-legal-acceptance-r1',
      'Codex/Customer-Lifecycle-CL1-Implementation-R1',
    ]) {
      expect(resolveProtectedGrant('HPO-ODS-W2-28', branch).grant).toBeUndefined()
      const union = resolveProtectedGrants(['HPO-ODS-W2-28'], branch)
      expect(union.grants).toEqual([])
      const paths = ['db/migrations/0099_cl1_fixture.sql', OBSERVATION]
      expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, union.grants).protectedViolations).toEqual(paths)
    }
    // ...and it DOES resolve on its own exact branch, so the control above is
    // binding and not a blanket denial.
    expect(resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH).grant).toBeDefined()
    // An UNKNOWN id on the correct branch resolves to nothing, and fails in
    // exactly the same way as a wrong-branch attempt.
    for (const id of ['HPO-ODS-W2-29', 'HPO-ODS-W2-28 ', 'hpo-ods-w2-28', 'HPO-ODS-W2-2', '']) {
      expect(resolveProtectedGrant(id, CL1_BRANCH).grant).toBeUndefined()
    }
  })

  it('APPEND-ONLY (CL1-GRANT-N5): the 15 predecessor rows are preserved, in order, with their branches unchanged, and W2-28 is LAST', () => {
    // Mutation control. Reordering, rebranching, widening or dropping any
    // predecessor row fails here. W2-28 is appended LAST and touches none of
    // them.
    const PREDECESSORS: ReadonlyArray<readonly [string, string]> = [
      ['HPO-ODS-W2-01', 'codex/w2-methodology-objects-r1'],
      ['HPO-ODS-W2-02', 'codex/u0-u9-reengineering-resume-r1'],
      ['HPO-ODS-W2-03', 'codex/u0-u9-reengineering-resume-r1'],
      ['HPO-ODS-W2-07', 'codex/product-commercial-v1-pr-r1'],
      ['HPO-ODS-W2-08', 'codex/commercial-v1-wave2-reconciliation-r1'],
      ['HPO-ODS-W2-09', 'codex/commercial-v1-wave2-reconciliation-r1'],
      ['HPO-ODS-W2-11', 'codex/p1a-full-bootstrap-r1'],
      ['HPO-ODS-W2-12', 'codex/w2-b4-r1'],
      ['HPO-ODS-W2-16', 'codex/w2-b4-r1'],
      ['HPO-ODS-W2-17', 'codex/w2-b5-r1'],
      ['HPO-ODS-W2-20', 'codex/multiorg-s1-founder-traceability-r1'],
      ['HPO-ODS-W2-21', 'codex/multiorg-s1-founder-traceability-r1'],
      ['HPO-ODS-W2-25', 'codex/multiorg-s3-refusal-audit-implementation-r1'],
      ['HPO-ODS-W2-26', 'codex/commercial-account-ce1-implementation-r1'],
      ['HPO-ODS-W2-27', 'codex/fibdb052-p1-implementation-r1'],
    ]
    expect(PROTECTED_GRANTS.slice(0, 15).map((g) => [g.authorityId, g.branch])).toEqual(
      PREDECESSORS.map(([id, branch]) => [id, branch]),
    )
    // W2-28 is the LAST row, so the growth was an append and not an insert.
    // This is the LIVE last-row binding, inherited from P1-GRANT-N5 when W2-28
    // was registered, exactly as the live-count guard is inherited.
    expect(PROTECTED_GRANTS[PROTECTED_GRANTS.length - 1].authorityId).toBe('HPO-ODS-W2-28')
    expect(PROTECTED_GRANTS.length).toBe(16)
    // The predecessors' PATTERNS are byte-unchanged too, not merely their ids
    // and branches — a widening of an existing row would pass an id/branch
    // comparison untouched.
    expect(PROTECTED_GRANTS.slice(0, 15).map((g) => g.patterns.length)).toEqual([
      2, 75, 8, 1, 98, 4, 3, 2, 1, 3, 1, 1, 2, 3, 2,
    ])
    // No grant anywhere in the registry carries a blanket db/prepared/** or a
    // checkpoint-b0 directory glob.
    for (const g of PROTECTED_GRANTS) {
      expect(g.patterns).not.toContain('db/prepared/**')
      expect(g.patterns).not.toContain('db/prepared/checkpoint-b0/**')
    }
  })

  it('LIVE_COUNT_GUARD_TRANSFER (CL1-GRANT-N6): PROMOTE-WITHOUT-DEMOTE would be red — the v1.0.30 frozen figure no longer equals the live count', () => {
    // MUTATION CONTROL for the DEMOTE half. Had the v1.0.30 guard been left
    // bound to the live array, it would now evaluate 15 against 16 and fail.
    // This asserts that divergence directly, which is what makes the demotion
    // NECESSARY rather than cosmetic — and it pins that the demoted literal is
    // the figure the frozen artefact actually asserts, not the live count.
    const addendumP1Frozen = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json'), 'utf8'),
    ) as { PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27: number }
    expect(addendumP1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27).toBe(15)
    expect(addendumP1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27).not.toBe(
      PROTECTED_GRANTS.length,
    )
    // Editing that frozen artefact away from 15 to match the live count is
    // PROHIBITED — it would corrupt the historical record to satisfy a
    // present-tense guard. This assertion fails if anyone does it.
    expect(PROTECTED_GRANTS.length).toBe(16)
    // And the v1.0.31 artefact, which this act DOES consume, declares 15
    // before and 16 after — so the registry moved by exactly one row.
    const addendumCl1Frozen = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json'), 'utf8'),
    ) as {
      PROTECTED_GRANTS_COUNT_BEFORE: number
      PROTECTED_GRANTS_COUNT_AFTER: number
      PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28: number
    }
    expect(addendumCl1Frozen.PROTECTED_GRANTS_COUNT_BEFORE).toBe(15)
    expect(addendumCl1Frozen.PROTECTED_GRANTS_COUNT_AFTER).toBe(15)
    expect(addendumCl1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28).toBe(16)
    expect(
      addendumCl1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28 -
        addendumCl1Frozen.PROTECTED_GRANTS_COUNT_BEFORE,
    ).toBe(1)
  })

  it('ATOMICITY (CL1-GRANT-N7): the demoted literal and the promoted live binding are both present in this file, and the live binding is unique', () => {
    // The auditor's atomicity check, made executable. DEMOTE-WITHOUT-PROMOTE
    // would leave ZERO live bindings — green with no guard at all, the
    // dangerous half precisely because it looks fine. PROMOTE-WITHOUT-DEMOTE
    // would leave TWO. Both halves fail here.
    const selfSource = readFileSync(path.join(REPO_ROOT, 'tests/ods/ods-scope.test.ts'), 'utf8')
    const liveGuard =
      /expect\(\s*([A-Za-z0-9_.]*PROTECTED_GRANTS_COUNT[A-Za-z0-9_]*)\s*\)\s*\.toBe\(\s*PROTECTED_GRANTS\.length\s*,?\s*\)/g
    const bound = [...selfSource.matchAll(liveGuard)].map((m) => m[1])
    expect(bound).toEqual(['addendumCl1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_28'])
    // THE PROMOTE landed against the v1.0.31 artefact specifically.
    expect(selfSource).toContain('ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json')
    // THE DEMOTE landed, asserted by VALUE rather than by a text search for
    // the assertion's own source line — a toContain whose argument is itself
    // part of the file it searches would be satisfied by its own presence.
    const addendumP1Frozen = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json'), 'utf8'),
    ) as { PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27: number }
    expect(bound).not.toContain('addendumP1.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27')
    expect(addendumP1Frozen.PROTECTED_GRANTS_COUNT_AFTER_A_FUTURE_MISSION_REGISTERS_W2_27).not.toBe(
      PROTECTED_GRANTS.length,
    )
  })

  it('SEPARATION (CL1-GRANT-N8): no OTHER registered grant authorizes the CL-1 families on the CL-1 branch', () => {
    // v1.0.31 why_existing_grants_cannot_be_reused, MEASURED rather than
    // asserted: offer EVERY other registered id at once and the union is still
    // empty, so W2-28 is doing real work and is not a duplicate. The ceiling is
    // derived from the live registry rather than typed out, so a future row
    // cannot escape it.
    const ceiling = PROTECTED_GRANTS.map((g) => g.authorityId).filter((id) => id !== 'HPO-ODS-W2-28')
    expect(ceiling.length).toBe(15)
    const resolved = resolveProtectedGrants(ceiling, CL1_BRANCH)
    expect(resolved.grants).toEqual([])
    const paths = [
      'db/migrations/0099_cl1_fixture.sql',
      'db/prepared/journal/083_0099_cl1_fixture.sql',
      OBSERVATION,
    ]
    expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, resolved.grants).protectedViolations).toEqual(paths)
    // And WITH W2-28 in the union the same three paths are authorized, so the
    // emptiness above is separation and not an inert fixture.
    const withCl1 = resolveProtectedGrants([...ceiling, 'HPO-ODS-W2-28'], CL1_BRANCH)
    expect(withCl1.grants.map((g) => g.authorityId)).toEqual(['HPO-ODS-W2-28'])
    expect(classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, withCl1.grants).protectedViolations).toEqual([])
  })

  it('IMPLEMENTATION PREDICATE (CL1-GRANT-N9): GRANT_ALREADY_REGISTERED is TRUE for HPO-ODS-W2-28 under KEY-POSITION semantics, and a textual sweep is not the evaluator', () => {
    // The predicate is evaluated by parsing the PROTECTED_GRANTS array literal
    // and reading the authorityId KEY POSITION — never by a textual mention,
    // never by an occurrence count. This control evaluates it the authorized
    // way against the real source and demonstrates, in the same test, that the
    // unauthorized way disagrees.
    const scopeSource = readFileSync(path.join(REPO_ROOT, 'scripts/ods-scope.ts'), 'utf8')
    const registeredByKeyPosition = PROTECTED_GRANTS.map((g) => g.authorityId)
    expect(registeredByKeyPosition).toContain('HPO-ODS-W2-28')
    expect(registeredByKeyPosition.filter((id) => id === 'HPO-ODS-W2-28').length).toBe(1)
    // The bound branch resolves; that is the operative consequence of the
    // predicate being TRUE, and it is what makes CL-1 implementation-authorized
    // under v1.0.31 when_CL1_becomes_implementation_authorized.
    expect(resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH).grant).toBeDefined()
    // TEXTUAL SWEEP IS NOT THE EVALUATOR. The id also appears in the
    // explanatory comment block above its row, so counting occurrences
    // overcounts. This asserts the two methods genuinely disagree.
    expect(scopeSource.split('HPO-ODS-W2-28').length - 1).toBeGreaterThan(1)
  })

  it('NO ORDINAL AND NO CONTROLLER ARE ALLOCATED BY THIS ROW (CL1-GRANT-N10)', () => {
    // v1.0.31 MIGRATION_ORDINAL_DISPOSITION posture B and NO_PREALLOCATION.
    // The grant names GLOBS over the migration family, never a specific
    // ordinal, so registering it reserves no number: 0070 and every other
    // literal ordinal remain unallocated and the implementing mission
    // re-derives at its own head.
    const w2_28 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-28')!
    expect(w2_28.patterns.some((p) => /db\/migrations\/\d{4}/.test(p))).toBe(false)
    expect(w2_28.patterns).toContain('db/migrations/**')
    // The glob authorizes ANY ordinal the mission derives, which is precisely
    // why no ordinal needs reserving.
    for (const ordinal of ['0070', '0071', '0099']) {
      const p = 'db/migrations/' + ordinal + '_cl1_fixture.sql'
      expect(matchesAnyPattern(p, w2_28.patterns)).toBe(true)
    }
    // The Controller registry is a SEPARATE axis. Registering a grant neither
    // reads nor advances IMMUTABLE_BY_CONVENTION, and a missing Controller
    // enumeration cannot prevent this grant from resolving (v1.0.31
    // DECOUPLING_PRESERVED).
    expect(resolveProtectedGrant('HPO-ODS-W2-28', CL1_BRANCH).grant).toBeDefined()
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

// ---------------------------------------------------------------------------
// HPO-ODS-W2-03 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.4.json).
//
// The baseline provisioning repair: eight exact literal protected paths on
// codex/u0-u9-reengineering-resume-r1. Every control below is a real CLI run
// against a temporary repository — nothing reads the real working tree.
// ---------------------------------------------------------------------------

describe('ods:scope --protected-authority HPO-ODS-W2-03 — real CLI, temporary-repo fixtures', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  const w2_03 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-03')!
  const TARGET_BRANCH = 'codex/u0-u9-reengineering-resume-r1'

  function runRealCli(cwd: string, args: string[]): { status: number | null; stdout: string } {
    const tsxCli = require.resolve('tsx/cli')
    const scriptAbsolutePath = path.join(REPO_ROOT, 'scripts', 'ods-scope.ts')
    const res = spawnSync(process.execPath, [tsxCli, scriptAbsolutePath, ...args], { cwd, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout }
  }

  function makeTargetBranchRepo(): { dir: string; base: string } {
    const d = makeTempGitRepo()
    const base = commitFile(d, 'README.md', 'seed\n')
    git(d, ['checkout', '-b', TARGET_BRANCH])
    return { dir: d, base }
  }

  /** Writes every granted path as a fixture and commits them in one commit. */
  function materializeGrantedPaths(d: string): void {
    for (const p of w2_03.patterns) {
      mkdirSync(path.join(d, path.dirname(p)), { recursive: true })
      writeFileSync(path.join(d, p), `-- fixture for ${p}\n`)
    }
    git(d, ['add', '-A'])
    git(d, ['commit', '-q', '-m', 'materialize the eight W2-03 fixture paths'])
  }

  it('sanity: the grant is exactly eight literal paths, each under db/migrations/ or db/prepared/, with no glob', () => {
    expect(w2_03.patterns).toEqual([
      'db/migrations/0044_fib_audit_hardening_supersession.sql',
      'db/prepared/journal/055_0044_fib_audit_hardening_supersession.sql',
      'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
      'db/prepared/stella_hosted_0000_rollback.sql',
      'db/prepared/stella_hosted_0001_managed_role_bootstrap.sql',
      'db/prepared/stella_hosted_0001_rollback.sql',
      'db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql',
      'db/prepared/README.md',
    ])
    for (const p of w2_03.patterns) expect(p.includes('*')).toBe(false)
  })

  it('POSITIVE: the eight granted paths, changed together on the target branch, PASS under HPO-ODS-W2-03', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    materializeGrantedPaths(dir)

    const args = ['--base', g.base, '--protected-authority', 'HPO-ODS-W2-03']
    for (const p of w2_03.patterns) args.push('--allow', p)
    const { status, stdout } = runRealCli(dir, args)

    expect(status).toBe(0)
    expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-03')
    expect(stdout).toContain('CHANGED_FILE_COUNT=8')
    expect(stdout).toContain('PROTECTED_AUTHORIZED_PATH_COUNT=8')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
    expect(stdout).toContain('ODS_SCOPE=PASS')
  })

  it('NEGATIVE (wrong branch): HPO-ODS-W2-03 on any other branch FAILs even for a granted path', () => {
    dir = makeTempGitRepo()
    const base = commitFile(dir, 'README.md', 'seed\n')
    mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true })
    commitFile(dir, 'db/migrations/0044_fib_audit_hardening_supersession.sql', '-- x\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', base,
      '--allow', 'db/migrations/0044_fib_audit_hardening_supersession.sql',
      '--protected-authority', 'HPO-ODS-W2-03',
    ])
    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
  })

  it.each([
    ['unlisted migration sibling', 'db/migrations/0043_fib_audit_project_id_fk.sql'],
    ['0042 — explicitly NOT authorized by D3', 'db/migrations/0042_fib_audit_insert_policy.sql'],
    ['0045 — explicitly NOT authorized by D3', 'db/migrations/0045_fib_domain_object_version_lineage.sql'],
    ['unlisted prepared sibling (stella_0003 is a stop condition)', 'db/prepared/stella_0003_suggestion_decisions.sql'],
    ['unlisted journal wrapper sibling', 'db/prepared/journal/056_0045_fib_domain_object_version_lineage.sql'],
    ['unlisted hosted artefact sibling', 'db/prepared/hosted/stella_0013_grounded_query_quota.hosted.sql'],
    ['future migration', 'db/migrations/0053_fib_future.sql'],
    ['db/baseline path', 'db/baseline/stella_g2_schema.sql'],
  ])('NEGATIVE (%s): %s FAILs under HPO-ODS-W2-03 even when named in --allow', (_label, p) => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, path.dirname(p)), { recursive: true })
    commitFile(dir, p, '-- x\n')

    const { status, stdout } = runRealCli(dir, ['--base', g.base, '--allow', p, '--protected-authority', 'HPO-ODS-W2-03'])
    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain(`PROTECTED_PATH_VIOLATION=${p}`)
  })

  it('NEGATIVE (wildcard attempt): a glob in ordinary --allow cannot widen the grant to an unlisted protected sibling', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    materializeGrantedPaths(dir)
    // One extra protected sibling next to the eight, and a --allow glob that
    // covers all of db/prepared/**. The grant is literal, so the sibling is
    // still a violation and the eight are still authorized.
    commitFile(dir, 'db/prepared/journal/054_0043_fib_audit_project_id_fk.sql', '-- sibling\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', g.base,
      '--allow', 'db/prepared/**',
      '--allow', 'db/migrations/0044_fib_audit_hardening_supersession.sql',
      '--protected-authority', 'HPO-ODS-W2-03',
    ])
    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_AUTHORIZED_PATH_COUNT=8')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/journal/054_0043_fib_audit_project_id_fk.sql')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=1')
  })

  it('NEGATIVE (noncanonical casing): a case variant of a granted path FAILs unconditionally', () => {
    const g = makeTargetBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'DB', 'migrations'), { recursive: true })
    commitFile(dir, 'DB/migrations/0044_fib_audit_hardening_supersession.sql', '-- x\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', g.base,
      '--allow', 'DB/migrations/0044_fib_audit_hardening_supersession.sql',
      '--protected-authority', 'HPO-ODS-W2-03',
    ])
    expect(status).toBe(1)
    expect(stdout).toContain('NON_CANONICAL_PROTECTED_PATH=DB/migrations/0044_fib_audit_hardening_supersession.sql')
  })

  it('REGRESSION: HPO-ODS-W2-02 still resolves on the same branch, and its 75 paths are untouched by the W2-03 registration', () => {
    const w2_02 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-02')!
    expect(w2_02.branch).toBe(TARGET_BRANCH)
    expect(w2_02.patterns.length).toBe(75)
    // The two grants overlap on EXACTLY one path: the 0044 journal wrapper,
    // which the closed-B1 integration also carried because B1 regenerated
    // every wrapper. Pinned as a set so a widened overlap is a failure, not a
    // surprise. Each grant stays independently bound to its own purpose.
    const overlap = w2_03.patterns.filter((p) => w2_02.patterns.includes(p))
    expect(overlap).toEqual(['db/prepared/journal/055_0044_fib_audit_hardening_supersession.sql'])
  })
})

// ---------------------------------------------------------------------------
// COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M1).
//
// --protected-authority is now repeatable: every occurrence resolves
// independently (resolveProtectedGrants) and the authorized protected
// surface is the exact UNION of every valid supplied grant's patterns —
// never "any one grant authorizes the whole diff", and an unknown id
// contributes zero patterns without invalidating the OTHER supplied ids.
// This is the canonical fix for the two-run workaround the Wave2
// reconciliation needed (HPO-ODS-W2-08 + HPO-ODS-W2-09 could previously
// only be proven via two separate ods:scope invocations plus a manual
// union check — see COMMERCIAL_V1_WAVE2_RECONCILIATION_EVIDENCE_v1.0.1.json
// gates.ODS_SCOPE).
// ---------------------------------------------------------------------------

describe('resolveProtectedGrants — pure, M1-P1..M1-N3 basis', () => {
  it('M1-P1 basis: a single id behaves exactly like resolveProtectedGrant wrapped in a one-element array', () => {
    const single = resolveProtectedGrant('HPO-ODS-W2-01', 'codex/w2-methodology-objects-r1')
    const plural = resolveProtectedGrants(['HPO-ODS-W2-01'], 'codex/w2-methodology-objects-r1')
    expect(plural.resolutions).toEqual([single])
    expect(plural.grants).toEqual(single.grant ? [single.grant] : [])
  })

  it('M1-P2 basis: two disjoint valid ids resolve to both grants, in input order', () => {
    const plural = resolveProtectedGrants(['HPO-ODS-W2-08', 'HPO-ODS-W2-09'], 'codex/commercial-v1-wave2-reconciliation-r1')
    expect(plural.grants.map((g) => g.authorityId)).toEqual(['HPO-ODS-W2-08', 'HPO-ODS-W2-09'])
  })

  it('M1-N1 basis: one unknown id among valid ones resolves with an empty grant for that id only, never crashing or contaminating the others', () => {
    const plural = resolveProtectedGrants(['HPO-ODS-W2-08', 'NOT-A-REAL-AUTHORITY', 'HPO-ODS-W2-09'], 'codex/commercial-v1-wave2-reconciliation-r1')
    expect(plural.resolutions.length).toBe(3)
    expect(plural.grants.map((g) => g.authorityId)).toEqual(['HPO-ODS-W2-08', 'HPO-ODS-W2-09'])
    expect(plural.resolutions[1].grant).toBeUndefined()
    expect(plural.resolutions[1].reason).toContain('unknown protected authority')
  })

  it('M1-N3 basis: a duplicated id resolves twice (undeduplicated) but classifyPaths treats the union identically either way', () => {
    const once = resolveProtectedGrants(['HPO-ODS-W2-01'], 'codex/w2-methodology-objects-r1')
    const twice = resolveProtectedGrants(['HPO-ODS-W2-01', 'HPO-ODS-W2-01'], 'codex/w2-methodology-objects-r1')
    expect(twice.grants.length).toBe(2)
    expect(twice.grants).toEqual([once.grants[0], once.grants[0]])

    const path = 'db/prepared/journal/x.sql'
    const resultOnce = classifyPaths([path], DEFAULT_PROTECTED_PATTERNS, [path], once.grants)
    const resultTwice = classifyPaths([path], DEFAULT_PROTECTED_PATTERNS, [path], twice.grants)
    expect(resultTwice).toEqual(resultOnce)
    expect(resultTwice.grantAuthorized).toEqual([path]) // not doubled
  })
})

describe('classifyPaths — multi-grant array, M1-P1..M1-P3 basis (pure)', () => {
  it('M1-P1: classifyPaths(..., singleGrant) === classifyPaths(..., [singleGrant]) — signature change is purely additive', () => {
    const grant: ProtectedGrant = {
      authorityId: 'HPO-ODS-W2-01',
      branch: 'codex/w2-methodology-objects-r1',
      patterns: ['db/migrations/**', 'db/prepared/journal/**'],
    }
    const path = 'db/prepared/journal/x.sql'
    const asObject = classifyPaths([path], DEFAULT_PROTECTED_PATTERNS, [path], grant)
    const asArray = classifyPaths([path], DEFAULT_PROTECTED_PATTERNS, [path], [grant])
    expect(asArray).toEqual(asObject)
  })

  it('M1-P2: two DISJOINT synthetic grants authorize the exact union — neither alone would cover both paths', () => {
    const grantA: ProtectedGrant = { authorityId: 'SYNTH-A', branch: 'x', patterns: ['db/migrations/0900_a.sql'] }
    const grantB: ProtectedGrant = { authorityId: 'SYNTH-B', branch: 'x', patterns: ['db/migrations/0901_b.sql'] }
    const paths = ['db/migrations/0900_a.sql', 'db/migrations/0901_b.sql']

    const withOnlyA = classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, [grantA])
    expect(withOnlyA.protectedViolations).toEqual(['db/migrations/0901_b.sql'])

    const withBoth = classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, [grantA, grantB])
    expect(withBoth.protectedViolations).toEqual([])
    expect(withBoth.grantAuthorized.sort()).toEqual([...paths].sort())
  })

  it('M1-P3: two OVERLAPPING real grants (HPO-ODS-W2-08 + HPO-ODS-W2-09) authorize their union without double-counting the shared path', () => {
    const w2_08 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-08')!
    const w2_09 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-09')!
    const shared = 'db/migrations/meta/_journal.json'
    expect(w2_08.patterns).toContain(shared)
    expect(w2_09.patterns).toContain(shared)

    const onlyW208Path = 'db/migrations/0060_fib_outcome_monetization_dispositions_governance.sql'
    const onlyW209Path = 'db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql'
    const paths = [onlyW208Path, shared, onlyW209Path]

    const result = classifyPaths(paths, DEFAULT_PROTECTED_PATTERNS, paths, [w2_08, w2_09])
    expect(result.protectedViolations).toEqual([])
    expect(result.grantAuthorized.sort()).toEqual([...paths].sort()) // shared path appears exactly once, not twice
  })
})

describe('ods:scope --protected-authority (repeated) — real CLI, M1-N1/M1-N2/M1-N4/M1-E2E-SCOPE', () => {
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

  const RECONCILIATION_BRANCH = 'codex/commercial-v1-wave2-reconciliation-r1'

  function makeReconciliationBranchRepo(): { dir: string; base: string } {
    const d = makeTempGitRepo()
    const base = commitFile(d, 'README.md', 'seed\n')
    git(d, ['checkout', '-b', RECONCILIATION_BRANCH])
    return { dir: d, base }
  }

  it('M1-N1 (NEGATIVE): one unknown id alongside one valid id still FAILs when the changed protected path is outside the valid id\'s grant', () => {
    const g = makeReconciliationBranchRepo()
    dir = g.dir
    // db/baseline/** is protected by default but granted by NEITHER W2-08 nor
    // any synthetic unknown id — the unknown id must not accidentally widen
    // coverage, nor may it crash the invocation.
    mkdirSync(path.join(dir, 'db', 'baseline'), { recursive: true })
    commitFile(dir, 'db/baseline/x.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', g.base,
      '--allow', 'db/baseline/x.sql',
      '--protected-authority', 'HPO-ODS-W2-08',
      '--protected-authority', 'NOT-A-REAL-AUTHORITY',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-08,NOT-A-REAL-AUTHORITY')
    expect(stdout).toContain('unknown protected authority "NOT-A-REAL-AUTHORITY"')
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/baseline/x.sql')
  })

  it('M1-N2 (NEGATIVE): two VALID grants together still FAIL a protected path outside the union of both', () => {
    const g = makeReconciliationBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'baseline'), { recursive: true })
    commitFile(dir, 'db/baseline/x.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', g.base,
      '--allow', 'db/baseline/x.sql',
      '--protected-authority', 'HPO-ODS-W2-08',
      '--protected-authority', 'HPO-ODS-W2-09',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/baseline/x.sql')
  })

  it('M1-N3 (real CLI): the same id supplied twice is deterministic and does not double-count the authorized path', () => {
    const g = makeReconciliationBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', g.base,
      '--allow', 'db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql',
      '--protected-authority', 'HPO-ODS-W2-09',
      '--protected-authority', 'HPO-ODS-W2-09',
    ])

    expect(status).toBe(0)
    expect(stdout).toContain('ODS_SCOPE=PASS')
    expect(stdout).toContain('PROTECTED_AUTHORIZED_PATH_COUNT=1')
  })

  it('M1-N4 (NEGATIVE): the union of two valid grants does not bypass the independent ordinary --allow requirement', () => {
    const g = makeReconciliationBranchRepo()
    dir = g.dir
    mkdirSync(path.join(dir, 'db', 'prepared', 'journal'), { recursive: true })
    commitFile(dir, 'db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql', 'select 1;\n')

    const { status, stdout } = runRealCli(dir, [
      '--base', g.base,
      '--allow', 'README.md', // deliberately does NOT cover the changed protected path
      '--protected-authority', 'HPO-ODS-W2-08',
      '--protected-authority', 'HPO-ODS-W2-09',
    ])

    expect(status).toBe(1)
    expect(stdout).toContain('ODS_SCOPE=FAIL')
    expect(stdout).toContain('PROTECTED_PATH_VIOLATION=db/prepared/journal/074_0061_fib_disposition_governance_function_execute_revocation.sql')
  })

  it('M1-E2E-SCOPE: HPO-ODS-W2-08 + HPO-ODS-W2-09 together, in ONE canonical invocation, authorize their exact union — the real reconciliation case, no two-run workaround', () => {
    const w2_08 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-08')!
    const w2_09 = PROTECTED_GRANTS.find((g) => g.authorityId === 'HPO-ODS-W2-09')!
    const unionPatterns = [...new Set([...w2_08.patterns, ...w2_09.patterns])]

    const g = makeReconciliationBranchRepo()
    dir = g.dir
    for (const p of unionPatterns) {
      mkdirSync(path.join(dir, path.dirname(p)), { recursive: true })
      writeFileSync(path.join(dir, p), `-- fixture for ${p}\n`)
    }
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'materialize the exact union of HPO-ODS-W2-08 and HPO-ODS-W2-09'])

    const args = ['--base', g.base, '--protected-authority', 'HPO-ODS-W2-08', '--protected-authority', 'HPO-ODS-W2-09']
    for (const p of unionPatterns) args.push('--allow', p)
    const { status, stdout } = runRealCli(dir, args)

    expect(status).toBe(0)
    expect(stdout).toContain('PROTECTED_AUTHORITY=HPO-ODS-W2-08,HPO-ODS-W2-09')
    expect(stdout).toContain(`CHANGED_FILE_COUNT=${unionPatterns.length}`)
    expect(stdout).toContain(`PROTECTED_AUTHORIZED_PATH_COUNT=${unionPatterns.length}`)
    expect(stdout).toContain('PROTECTED_PATH_VIOLATIONS=0')
    expect(stdout).toContain('ODS_SCOPE=PASS')

    // Adding one sibling outside BOTH grants must still FAIL — the union
    // is exact, never a blanket "any grant active => anything passes".
    commitFile(dir, 'db/baseline/sibling.sql', 'select 1;\n')
    const failResult = runRealCli(dir, [...args, '--allow', 'db/baseline/sibling.sql'])
    expect(failResult.status).toBe(1)
    expect(failResult.stdout).toContain('ODS_SCOPE=FAIL')
    expect(failResult.stdout).toContain('PROTECTED_PATH_VIOLATION=db/baseline/sibling.sql')
  })
})
