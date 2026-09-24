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
// It implements the route-B contract as amended by the owner decision
// N11_PASSWORD_TRANSPORT = CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER: the
// plaintext only derives the SCRAM-SHA-256 verifier and goes to the depositor;
// only the verifier is bound. The driver is built from explicit options after
// the operator URL is checked (no query, exact host/port/database/principal),
// and the driver's files are checked against --driver-digest first (OT-13..17).
//
// It does NOT implement OT-1's run-time git-tree refusal: it is rendered under
// the OS temp directory, which on the authoring workstation is itself inside a
// git work tree, so that refusal would stop every scenario. The harness's
// TOOL_INSIDE_GIT_TREE scenario is therefore run against the real outside tool
// only (execution record), never against this fixture.
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
  /** OT-13 broken: any driver version is accepted. */
  | 'NO_DRIVER_VERSION_CHECK'
  /** OT-14 broken: the operator principal is not compared. */
  | 'NO_PRINCIPAL_CHECK'
  /** OT-15 broken: the PLAINTEXT is bound instead of the verifier. */
  | 'PLAINTEXT_BOUND'
  /** OT-15 broken: the verifier is derived with a wrong HMAC label (not a verifier of the plaintext). */
  | 'WRONG_KEY_LABEL'
  /** OT-16 broken: the driver is built from the URL string, so its query becomes startup GUCs. */
  | 'URL_CONSTRUCTED'
  /** OT-16 broken: the host is compared with startsWith. */
  | 'HOST_STARTSWITH'
  /** OT-16 broken: a query in the operator URL is not refused. */
  | 'NO_QUERY_CHECK'
  /** OT-16 broken: the database is not compared. */
  | 'NO_DATABASE_CHECK'
  | 'NO_PORT_CHECK'
  /** OT-17 broken: the driver's files are not compared with --driver-digest. */
  | 'NO_DRIVER_DIGEST_CHECK'

