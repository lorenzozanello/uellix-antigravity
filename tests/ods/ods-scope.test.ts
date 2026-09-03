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

  it('the frozen registry contains exactly the HPO-ODS-W2-01 grant, unchanged, plus the successor HPO-ODS-W2-02 and HPO-ODS-W2-03 grants, plus the HPO-ODS-W2-07 checkpoint-b0 probe grant, plus the HPO-ODS-W2-08 Commercial V1 / Wave2 reconciliation grant, plus the HPO-ODS-W2-09 0061 security-successor grant, plus the HPO-ODS-W2-11 P1A canonical local/CI bootstrap grant, plus the HPO-ODS-W2-12 Wave 2 batch B4 grant', () => {
    expect(PROTECTED_GRANTS.length).toBe(8)
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
