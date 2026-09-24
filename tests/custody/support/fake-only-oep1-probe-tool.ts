// tests/custody/support/fake-only-oep1-probe-tool.ts
//
// A FAKE-ONLY candidate for the OEP-1 probe harness (OEP-1 v2), rendered to a
// file OUTSIDE the repository at test time. Right after it loads the driver it
// checks the fake marker and exits 97 on any real driver, so pointed at the
// real `postgres` package it refuses before constructing a client: the
// repository hosts no script that can reach a hosted target.
//
// Like the mint fixture it omits the run-time git-tree refusal (it is rendered
// under the OS temp directory, which on the authoring workstation is inside a
// git work tree); TOOL_INSIDE_GIT_TREE is measured on the real outside tool.
//
// Each non-conforming VARIANT breaks one PROBE_CONTRACT clause.

import { OEP1_DERIVED_MATERIAL_SETTINGS } from '@/db/custody/mint-operator-channel'

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
  /** PC-4: the host is compared with startsWith. */
  | 'HOST_STARTSWITH'
  /** PC-4: a query in the URL is not refused. */
  | 'NO_QUERY_CHECK'
  /** PC-4: the database is not compared. */
  | 'NO_DATABASE_CHECK'
  | 'NO_PORT_CHECK'
  /** PC-4: any driver version is accepted. */
  | 'NO_DRIVER_VERSION_CHECK'
  /** PC-4: the driver files are not compared with --driver-digest. */
  | 'NO_DRIVER_DIGEST_CHECK'
  /** PC-4: the driver is built from the URL (its query becomes startup GUCs). */
  | 'URL_CONSTRUCTED'
  /** PC-2: the derived-material list bound is not the stated one. */
  | 'WRONG_SETTINGS_LIST'

