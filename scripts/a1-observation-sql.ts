// scripts/a1-observation-sql.ts
// The read-only SQL that produces the CHECKPOINT A1 corroboration.
//
//   pnpm a1:observation:generate   write db/prepared/checkpoint-a1/corroboration.sql
//   pnpm a1:observation:verify     regenerate and compare bytes
//
// CONNECTS TO NOTHING. It reads db/hosted/package-witnesses.ts and writes a file.
//
// Generated for the reason the B0 and S1 probes are: the query the operator runs
// and the contract the verdict rests on must be one thing. Here the coupling is
// tighter than usual — the probe has one arm per WITNESS, and the witnesses were
// chosen so that ARITY discriminates a package from its successor. A probe that
// drifted by one signature would not fail; it would classify stella_0017 as
// installed because stella_0016 is, and the chain plan built on that reading
// would re-apply a package over its own state.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { A1_OBSERVATION_SQL, buildA1CorroborationSql } from '../db/hosted/checkpoint-a1'

const ROOT = path.resolve(import.meta.dirname, '..')
const target = path.join(ROOT, A1_OBSERVATION_SQL)

const mode = process.argv[2] ?? 'generate'

let build: string
try {
  build = buildA1CorroborationSql()
} catch (error) {
  console.error(`[a1-sql] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (mode === 'generate') {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, build, 'utf8')
  console.log(`[a1-sql] wrote ${A1_OBSERVATION_SQL}`)
} else if (mode === 'verify') {
  let onDisk: string | null = null
  try {
    onDisk = readFileSync(target, 'utf8')
  } catch {
    onDisk = null
  }
  if (onDisk === null) {
    console.error(`[a1-sql] ${A1_OBSERVATION_SQL} is MISSING. Run \`pnpm a1:observation:generate\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== build) {
    console.error(
      `[a1-sql] ${A1_OBSERVATION_SQL} DIVERGED from db/hosted/package-witnesses.ts. A hand-edited probe measures a set of signatures the registry does not classify, and the mismatch surfaces as a package silently reported absent.`,
    )
    process.exit(1)
  }
  console.log('[a1-sql] verification OK — the probe regenerates byte-identically from the witness registry')
} else {
  console.error('usage: tsx scripts/a1-observation-sql.ts <generate|verify>')
  process.exit(2)
}
