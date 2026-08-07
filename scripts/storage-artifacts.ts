// scripts/storage-artifacts.ts
// TRAIN 5C2 — generate or verify the two derivations of unit 41.
//
//   pnpm storage:generate   writes db/prepared/storage/*.sql
//   pnpm storage:verify     regenerates in memory and compares, byte for byte
//
// CONNECTS TO NOTHING. It reads one canonical file, writes two derived ones, and
// exits.
//
// The artefacts are checked in — not as a second source of truth, but so a
// reviewer (and the operator who will run PART B by hand) can read the exact SQL
// without executing a generator to see it. `storage:verify` is what keeps
// "checked in" from becoming "diverged", and the unit suite runs the same
// comparison.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  MANAGED_ARTEFACT,
  PSQL_ARTEFACT,
  STORAGE_ARTEFACT_DIR,
  STORAGE_UNIT_SOURCE,
  buildStorageArtefacts,
} from '../db/hosted/storage-policy-artifact'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

function generate(): void {
  const artefacts = buildStorageArtefacts(read(STORAGE_UNIT_SOURCE))
  mkdirSync(path.join(ROOT, STORAGE_ARTEFACT_DIR), { recursive: true })
  writeFileSync(path.join(ROOT, PSQL_ARTEFACT), artefacts.psqlSql, 'utf8')
  writeFileSync(path.join(ROOT, MANAGED_ARTEFACT), artefacts.managedSql, 'utf8')

  console.log(`[storage] source  ${STORAGE_UNIT_SOURCE}  ${artefacts.sourceSha256.slice(0, 16)}`)
  console.log(`[storage] PART A  ${PSQL_ARTEFACT}  ${artefacts.psqlSha256.slice(0, 16)}`)
  console.log(`[storage] PART B  ${MANAGED_ARTEFACT}  ${artefacts.managedSha256.slice(0, 16)}`)
  console.log(`[storage] PART B security surface  ${artefacts.managedSecuritySurfaceDigest.slice(0, 16)}`)
  console.log(
    `[storage] statements: ${artefacts.statementCounts.total} total = ` +
      `${artefacts.statementCounts.partA} PART A + ${artefacts.statementCounts.partB} PART B`,
  )
}

function verify(): void {
  const artefacts = buildStorageArtefacts(read(STORAGE_UNIT_SOURCE))
  const problems: string[] = []

  for (const [label, rel, expected] of [
    ['PART A', PSQL_ARTEFACT, artefacts.psqlSql],
    ['PART B', MANAGED_ARTEFACT, artefacts.managedSql],
  ] as const) {
    let onDisk: string
    try {
      onDisk = read(rel).replace(/\r\n?/g, '\n')
    } catch {
      problems.push(`${label}: ${rel} is MISSING. Run \`pnpm storage:generate\`.`)
      continue
    }
    if (onDisk !== expected) {
      problems.push(
        `${label}: ${rel} DIVERGED from what the canonical source produces. Do not edit the artefact — ` +
          `edit ${STORAGE_UNIT_SOURCE} and regenerate. An artefact edited by hand is the second source ` +
          `of truth this whole design exists to avoid, and PART B is the one a human runs against a ` +
          `production-adjacent platform.`,
      )
    }
  }

  if (problems.length > 0) {
    console.error('[storage] verification FAILED:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(
    `[storage] verification OK — both artefacts regenerate byte-identically from ` +
      `${STORAGE_UNIT_SOURCE} (${artefacts.sourceSha256.slice(0, 12)}…)`,
  )
}

const mode = process.argv[2]
if (mode === 'generate') generate()
else if (mode === 'verify') verify()
else {
  console.error('usage: tsx scripts/storage-artifacts.ts <generate|verify>')
  process.exit(2)
}
