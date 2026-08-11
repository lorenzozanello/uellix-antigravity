// scripts/posture-status.ts
// F-PI-01, half two — the verdict over a REMOTE posture measurement.
//
//   pnpm posture:status        --attempt=<id> --observation=<file>   print it
//   pnpm posture:status:write  --attempt=<id> --observation=<file>   record it
//   pnpm posture:status:verify --attempt=<id> --observation=<file>   recompute and compare
//
// CONNECTS TO NOTHING, and RUNS NOTHING. It reads the single JSON cell the
// operator saved from `artifacts/hosted-chain-posture-probe.sql` and runs the
// CANONICAL evaluators over it — `evaluateOwnerTransfers`,
// `evaluateCanonicalOwnerContexts`, `evaluatePersistentRoleTopology`,
// `evaluateSecurityDefinerGate`, `evaluateRlsPolicyEngine`, plus the two derived
// residual gates that close TEMP_MEMBERSHIPS and TEMP_CREATE_GRANTS.
//
// The split is CHECKPOINT A1's and CHECKPOINT B0's: if the process that judges a
// measurement could also produce it, the measurement would not be evidence. The
// operator measures; this evaluates.
//
// THIS FILE IS ONLY THE ENTRY POINT. The status shape, its serialization and the
// comparison `:verify` performs live in
// db/hosted/authority/certification/chain-posture-evidence.ts, so they are
// testable without spawning a process — a `:verify` whose comparison nothing
// exercises is an advisory gate wearing a mandatory one's clothes.
//
// ---------------------------------------------------------------------------
// WHAT A PASS HERE IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It says the posture MEASURED ON THE REMOTE PROJECT is the posture the
// authority plan requires. It authorises nothing: it enables no feature flag,
// it permits no write, and it says nothing whatsoever about Production. The
// governed chain is forward-only and already installed; there is no action this
// verdict unlocks.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  POSTURE_ATTEMPT_LEDGER,
  POSTURE_STATUS_ARTEFACT,
  computePostureStatus,
  parsePostureAttemptLedger,
  postureAttemptLine,
  postureAttemptStatus,
  readRepoFile,
  serializePostureStatus,
  verifyPostureStatus,
} from '../db/hosted/authority/certification/chain-posture-evidence'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')
/** Where a consumed measurement is kept, per attempt, so the next one cannot bury it. */
const EVIDENCE_DIR = 'docs/ops/staging/evidence'

const read = readRepoFile(ROOT)

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const mode = process.argv[2] ?? 'report'
if (!['report', 'write', 'verify'].includes(mode)) {
  die('usage: posture-status.ts <report|write|verify> --attempt=<id> --observation=<file>')
}

const observationFile = arg('observation')
if (observationFile === undefined) {
  die('[posture] --observation=<file> is required; there is no default. A status with no measurement is not a status.')
}

const ledgerRaw = read(POSTURE_ATTEMPT_LEDGER)
if (ledgerRaw === null) {
  die(`[posture] ${POSTURE_ATTEMPT_LEDGER} does not exist. Run \`pnpm posture:observation\` first.`)
}

// The attempt is read FROM THE LEDGER, exactly as `chain:attempt:plan` reads
// its own: taking it from a flag alone would let the thing being checked choose
// what it is checked against. `--attempt` is required and must AGREE — the
// operator states which measurement they believe they are judging, and a
// disagreement is a refusal rather than a silent redirect to the right one.
const opened = parsePostureAttemptLedger(ledgerRaw).filter((r) => r.event === 'OPENED')
const latest = opened[opened.length - 1]
if (latest === undefined) die('[posture] no posture attempt has ever been opened.')

const claimed = arg('attempt')
if (claimed === undefined) {
  die(`[posture] --attempt=<id> is required. The latest OPENED posture attempt is ${latest.attemptId}.`)
}
if (claimed !== latest.attemptId) {
  die(
    `[posture] --attempt=${claimed} and the latest OPENED posture attempt is ${latest.attemptId}. ` +
      `Opening an attempt retires every attempt before it, so an older one cannot be judged now.`,
  )
}

const observationRaw = (() => {
  try {
    return readFileSync(path.resolve(ROOT, observationFile), 'utf8')
  } catch {
    return null
  }
})()

const ledgerState = postureAttemptStatus(parsePostureAttemptLedger(ledgerRaw), latest.attemptId)

// THE JUDGEMENT IS A PURE FUNCTION of the observation, the declared baseline and
// the repository. The ledger is NOT one of its inputs — see the header of
// `PostureStatusInputs`. Freshness is enforced below, in `write`, which is the
// act that records and promotes.
const status = computePostureStatus({
  expectedAttemptId: latest.attemptId,
  raw: observationRaw,
  readArtefact: read,
  root: ROOT,
})

function print(): void {
  process.stdout.write(
    [
      `POSTURE_ATTEMPT      ${status.attemptId} (${ledgerState})`,
      `OBSERVATION          ${status.observationPresent ? observationFile : 'ABSENT'}`,
      `BASELINE             ${status.baseline.source ?? '(unresolved)'}`,
      '',
      ...Object.entries(status.verdicts).map(([k, v]) => `  ${k.padEnd(32)} ${v}`),
      '',
      ...status.blockers.map((b) => `  BLOCKER ${b}`),
      ...(status.refusal ? [`  REFUSED ${status.refusal.code}`, '', status.refusal.detail] : []),
      '',
      `REMOTE_CHAIN_POSTURE = ${status.postureVerified ? 'VERIFIED' : 'NOT_VERIFIED'}`,
      '',
      'This authorises nothing. It enables no feature flag, permits no write, and says',
      'nothing about Production.',
      '',
    ].join('\n'),
  )
}

