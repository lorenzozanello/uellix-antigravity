// scripts/chain-attempt.ts
// The operator workflow for ONE chain write.
//
//   pnpm chain:attempt:open                      mint an attempt, emit its probe
//   pnpm chain:attempt:plan --observation=<file> validate it and plan ONE write
//
// CONNECTS TO NOTHING and RUNS NOTHING. `open` mints the attempt id and writes
// the read-only SQL that carries it; a human runs that SQL through psql and
// assembles the document; `plan` refuses or authorises exactly one package.
//
// ---------------------------------------------------------------------------
// WHY TWO COMMANDS AND NOT ONE
// ---------------------------------------------------------------------------
// A single command would have to hold the connection, and this module is on the
// side of the boundary that never connects — the same reason `chain:status`
// reads a file instead of running a query. So the binding is carried by the
// LEDGER instead of by a process: `open` appends an OPENED record, `plan`
// refuses any attempt that is not the latest unconsumed one, and a successful
// plan appends CONSUMED. Yesterday's document cannot authorise today's write
// because opening today's attempt retired yesterday's.
//
// The attempt id is compiled INTO the probe SQL, so the database echoes it in
// the document it produces. That is what makes "re-run last week's probe and
// paste the output" fail instead of pass.
//
// ---------------------------------------------------------------------------
// COMMIT 5.4 — WHY `open` NOW EMITS THREE PROBES (F-PS-02)
// ---------------------------------------------------------------------------
// The first package this tool can ever authorise is T1, and T1's prerequisite
// is not a chain witness: the prechain remediation must be INSTALLED and the
// prechain authority gate must pass. `authorizeGovernedT1` decides that and was
// reachable from nothing an operator could run, so the plan path could report
// T1 AUTHORISED against a project where the reconciliation had never happened.
//
// The evidence has to be measured for THIS attempt or it is not evidence, so
// all three probes carry the same attempt id and are emitted together. Two of
// them are only read when the observation turns out to authorise T1 — which is
// not known until the measurement exists, which is why they are emitted rather
// than requested later.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  ATTEMPT_ID_SHAPE,
  CHAIN_ATTEMPT_LEDGER,
  buildPreWriteObservationSql,
  parseChainAttemptLedger,
} from '../db/hosted/fresh-observation'
import {
  GOVERNED_T1_PACKAGE,
  buildPrechainObservationSql,
  gateGovernedT1,
  planChainWriteForOperator,
} from '../db/hosted/chain-operator'
import { certifiedCapabilitiesBodyDigest } from '../db/hosted/remediation-operator'
import { buildRemediationWitnessSql } from '../db/hosted/authority/certification/remediation-probes'
import { PRECHAIN_REMEDIATION } from '../db/hosted/prechain-remediation'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')
const PROBE_OUT = 'artifacts/hosted-chain-pre-write-probe.sql'
const WITNESS_PROBE_OUT = 'artifacts/hosted-chain-t1-remediation-probe.sql'
const PRECHAIN_PROBE_OUT = 'artifacts/hosted-chain-t1-prechain-probe.sql'

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function open(): void {
  const attemptId = `att_${randomBytes(16).toString('hex')}`
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) die('[chain] minted an attempt id of the wrong shape')

  const remediationSql = read(PRECHAIN_REMEDIATION.sourceFile)
  if (remediationSql === null) {
    die(
      `[chain] ${PRECHAIN_REMEDIATION.sourceFile} is unreadable, so the T1 remediation witness ` +
        `probe cannot be built. T1 is not plannable without it.`,
    )
  }

  const sql = buildPreWriteObservationSql(attemptId)
  mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true })
  writeFileSync(path.join(ROOT, PROBE_OUT), sql, 'utf8')
  writeFileSync(
    path.join(ROOT, WITNESS_PROBE_OUT),
    buildRemediationWitnessSql(attemptId, certifiedCapabilitiesBodyDigest(remediationSql)),
    'utf8',
  )
  writeFileSync(path.join(ROOT, PRECHAIN_PROBE_OUT), buildPrechainObservationSql(attemptId), 'utf8')

  // APPEND, never rewrite. The ledger is the record of which attempts existed,
  // and an attempt that could be edited out of it is an attempt that could be
  // replayed.
  appendFileSync(
    path.join(ROOT, CHAIN_ATTEMPT_LEDGER),
    `${JSON.stringify({
      attemptId,
      event: 'OPENED',
      targetProjectRef: KNOWN_STAGING_PROJECT_REF,
      at: new Date().toISOString(),
    })}\n`,
    'utf8',
  )

  process.stdout.write(
    [
      `ATTEMPT OPENED   ${attemptId}`,
      `probes written — each carries this attempt id and no other:`,
      `  ${PROBE_OUT}            chain witnesses (always required)`,
      `  ${WITNESS_PROBE_OUT}    remediation witness (required for ${GOVERNED_T1_PACKAGE})`,
      `  ${PRECHAIN_PROBE_OUT}   prechain authority (required for ${GOVERNED_T1_PACKAGE})`,
      '',
      'Run them READ-ONLY against the target, then assemble the observation document:',
      '',
      `  psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f ${PROBE_OUT}`,
      '',
      'Wrap the probe output as { schema, phase: "PRE_WRITE", attemptId, observationId,',
      'corroboration: { declaredEnvironment, declaredProjectRef, connection, featureFlags,',
      'observation: <probe output> }, digest } and pass it to:',
      '',
      `  pnpm chain:attempt:plan --observation=<file>`,
      '',
      `If the observation authorises ${GOVERNED_T1_PACKAGE}, the other two documents are`,
      'required as well — each is the single JSON cell its probe prints, saved verbatim:',
      '',
      `  pnpm chain:attempt:plan --observation=<file> \\`,
      `    --remediation-witness=<file> --prechain-observation=<file>`,
      '',
      'Opening another attempt retires this one. Do not keep two open.',
      '',
    ].join('\n'),
  )
}

