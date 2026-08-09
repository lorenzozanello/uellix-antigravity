// scripts/b0-status.ts
// CHECKPOINT B0's verdict, derived rather than asserted.
//
//   pnpm b0:status           print it
//   pnpm b0:status:write     write artifacts/hosted-b0-status.json
//   pnpm b0:status:verify    recompute and compare — non-zero if it drifted
//
// CONNECTS TO NOTHING, and RUNS NOTHING. It reads whatever the operator
// recorded in artifacts/hosted-b0-observation.json — produced by the read-only
// SQL at db/prepared/checkpoint-b0/observation.sql — and runs the CANONICAL
// eighteen postconditions over it.
//
// The split matters: if the process that judges B0 could also produce the
// observation it judges, the observation would not be evidence. The operator
// measures; this evaluates.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { B0_OBSERVATION_ARTEFACT, B0_STATUS_ARTEFACT, evaluateB0 } from '../db/hosted/checkpoint-b0'
import { deriveExpectedBaselineState } from '../db/hosted/baseline-postconditions'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

export function computeB0Status() {
  const expected = deriveExpectedBaselineState(read)
  const verdict = evaluateB0(read(B0_OBSERVATION_ARTEFACT), expected)
  return {
    generatedBy: 'pnpm b0:status:write — do not hand-edit; this file is derived from the observation',
    observationArtefact: B0_OBSERVATION_ARTEFACT,
    observationPresent: verdict.observationPresent,
    projectRef: verdict.projectRef,
    checkCount: verdict.checkCount,
    passedCount: verdict.passedCount,
    // THE ONE VALUE A REPORT MAY QUOTE. Derived from the eighteen canonical
    // postconditions over a target-bound observation — never from anyone
    // saying the checkpoint went fine.
    checkpointPassed: verdict.checkpointPassed,
    failing: verdict.failing,
  }
}

const serialize = (s: ReturnType<typeof computeB0Status>): string => `${JSON.stringify(s, null, 2)}\n`

const mode = process.argv[2] ?? 'report'

if (mode === 'report') {
  const s = computeB0Status()
  console.log(
    `[b0] ${s.passedCount}/${s.checkCount} checks pass · checkpointPassed=${s.checkpointPassed}` +
      `${s.observationPresent ? '' : ' (no observation artefact)'}`,
  )
  for (const f of s.failing) console.log(`[b0]   - ${f.id}: ${f.detail}`)
} else if (mode === 'write') {
  writeFileSync(path.join(ROOT, B0_STATUS_ARTEFACT), serialize(computeB0Status()), 'utf8')
  console.log(`[b0] wrote ${B0_STATUS_ARTEFACT}`)
} else if (mode === 'verify') {
  const onDisk = read(B0_STATUS_ARTEFACT)
  const expected = serialize(computeB0Status())
  if (onDisk === null) {
    console.error(`[b0] ${B0_STATUS_ARTEFACT} is MISSING. Run \`pnpm b0:status:write\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    console.error(
      `[b0] ${B0_STATUS_ARTEFACT} DIVERGED from the derived verdict. A hand-edited status is the one thing this file may never be.`,
    )
    process.exit(1)
  }
  console.log('[b0] verification OK — the recorded status is the verdict over the recorded observation')
} else {
  console.error('usage: tsx scripts/b0-status.ts <report|write|verify>')
  process.exit(2)
}
