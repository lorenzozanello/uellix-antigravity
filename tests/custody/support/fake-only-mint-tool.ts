// tests/custody/support/fake-only-mint-tool.ts
//
// A FAKE-ONLY candidate for the Route-B mint-tool harness, rendered to a file
// OUTSIDE the repository at test time. It is not a mint tool: right after it
// loads the driver it checks the fake marker and exits 97 on any real driver,
// so pointed at the real `postgres` package it refuses before generating a
// value or constructing a client. The repository therefore hosts no live
// mint script (the detector in db/custody/mint-route-b-contract.ts keys on
// exactly that guard).
//
// It carries no real target: the host it pins is whatever --target-host says,
// and the harness passes an RFC 6761 `.invalid` host.
//
// Each non-conforming VARIANT breaks one contract clause, so the harness is
// shown able to FAIL on each, not only to pass.

export type ToolVariant =
  | 'CONFORMING'
  | 'LITERAL_IN_SQL'
  | 'INTERPOLATED_NOT_BOUND'
  | 'SECRET_IN_DEPOSITOR_ARGV'
  | 'SECRET_TO_TEMP_FILE'
  | 'SECRET_PRINTED'
  | 'WRONG_VALID_UNTIL'
  | 'HANDOFF_BEFORE_COMMIT'
  | 'ADMIN_ENV_LEAKED_TO_DEPOSITOR'
  | 'NO_TARGET_PIN'
  | 'AMBIGUITY_AS_NOT_COMMITTED'
  | 'AMBIGUITY_DROPS_CANDIDATE'
  /** NB-1 survivor strategy: UNKNOWN only for the one transport code it knows. */
  | 'COMMIT_CLASSIFIED_BY_CODE'
  /** NB-1 survivor strategy: a SQLSTATE-bearing error is read as a definite rollback. */
  | 'COMMIT_CLASSIFIED_BY_SQLSTATE'

