// tests/ods/git-fixture-helpers.ts
//
// Shared temporary-git-repository harness for tests/ods/**. Negative
// controls for the ODS deterministic gates must never mutate real certified
// artifacts (see docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json,
// negative_control_doctrine.fixture_rule). Every fixture repo created here
// is disposable and isolated from the actual project worktree.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${res.stderr ?? res.error}`)
  }
  return (res.stdout ?? '').trim()
}

export function makeTempGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ods-fixture-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'ods-test@example.invalid'])
  git(dir, ['config', 'user.name', 'ODS Fixture'])
  return dir
}

/** Writes `relPath` with `content`, stages and commits it. Returns the new commit SHA. */
export function commitFile(dir: string, relPath: string, content: string): string {
  const abs = path.join(dir, relPath)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  git(dir, ['add', relPath])
  git(dir, ['commit', '-q', '-m', `fixture: ${relPath}`])
  return git(dir, ['rev-parse', 'HEAD'])
}

/** Overwrites `relPath` on disk WITHOUT committing — the working-tree mutation negative controls need. */
export function mutateFile(dir: string, relPath: string, content: string): void {
  writeFileSync(path.join(dir, relPath), content)
}

export function blobAt(dir: string, commit: string, relPath: string): string {
  return git(dir, ['rev-parse', `${commit}:${relPath}`])
}

export function hashObjectCurrent(dir: string, relPath: string): string {
  return git(dir, ['hash-object', relPath])
}

export function catFileBlob(dir: string, blobSha1: string): Buffer {
  const res = spawnSync('git', ['cat-file', 'blob', blobSha1], { cwd: dir })
  if (res.status !== 0) throw new Error(`git cat-file blob ${blobSha1} failed: ${res.stderr?.toString()}`)
  return res.stdout as Buffer
}

export function cleanupTempGitRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
