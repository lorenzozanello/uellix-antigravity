// scripts/apply-status.ts
// TRAIN 5C2 — the LIVE apply-authorization verdict, computed from measured
// evidence rather than from a test fixture.
//
//   pnpm apply:status           print it
//   pnpm apply:status:write     write artifacts/hosted-apply-status.json
//   pnpm apply:status:verify    recompute and compare — fails if a report drifted
//
// CONNECTS TO NOTHING. It reads two probe artefacts and the corpus.
//
// This exists because a previous report quoted "1 blocking" from the unit-test
// fixture — a hypothetical project where every probe came back the way we wished.
// A number that a document can state and nothing can check is a number that will
// eventually be wrong in the direction that flatters the author.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { evaluateApplyAuthorization, APPLY_AUTHORIZATION_CRITERIA } from '../db/hosted/baseline-apply-authorization'
import {
  APPLY_STATUS_ARTEFACT,
  loadMeasuredEvidence,
  type ApplyStatusArtefact,
} from '../db/hosted/measured-evidence'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const readJson = (rel: string): unknown | null => {
  const raw = read(rel)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function discovered(): string[] {
  const dirs: [string, (n: string) => boolean][] = [
    ['db/migrations', (n) => /^\d{4}_.*\.sql$/.test(n)],
    ['supabase/migrations', (n) => n.endsWith('.sql')],
    ['db/policies', (n) => n.endsWith('.sql')],
  ]
  const out: string[] = []
  for (const [dir, accept] of dirs) {
    let names: string[]
    try {
      names = readdirSync(path.join(ROOT, dir))
    } catch {
      continue
    }
    for (const name of names.sort()) if (accept(name)) out.push(`${dir}/${name}`)
  }
  return out
}

export function computeApplyStatus(): ApplyStatusArtefact {
  const evidence = loadMeasuredEvidence({
    readJson,
    readBaselineSql: read,
    discoveredBaselineFiles: discovered(),
  })
  const report = evaluateApplyAuthorization(evidence.inputs)
  const blocking = report.criteria.filter((c) => !c.satisfied)

  return {
    generatedBy: 'pnpm apply:status:write — do not hand-edit; a report quotes this file',
    criterionCount: APPLY_AUTHORIZATION_CRITERIA.length,
    satisfiedCount: report.criteria.length - blocking.length,
    blockingCount: blocking.length,
    blockingIds: blocking.map((c) => c.id),
    // TWO GATES, BECAUSE THEY ANSWER TWO QUESTIONS.
    //
    // "May PHASE_BASELINE be run?" and "may evidence runtime be used?" have
    // different preconditions, and one list answering both is what made an absent
    // `uellix-evidence` bucket refuse the application of fifty units that never
    // read storage.buckets. Each blocker carries its four parts separately so a
    // conclusion cannot outlive the measurement behind it.
    baselineStartGate: report.baselineStartGate,
    baselineCompletionGate: report.baselineCompletionGate,
    stagingRuntimeGate: report.stagingRuntimeGate,
    // THE GATE'S OWN VERDICT, not a constant. `baselineApplied` and the three
    // below stay false because nothing here applies anything; authorisation is
    // the one value that must be allowed to move, or the artefact would publish
    // a number the gate does not compute.
    applyAuthorized: report.applyAuthorized,
    baselineApplied: false,
    stagingApplied: false,
    hostedReady: false,
    providerReady: false,
    evidenceProblems: evidence.problems.map((p) => `${p.file}: ${p.detail}`),
    observed: evidence.observed,
  }
}

const serialize = (s: ApplyStatusArtefact): string => `${JSON.stringify(s, null, 2)}\n`

const mode = process.argv[2] ?? 'report'

if (mode === 'report') {
  const status = computeApplyStatus()
  for (const [label, gate] of [
    ['BASELINE_START_GATE', status.baselineStartGate],
    ['BASELINE_COMPLETION_GATE', status.baselineCompletionGate],
    ['STAGING_RUNTIME_GATE', status.stagingRuntimeGate],
  ] as const) {
    console.log(`[${label}] ${gate.total} criteria · ${gate.satisfied} satisfied · ${gate.blocking.length} BLOCKING`)
    for (const b of gate.blocking) {
      console.log(`  - ${b.id}`)
      console.log(`      observed:  ${b.observedEvidence}`)
      console.log(`      expected:  ${b.expectedProperty.slice(0, 110)}`)
      console.log(`      reason:    ${b.reason.slice(0, 110)}`)
      console.log(`      source:    ${b.sourceArtifact}`)
    }
  }
  console.log(`[apply] applyAuthorized=${status.applyAuthorized} baselineApplied=${status.baselineApplied}`)
} else if (mode === 'write') {
  writeFileSync(path.join(ROOT, APPLY_STATUS_ARTEFACT), serialize(computeApplyStatus()), 'utf8')
  console.log(`[apply] wrote ${APPLY_STATUS_ARTEFACT}`)
} else if (mode === 'verify') {
  const onDisk = read(APPLY_STATUS_ARTEFACT)
  const expected = serialize(computeApplyStatus())
  if (onDisk === null) {
    console.error(`[apply] ${APPLY_STATUS_ARTEFACT} is MISSING. Run \`pnpm apply:status:write\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    console.error(
      `[apply] ${APPLY_STATUS_ARTEFACT} DIVERGED from the live gate verdict. Any report quoting it is ` +
        `now stating a number the gate does not compute. Regenerate and re-read the report.`,
    )
    process.exit(1)
  }
  console.log('[apply] verification OK — the recorded status is the gate verdict over the measured evidence')
} else {
  console.error('usage: tsx scripts/apply-status.ts <report|write|verify>')
  process.exit(2)
}
