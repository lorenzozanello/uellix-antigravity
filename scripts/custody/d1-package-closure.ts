// scripts/custody/d1-package-closure.ts
//
// THE EXECUTION-RELEVANT D-1 PACKAGE, DERIVED — NEVER LISTED.
//
// The independent recertification found PMR-8 binding ten hand-listed files
// while the package was thirty-one, and a demonstration record nobody bound. A
// list is a guess about the future. This module derives the closure from two
// sources that grow by themselves:
//
//   CODE       the runtime import closure (require() calls TypeScript actually
//              emits, followed transitively) of every execution entry point:
//              the production entries, the PRE-HC1 evaluator, the mint-route
//              contract and its harness, the topology demonstration. A new
//              module imported by any of them is in the package automatically.
//              External packages are recorded by name, not followed.
//   AUTHORITY  every tracked file under the D-1 authority prefixes: the DAG
//              chain and every other docs/ops/release/FIBDB053_D1_* artifact,
//              every docs/ops/owner-ratifications/FIBDB053_D1_* record, the
//              custody inventory; plus package.json and pnpm-lock.yaml, which
//              decide what the runtime driver is. A new amendment, owner
//              decision or execution record is in the package automatically.
//
// EXCLUDED, by one rule: a certification EVENT (it certifies the package, it is
// not part of it; see DAG v1.0.6 CERTIFICATION_EVENT_CONTRACT).
//
// The identity of the package is its digest: sha256 over the sorted
// "path:blob" lines, where blob is the git blob id of the WORKING-TREE file
// (git hash-object), so an uncommitted edit changes the digest too.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { PRODUCTION_ENTRY_POINTS, requiresOf, transpile } from './build-production-entrypoints'

export const EXECUTION_ENTRY_POINTS: readonly string[] = [
  ...PRODUCTION_ENTRY_POINTS,
  'scripts/custody/d1-pre-hc1.ts',
  'scripts/custody/d1-pre-hc1-post-mint.ts',
  'db/custody/mint-route-b-contract.ts',
  'scripts/custody/d1-mint-tool-contract-harness.ts',
  'scripts/custody/d1-production-topology-demonstration.ts',
  'scripts/custody/d1-n30-deposit.ts',
  // Operator channel (DAG v1.0.7): the launcher, its pre-execution gate, and the probe contract harness.
  'scripts/custody/d1-mint-operator-launcher.ts',
  'scripts/custody/d1-mint-operator-plan.ts',
  'scripts/custody/d1-oep1-probe-harness.ts',
  'scripts/custody/d1-mint-operator-channel-demonstration.ts',
  // R2 (DAG v1.0.8): the SCRAM-verifier transport proved on a disposable PostgreSQL.
  'scripts/custody/d1-scram-disposable-proof.ts',
]

export const AUTHORITY_PREFIXES: readonly string[] = [
  'docs/ops/release/FIBDB053_D1_',
  'docs/ops/owner-ratifications/FIBDB053_D1_',
  'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_',
]

export const RUNTIME_CONFIG_FILES: readonly string[] = ['package.json', 'pnpm-lock.yaml']

/** A certification event is outside the package it certifies. */
export const CERTIFICATION_EVENT_PATTERN = /^docs\/ops\/release\/FIBDB053_D1_AUDITOR_PREHC1_PACKAGE_CERTIFICATION_[0-9a-f]{12}_v\d+\.\d+\.\d+\.json$/

/** The code closure, following every relative require and recording external ones. */
export function deriveCodeClosure(
  root: string,
  entries: readonly string[],
  read: (abs: string) => string = (abs) => readFileSync(abs, 'utf8')
): { files: string[]; externals: string[] } {
  const seen = new Set<string>()
  const externals = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const rel = queue.shift()!
    if (seen.has(rel)) continue
    seen.add(rel)
    for (const spec of requiresOf(transpile(read(join(root, rel)), rel))) {
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) {
        externals.add(spec.split('/')[0]!.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)
        continue
      }
      const base = posix.normalize(posix.join(posix.dirname(rel), spec))
      queue.push(!existsSync(join(root, `${base}.ts`)) && existsSync(join(root, base, 'index.ts')) ? `${base}/index.ts` : `${base}.ts`)
    }
  }
  return { files: [...seen].sort(), externals: [...externals].sort() }
}

const git = (root: string, args: readonly string[]): string => execFileSync('git', [...args], { cwd: root, encoding: 'utf8' })

/** Every tracked-or-untracked (not ignored) authority file of the package. */
export function deriveAuthorityFiles(root: string): string[] {
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '--', ...AUTHORITY_PREFIXES.map((p) => `${p}*`)])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return [...new Set(listed)].filter((p) => !CERTIFICATION_EVENT_PATTERN.test(p)).sort()
}

export interface PackageClosure {
  readonly files: readonly string[]
  readonly externals: readonly string[]
  readonly blobs: Readonly<Record<string, string>>
  readonly digest: string
}

export function closureDigest(blobs: Readonly<Record<string, string>>): string {
  const lines = Object.keys(blobs)
    .sort()
    .map((p) => `${p}:${blobs[p]}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function derivePackageClosure(root: string): PackageClosure {
  const code = deriveCodeClosure(root, EXECUTION_ENTRY_POINTS)
  const files = [...new Set([...code.files, ...deriveAuthorityFiles(root), ...RUNTIME_CONFIG_FILES.filter((f) => existsSync(join(root, f)))])].sort()
  const hashes = files.length === 0 ? [] : git(root, ['hash-object', '--', ...files]).trim().split('\n')
  if (hashes.length !== files.length) throw new Error('git hash-object returned a different number of blobs than files.')
  const blobs = Object.fromEntries(files.map((f, i) => [f, hashes[i]!.trim()]))
  return { files, externals: code.externals, blobs, digest: closureDigest(blobs) }
}