export function renderFakeOnlyMintTool(variant: ToolVariant = 'CONFORMING'): string {
  const v = (name: ToolVariant, yes: string, no: string): string => (variant === name ? yes : no)
  return `'use strict'
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DO_BLOCK = ${JSON.stringify(
    [
      'DO $rotate$',
      'BEGIN',
      '  EXECUTE format(',
      "    'ALTER ROLE %I PASSWORD %L VALID UNTIL %L',",
      "    current_setting('uellix.rotating_role'),",
      "    current_setting('uellix.rotating_password'),",
      "    current_setting('uellix.rotating_valid_until')",
      '  );',
      'EXCEPTION WHEN OTHERS THEN',
      "  RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = 'D1_CREDENTIAL_SET_FAILED';",
      'END',
      '$rotate$',
    ].join('\n')
  )}
const STOP_TOKEN = 'STOP_COMMIT_OUTCOME_UNKNOWN__CREDENTIAL_MAY_BE_LIVE'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const argOf = (k) => { const a = process.argv.slice(2).find((x) => x.startsWith(k)); return a === undefined ? undefined : a.slice(k.length) }

async function main() {
  const KNOWN = ['--driver-root=', '--depositor=', '--valid-until=', '--target-host=']
  for (const a of process.argv.slice(2)) if (!KNOWN.some((k) => a.startsWith(k))) { out({ refused: 'UNKNOWN_ARGUMENT' }); return 2 }
  const validUntil = argOf('--valid-until=') || ''
  if (!/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d{3})?Z$/.test(validUntil)) { out({ refused: 'VALID_UNTIL' }); return 2 }
  const targetHost = argOf('--target-host=') || ''
  if (targetHost === '') { out({ refused: 'NO_TARGET_HOST' }); return 2 }
  const adminUrl = process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  ${v('ADMIN_ENV_LEAKED_TO_DEPOSITOR', '', 'delete process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL')}
  if (!adminUrl) { out({ refused: 'NO_OPERATOR_CONNECTION' }); return 2 }
  ${v('NO_TARGET_PIN', '', "if (new URL(adminUrl).hostname !== targetHost) { out({ refused: 'OPERATOR_TARGET_NOT_THE_PINNED_HOST' }); return 2 }")}

  const req = createRequire(path.join(argOf('--driver-root=') || '', 'package.json'))
  const postgres = req('postgres')
  // FAKE-ONLY GUARD: this fixture refuses every real driver.
  if (postgres.__UELLIX_CONTRACT_FAKE__ !== true) { out({ refused: 'FAKE_ONLY_FIXTURE' }); return 97 }

  const secret = randomBytes(32).toString('base64url')
  ${v('SECRET_TO_TEMP_FILE', "fs.writeFileSync(path.join(process.env.TEMP || '.', 'staged.txt'), secret)", '')}
  ${v('SECRET_PRINTED', 'out({ debug: secret })', '')}
  const childEnv = {}
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP']) if (process.env[k] !== undefined) childEnv[k] = process.env[k]
  ${v('ADMIN_ENV_LEAKED_TO_DEPOSITOR', 'childEnv.UELLIX_D1_MINT_OPERATOR_DATABASE_URL = adminUrl', '')}
  const depArgs = [argOf('--depositor=')${v('SECRET_IN_DEPOSITOR_ARGV', ', secret', '')}]
  const dep = spawn(process.execPath, depArgs, { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv, windowsHide: false })
  let depOut = ''
  dep.stdout.setEncoding('utf8')
  dep.stdout.on('data', (c) => { depOut += c })
  const dsn = () => ['postgresql:', '//uellix_auditor:', secret, '@', targetHost, ':5432/postgres'].join('')
  ${v('HANDOFF_BEFORE_COMMIT', 'dep.stdin.write(dsn() + "\\n")', '')}

  const sql = postgres(adminUrl, { max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })
  // callbackCompleted flips as the LAST act of the callback, right before the
  // driver sends COMMIT. After it, a failure cannot prove COMMIT never reached
  // the server, so it is COMMIT_OUTCOME_UNKNOWN, never DEFINITELY_NOT_COMMITTED.
  let callbackCompleted = false
  let outcome = 'DEFINITELY_NOT_COMMITTED'
  try {
    await sql.begin(async (tx) => {
      await tx\`SELECT set_config('uellix.rotating_role', \${'uellix_auditor'}, true)\`
      ${v(
        'INTERPOLATED_NOT_BOUND',
        "await tx.unsafe(\"SELECT set_config('uellix.rotating_password', '\" + secret + \"', true)\")",
        "await tx`SELECT set_config('uellix.rotating_password', ${secret}, true)`"
      )}
      await tx\`SELECT set_config('uellix.rotating_valid_until', \${${v('WRONG_VALID_UNTIL', "'2099-01-01T00:00:00.000Z'", 'validUntil')}}, true)\`
      await tx.unsafe(${v('LITERAL_IN_SQL', "DO_BLOCK.replace(\"current_setting('uellix.rotating_password')\", \"'\" + secret + \"'\")", 'DO_BLOCK')})
      callbackCompleted = true
      out({ phase: 'COMMIT_REQUESTED' })
    })
    outcome = 'COMMITTED'
  } catch (e) {
    outcome = ${
      variant === 'AMBIGUITY_AS_NOT_COMMITTED'
        ? "'DEFINITELY_NOT_COMMITTED'"
        : variant === 'COMMIT_CLASSIFIED_BY_CODE'
          ? "callbackCompleted && e && e.code === 'CONNECTION_CLOSED' ? 'COMMIT_OUTCOME_UNKNOWN' : 'DEFINITELY_NOT_COMMITTED'"
          : variant === 'COMMIT_CLASSIFIED_BY_SQLSTATE'
            ? "callbackCompleted && !(e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) ? 'COMMIT_OUTCOME_UNKNOWN' : 'DEFINITELY_NOT_COMMITTED'"
            : "callbackCompleted ? 'COMMIT_OUTCOME_UNKNOWN' : 'DEFINITELY_NOT_COMMITTED'"
    }
    out({ phase: 'DRIVER_REJECTED', code: e && e.code ? String(e.code) : 'UNKNOWN' })
  } finally {
    try { await sql.end({ timeout: 5 }) } catch { /* the outcome above stands */ }
  }
  // Custody: a value that may be live goes into the ratified store, whether
  // COMMIT was acknowledged or its outcome is unknown. Only a transaction that
  // provably never asked for COMMIT hands nothing over.
  const deposit = ${v('AMBIGUITY_DROPS_CANDIDATE', "outcome === 'COMMITTED'", "outcome !== 'DEFINITELY_NOT_COMMITTED'")}${v('HANDOFF_BEFORE_COMMIT', ' && false', '')}
  if (deposit) dep.stdin.end(dsn() + '\\n')
  else dep.stdin.end()
  const code = await new Promise((r) => dep.on('close', r))
  let n30 = null
  try { n30 = JSON.parse(depOut.trim().split(/\\r?\\n/).pop() || 'null') } catch { n30 = null }
  const n30ExitMet = n30 !== null && n30.n30ExitMet === true
  if (outcome === 'COMMIT_OUTCOME_UNKNOWN') {
    out({ mint: outcome, token: STOP_TOKEN, depositorExit: code, n30ExitMet })
    return 4
  }
  out({ mint: outcome, depositorExit: code, n30ExitMet })
  return outcome === 'COMMITTED' && code === 0 ? 0 : 1
}
main().then((c) => { process.exitCode = c }, () => { out({ aborted: true }); process.exitCode = 3 })
`
}