function plan(): void {
  const file = arg('observation')
  if (file === undefined) die('[chain] --observation=<file> is required; there is no default.')

  const ledgerRaw = read(CHAIN_ATTEMPT_LEDGER)
  if (ledgerRaw === null) {
    die(`[chain] ${CHAIN_ATTEMPT_LEDGER} does not exist. Run pnpm chain:attempt:open first.`)
  }
  // The attempt is read FROM THE LEDGER, not from a flag and not from the
  // document: taking it from either would let the thing being checked choose
  // what it is checked against. Records declaring a foreign kind are dropped —
  // a remediation attempt measures a different question and must never be the
  // latest OPENED chain attempt (F-PS-04).
  const opened = parseChainAttemptLedger(ledgerRaw).filter((r) => r.event === 'OPENED')
  const latest = opened[opened.length - 1]
  if (latest === undefined) die('[chain] no chain attempt has ever been opened.')

  const readOrNull = (rel: string | undefined): string | null | undefined => {
    if (rel === undefined) return undefined
    try {
      return readFileSync(path.resolve(ROOT, rel), 'utf8')
    } catch {
      return null
    }
  }

  const verdict = planChainWriteForOperator({
    raw: readOrNull(file) ?? null,
    expectedAttemptId: latest.attemptId,
    attemptLedger: ledgerRaw,
    at: new Date().toISOString(),
    ...(arg('remediation-witness') !== undefined
      ? { witnessRaw: readOrNull(arg('remediation-witness')) ?? null }
      : {}),
    ...(arg('prechain-observation') !== undefined
      ? { prechainRaw: readOrNull(arg('prechain-observation')) ?? null }
      : {}),
  })

  if (!verdict.ok) {
    process.stderr.write(`REFUSED  ${verdict.code}\n\n${verdict.detail}\n`)
    process.exit(1)
  }

  // CONSUMED only here. A refusal carries no ledger line at all, so there is no
  // branch on which this file could record a write that was never authorised.
  appendFileSync(path.join(ROOT, CHAIN_ATTEMPT_LEDGER), verdict.consumedLedgerLine, 'utf8')

  const r = verdict.record
  process.stdout.write(
    [
      `AUTHORISED  exactly one write`,
      `  CHAIN_ATTEMPT_ID         ${r.CHAIN_ATTEMPT_ID}`,
      `  TARGET_PROJECT_REF       ${r.TARGET_PROJECT_REF}`,
      `  PACKAGE_ID               ${r.PACKAGE_ID}`,
      `  PACKAGE_PATH             ${r.PACKAGE_PATH}`,
      `  PACKAGE_DIGEST           ${r.PACKAGE_DIGEST}`,
      `  T1_GATE                  ${r.T1_GATE}`,
      `  REMEDIATION_WITNESS      ${r.REMEDIATION_WITNESS}`,
      `  PRECHAIN_AUTHORITY_GATE  ${r.PRECHAIN_AUTHORITY_GATE}`,
      `  ATTEMPT_STATUS           ${r.ATTEMPT_STATUS}`,
      `  DECISION                 ${r.DECISION}`,
      '',
      ...verdict.authorization.log.map((l) => `  ${l}`),
      '',
      'BEFORE psql — revalidate the authorised bytes. A plan authorises BYTES, and',
      'the window between this line and your keystroke belongs to a human:',
      '',
      `  pnpm artefact:verify --path=${r.PACKAGE_PATH} --digest=${r.PACKAGE_DIGEST}`,
      '',
      'Required: ARTEFACT_DIGEST = PASS. Then the human checkpoint. Then:',
      '',
      `  psql -1 -v ON_ERROR_STOP=1 -f ${r.PACKAGE_PATH}`,
      '',
      'This attempt is now CONSUMED. Whatever happens to that command — success,',
      'failure, or a connection that dies without answering — the next step is a NEW',
      'attempt and a NEW measurement. Never a retry decided by an exit code.',
      '',
    ].join('\n'),
  )
}

