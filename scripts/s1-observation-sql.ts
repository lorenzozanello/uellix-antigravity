// scripts/s1-observation-sql.ts
// The read-only SQL that measures PHASE_STELLA_BOOTSTRAP's postconditions.
//
//   pnpm s1:observation:generate   write db/prepared/stella-bootstrap/observation.sql
//   pnpm s1:observation:verify     regenerate and compare bytes
//
// CONNECTS TO NOTHING. It reads the contract and writes a file.
//
// Generated rather than hand-written for the reason the Class-C probe is:
// the query the operator runs and the contract the verdict rests on must be
// one thing. A hand-maintained probe drifts by one field and produces a
// refusal — or worse, a PASS — that nobody can explain.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  S1_OBSERVATION_SQL,
  S2_SENTINEL_SQL,
  buildBootstrapObservationSql,
  buildSentinelInsertSql,
} from '../db/hosted/bootstrap-postconditions'

const ROOT = path.resolve(import.meta.dirname, '..')
// One script, two generated files: the read-only probe and the S2 template.
// They share a contract, so they share a generator; splitting them would let
// one be regenerated without the other.
const WHICH = process.argv.includes('--sentinel')
const REL = WHICH ? S2_SENTINEL_SQL : S1_OBSERVATION_SQL
const build = WHICH ? buildSentinelInsertSql : buildBootstrapObservationSql
const target = path.join(ROOT, REL)

const mode = process.argv[2] ?? 'generate'

if (mode === 'generate') {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, build(), 'utf8')
  console.log(`[s1-sql] wrote ${REL}`)
} else if (mode === 'verify') {
  let onDisk: string | null = null
  try {
    onDisk = readFileSync(target, 'utf8')
  } catch {
    onDisk = null
  }
  if (onDisk === null) {
    console.error(`[s1-sql] ${REL} is MISSING. Run the matching :generate script.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== build()) {
    console.error(
      `[s1-sql] ${REL} DIVERGED from the contract in db/hosted/bootstrap-postconditions.ts. A probe that measures something else answers a different question.`,
    )
    process.exit(1)
  }
  console.log('[s1-sql] verification OK — the probe matches the postcondition contract')
} else {
  console.error('usage: tsx scripts/s1-observation-sql.ts <generate|verify> [--sentinel]')
  process.exit(2)
}
