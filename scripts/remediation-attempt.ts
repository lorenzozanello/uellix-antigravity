// scripts/remediation-attempt.ts
// The operator workflow for ONE prechain remediation write (F-PS-05).
//
//   pnpm remediation:attempt:open                  mint an attempt, emit its probe
//   pnpm remediation:attempt:plan --witness=<file> validate it and authorise ONE write
//
// CONNECTS TO NOTHING and RUNS NOTHING. `open` mints the attempt id and writes
// the read-only witness SQL that carries it; a human runs that SQL through psql
// and saves the single JSON cell it returns; `plan` refuses, or consumes the
// attempt and names the one package that may be applied.
//
// ---------------------------------------------------------------------------
// WHY THIS MIRRORS chain-attempt.ts INSTEAD OF EXTENDING IT
// ---------------------------------------------------------------------------
// The rules are the same and the IDENTITY is not. The remediation is not a
// chain package: it has no chain witness, never appears in `nextChainPackage`,
// and is a PREREQUISITE of T1 rather than a member of the sequence. It
// therefore keeps its own ledger file, so that opening a chain attempt cannot
// retire a remediation attempt that is still the current measurement of a
// different question — and every record it writes declares its kind, so the two
// cannot be confused even if the lines were pasted between files.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS NOT ALLOWED TO DO
// ---------------------------------------------------------------------------
// Decide anything. Every verdict comes from `db/hosted/remediation-operator.ts`,
// which composes the functions `pnpm certify:remediation` exercises on a real
// engine. This file reads files, appends one line, and prints.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  REMEDIATION_PROBE_ARTIFACT,
  openRemediationAttempt,
  planRemediationWrite,
} from '../db/hosted/remediation-operator'
import {
  REMEDIATION_ATTEMPT_LEDGER,
  parseRemediationAttemptLedger,
} from '../db/hosted/remediation-attempt'
import { PRECHAIN_REMEDIATION } from '../db/hosted/prechain-remediation'
import { ATTEMPT_ID_SHAPE } from '../db/hosted/fresh-observation'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Repo-relative, for the files this tool knows the names of. */
const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

/** Operator-supplied, so absolute paths must work as well as relative ones. */
const readAt = (given: string): string | null => {
  try {
    return readFileSync(path.resolve(ROOT, given), 'utf8')
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

const packageSql = (): string => {
  const sql = read(PRECHAIN_REMEDIATION.sourceFile)
  if (sql === null) die(`[remediation] ${PRECHAIN_REMEDIATION.sourceFile} is unreadable.`)
  return sql
}

function open(): void {
  const attemptId = `att_${randomBytes(16).toString('hex')}`
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) die('[remediation] minted an attempt id of the wrong shape')

  let result: ReturnType<typeof openRemediationAttempt>
  try {
    result = openRemediationAttempt({
      attemptId,
      remediationSql: packageSql(),
      at: new Date().toISOString(),
    })
  } catch (error) {
    die(`REFUSED  ${error instanceof Error ? error.message : String(error)}`)
  }

  mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true })
  writeFileSync(path.join(ROOT, REMEDIATION_PROBE_ARTIFACT), result.probeSql, 'utf8')

  // APPEND, never rewrite. An attempt that could be edited out of the ledger is
  // an attempt that could be replayed.
  appendFileSync(path.join(ROOT, REMEDIATION_ATTEMPT_LEDGER), result.ledgerLine, 'utf8')

  process.stdout.write(
    [
      `REMEDIATION ATTEMPT OPENED   ${result.attemptId}`,
      `  target        ${result.targetProjectRef}   (production denylist: ${KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.join(', ') || 'none'})`,
      `  package       ${result.packageId}`,
      `  pin           ${result.sourceSha256}`,
      `  certified body ${result.certifiedBodyDigest}`,
      `  probe         ${REMEDIATION_PROBE_ARTIFACT} — it carries this attempt id and no other`,
      '',
      'Run it READ-ONLY against the target and save the single JSON cell it prints:',
      '',
      `  psql "$UELLIX_STAGING_URL" -X -q -A -t -v ON_ERROR_STOP=1 \\`,
      `       -f ${REMEDIATION_PROBE_ARTIFACT} > artifacts/hosted-remediation-witness.json`,
      '',
      'Then:',
      '',
      `  pnpm remediation:attempt:plan --witness=artifacts/hosted-remediation-witness.json`,
      '',
      'Opening another attempt retires this one. Do not keep two open.',
      '',
    ].join('\n'),
  )
}