/**
 * Report the T1 prerequisite WITHOUT authorising anything.
 *
 * The staging sequence has a hard stop between "the prechain gate passes" and
 * "T1 may be written", and a stop whose only observation is the command that
 * consumes the attempt is not a stop. This asks `gateGovernedT1` — the same
 * certified predicate `plan` consults — and writes nothing at all.
 */
function gate(): void {
  const witness = arg('remediation-witness')
  const prechain = arg('prechain-observation')
  const attemptId = arg('attempt')
  if (witness === undefined || prechain === undefined || attemptId === undefined) {
    die(
      '[chain] gate requires --attempt=<id> --remediation-witness=<file> --prechain-observation=<file>. ' +
        'The attempt is the one both documents echo; there is no default.',
    )
  }

  const readOrNull = (rel: string): string | null => {
    try {
      return readFileSync(path.resolve(ROOT, rel), 'utf8')
    } catch {
      return null
    }
  }

  const verdict = gateGovernedT1({
    packageId: GOVERNED_T1_PACKAGE,
    attemptId,
    witnessRaw: readOrNull(witness),
    prechainRaw: readOrNull(prechain),
  })

  if (!verdict.ok) {
    process.stderr.write(
      `PRECHAIN_AUTHORITY_GATE = FAIL\nREFUSED  ${verdict.code}\n\n${verdict.detail}\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    [
      `PRECHAIN_AUTHORITY_GATE = PASS`,
      `  attempt                 ${attemptId}`,
      `  package                 ${GOVERNED_T1_PACKAGE}`,
      `  REMEDIATION_WITNESS     ${verdict.required ? verdict.remediation.state : 'NOT_APPLICABLE'}`,
      `  PRECHAIN_REFUSALS       ${verdict.required ? verdict.gateRefusals.length : 0}`,
      `  CONTRACTS_CHECKED       ${verdict.required ? verdict.contracts : 0}`,
      '',
      'Nothing was consumed and nothing was written. This is a REPORT: it does not',
      'authorise T1, and the operator boundary between it and a chain plan is where',
      'a human decision goes.',
      '',
    ].join('\n'),
  )
}

const command = process.argv[2]
if (command === 'open') open()
else if (command === 'plan') plan()
else if (command === 'gate') gate()
else {
  die(
    'usage: chain-attempt.ts open | plan --observation=<file> | ' +
      'gate --attempt=<id> --remediation-witness=<file> --prechain-observation=<file>',
  )
}
