// scripts/storage-boundary-status.ts
// TRAIN 5C2 — unit 41 PART B's catalogue state, derived rather than asserted.
//
//   pnpm boundary:status           print it
//   pnpm boundary:status:write     write artifacts/hosted-storage-boundary-status.json
//   pnpm boundary:status:verify    recompute and compare
//
// CONNECTS TO NOTHING, and RUNS NOTHING. It reads whatever the operator recorded
// in artifacts/hosted-storage-boundary.json and evaluates the boundary over it.
//
// WHY THIS EXISTS. Adversarial review found that `reconcileStorageBoundary` —
// documented as "the only path to MANUAL_BOUNDARY_VERIFIED" — had zero
// production callers, while `loadMeasuredEvidence` hardcoded
// `managedBoundaryVerified: false`. So after the operator installed all three
// canonical policies correctly, nothing would have recomputed it and the gate
// would have refused forever, for a reason no evidence could remove. That is the
// third time in this programme that an artefact was built and never connected,
// and this is the wire.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  STORAGE_BOUNDARY_ARTEFACT,
  STORAGE_BOUNDARY_STATUS_ARTEFACT,
  evaluateStorageBoundaryArtefact,
  type StorageBoundaryArtefact,
} from '../db/hosted/managed-policy-channel'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

export function computeBoundaryStatus() {
  const raw = read(STORAGE_BOUNDARY_ARTEFACT)
  let artefact: StorageBoundaryArtefact | null = null
  if (raw !== null) {
    try {
      artefact = JSON.parse(raw) as StorageBoundaryArtefact
    } catch {
      artefact = {}
    }
  }
  const verdict = evaluateStorageBoundaryArtefact(artefact)
  return {
    generatedBy: 'pnpm boundary:status:write — do not hand-edit; the apply gate reads this file',
    recordArtefact: STORAGE_BOUNDARY_ARTEFACT,
    recordPresent: raw !== null,
    unit41State: verdict.state,
    surfaceVerified: verdict.surfaceVerified,
    // THE ONE VALUE THE APPLY GATE CONSUMES. It is derived from pg_proc,
    // pg_policies and the journal — never from an operator saying "done".
    managedBoundaryVerified: verdict.managedBoundaryVerified,
    problems: verdict.problems,
  }
}

const serialize = (s: ReturnType<typeof computeBoundaryStatus>): string =>
  `${JSON.stringify(s, null, 2)}\n`

const mode = process.argv[2] ?? 'report'

if (mode === 'report') {
  const s = computeBoundaryStatus()
  console.log(
    `[boundary] ${s.unit41State} · managedBoundaryVerified=${s.managedBoundaryVerified}` +
      `${s.recordPresent ? '' : ' (no record artefact)'}`,
  )
  for (const p of s.problems) console.log(`[boundary]   - ${p}`)
} else if (mode === 'write') {
  writeFileSync(path.join(ROOT, STORAGE_BOUNDARY_STATUS_ARTEFACT), serialize(computeBoundaryStatus()), 'utf8')
  console.log(`[boundary] wrote ${STORAGE_BOUNDARY_STATUS_ARTEFACT}`)
} else if (mode === 'verify') {
  const onDisk = read(STORAGE_BOUNDARY_STATUS_ARTEFACT)
  const expected = serialize(computeBoundaryStatus())
  if (onDisk === null) {
    console.error(`[boundary] ${STORAGE_BOUNDARY_STATUS_ARTEFACT} is MISSING. Run \`pnpm boundary:status:write\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    console.error(`[boundary] ${STORAGE_BOUNDARY_STATUS_ARTEFACT} DIVERGED from the derived verdict.`)
    process.exit(1)
  }
  console.log('[boundary] verification OK — the recorded status is the verdict over the recorded catalogue')
} else {
  console.error('usage: tsx scripts/storage-boundary-status.ts <report|write|verify>')
  process.exit(2)
}
