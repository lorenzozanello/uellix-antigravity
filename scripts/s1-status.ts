// scripts/s1-status.ts
// The PHASE_STELLA_BOOTSTRAP verdict, computed from a measured observation.
//
//   pnpm s1:status        --phase=<pre-sentinel|post-sentinel>   print it
//   pnpm s1:status:write  --phase=<...>                          write the status artefact
//   pnpm s1:status:verify --phase=<...>                          recompute and compare
//
// THE PHASE IS MANDATORY AND THERE IS NO DEFAULT. An earlier version defaulted
// to the S1 question and read one fixed path, which is how the post-sentinel
// measurement would have been written over the pre-sentinel evidence. A silent
// default is exactly the mechanism that turns two historical facts into one
// overwritten file, so this refuses instead of guessing.
//
// CONNECTS TO NOTHING. It reads the artefact the operator filled from
// db/prepared/stella-bootstrap/observation.sql — the SAME probe for both
// phases. What changes is where its output is stored and which question it is
// asked.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  PHASE_LABEL,
  S1_OBSERVATION_SQL,
  evaluateBootstrapPostconditions,
  parseS1Observation,
  resolveS1Evidence,
  type S1EvidencePhase,
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

const PHASES: readonly S1EvidencePhase[] = ['pre-sentinel', 'post-sentinel']

function requestedPhase(): S1EvidencePhase {
  const flags = process.argv.filter((a) => a.startsWith('--phase='))
  if (flags.length === 0) {
    console.error(
      '[s1-status] REFUSED: --phase is mandatory and has no default.\n' +
        `  --phase=pre-sentinel   the measurement taken BEFORE the human sentinel INSERT\n` +
        `  --phase=post-sentinel  the S3 measurement taken AFTER it\n` +
        'They are two historical facts. Guessing between them is how one overwrites the other.',
    )
    process.exit(2)
  }
  if (flags.length > 1) {
    console.error(`[s1-status] REFUSED: --phase given ${flags.length} times (${flags.join(' ')}).`)
    process.exit(2)
  }
  const value = flags[0]!.slice('--phase='.length)
  if (!PHASES.includes(value as S1EvidencePhase)) {
    console.error(`[s1-status] REFUSED: unknown phase ${JSON.stringify(value)}. Declared: ${PHASES.join(', ')}.`)
    process.exit(2)
  }
  return value as S1EvidencePhase
}

const mode = process.argv[2] ?? 'report'
const phase = requestedPhase()

const resolved = resolveS1Evidence(phase, undefined, KNOWN_STAGING_PROJECT_REF)
if (!resolved.ok) {
  console.error(`[s1-status] REFUSED (${resolved.code}): ${resolved.detail}`)
  process.exit(1)
}
const { entry, sentinelExpected } = resolved

export function computeS1Status(): Record<string, unknown> {
  const parsed = parseS1Observation(read(entry.path), KNOWN_STAGING_PROJECT_REF, entry.path)
  if (!parsed.ok) {
    return {
      phase: PHASE_LABEL[phase],
      sentinelExpected,
      verdict: 'REFUSED',
      code: parsed.code,
      detail: parsed.detail,
      remedy:
        `Run ${S1_OBSERVATION_SQL} against staging read-only and record its JSON output at ` +
        `${entry.path}. Do not write it anywhere else: the other phase's artefact is a different ` +
        `historical fact and overwriting it would destroy evidence that cannot be re-measured.`,
    }
  }
  const verdict = evaluateBootstrapPostconditions(parsed.observation, phase)
  return {
    // SHAPE FROZEN BY 90c2dff. The pre-sentinel status was committed with this
    // exact serialization, and the instruction forbids re-serializing it to fit
    // new plumbing. Nothing is added; the phase is recorded through its LABEL,
    // and the two labels differ — which is what makes a status cross-wired into
    // the other phase's slot fail `:verify` rather than pass unnoticed.
    phase: PHASE_LABEL[phase],
    sentinelExpected,
    targetProjectRef: parsed.observation.targetProjectRef,
    verdict: verdict.passed ? 'PASS' : 'FAIL',
    passedCount: verdict.checks.filter((c) => c.passed).length,
    totalCount: verdict.checks.length,
    checks: verdict.checks,
  }
}

const status = computeS1Status()
const serialized = `${JSON.stringify(status, null, 2)}\n`

if (mode === 'report') {
  console.log(serialized.trimEnd())
  process.exit(status.verdict === 'PASS' ? 0 : 1)
} else if (mode === 'write') {
  if (status.verdict === 'REFUSED') {
    console.error(`[s1-status] REFUSED (${String(status.code)}): ${String(status.detail)}`)
    process.exit(1)
  }
  writeFileSync(path.join(ROOT, entry.statusPath), serialized, 'utf8')
  console.log(`[s1-status] wrote ${entry.statusPath} — ${String(status.verdict)} (${phase})`)
} else if (mode === 'verify') {
  const onDisk = read(entry.statusPath)
  if (onDisk === null) {
    // NOT a failure. Until the operator has measured that phase there is
    // nothing to compare, and a gate demanding it would block every run of the
    // suite on a step that has not happened yet.
    console.log(`[s1-status] ${entry.statusPath} not present yet — nothing to verify (${phase})`)
    process.exit(0)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== serialized) {
    console.error(
      `[s1-status] ${entry.statusPath} DIVERGED from what the contract computes today for ${phase}. ` +
        `Either the observation changed, or this status was derived from a different phase's ` +
        `observation. A status a document quotes and nothing recomputes is a number that will ` +
        `eventually be wrong in the direction that flatters the author.`,
    )
    process.exit(1)
  }
  console.log(`[s1-status] verification OK — the recorded ${phase} verdict is what the contract computes`)
} else {
  console.error('usage: tsx scripts/s1-status.ts <report|write|verify> --phase=<pre-sentinel|post-sentinel>')
  process.exit(2)
}
