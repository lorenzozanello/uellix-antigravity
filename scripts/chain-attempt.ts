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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  ATTEMPT_ID_SHAPE,
  CHAIN_ATTEMPT_LEDGER,
  authorizeChainWrite,
  buildPreWriteObservationSql,
} from '../db/hosted/fresh-observation'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')
const PROBE_OUT = 'artifacts/hosted-chain-pre-write-probe.sql'

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

  const sql = buildPreWriteObservationSql(attemptId)
  mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true })
  writeFileSync(path.join(ROOT, PROBE_OUT), sql, 'utf8')

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
      `probe written to ${PROBE_OUT} — it carries this attempt id and no other`,
      '',
      'Run it READ-ONLY against the target, then assemble the observation document:',
      '',
      `  psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f ${PROBE_OUT}`,
      '',
      'Wrap the probe output as { schema, phase: "PRE_WRITE", attemptId, observationId,',
      'corroboration: { declaredEnvironment, declaredProjectRef, connection, featureFlags,',
      'observation: <probe output> }, digest } and pass it to:',
      '',
      `  pnpm chain:attempt:plan --observation=<file>`,
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
  // what it is checked against.
  const opened = ledgerRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { attemptId: string; event: string })
    .filter((r) => r.event === 'OPENED')
  const latest = opened[opened.length - 1]
  if (latest === undefined) die('[chain] no attempt has ever been opened.')

  let raw: string | null
  try {
    raw = readFileSync(path.resolve(ROOT, file), 'utf8')
  } catch {
    raw = null
  }

  const verdict = authorizeChainWrite({
    raw,
    expectedAttemptId: latest.attemptId,
    attemptLedger: ledgerRaw,
  })

  if (!verdict.ok) {
    process.stderr.write(`REFUSED  ${verdict.code}\n\n${verdict.detail}\n`)
    process.exit(1)
  }

  appendFileSync(
    path.join(ROOT, CHAIN_ATTEMPT_LEDGER),
    `${JSON.stringify({
      attemptId: verdict.attemptId,
      event: 'CONSUMED',
      targetProjectRef: verdict.projectRef,
      at: new Date().toISOString(),
      packageId: verdict.packageId,
    })}\n`,
    'utf8',
  )

  process.stdout.write(
    [
      `AUTHORISED  exactly one write`,
      `  attempt   ${verdict.attemptId}`,
      `  target    ${verdict.projectRef}`,
      `  package   ${verdict.packageId}`,
      '',
      ...verdict.log.map((l) => `  ${l}`),
      '',
      `  psql -1 -v ON_ERROR_STOP=1 -f db/prepared/hosted/${verdict.packageId}.hosted.sql`,
      '',
      'This attempt is now CONSUMED. Whatever happens to that command — success,',
      'failure, or a connection that dies without answering — the next step is a NEW',
      'attempt and a NEW measurement. Never a retry decided by an exit code.',
      '',
    ].join('\n'),
  )
}

const command = process.argv[2]
if (command === 'open') open()
else if (command === 'plan') plan()
else die('usage: chain-attempt.ts open | plan --observation=<file>')