/** `VERIFIED sha256=<hex>` -> `<hex>`. The record carries the prose; the
 *  operator needs the value, and retyping a 64-character hex is how a digit
 *  goes missing. */
const sourceSha256 = (pinStatus: string): string => pinStatus.replace(/^.*sha256=/, '')

function plan(): void {
  const file = arg('witness')
  if (file === undefined) die('[remediation] --witness=<file> is required; there is no default.')

  const ledgerRaw = read(REMEDIATION_ATTEMPT_LEDGER)
  if (ledgerRaw === null) {
    die(`[remediation] ${REMEDIATION_ATTEMPT_LEDGER} does not exist. Run pnpm remediation:attempt:open first.`)
  }

  // The attempt is read FROM THE LEDGER, never from a flag and never from the
  // document: taking it from either would let the thing being checked choose
  // what it is checked against.
  const openedRecords = parseRemediationAttemptLedger(ledgerRaw).filter((r) => r.event === 'OPENED')
  const latest = openedRecords[openedRecords.length - 1]
  if (latest === undefined) die('[remediation] no remediation attempt has ever been opened.')

  const result = planRemediationWrite({
    witnessRaw: readAt(file),
    expectedAttemptId: latest.attemptId,
    attemptLedger: ledgerRaw,
    remediationSql: packageSql(),
    at: new Date().toISOString(),
    ...(arg('package') !== undefined ? { requestedPackageId: arg('package') as string } : {}),
  })

  if (!result.ok) {
    process.stderr.write(`REFUSED  ${result.code}\n\n${result.detail}\n`)
    process.exit(1)
  }

  // CONSUMED BEFORE THE WRITE. If anything after this line dies, the ledger
  // says spent and the only route forward is a new attempt and a new
  // measurement — correct whether the package committed or rolled back.
  appendFileSync(path.join(ROOT, REMEDIATION_ATTEMPT_LEDGER), result.consumedLedgerLine, 'utf8')

  const r = result.record
  process.stdout.write(
    [
      'AUTHORISED  exactly one remediation write',
      `  REMEDIATION_ATTEMPT_ID  ${r.REMEDIATION_ATTEMPT_ID}`,
      `  WITNESS                 ${r.WITNESS}`,
      `  PACKAGE_ID              ${r.PACKAGE_ID}`,
      `  PACKAGE_PATH            ${r.PACKAGE_PATH}`,
      `  PIN_STATUS              ${r.PIN_STATUS}`,
      `  ATTEMPT_STATUS          ${r.ATTEMPT_STATUS}`,
      `  TARGET_PROJECT_REF      ${r.TARGET_PROJECT_REF}`,
      `  DECISION                ${r.DECISION}`,
      '',
      ...result.log.map((l) => `  ${l}`),
      '',
      'BEFORE psql — revalidate the authorised bytes. A plan authorises BYTES, and',
      'the window between this line and your keystroke belongs to a human:',
      '',
      `  pnpm artefact:verify --path=${r.PACKAGE_PATH} --digest=${sourceSha256(r.PIN_STATUS)}`,
      '',
      'Required: ARTEFACT_DIGEST = PASS. Then the human checkpoint.',
      '',
      'The operator applies it manually, in ONE transaction, declaring the environment',
      'in the SAME session:',
      '',
      `  psql "$UELLIX_STAGING_URL" -X -1 -v ON_ERROR_STOP=1 \\`,
      `       -c "SET uellix.bootstrap_environment = 'staging'" \\`,
      `       -f ${r.PACKAGE_PATH}`,
      '',
      `Expected target: ${KNOWN_STAGING_PROJECT_REF}. Never ${KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.join(', ')}.`,
      '',
      'This attempt is now CONSUMED. Whatever happens to that command — success,',
      'failure, or a connection that dies without answering — the next step is a NEW',
      'attempt and a NEW measurement. Never a retry decided by an exit code.',
      'T1 is NOT authorised by this plan; it has its own gate.',
      '',
    ].join('\n'),
  )
}

const command = process.argv[2]
if (command === 'open') open()
else if (command === 'plan') plan()
else die('usage: remediation-attempt.ts open | plan --witness=<file>')
