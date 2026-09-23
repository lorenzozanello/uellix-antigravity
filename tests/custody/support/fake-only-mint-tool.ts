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

export function renderFakeOnlyMintTool(variant: ToolVariant = 'CONFORMING'): string {
  const v = (name: ToolVariant, yes: string, no: string): string => (variant === name ? yes : no)
  return `'use strict'
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const REF = 'bvyzblhqymxruxdguaee'
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
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const argOf = (k) => { const a = process.argv.slice(2).find((x) => x.startsWith(k)); return a === undefined ? undefined : a.slice(k.length) }

async function main() {
  const KNOWN = ['--driver-root=', '--depositor=', '--valid-until=']
  for (const a of process.argv.slice(2)) if (!KNOWN.some((k) => a.startsWith(k))) { out({ refused: 'UNKNOWN_ARGUMENT' }); return 2 }
  const validUntil = argOf('--valid-until=') || ''
  if (!/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d{3})?Z$/.test(validUntil)) { out({ refused: 'VALID_UNTIL' }); return 2 }
  const adminUrl = process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  ${v('ADMIN_ENV_LEAKED_TO_DEPOSITOR', '', 'delete process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL')}
  if (!adminUrl) { out({ refused: 'NO_OPERATOR_CONNECTION' }); return 2 }
  ${v('NO_TARGET_PIN', '', "if (new URL(adminUrl).hostname !== 'db.' + REF + '.supabase.co') { out({ refused: 'OPERATOR_TARGET_NOT_PINNED_DIRECT_HOST' }); return 2 }")}

  const req = createRequire(path.join(argOf('--driver-root=') || '', 'package.json'))
  const postgres = req('postgres')
  // FAKE-ONLY GUARD: this fixture refuses every real driver.
  if (postgres.__UELLIX_CONTRACT_FAKE__ !== true) { out({ refused: 'FAKE_ONLY_FIXTURE' }); return 97 }

  const secret = randomBytes(32).toString('base64url')
  ${v('SECRET_TO_TEMP_FILE', "fs.writeFileSync(path.join(process.env.TEMP || '.', 'staged.txt'), secret)", '')}
  ${v('SECRET_PRINTED', "out({ debug: secret })", '')}
  const childEnv = {}
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP']) if (process.env[k] !== undefined) childEnv[k] = process.env[k]
  ${v('ADMIN_ENV_LEAKED_TO_DEPOSITOR', "childEnv.UELLIX_D1_MINT_OPERATOR_DATABASE_URL = adminUrl", '')}
  const depArgs = [argOf('--depositor=')${v('SECRET_IN_DEPOSITOR_ARGV', ', secret', '')}]
  const dep = spawn(process.execPath, depArgs, { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv, windowsHide: false })
  let depOut = ''
  dep.stdout.setEncoding('utf8')
  dep.stdout.on('data', (c) => { depOut += c })
  const dsn = () => ['postgresql:', '//uellix_auditor:', secret, '@db.', REF, '.supabase.co:5432/postgres'].join('')
  ${v('HANDOFF_BEFORE_COMMIT', 'dep.stdin.write(dsn() + "\\n")', '')}

  const sql = postgres(adminUrl, { max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })
  let committed = false
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
    })
    committed = true
  } catch (e) {
    out({ mint: 'NOT_COMMITTED', code: e && e.code ? String(e.code) : 'UNKNOWN' })
  } finally {
    await sql.end({ timeout: 5 })
  }
  if (committed${v('HANDOFF_BEFORE_COMMIT', ' && false', '')}) dep.stdin.end(dsn() + '\\n')
  else dep.stdin.end()
  const code = await new Promise((r) => dep.on('close', r))
  let n30 = null
  try { n30 = JSON.parse(depOut.trim().split(/\\r?\\n/).pop() || 'null') } catch { n30 = null }
  out({ mint: committed ? 'COMMITTED' : 'NOT_COMMITTED', depositorExit: code, n30ExitMet: n30 && n30.n30ExitMet === true })
  return committed && code === 0 ? 0 : 1
}
main().then((c) => { process.exitCode = c }, () => { out({ aborted: true }); process.exitCode = 3 })
`
}
