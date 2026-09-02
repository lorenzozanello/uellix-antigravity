// scripts/class-c-observation-sql.ts
// The read-only SQL that produces a Class-C evidence artefact.
//
//   pnpm classc:observation:generate   write db/prepared/class-c/observation.sql
//   pnpm classc:observation:verify     regenerate and compare bytes
//
// CONNECTS TO NOTHING. It reads CLASS_C_PROBES and writes a file.
//
// Generated rather than hand-written because the criterion that consumes the
// artefact requires each §2.7 query VERBATIM. A hand-typed probe drifts by one
// character and produces a refusal nobody can explain.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { CLASS_C_OBSERVATION_SQL, buildClassCObservationSql } from '../db/hosted/class-c-observation'

const ROOT = path.resolve(import.meta.dirname, '..')
const target = path.join(ROOT, CLASS_C_OBSERVATION_SQL)

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const mode = process.argv[2] ?? 'generate'

if (mode === 'generate') {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, buildClassCObservationSql(), 'utf8')
  console.log(`[class-c-sql] wrote ${CLASS_C_OBSERVATION_SQL}`)
} else if (mode === 'verify') {
  const onDisk = read(CLASS_C_OBSERVATION_SQL)
  if (onDisk === null) {
    console.error(`[class-c-sql] ${CLASS_C_OBSERVATION_SQL} is MISSING. Run \`pnpm classc:observation:generate\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== buildClassCObservationSql()) {
    console.error(
      `[class-c-sql] ${CLASS_C_OBSERVATION_SQL} DIVERGED from CLASS_C_PROBES. A probe that no longer quotes the canonical query answers a different question.`,
    )
    process.exit(1)
  }
  console.log('[class-c-sql] verification OK — every probe quotes its canonical §2.7 query verbatim')
} else {
  console.error('usage: tsx scripts/class-c-observation-sql.ts <generate|verify>')
  process.exit(2)
}
