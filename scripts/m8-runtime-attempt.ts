// scripts/m8-runtime-attempt.ts
//
//   pnpm m8:runtime:open    mint a runtime attempt, emit the operator command
//
// CONNECTS TO NOTHING and RUNS NOTHING. It mints the id that
// artifacts/hosted-m8-runtime-proof-v2.sql refuses to run without, records it
// append-only, and prints the one command that carries it.
//
// ---------------------------------------------------------------------------
// WHY A SEPARATE LEDGER AND NOT THE CHAIN'S
// ---------------------------------------------------------------------------
// A runtime proof is not a chain package write. It commits nothing, installs
// nothing and authorises nothing, and a record of one must never be able to
// become the latest OPENED entry in artifacts/hosted-chain-attempts.jsonl —
// that ledger position IS the chain's freshness binding, and F-PS-04 exists
// because a foreign record sitting there once could decide it.
//
// So this writes its own file under its own `kind`. The direction F-PS-04
// closed is already covered: `parseChainAttemptLedger` accepts only records
// with no kind or kind === 'hosted-chain', so even a record pasted into the
// wrong file cannot be mistaken for a chain attempt.
//
// ---------------------------------------------------------------------------
// WHY THE OUTPUT PATH IS CHECKED HERE
// ---------------------------------------------------------------------------
// psql's `-o` TRUNCATES. A second run against a path that already holds a
// measurement destroys it silently and reports success, and the destroyed file
// is the only record of an execution that can never be repeated — the
// credential it ran under is gone by then. The path is therefore bound to the
// attempt and refused if it exists, before the operator is given a command.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { ATTEMPT_ID_SHAPE, parseAttemptLedger } from '../db/hosted/fresh-observation'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')
const LEDGER = 'artifacts/hosted-m8-runtime-attempts.jsonl'
const PROBE = 'artifacts/hosted-m8-runtime-proof-v2.sql'
const RUNTIME_ATTEMPT_KIND = 'hosted-m8-runtime'

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function open(): void {
  if (!existsSync(path.join(ROOT, PROBE))) {
    die(`[m8] ${PROBE} does not exist. There is nothing to mint an attempt for.`)
  }

  const attemptId = `att_${randomBytes(16).toString('hex')}`
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) die('[m8] minted an attempt id of the wrong shape')

  const observation = `artifacts/hosted-m8-runtime-observation-${attemptId}.json`
  if (existsSync(path.join(ROOT, observation))) {
    die(
      `[m8] REFUSED: ${observation} already exists. psql -o truncates, so running against ` +
        `it would destroy a measurement that cannot be repeated — the credential that ` +
        `produced it is no longer valid. Open a new attempt instead.`,
    )
  }

  let ledgerRaw: string | null = null
  try {
    ledgerRaw = readFileSync(path.join(ROOT, LEDGER), 'utf8')
  } catch {
    ledgerRaw = null
  }
  const prior = parseAttemptLedger(ledgerRaw).filter((r) => r.kind === RUNTIME_ATTEMPT_KIND)
  const openPrior = prior.filter(
    (r) => r.event === 'OPENED' && !prior.some((c) => c.event === 'CONSUMED' && c.attemptId === r.attemptId),
  )

  mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true })
  appendFileSync(
    path.join(ROOT, LEDGER),
    `${JSON.stringify({
      attemptId,
      event: 'OPENED',
      targetProjectRef: KNOWN_STAGING_PROJECT_REF,
      at: new Date().toISOString(),
      kind: RUNTIME_ATTEMPT_KIND,
    })}\n`,
    'utf8',
  )

  process.stdout.write(
    [
      `M8 RUNTIME ATTEMPT OPENED   ${attemptId}`,
      `  probe        ${PROBE}`,
      `  ledger       ${LEDGER}   (kind ${RUNTIME_ATTEMPT_KIND}, NOT the chain ledger)`,
      `  observation  ${observation}`,
      '',
      ...(openPrior.length > 0
        ? [
            `NOTE: ${openPrior.length} earlier runtime attempt(s) were opened and never recorded`,
            `as consumed. That is a record of history, not an error; nothing is retired.`,
            '',
          ]
        : []),
      'The probe REFUSES to run without this id. It is compiled into neither the file',
      'nor a default — it travels on the command line and is echoed back by the server',
      'in both evidence rows.',
      '',
      'Requires a live uellix_app credential (lifecycle #2, not yet opened):',
      '',
      `  & $Psql -h db.${KNOWN_STAGING_PROJECT_REF}.supabase.co -p 5432 -U uellix_app -d postgres \\`,
      `      -W -X -q -A -t -v ON_ERROR_STOP=1 -v m8_attempt_id=${attemptId} \\`,
      `      -f ${PROBE} -o ${observation}`,
      '',
      'Keep PGSSLMODE=verify-full. Do NOT pass -1: the probe opens its own transaction.',
      'Exit code 0 is necessary and NEVER sufficient — the two evidence rows decide.',
      '',
    ].join('\n'),
  )
}

const command = process.argv[2]
if (command === 'open') open()
else die('usage: m8-runtime-attempt.ts open')
