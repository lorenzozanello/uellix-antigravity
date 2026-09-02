// scripts/verify-installer-identity.ts
// The second-to-last thing an operator runs before psql (Commit 5.6).
//
//   pnpm identity:verify --attempt=<CHAIN_ATTEMPT_ID> --identity=<file>
//
// ---------------------------------------------------------------------------
// THE WINDOW THIS CLOSES
// ---------------------------------------------------------------------------
// `planChainWriteForOperator` already refuses without an identity measurement,
// and that is the fail-closed gate: no document, no PACKAGE_PATH, no command to
// paste. But the plan and the keystroke are two moments. Between them the
// operator may open a different terminal, export a different variable, or paste
// into a shell where `$UELLIX_STAGING_URL` resolves to the administrative login
// rather than the installer — which is the exact shape of the two staging
// incidents, transposed one step later.
//
// This is the same relationship `artefact:verify` has to the pin inside the
// plan: the plan checks when it issues, this checks when you execute, and the
// gap between them is a human. One fact, deliberately measured twice.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY CANNOT DO
// ---------------------------------------------------------------------------
// Connect, grant, alter a role, assume a role, read an environment variable,
// touch an attempt ledger, or authorise anything. It reads one JSON document
// the operator measured and compares it against `CERTIFIED_CHAIN_INSTALLER` —
// which is derived from the authority role registry, not spelled here. A
// verifier that named the expected role itself would be a second contract, and
// a verifier that resolved its own expectation would agree with itself.
//
// It prints no connection string and no DSN, because it is never given one:
// the document it reads contains role names and six booleans and nothing else.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CERTIFIED_CHAIN_INSTALLER,
  InstallerIdentityRefusal,
  parseInstallerIdentity,
  verifyInstallerIdentity,
} from '../db/hosted/authority/certification/installer-identity'

const ROOT = path.resolve(import.meta.dirname, '..')

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const attemptId = arg('attempt')
const identityFile = arg('identity')

if (attemptId === undefined || identityFile === undefined) {
  die(
    'usage: verify-installer-identity.ts --attempt=<CHAIN_ATTEMPT_ID> --identity=<file>\n' +
      'The attempt comes from the plan output, copied exactly; the file is the single JSON cell\n' +
      'printed by artifacts/hosted-chain-installer-identity-probe.sql, run through THE CONNECTION\n' +
      'THE WRITE WILL USE. Neither has a default: a check that supplied its own inputs would be a\n' +
      'check that always passes.',
  )
}

let raw: string | null
try {
  raw = readFileSync(path.resolve(ROOT, identityFile), 'utf8')
} catch {
  raw = null
}

let document: ReturnType<typeof parseInstallerIdentity>
try {
  document = parseInstallerIdentity(raw, attemptId)
} catch (error) {
  if (error instanceof InstallerIdentityRefusal) {
    die(`INSTALLER_IDENTITY = FAIL\nREFUSED  ${error.code}\n\n${error.message}`)
  }
  throw error
}

const findings = verifyInstallerIdentity(document.identity)
if (findings.length > 0) {
  die(
    `INSTALLER_IDENTITY = FAIL\n\n` +
      findings.map((f) => `REFUSED  ${f.code}\n\n${f.detail}`).join('\n\n') +
      `\n\nNothing was consumed and nothing was written. Do NOT apply. Reconnect as ` +
      `${CERTIFIED_CHAIN_INSTALLER} and open a new attempt: the measurement that authorised this ` +
      `plan described a different session, and an attempt is spent by the plan it authorises.`,
  )
}

process.stdout.write(
  [
    'INSTALLER_IDENTITY = PASS',
    `  attempt       ${document.attemptId}`,
    `  session_user  ${document.identity.sessionUser}`,
    `  current_user  ${document.identity.currentUser}`,
    `  createRole    ${String(document.identity.createRole)}`,
    `  canSetOwner   ${String(document.identity.canSetOwner)}`,
    `  isSuper       ${String(document.identity.isSuper)}`,
    '',
    `The session this document was measured from is ${CERTIFIED_CHAIN_INSTALLER}, and it is shaped`,
    'the way the managed PG17 certification measured it. That is ALL this establishes: it is not',
    'an authorisation, it consumed nothing, and it changed nothing. The human checkpoint is next.',
    '',
  ].join('\n'),
)
