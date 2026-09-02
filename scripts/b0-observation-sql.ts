// scripts/b0-observation-sql.ts
// The read-only SQL that produces the CHECKPOINT B0 observation.
//
//   pnpm b0:observation:generate   write db/prepared/checkpoint-b0/observation.sql
//   pnpm b0:observation:verify     regenerate and compare bytes
//
// CONNECTS TO NOTHING. It reads the corpus and writes a file.
//
// The file is generated rather than hand-written because `rowCounts` needs one
// arm per table the fifty units create. A hand-maintained list would drift from
// the manifest the first time a unit is added, and a drifted observation is one
// that reports a table as absent because nobody asked about it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { B0_OBSERVATION_SQL, buildB0ObservationSql } from '../db/hosted/checkpoint-b0'
import { deriveExpectedBaselineState } from '../db/hosted/baseline-postconditions'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const build = (): string => buildB0ObservationSql(deriveExpectedBaselineState(read).tables)

const mode = process.argv[2] ?? 'generate'
const target = path.join(ROOT, B0_OBSERVATION_SQL)

if (mode === 'generate') {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, build(), 'utf8')
  console.log(`[b0-sql] wrote ${B0_OBSERVATION_SQL}`)
} else if (mode === 'verify') {
  const onDisk = read(B0_OBSERVATION_SQL)
  if (onDisk === null) {
    console.error(`[b0-sql] ${B0_OBSERVATION_SQL} is MISSING. Run \`pnpm b0:observation:generate\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== build()) {
    console.error(
      `[b0-sql] ${B0_OBSERVATION_SQL} DIVERGED from the corpus. A hand-edited probe measures something the manifest does not describe.`,
    )
    process.exit(1)
  }
  console.log('[b0-sql] verification OK — the probe regenerates byte-identically from the corpus')
} else {
  console.error('usage: tsx scripts/b0-observation-sql.ts <generate|verify>')
  process.exit(2)
}
