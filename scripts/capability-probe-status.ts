// scripts/capability-probe-status.ts
// TRAIN 5C2 — the capability probe's result, derived rather than asserted.
//
//   pnpm probe:status           print it
//   pnpm probe:status:write     write artifacts/hosted-capability-probe-status.json
//   pnpm probe:status:verify    recompute and compare
//
// CONNECTS TO NOTHING, and RUNS NOTHING. It reads whatever the operator recorded
// in artifacts/hosted-capability-probe.json and evaluates the chain over it.
//
// Adversarial review's point, which this closes: every function in
// storage-capability-probe.ts was imported by its own test and by nothing else.
// Without this script the operator would run the probe by hand, paste a result
// somewhere, and a HUMAN would have to remember to call the verifiers — which is
// the same "a report and a gate can diverge" defect the apply-status script was
// written to fix, reintroduced one module over.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  CAPABILITY_PROBE_ARTEFACT,
  CAPABILITY_PROBE_POLICY,
  CAPABILITY_PROBE_STATUS_ARTEFACT,
  evaluateCapabilityProbeArtefact,
  type CapabilityProbeArtefact,
} from '../db/hosted/storage-capability-probe'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

export function computeProbeStatus() {
  const raw = read(CAPABILITY_PROBE_ARTEFACT)
  let artefact: CapabilityProbeArtefact | null = null
  if (raw !== null) {
    try {
      artefact = JSON.parse(raw) as CapabilityProbeArtefact
    } catch {
      artefact = {}
    }
  }
  const verdict = evaluateCapabilityProbeArtefact(artefact)
  return {
    generatedBy: 'pnpm probe:status:write — do not hand-edit; a report quotes this file',
    policyName: CAPABILITY_PROBE_POLICY,
    recordArtefact: CAPABILITY_PROBE_ARTEFACT,
    recordPresent: raw !== null,
    // SURFACED RATHER THAN SILENTLY ABSENT. The operator's report carried no
    // timestamp and none was invented; the substantive evidence is the
    // pg_policies observation, but an audit record whose time nobody wrote down
    // should say so where a reader will see it.
    timestampRecorded: (artefact?.record?.timestamp ?? '').trim() !== '',
    state: verdict.state,
    problems: verdict.problems,
    // NEVER true from this file, in any state. Capability is not correctness.
    canonicalPoliciesProven: verdict.canonicalPoliciesProven,
    managementPlaneVerified: false as const,
  }
}

const serialize = (s: ReturnType<typeof computeProbeStatus>): string => `${JSON.stringify(s, null, 2)}\n`

const mode = process.argv[2] ?? 'report'

if (mode === 'report') {
  const s = computeProbeStatus()
  console.log(`[probe] ${s.state}${s.recordPresent ? '' : ' (no record artefact)'}`)
  for (const p of s.problems) console.log(`[probe]   - ${p}`)
} else if (mode === 'write') {
  writeFileSync(path.join(ROOT, CAPABILITY_PROBE_STATUS_ARTEFACT), serialize(computeProbeStatus()), 'utf8')
  console.log(`[probe] wrote ${CAPABILITY_PROBE_STATUS_ARTEFACT}`)
} else if (mode === 'verify') {
  const onDisk = read(CAPABILITY_PROBE_STATUS_ARTEFACT)
  const expected = serialize(computeProbeStatus())
  if (onDisk === null) {
    console.error(`[probe] ${CAPABILITY_PROBE_STATUS_ARTEFACT} is MISSING. Run \`pnpm probe:status:write\`.`)
    process.exit(1)
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    console.error(`[probe] ${CAPABILITY_PROBE_STATUS_ARTEFACT} DIVERGED from the derived verdict.`)
    process.exit(1)
  }
  console.log('[probe] verification OK — the recorded status is the verdict over the recorded evidence')
} else {
  console.error('usage: tsx scripts/capability-probe-status.ts <report|write|verify>')
  process.exit(2)
}
