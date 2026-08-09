// scripts/a1-status.ts
// CHECKPOINT A1's verdict, derived rather than asserted.
//
//   pnpm a1:status         print it
//   pnpm a1:status:write   write artifacts/hosted-a1-status.json
//   pnpm a1:status:verify  recompute and compare — non-zero if it drifted
//
// CONNECTS TO NOTHING, and RUNS NOTHING. It reads what the operator assembled in
// artifacts/hosted-a1-corroboration.json — the output of the read-only probe at
// db/prepared/checkpoint-a1/corroboration.sql plus the two connection facts no
// query can report — and runs the CANONICAL gates over it: verifyStagingTarget,
// the witness registry, and planProvisioningPhase.
//
// The split is the same one CHECKPOINT B0 makes: if the process that judges A1
// could also produce the observation it judges, the observation would not be
// evidence. The operator measures; this evaluates.
//
// THIS FILE IS ONLY THE ENTRY POINT. The status shape, its serialization and the
// comparison `:verify` performs all live in db/hosted/checkpoint-a1.ts, so they
// are testable without spawning a process — a `:verify` whose comparison nothing
// exercises is an advisory gate wearing a mandatory one's clothes.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  A1_CORROBORATION_ARTEFACT,
  A1_STATUS_ARTEFACT,
  computeA1Status,
  serializeA1Status,
  verifyA1Status,
} from '../db/hosted/checkpoint-a1'
import { HOSTED_CHAIN } from '../db/hosted/hosted-package-manifest'
import { STORAGE_UNIT_TRANSITIONS, type StorageUnitState } from '../db/hosted/storage-policy-artifact'

const ROOT = path.resolve(import.meta.dirname, '..')
/** Unit 41's state lives here, derived by `pnpm boundary:status:write` and gated. */
const BOUNDARY_STATUS = 'artifacts/hosted-storage-boundary-status.json'

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

function stellaSources(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of HOSTED_CHAIN) {
    const sql = read(`db/prepared/${name}.sql`)
    if (sql !== null) out[name] = sql
  }
  return out
}

/**
 * Unit 41's state, read from the boundary status artefact.
 *
 * NOT defaulted and NOT inferred. `null` here means "nobody measured it", and
 * `evaluateCheckpointA1` refuses on that — the same rule the runner applies to
 * every other probe. A missing file quietly becoming UNIT_41_NOT_STARTED would
 * be a guess, and quietly becoming UNIT_41_COMPLETE would be a lie.
 */
function storageUnitState(): StorageUnitState | null {
  const raw = read(BOUNDARY_STATUS)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state = parsed.unit41State
    return typeof state === 'string' && state in STORAGE_UNIT_TRANSITIONS ? (state as StorageUnitState) : null
  } catch {
    return null
  }
}

const status = computeA1Status({
  raw: read(A1_CORROBORATION_ARTEFACT),
  readBaselineSql: read,
  stellaSources: stellaSources(),
  storageUnitState: storageUnitState(),
})

const mode = process.argv[2] ?? 'report'

if (mode === 'report') {
  console.log(
    `[a1] corroboration=${status.corroborationPresent ? 'present' : 'ABSENT'} · ` +
      `packages=${String(status.packageCount)} · checkpointPassed=${String(status.checkpointPassed)}`,
  )
  for (const b of status.blockers as string[]) console.log(`[a1]   BLOCKER ${b}`)
  for (const w of status.warnings as string[]) console.log(`[a1]   warning ${w}`)
  process.exit(status.checkpointPassed === true ? 0 : 1)
} else if (mode === 'write') {
  // A status written without an observation records "we have not measured" in a
  // file everyone downstream reads as a verdict.
  if (status.corroborationPresent !== true) {
    console.error(`[a1] REFUSED: ${A1_CORROBORATION_ARTEFACT} is absent, so there is nothing to derive a verdict from.`)
    process.exit(1)
  }
  writeFileSync(path.join(ROOT, A1_STATUS_ARTEFACT), serializeA1Status(status), 'utf8')
  console.log(`[a1] wrote ${A1_STATUS_ARTEFACT} — checkpointPassed=${String(status.checkpointPassed)}`)
} else if (mode === 'verify') {
  const result = verifyA1Status(read(A1_STATUS_ARTEFACT), serializeA1Status(status))
  if (!result.ok) {
    console.error(`[a1] ${result.note}`)
    process.exit(1)
  }
  console.log(`[a1] ${result.present ? 'verification OK — ' : ''}${result.note}`)
} else {
  console.error('usage: tsx scripts/a1-status.ts <report|write|verify>')
  process.exit(2)
}
