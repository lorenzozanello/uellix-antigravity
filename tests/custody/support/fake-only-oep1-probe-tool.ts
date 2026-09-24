// tests/custody/support/fake-only-oep1-probe-tool.ts
//
// A FAKE-ONLY candidate for the OEP-1 probe harness, rendered to a file
// OUTSIDE the repository at test time. Right after it loads the driver it
// checks the fake marker and exits 97 on any real driver, so pointed at the
// real `postgres` package it refuses before constructing a client: the
// repository hosts no script that can reach a hosted target.
//
// Like the mint fixture it omits the run-time git-tree refusal (it is rendered
// under the OS temp directory, which on the authoring workstation is inside a
// git work tree); TOOL_INSIDE_GIT_TREE is measured on the real outside tool.
//
// Each non-conforming VARIANT breaks one PROBE_CONTRACT clause.

import { OEP1_EXTENSION_NAMES, OEP1_SETTINGS } from '@/db/custody/mint-operator-channel'

export type ProbeVariant =
  | 'CONFORMING'
  /** PC-1: the transaction is not opened READ ONLY. */
  | 'READ_WRITE'
  /** PC-2: one statement beyond the pinned three. */
  | 'EXTRA_STATEMENT'
  /** PC-2/PC-3: a statement through unsafe() that changes a setting. */
  | 'MUTATES_THROUGH_UNSAFE'
  /** PC-3: the source can spawn a process. */
  | 'SPAWNS_CHILD'
  /** PC-5: the operator URL is printed. */
  | 'PRINTS_URL'
  /** PC-4: the URL host is not compared with --target-host. */
  | 'NO_TARGET_PIN'
  /** PC-4: any driver version is accepted. */
  | 'NO_DRIVER_VERSION_CHECK'
  /** PC-2: the settings list bound is not the closed list. */
  | 'WRONG_SETTINGS_LIST'

export function renderFakeOnlyProbeTool(variant: ProbeVariant = 'CONFORMING'): string {
  const v = (name: ProbeVariant, yes: string, no: string): string => (variant === name ? yes : no)
  const settings = variant === 'WRONG_SETTINGS_LIST' ? OEP1_SETTINGS.filter((s) => s !== 'log_statement') : OEP1_SETTINGS
  return `'use strict'
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
${v('SPAWNS_CHILD', "const cp = require('node:child_process')", '')}
const SETTINGS = ${JSON.stringify(settings)}
const EXTENSIONS = ${JSON.stringify(OEP1_EXTENSION_NAMES)}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const argOf = (k) => { const a = process.argv.slice(2).find((x) => x.startsWith(k)); return a === undefined ? undefined : a.slice(k.length) }

async function main() {
  const KNOWN = ['--driver-root=', '--target-host=']
  for (const a of process.argv.slice(2)) if (!KNOWN.some((k) => a.startsWith(k))) { out({ refused: 'UNKNOWN_ARGUMENT' }); return 2 }
  const targetHost = argOf('--target-host=') || ''
  if (targetHost === '') { out({ refused: 'NO_TARGET_HOST' }); return 2 }
  const adminUrl = process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  delete process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  if (!adminUrl) { out({ refused: 'NO_OPERATOR_CONNECTION' }); return 2 }
  ${v('PRINTS_URL', 'out({ debug: adminUrl })', '')}
  ${v('NO_TARGET_PIN', '', "if (new URL(adminUrl).hostname !== targetHost) { out({ refused: 'OPERATOR_TARGET_NOT_THE_PINNED_HOST' }); return 2 }")}
  const driverRoot = argOf('--driver-root=') || ''
  let version = null
  try { version = JSON.parse(fs.readFileSync(path.join(driverRoot, 'node_modules', 'postgres', 'package.json'), 'utf8')).version } catch { version = null }
  ${v('NO_DRIVER_VERSION_CHECK', '', "if (version !== '3.4.9') { out({ refused: 'DRIVER_VERSION_NOT_ROUTE_B' }); return 2 }")}
  const postgres = createRequire(path.join(driverRoot, 'package.json'))('postgres')
  // FAKE-ONLY GUARD: this fixture refuses every real driver.
  if (postgres.__UELLIX_CONTRACT_FAKE__ !== true) { out({ refused: 'FAKE_ONLY_FIXTURE' }); return 97 }
  ${v('SPAWNS_CHILD', "cp.spawnSync(process.execPath, ['-e', ''])", '')}

  const sql = postgres(adminUrl, { max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })
  let observed = null
  try {
    observed = await sql.begin(${v('READ_WRITE', '', "'read only', ")}async (tx) => {
      const identity = await tx\`SELECT current_user AS current_user_name, session_user AS session_user_name\`
      const rows = await tx\`SELECT name, setting, source FROM pg_catalog.pg_settings WHERE name = ANY(\${SETTINGS}::text[]) ORDER BY name\`
      const extensions = await tx\`SELECT extname FROM pg_catalog.pg_extension WHERE extname = ANY(\${EXTENSIONS}::text[]) ORDER BY extname\`
      ${v('EXTRA_STATEMENT', 'await tx`SELECT 1`', '')}
      ${v('MUTATES_THROUGH_UNSAFE', "await tx.unsafe(\"SET log_statement = 'none'\")", '')}
      return { identity, rows, extensions }
    })
  } catch (e) {
    out({ probe: 'FAILED', code: e && e.code ? String(e.code) : 'UNKNOWN' })
    return 1
  } finally {
    try { await sql.end({ timeout: 5 }) } catch { /* read only */ }
  }
  const id = observed.identity[0] || {}
  out({
    probe: 'OBSERVED',
    identity: { current_user: String(id.current_user_name), session_user: String(id.session_user_name) },
    rows: observed.rows.map((r) => ({ name: String(r.name), setting: String(r.setting), source: String(r.source) })),
    extensions: observed.extensions.map((r) => String(r.extname)),
  })
  return 0
}
main().then((c) => { process.exitCode = c }, () => { out({ aborted: true }); process.exitCode = 3 })
`
}