export function renderFakeOnlyProbeTool(variant: ProbeVariant = 'CONFORMING'): string {
  const v = (name: ProbeVariant, yes: string, no: string): string => (variant === name ? yes : no)
  const settings = variant === 'WRONG_SETTINGS_LIST' ? OEP1_DERIVED_MATERIAL_SETTINGS.filter((s) => s !== 'log_statement') : OEP1_DERIVED_MATERIAL_SETTINGS
  return `'use strict'
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
${v('SPAWNS_CHILD', "const cp = require('node:child_process')", '')}
const DERIVED = ${JSON.stringify(settings)}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const argOf = (k) => { const a = process.argv.slice(2).find((x) => x.startsWith(k)); return a === undefined ? undefined : a.slice(k.length) }

function driverDigest(dir) {
  const root = fs.realpathSync(dir)
  const lines = []
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else lines.push(path.relative(root, p).split(path.sep).join('/') + ':' + createHash('sha256').update(fs.readFileSync(p)).digest('hex') + '\\n') } }
  walk(root)
  return createHash('sha256').update(lines.sort().join('')).digest('hex')
}

async function main() {
  const KNOWN = ['--driver-root=', '--driver-digest=', '--target-host=', '--target-port=', '--target-database=']
  for (const a of process.argv.slice(2)) if (!KNOWN.some((k) => a.startsWith(k))) { out({ refused: 'UNKNOWN_ARGUMENT' }); return 2 }
  const targetHost = argOf('--target-host=') || ''
  const targetPort = argOf('--target-port=') || ''
  const targetDatabase = argOf('--target-database=') || ''
  if (targetHost === '' || targetPort === '' || targetDatabase === '') { out({ refused: 'NO_TARGET' }); return 2 }
  const adminUrl = process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  delete process.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL
  if (!adminUrl) { out({ refused: 'NO_OPERATOR_CONNECTION' }); return 2 }
  ${v('PRINTS_URL', 'out({ debug: adminUrl })', '')}
  let u
  try { u = new URL(adminUrl) } catch { out({ refused: 'OPERATOR_CONNECTION_MALFORMED' }); return 2 }
  ${v('NO_QUERY_CHECK', '', "if (u.search !== '' || u.hash !== '') { out({ refused: 'OPERATOR_URL_HAS_STARTUP_PARAMETERS' }); return 2 }")}
  ${v('NO_TARGET_PIN', '', v('HOST_STARTSWITH', "if (!u.hostname.startsWith(targetHost)) { out({ refused: 'OPERATOR_TARGET_NOT_THE_PINNED_HOST' }); return 2 }", "if (u.hostname !== targetHost) { out({ refused: 'OPERATOR_TARGET_NOT_THE_PINNED_HOST' }); return 2 }"))}
  ${v('NO_PORT_CHECK', '', "if ((u.port || '5432') !== targetPort) { out({ refused: 'OPERATOR_PORT_NOT_THE_PINNED_PORT' }); return 2 }")}
  ${v('NO_DATABASE_CHECK', '', "if (decodeURIComponent(u.pathname.slice(1)) !== targetDatabase) { out({ refused: 'OPERATOR_DATABASE_NOT_THE_PINNED_DATABASE' }); return 2 }")}
  const driverRoot = argOf('--driver-root=') || ''
  let version = null
  try { version = JSON.parse(fs.readFileSync(path.join(driverRoot, 'node_modules', 'postgres', 'package.json'), 'utf8')).version } catch { version = null }
  ${v('NO_DRIVER_VERSION_CHECK', '', "if (version !== '3.4.9') { out({ refused: 'DRIVER_VERSION_NOT_ROUTE_B' }); return 2 }")}
  ${v('NO_DRIVER_DIGEST_CHECK', '', "if (driverDigest(path.join(driverRoot, 'node_modules', 'postgres')) !== (argOf('--driver-digest=') || '')) { out({ refused: 'DRIVER_DIGEST_NOT_PINNED' }); return 2 }")}
  const postgres = createRequire(path.join(driverRoot, 'package.json'))('postgres')
  // FAKE-ONLY GUARD: this fixture refuses every real driver.
  if (postgres.__UELLIX_CONTRACT_FAKE__ !== true) { out({ refused: 'FAKE_ONLY_FIXTURE' }); return 97 }
  ${v('SPAWNS_CHILD', "cp.spawnSync(process.execPath, ['-e', ''])", '')}

  const sql = ${v(
    'URL_CONSTRUCTED',
    "postgres(adminUrl, { max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })",
    "postgres({ host: u.hostname, port: Number(targetPort), database: targetDatabase, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 1, prepare: false, ssl: 'require', onnotice: () => undefined })"
  )}
  u = null
  let observed = null
  try {
    observed = await sql.begin(${v('READ_WRITE', '', "'read only', ")}async (tx) => {
      const identity = await tx\`SELECT current_user AS current_user_name, session_user AS session_user_name, current_database() AS database_name, current_setting('server_version_num') AS server_version_num\`
      const client = await tx\`SELECT name, setting FROM pg_catalog.pg_settings WHERE source = 'client' ORDER BY name\`
      const derived = await tx\`SELECT name, setting, source FROM pg_catalog.pg_settings WHERE name = ANY(\${DERIVED}::text[]) ORDER BY name\`
      ${v('EXTRA_STATEMENT', 'await tx`SELECT 1`', '')}
      ${v('MUTATES_THROUGH_UNSAFE', "await tx.unsafe(\"SET log_statement = 'none'\")", '')}
      return { identity, client, derived }
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
    identity: { current_user: String(id.current_user_name), session_user: String(id.session_user_name), database: String(id.database_name), server_version_num: String(id.server_version_num) },
    client_settings: observed.client.map((r) => [String(r.name), String(r.setting)]),
    derived_settings: observed.derived.map((r) => ({ name: String(r.name), setting: String(r.setting), source: String(r.source) })),
  })
  return 0
}
main().then((c) => { process.exitCode = c }, () => { out({ aborted: true }); process.exitCode = 3 })
`
}
