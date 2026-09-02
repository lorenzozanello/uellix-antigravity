// scripts/posture-observation-sql.ts
// F-PI-01, half one — the read-only SQL that measures the REMOTE chain posture.
//
//   pnpm posture:observation                 mint an attempt and emit its probe
//   pnpm posture:observation --attempt=<id>  re-emit the probe for an OPEN attempt
//
// CONNECTS TO NOTHING and RUNS NOTHING. It mints an id, appends one line to an
// append-only ledger, and writes a file. A human runs that file through psql,
// READ ONLY, against staging, and saves the single JSON cell it prints.
//
// ---------------------------------------------------------------------------
// WHY IT MINTS RATHER THAN TAKES
// ---------------------------------------------------------------------------
// The attempt id is compiled INTO the probe as a literal, so the server echoes
// it inside the document it produces, and `posture:status` refuses a document
// whose echoed attempt is not the one now open. That is what makes "re-run last
// month's probe and paste the output" fail instead of pass — the freshness of a
// measurement is a BINDING, not a timestamp, because an operator re-running an
// old file gets an old answer with a new `observedAt` the moment anything
// re-stamps it.
//
// `--attempt=<id>` re-emits for an attempt that is ALREADY OPEN, for the case
// where the probe file was lost between minting and running it. It cannot open
// one, and it cannot reach past a newer attempt: opening an attempt retires
// every attempt before it, and this refuses anything that is not the latest
// unconsumed one.
//
// ---------------------------------------------------------------------------
// A LEDGER OF ITS OWN
// ---------------------------------------------------------------------------
// Posture attempts go to `artifacts/hosted-chain-posture-attempts.jsonl` and
// carry `kind: "hosted-chain-posture"`. They are NOT chain attempts and must
// never become the latest OPENED record in `artifacts/hosted-chain-attempts.jsonl`
// — that record is the freshness binding for a WRITE, and a read-only
// measurement taken after the chain is installed has no business deciding it.
// This is F-PS-04's rule applied in the direction that had not come up yet.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  POSTURE_ATTEMPT_LEDGER,
  POSTURE_PROBE_ARTEFACT,
  PostureEvidenceRefusal,
  buildChainPostureProbeSql,
  parsePostureAttemptLedger,
  postureAttemptLine,
  postureAttemptStatus,
} from '../db/hosted/authority/certification/chain-posture-evidence'
import { ATTEMPT_ID_SHAPE } from '../db/hosted/fresh-observation'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')

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

const requested = arg('attempt')
const ledgerRaw = read(POSTURE_ATTEMPT_LEDGER)

let attemptId: string
let minted = false

if (requested === undefined) {
  attemptId = `att_${randomBytes(16).toString('hex')}`
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) die('[posture] minted an attempt id of the wrong shape')
  minted = true
} else {
  if (!ATTEMPT_ID_SHAPE.test(requested)) {
    die(
      `[posture] ${JSON.stringify(requested)} is not an attempt id. An attempt id is att_ followed ` +
        `by 32 hex characters, and this command cannot open one — run it with no arguments to mint.`,
    )
  }
  const status = postureAttemptStatus(parsePostureAttemptLedger(ledgerRaw), requested)
  if (status !== 'OPEN') {
    die(
      `[posture] attempt ${requested} is ${status}, not OPEN.\n` +
        (status === 'UNKNOWN'
          ? `It was never opened in ${POSTURE_ATTEMPT_LEDGER}. Run \`pnpm posture:observation\` with ` +
            `no arguments to mint one; this command re-emits a probe, it does not authorise a new ` +
            `measurement.`
          : `It was consumed by a status already, or a later attempt retired it. A spent attempt ` +
            `cannot measure again: one observation is judged once.`),
    )
  }
  attemptId = requested
}

let sql: string
try {
  sql = buildChainPostureProbeSql(attemptId, ROOT)
} catch (error) {
  if (error instanceof PostureEvidenceRefusal) {
    die(`[posture] REFUSED  ${error.code}\n\n${error.message}`)
  }
  throw error
}

// The ledger line is appended BEFORE the probe is written, and only when this
// invocation minted the id. An attempt whose probe exists but which the ledger
// never recorded is an attempt nothing can attribute a measurement to.
if (minted) {
  appendFileSync(
    path.join(ROOT, POSTURE_ATTEMPT_LEDGER),
    postureAttemptLine('OPENED', attemptId, KNOWN_STAGING_PROJECT_REF, new Date().toISOString()),
    'utf8',
  )
}

mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true })
writeFileSync(path.join(ROOT, POSTURE_PROBE_ARTEFACT), sql, 'utf8')

process.stdout.write(
  [
    `POSTURE ATTEMPT ${minted ? 'OPENED' : 'RE-EMITTED'}   ${attemptId}`,
    `  probe   ${POSTURE_PROBE_ARTEFACT}`,
    `  ledger  ${POSTURE_ATTEMPT_LEDGER}`,
    '',
    'The probe is SELECT-only: one `SET search_path = \'\'` and one SELECT, verified',
    'before it was written to disk. It measures ownership, canonical owner contexts,',
    'role topology, capability reachability, RLS, SECURITY DEFINER / search_path and',
    'the per-schema CREATE residual. It changes nothing and it writes nothing.',
    '',
    'Run it READ-ONLY against the STAGING target and save the single cell it prints:',
    '',
    `  psql -X -q -A -t -v ON_ERROR_STOP=1 -f ${POSTURE_PROBE_ARTEFACT} > <file>.json`,
    '',
    'Then judge it. Nothing is consumed and nothing is authorised by either step:',
    '',
    `  pnpm posture:status --attempt=${attemptId} --observation=<file>.json`,
    '',
    'Opening another posture attempt retires this one. Do not keep two open.',
    '',
  ].join('\n'),
)