export function renderFakeOnlyMintTool(variant: ToolVariant = 'CONFORMING'): string {
  const v = (name: ToolVariant, yes: string, no: string): string => (variant === name ? yes : no)
  return `'use strict'
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const { randomBytes, createHash, createHmac, pbkdf2Sync } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DO_BLOCK = ${JSON.stringify(
    [
      'DO $rotate$',
      'BEGIN',
      "  IF current_setting('uellix.rotating_verifier') !~ '^SCRAM-SHA-256\\$[0-9]+:[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' THEN",
      "    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'D1_VERIFIER_REQUIRED';",
      '  END IF;',
      '  EXECUTE format(',
      "    'ALTER ROLE %I PASSWORD %L VALID UNTIL %L',",
      "    current_setting('uellix.rotating_role'),",
      "    current_setting('uellix.rotating_verifier'),",
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

function scramVerifier(pw) {
  const salt = randomBytes(16)
  const it = 4096
  const sp = pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, it, 32, 'sha256')
  const ck = createHmac('sha256', sp).update(${v('WRONG_KEY_LABEL', "'Client key'", "'Client Key'")}).digest()
  const sk = createHash('sha256').update(ck).digest()
  const svk = createHmac('sha256', sp).update('Server Key').digest()
  return 'SCRAM-SHA-256$' + it + ':' + salt.toString('base64') + '$' + sk.toString('base64') + ':' + svk.toString('base64')
}

function driverDigest(dir) {
  const root = fs.realpathSync(dir)
  const lines = []
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else lines.push(path.relative(root, p).split(path.sep).join('/') + ':' + createHash('sha256').update(fs.readFileSync(p)).digest('hex') + '\\n') } }
  walk(root)
  return createHash('sha256').update(lines.sort().join('')).digest('hex')
}

async function main() {
  const KNOWN = ['--driver-root=', '--driver-digest=', '--depositor=', '--valid-until=', '--target-host=', '--target-port=', '--target-database=', '--operator-principal=']
  for (const a of process.argv.slice(2)) if (!KNOWN.some((k) => a.startsWith(k))) { out({ refused: 'UNKNOWN_ARGUMENT' }); return 2 }
  const validUntil = argOf('--valid-until=') || ''
  if (!/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d{3})?Z$/.test(validUntil)) { out({ refused: 'VALID_UNTIL' }); return 2 }
  const targetHost = argOf('--target-host=') || ''
  const targetPort = argOf('--target-port=') || ''
  const targetDatabase = argOf('--target-database=') || ''
  if (targetHost === '' || targetPort === '' || targetDatabase === '') { out({ refused: 'NO_TARGET' }); return 2 }
  const adminUrl = process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  ${v('ADMIN_ENV_LEAKED_TO_DEPOSITOR', '', 'delete process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL')}
  if (!adminUrl) { out({ refused: 'NO_OPERATOR_CONNECTION' }); return 2 }
  const principal = argOf('--operator-principal=') || ''
  if (principal === '') { out({ refused: 'NO_OPERATOR_PRINCIPAL' }); return 2 }
  let u
  try { u = new URL(adminUrl) } catch { out({ refused: 'OPERATOR_CONNECTION_MALFORMED' }); return 2 }
  ${v('NO_QUERY_CHECK', '', "if (u.search !== '' || u.hash !== '') { out({ refused: 'OPERATOR_URL_HAS_STARTUP_PARAMETERS' }); return 2 }")}
  ${v('NO_TARGET_PIN', '', v('HOST_STARTSWITH', "if (!u.hostname.startsWith(targetHost)) { out({ refused: 'OPERATOR_TARGET_NOT_THE_PINNED_HOST' }); return 2 }", "if (u.hostname !== targetHost) { out({ refused: 'OPERATOR_TARGET_NOT_THE_PINNED_HOST' }); return 2 }"))}
  ${v('NO_PORT_CHECK', '', "if ((u.port || '5432') !== targetPort) { out({ refused: 'OPERATOR_PORT_NOT_THE_PINNED_PORT' }); return 2 }")}
  ${v('NO_DATABASE_CHECK', '', "if (decodeURIComponent(u.pathname.slice(1)) !== targetDatabase) { out({ refused: 'OPERATOR_DATABASE_NOT_THE_PINNED_DATABASE' }); return 2 }")}
  ${v('NO_PRINCIPAL_CHECK', '', "if (decodeURIComponent(u.username) !== principal) { out({ refused: 'OPERATOR_PRINCIPAL_NOT_THE_OBSERVED_ONE' }); return 2 }")}

  const driverRoot = argOf('--driver-root=') || ''
  let version = null
  try { version = JSON.parse(fs.readFileSync(path.join(driverRoot, 'node_modules', 'postgres', 'package.json'), 'utf8')).version } catch { version = null }
  ${v('NO_DRIVER_VERSION_CHECK', '', "if (version !== '3.4.9') { out({ refused: 'DRIVER_VERSION_NOT_ROUTE_B' }); return 2 }")}
  ${v('NO_DRIVER_DIGEST_CHECK', '', "if (driverDigest(path.join(driverRoot, 'node_modules', 'postgres')) !== (argOf('--driver-digest=') || '')) { out({ refused: 'DRIVER_DIGEST_NOT_PINNED' }); return 2 }")}
  const req = createRequire(path.join(driverRoot, 'package.json'))
  const postgres = req('postgres')
  // FAKE-ONLY GUARD: this fixture refuses every real driver.
  if (postgres.__UELLIX_CONTRACT_FAKE__ !== true) { out({ refused: 'FAKE_ONLY_FIXTURE' }); return 97 }

  const secret = randomBytes(32).toString('base64url')
  const verifier = scramVerifier(secret)
  const bound = ${v('PLAINTEXT_BOUND', 'secret', 'verifier')}
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
  const dsn = () => ['postgresql:', '//uellix_auditor:', secret, '@', targetHost, ':', targetPort, '/', targetDatabase].join('')
  ${v('HANDOFF_BEFORE_COMMIT', 'dep.stdin.write(dsn() + "\\n")', '')}

  const sql = ${v(
    'URL_CONSTRUCTED',
    "postgres(adminUrl, { max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })",
    "postgres({ host: u.hostname, port: Number(targetPort), database: targetDatabase, username: principal, password: decodeURIComponent(u.password), max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })"
  )}
  u = null
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
        "await tx.unsafe(\"SELECT set_config('uellix.rotating_verifier', '\" + bound + \"', true)\")",
        "await tx`SELECT set_config('uellix.rotating_verifier', ${bound}, true)`"
      )}
      await tx\`SELECT set_config('uellix.rotating_valid_until', \${${v('WRONG_VALID_UNTIL', "'2099-01-01T00:00:00.000Z'", 'validUntil')}}, true)\`
      await tx.unsafe(${v('LITERAL_IN_SQL', "DO_BLOCK.split(\"current_setting('uellix.rotating_verifier'),\").join(\"'\" + bound + \"',\")", 'DO_BLOCK')})
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