if (mode === 'report') {
  print()
  process.exit(status.postureVerified ? 0 : 1)
}

if (mode === 'verify') {
  const result = verifyPostureStatus(read(POSTURE_STATUS_ARTEFACT), serializePostureStatus(status))
  if (!result.ok) die(`[posture] ${result.note}`)
  process.stdout.write(`[posture] ${result.present ? 'verification OK — ' : ''}${result.note}\n`)
  process.exit(0)
}

/* ------------------------------------------------------------------ write  */

// A status written without a measurement records "we have not measured" in a
// file everyone downstream reads as a verdict.
if (!status.observationPresent) {
  die(`[posture] REFUSED: ${observationFile} is absent, so there is nothing to derive a verdict from.`)
}
if (status.refusal !== null) {
  die(`[posture] REFUSED  ${status.refusal.code}\n\n${status.refusal.detail}`)
}

// R-H1. The name carries the attempt, and the date comes from the LEDGER's
// OPENED record rather than from the clock — the file is named for when it was
// measured, not for when someone got round to promoting it.
const promoted = path.join(
  EVIDENCE_DIR,
  `${latest.at.slice(0, 10)}-${latest.attemptId.slice(0, 12)}-chain-posture-observation.json`,
).replace(/\\/g, '/')
const promotedAbs = path.join(ROOT, promoted)
const alreadyPromoted = existsSync(promotedAbs)

/**
 * FRESHNESS, enforced HERE — the act that records a verdict and promotes a
 * measurement — rather than inside the judgement, which must stay recomputable.
 *
 * One exception, and it is narrow enough to state completely: an attempt that
 * is already CONSUMED may re-materialise the status it already produced, if and
 * only if the promoted evidence exists and is BYTE-IDENTICAL to the observation
 * supplied now. That is not a new judgement — it is the same one, over the same
 * bytes, written again because the status file was lost or its shape changed.
 * Nothing is promoted and nothing is appended on that path, so it cannot
 * manufacture a measurement or spend an attempt twice.
 */
const sameBytes =
  alreadyPromoted && readFileSync(promotedAbs, 'utf8') === (observationRaw as string)
const reMaterialise = ledgerState === 'CONSUMED' && sameBytes

if (ledgerState !== 'OPEN' && !reMaterialise) {
  die(
    `[posture] REFUSED  POSTURE_ATTEMPT_NOT_OPEN\n\n` +
      (ledgerState === 'UNKNOWN'
        ? `attempt ${latest.attemptId} was never opened in ${POSTURE_ATTEMPT_LEDGER}. An attempt is ` +
          `opened before the probe runs; one that appears only now was not the attempt anything measured.`
        : `attempt ${latest.attemptId} is spent — it was consumed by a status already. One observation ` +
          `is judged once, and the observation supplied now is not byte-identical to the one that was ` +
          `promoted for it, so this is a NEW judgement asking to reuse a spent attempt. Open a new ` +
          `attempt and measure again.`),
  )
}

writeFileSync(path.join(ROOT, POSTURE_STATUS_ARTEFACT), serializePostureStatus(status), 'utf8')

let promotionNote: string
if (reMaterialise) {
  promotionNote = `re-materialised over an existing judgement; promotion untouched: ${promoted}`
} else if (alreadyPromoted) {
  // The attempt is OPEN and yet its evidence slot is taken. That is a name
  // collision, not a re-run, and overwriting is the defect the slot exists to
  // close.
  die(
    `[posture] REFUSED  ${promoted} already exists and this attempt is OPEN. A promotion that could ` +
      `clobber an earlier measurement is exactly what this directory exists to prevent.`,
  )
} else {
  mkdirSync(path.dirname(promotedAbs), { recursive: true })
  copyFileSync(path.resolve(ROOT, observationFile), promotedAbs)
  promotionNote = `promoted verbatim: ${promoted}`
}

// CONSUMED only here, and only after the status and the promotion have both
// landed. A refusal above writes no ledger line at all, so there is no branch on
// which this file records a judgement that was never made — and the
// re-materialisation path appends nothing, because the attempt is already spent.
if (!reMaterialise) {
  appendFileSync(
    path.join(ROOT, POSTURE_ATTEMPT_LEDGER),
    postureAttemptLine('CONSUMED', latest.attemptId, KNOWN_STAGING_PROJECT_REF, new Date().toISOString()),
    'utf8',
  )
}

print()
process.stdout.write(
  [
    `[posture] wrote ${POSTURE_STATUS_ARTEFACT}`,
    `[posture] ${promotionNote}`,
    reMaterialise
      ? `[posture] attempt ${latest.attemptId} was ALREADY CONSUMED — nothing was appended.`
      : `[posture] attempt ${latest.attemptId} CONSUMED — one observation is judged once.`,
    '',
  ].join('\n'),
)
process.exit(status.postureVerified ? 0 : 1)
