// scripts/s1-status.ts
// The PHASE_STELLA_BOOTSTRAP verdict, computed from the measured observation.
//
//   pnpm s1:status              print it
//   pnpm s1:status:write        write artifacts/hosted-s1-status.json
//   pnpm s1:status:verify       recompute and compare — fails if the report drifted
//
// Add `--sentinel=present` to ask the CHECKPOINT A1 question instead of the S1
// one. That flag is the ONLY difference between the two verdicts, which is why
// there is one script and not two.
//
// CONNECTS TO NOTHING. It reads the artefact the operator filled from
// db/prepared/stella-bootstrap/observation.sql.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  S1_OBSERVATION_ARTEFACT,
  S1_STATUS_ARTEFACT,
  S1_OBSERVATION_SQL,
  evaluateBootstrapPostconditions,
  parseS1Observation,
  type SentinelExpectation,
} from '../db/hosted/bootstrap-postconditions'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const mode = process.argv[2] ?? 'report'
const sentinelExpected: SentinelExpectation = process.argv.includes('--sentinel=present')
  ? 'present'
  : 'absent'
const phase = sentinelExpected === 'absent' ? 'S1 (PHASE_STELLA_BOOTSTRAP)' : 'CHECKPOINT A1'

export function computeS1Status(): Record<string, unknown> {
  const parsed = parseS1Observation(read(S1_OBSERVATION_ARTEFACT), KNOWN_STAGING_PROJECT_REF)
  if (!parsed.ok) {
    return {
      phase,
      sentinelExpected,
      verdict: 'REFUSED',
      code: parsed.code,
      detail: parsed.detail,
      remedy: `Run ${S1_OBSERVATION_SQL} against staging and record its JSON output at ${S1_OBSERVATION_ARTEFACT}.`,
    }
  }
  const verdict = evaluateBootstrapPostconditions(parsed.observation, { sentinelExpected })
  return {
    phase,
    sentinelExpected,
    targetProjectRef: parsed.observation.targetProjectRef,
    verdict: verdict.passed ? 'PASS' : 'FAIL',
    passedCount: verdict.checks.filter((c) => c.passed).length,
    totalCount: verdict.checks.length,
    checks: verdict.checks,
  }
}

const status = computeS1Status()

if (mode === 'report') {
  console.log(JSON.stringify(status, null, 2))
  process.exit(status.verdict === 'PASS' ? 0 : 1)
} else if (mode === 'write') {
  if (status.verdict === 'REFUSED') {
    console.error(`[s1-status] REFUSED (${String(status.code)}): ${String(status.detail)}`)
    process.exit(1)
  }
  writeFileSync(path.join(ROOT, S1_STATUS_ARTEFACT), `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  console.log(`[s1-status] wrote ${S1_STATUS_ARTEFACT} — ${String(status.verdict)}`)
} else if (mode === 'verify') {
  const onDisk = read(S1_STATUS_ARTEFACT)
  if (onDisk === null) {
    // NOT a failure. Until the operator has measured the target there is
    // nothing to compare, and a gate that demanded the artefact would block
    // every run of the suite on a phase that has not happened yet.
    console.log(`[s1-status] ${S1_STATUS_ARTEFACT} not present yet — nothing to verify`)
    process.exit(0)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== `${JSON.stringify(status, null, 2)}\n`) {
    console.error(
      `[s1-status] ${S1_STATUS_ARTEFACT} DIVERGED from what the contract computes today. A status a document quotes and nothing recomputes is a number that will eventually be wrong in the direction that flatters the author.`,
    )
    process.exit(1)
  }
  console.log('[s1-status] verification OK — the recorded verdict is what the contract computes')
} else {
  console.error('usage: tsx scripts/s1-status.ts <report|write|verify> [--sentinel=present]')
  process.exit(2)
}
