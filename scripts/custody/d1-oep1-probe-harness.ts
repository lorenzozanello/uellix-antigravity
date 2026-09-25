// scripts/custody/d1-oep1-probe-harness.ts
//
// MEASURE A CANDIDATE OEP-1 PROBE TOOL (OEP-1 v2) AGAINST ITS CONTRACT, WITHOUT
// A DATABASE, WITHOUT A REAL CREDENTIAL AND WITHOUT A REAL TARGET.
//
// The candidate is a file OUTSIDE the repository (the pinned probe tool, or a
// fake-only fixture in tests). The harness gives it a FAKE `postgres` driver
// that follows postgres.js's begin([options,] fn) shape, records every call
// with its bound parameters and the options it was constructed with, and
// answers the three pinned statements with canned rows; a synthetic operator
// URL naming an RFC 6761 `.invalid` host; and a working directory and TEMP of
// its own, searched after.
//
// PROBE_CONTRACT (PHASE 2 of OEP1_PROBE = C; only ever run through the certified channel):
//   PC-1  ONE transaction, opened READ ONLY; nothing outside it.
//   PC-2  exactly the three OEP1_PROBE_STATEMENTS, in order; the derived-material
//         list is the only bound parameter; nothing through unsafe().
//   PC-3  no child process, no generated value, no mutation text: the tool's
//         source carries none of the tokens a mint or a write needs.
//   PC-4  the session is bound and its startup closed BEFORE any driver call: no
//         query/fragment, exact host, port, database; driver version 3.4.9 and
//         files = --driver-digest; the driver built from explicit options.
//   PC-5  one non-secret output line: the identity, the client-sourced settings
//         and the derived-material settings, exactly as observed; the URL and its
//         password never appear in output or files.
//   PC-6  a failing statement ends in ROLLBACK, a non-zero exit and a FAILED line.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { OEP1_DERIVED_MATERIAL_SETTINGS, OEP1_EXPECTED_CLIENT_SETTINGS, OEP1_PROBE_STATEMENTS, OPERATOR_ENV_VAR_NAME, ROUTE_B_DRIVER, driverDigest } from '../../db/custody/mint-operator-channel'
import { ROUTE_B_DATABASE, ROUTE_B_PORT } from '../../db/custody/mint-route-b-contract'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { ALLOWED_DRIVER_OPTION_KEYS, FAKE_DRIVER_SSL_SHAPE, HOSTILE_AMBIENT_ENV, sslShapeReasons, writeHarnessCa } from './d1-mint-tool-contract-harness'

export type ProbeScenario =
  | 'SUCCESS'
  | 'QUERY_FAILS'
  | 'UNPINNED_TARGET'
  | 'HOST_LOOKALIKE'
  | 'URL_WITH_QUERY'
  | 'WRONG_DATABASE'
  | 'WRONG_PORT'
  | 'WRONG_DRIVER_VERSION'
  | 'DRIVER_DIGEST_MISMATCH'
  | 'TOOL_INSIDE_GIT_TREE'
  | 'CA_MISSING'
  | 'CA_MODIFIED'
  | 'AMBIENT_PG_ENV'
type State = 'PASSED' | 'FAILED'

export const PROBE_REFUSAL_SCENARIOS: readonly ProbeScenario[] = ['UNPINNED_TARGET', 'HOST_LOOKALIKE', 'URL_WITH_QUERY', 'WRONG_DATABASE', 'WRONG_PORT', 'WRONG_DRIVER_VERSION', 'DRIVER_DIGEST_MISMATCH', 'TOOL_INSIDE_GIT_TREE', 'CA_MISSING', 'CA_MODIFIED', 'AMBIENT_PG_ENV']

export const PROBE_HARNESS_TARGET_HOST = 'db.probe-harness-target.invalid'
const OTHER_HOST = 'db.probe-harness-other.invalid'
const LOOKALIKE_HOST = `${PROBE_HARNESS_TARGET_HOST}.lookalike.invalid`
export const PROBE_HARNESS_PRINCIPAL = 'postgres'

/** The canned identity the fake driver answers with. */
export const CANNED_IDENTITY = { current_user_name: PROBE_HARNESS_PRINCIPAL, session_user_name: PROBE_HARNESS_PRINCIPAL, database_name: ROUTE_B_DATABASE, server_version_num: '170006' }
/** The canned client-sourced settings: exactly the measured postgres.js set. */
export const CANNED_CLIENT_ROWS = OEP1_EXPECTED_CLIENT_SETTINGS.map(([name, setting]) => ({ name, setting }))
/** The canned derived-material settings: a posture with no known emitter on (NOT_INDICATED). */
export const CANNED_DERIVED_ROWS: readonly { name: string; setting: string; source: string }[] = OEP1_DERIVED_MATERIAL_SETTINGS.filter((n) => !n.includes('.')).map((name) => ({
  name,
  setting: name === 'log_statement' ? 'none' : name === 'log_min_duration_statement' ? '-1' : name === 'log_min_error_statement' ? 'error' : name === 'shared_preload_libraries' ? 'pg_stat_statements' : 'off',
  source: 'default',
}))

/** Exported for the operator-channel PEB demonstration. A HOLD file (ms) keeps the transaction open so an external observer can see the tool. */
export const FAKE_PROBE_DRIVER = `'use strict'
const fs = require('node:fs'); const path = require('node:path')
const LOG = path.join(__dirname, 'driver-log.jsonl')
const rec = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\\n')
const CANNED = JSON.parse(fs.readFileSync(path.join(__dirname, 'canned.json'), 'utf8'))
const flag = (n) => fs.existsSync(path.join(__dirname, n))
${FAKE_DRIVER_SSL_SHAPE}
// A canned server whose chain verifies to the ONE CA the tool pinned: the driver hands its
// peer certificate to the tool's checkServerIdentity the way node:tls does after a verified
// chain (leaf -> issuer -> self-signed anchor), so the probe can report what it observed.
const presentChain = (o) => {
  const s = o && o.ssl
  if (!s || typeof s !== 'object' || typeof s.checkServerIdentity !== 'function') return { called: false }
  const { X509Certificate, createHash } = require('node:crypto')
  const fp = (b) => createHash('sha256').update(b).digest('hex').toUpperCase().match(/../g).join(':')
  const anchor = Array.isArray(s.ca) && s.ca.length === 1 ? { fingerprint256: new X509Certificate(s.ca[0]).fingerprint256 } : { fingerprint256: fp('no pinned anchor') }
  anchor.issuerCertificate = anchor
  const leaf = { subject: { CN: o.host }, subjectaltname: 'DNS:' + o.host, fingerprint256: fp('leaf:' + o.host), issuerCertificate: anchor }
  const err = s.checkServerIdentity(o.host, leaf)
  return { called: true, rejected: err !== undefined }
}
module.exports = function postgres(a, b) {
  if (typeof a === 'string') rec({ event: 'construct', form: 'url', host: new URL(a).hostname, query: new URL(a).search, ssl: sslShape(b && b.ssl), keys: Object.keys(b || {}).sort(), connection: (b && b.connection) || null })
  else rec({ event: 'construct', form: 'options', host: a.host, port: a.port, database: a.database, username: a.username, ssl: sslShape(a.ssl), prepare: a.prepare, keys: Object.keys(a).sort(), connection: a.connection || null, tls: presentChain(a) })
  const q = (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + (i ? '$' + i : '') + s, '')
    rec({ event: 'query', text, params: values })
    if (flag('FAIL_CLIENT') && text.includes("source = 'client'")) return Promise.reject(Object.assign(new Error('fake failure'), { code: '42501' }))
    const hit = CANNED.find((c) => c.text === text)
    return Promise.resolve(hit ? hit.rows : [])
  }
  q.unsafe = (text, params) => { rec({ event: 'unsafe', text, params: params || [] }); return Promise.resolve([]) }
  return {
    begin: async (x, y) => {
      const fn = typeof x === 'function' ? x : y
      const mode = typeof x === 'string' ? x : null
      rec({ event: 'BEGIN', mode })
      let r
      try { r = await fn(q) } catch (e) { rec({ event: 'ROLLBACK' }); throw e }
      if (flag('HOLD')) await new Promise((res) => setTimeout(res, Number(fs.readFileSync(path.join(__dirname, 'HOLD'), 'utf8'))))
      rec({ event: 'COMMIT' })
      return r
    },
    unsafe: q.unsafe,
    end: async () => { rec({ event: 'end' }) },
  }
}
module.exports.__UELLIX_CONTRACT_FAKE__ = true
`

/** Tokens no probe source may carry (PC-3): a spawn, a generated value, a write, a mint, an unsafe statement. */
export const PROBE_FORBIDDEN_SOURCE_TOKENS = ['child_process', 'randomBytes', 'getRandomValues', 'writeFile', 'appendFile', 'set_config', 'ALTER ', 'DO $', '.unsafe(', 'INSERT ', 'UPDATE ', 'DELETE ', 'TRUNCATE', 'GRANT ', 'REVOKE ']

/** Write the canned answers for the three pinned statements next to a fake probe driver. */
export function writeCannedProbeAnswers(driverDir: string): void {
  writeFileSync(
    join(driverDir, 'canned.json'),
    JSON.stringify([
      { text: OEP1_PROBE_STATEMENTS.IDENTITY, rows: [CANNED_IDENTITY] },
      { text: OEP1_PROBE_STATEMENTS.CLIENT_SETTINGS, rows: CANNED_CLIENT_ROWS },
      { text: OEP1_PROBE_STATEMENTS.DERIVED_MATERIAL_SETTINGS, rows: CANNED_DERIVED_ROWS },
    ])
  )
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

export interface ProbeHarnessResult {
  readonly scenario: ProbeScenario
  readonly checks: Readonly<Record<string, State>>
  readonly overall: 'CONFORMS' | 'DOES_NOT_CONFORM'
  readonly toolExit: number | null
}

export function runOep1ProbeHarness(params: { readonly repoRoot: string; readonly toolPath: string; readonly workRoot: string; readonly scenario: ProbeScenario }): ProbeHarnessResult {
  const checks: Record<string, State> = {}
  const pf = (b: boolean): State => (b ? 'PASSED' : 'FAILED')
  const work = resolvePath(params.workRoot)
  if (isInsideRepositoryTree(params.repoRoot, work)) throw new Error('The harness work root must be outside the repository.')
  checks.OUTSIDE_REPOSITORY = pf(!isInsideRepositoryTree(params.repoRoot, resolvePath(params.toolPath)))
  const source = readFileSync(resolvePath(params.toolPath), 'utf8')
  checks.SOURCE_INERT = pf(PROBE_FORBIDDEN_SOURCE_TOKENS.every((t) => !source.includes(t)))

  const driverRoot = join(work, 'driver-root')
  const driverDir = join(driverRoot, 'node_modules', 'postgres')
  const cwd = join(work, 'cwd')
  const temp = join(work, 'temp')
  for (const d of [driverDir, cwd, temp]) mkdirSync(d, { recursive: true })
  writeFileSync(join(driverRoot, 'package.json'), '{"name":"probe-harness-driver-root","private":true}')
  writeFileSync(join(driverDir, 'package.json'), JSON.stringify({ name: 'postgres', main: 'index.js', version: params.scenario === 'WRONG_DRIVER_VERSION' ? '3.4.8' : ROUTE_B_DRIVER.version }))
  writeFileSync(join(driverDir, 'index.js'), FAKE_PROBE_DRIVER)
  writeCannedProbeAnswers(driverDir)
  if (params.scenario === 'QUERY_FAILS') writeFileSync(join(driverDir, 'FAIL_CLIENT'), '')
  const pinnedDriverDigest = params.scenario === 'DRIVER_DIGEST_MISMATCH' ? '0'.repeat(64) : driverDigest(driverDir)
  const trust = writeHarnessCa(join(work, 'trust'), params.scenario)

  const adminPassword = `probe-harness-${Date.now().toString(36)}-synthetic`
  const host = params.scenario === 'UNPINNED_TARGET' ? OTHER_HOST : params.scenario === 'HOST_LOOKALIKE' ? LOOKALIKE_HOST : PROBE_HARNESS_TARGET_HOST
  const database = params.scenario === 'WRONG_DATABASE' ? 'template1' : ROUTE_B_DATABASE
  const port = params.scenario === 'WRONG_PORT' ? 6543 : ROUTE_B_PORT
  const query = params.scenario === 'URL_WITH_QUERY' ? '?debug_print_parse=on' : ''
  const adminUrl = ['postgresql:', `//${PROBE_HARNESS_PRINCIPAL}:`, adminPassword, '@', host, `:${port}/${database}${query}`].join('')
  const env: Record<string, string> = { [OPERATOR_ENV_VAR_NAME]: adminUrl, TEMP: temp, TMP: temp, ...(params.scenario === 'AMBIENT_PG_ENV' ? HOSTILE_AMBIENT_ENV : {}) }
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path']) {
    const val = process.env[k]
    if (val !== undefined) env[k] = val
  }
  let toolToRun = resolvePath(params.toolPath)
  if (params.scenario === 'TOOL_INSIDE_GIT_TREE') {
    const gitTree = join(work, 'in-git-tree')
    mkdirSync(join(gitTree, '.git'), { recursive: true })
    toolToRun = join(gitTree, 'probe.js')
    writeFileSync(toolToRun, source)
  }
  const run = spawnSync(
    process.execPath,
    [toolToRun, `--driver-root=${driverRoot}`, `--driver-digest=${pinnedDriverDigest}`, `--target-host=${PROBE_HARNESS_TARGET_HOST}`, `--target-port=${ROUTE_B_PORT}`, `--target-database=${ROUTE_B_DATABASE}`, `--ca-file=${trust.caFile}`, `--ca-sha256=${trust.caSha256}`],
    { cwd, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000, windowsHide: true }
  )
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const leaks = (t: string): boolean => t.includes(adminPassword) || t.includes(adminUrl)
  const log = join(driverDir, 'driver-log.jsonl')
  const events = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; text?: string; params?: unknown[]; mode?: string | null; ssl?: unknown; form?: string; host?: string; port?: unknown; database?: unknown; username?: unknown; keys?: string[]; connection?: unknown })
    : []
  checks.OUTPUT_CLEAN = pf(!leaks(output))
  checks.FILES_CLEAN = pf([...filesUnder(cwd), ...filesUnder(temp)].every((f) => !leaks(readFileSync(f, 'latin1'))))

  if ((PROBE_REFUSAL_SCENARIOS as readonly string[]).includes(params.scenario)) {
    checks[`REFUSES_${params.scenario}`] = pf(run.status !== 0 && events.length === 0)
  } else {
    const shape = events.map((e) => (e.event === 'query' || e.event === 'unsafe' ? `${e.event}:${e.text}` : e.event === 'BEGIN' ? `BEGIN:${e.mode ?? '(read write)'}` : e.event))
    const s = OEP1_PROBE_STATEMENTS
    const expected =
      params.scenario === 'SUCCESS'
        ? ['construct', 'BEGIN:read only', `query:${s.IDENTITY}`, `query:${s.CLIENT_SETTINGS}`, `query:${s.DERIVED_MATERIAL_SETTINGS}`, 'COMMIT', 'end']
        : ['construct', 'BEGIN:read only', `query:${s.IDENTITY}`, `query:${s.CLIENT_SETTINGS}`, 'ROLLBACK', 'end']
    checks.SEQUENCE = pf(JSON.stringify(shape) === JSON.stringify(expected))
    checks.TLS_VERIFY_FULL_PINNED = pf(sslShapeReasons(events[0]?.ssl, PROBE_HARNESS_TARGET_HOST, trust.caSha256).length === 0)
    const c = events[0]
    checks.STARTUP_CLOSED = pf(
      c !== undefined &&
        c.form === 'options' &&
        c.host === PROBE_HARNESS_TARGET_HOST &&
        c.port === ROUTE_B_PORT &&
        c.database === ROUTE_B_DATABASE &&
        c.username === PROBE_HARNESS_PRINCIPAL &&
        c.connection === null &&
        (c.keys ?? []).every((k) => (ALLOWED_DRIVER_OPTION_KEYS as readonly string[]).includes(k))
    )
    checks.READ_ONLY_ONLY = pf(events.filter((e) => e.event === 'BEGIN').length === 1 && events.every((e) => e.event !== 'BEGIN' || e.mode === 'read only'))
    checks.NO_UNSAFE = pf(events.every((e) => e.event !== 'unsafe'))
    const idQ = events.find((e) => e.text === s.IDENTITY)
    const clQ = events.find((e) => e.text === s.CLIENT_SETTINGS)
    const dmQ = events.find((e) => e.text === s.DERIVED_MATERIAL_SETTINGS)
    checks.CLOSED_LISTS_BOUND = pf(
      (idQ?.params?.length ?? -1) === 0 && (clQ?.params?.length ?? -1) === 0 && (params.scenario !== 'SUCCESS' || JSON.stringify(dmQ?.params) === JSON.stringify([OEP1_DERIVED_MATERIAL_SETTINGS]))
    )
    const lines = (run.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '')
    if (params.scenario === 'SUCCESS') {
      type Observed = { probe?: string; identity?: unknown; client_settings?: unknown; derived_settings?: unknown; connection?: { host?: unknown; port?: unknown; database?: unknown; user?: unknown; tls?: { verified?: unknown; peer_sha256?: unknown; anchor_sha256?: unknown }; driver_digest?: unknown } }
      const parseOne = (): Observed | null => {
        try {
          return lines.length === 1 ? (JSON.parse(lines[0]!) as Observed) : null
        } catch {
          return null
        }
      }
      const parsed = parseOne()
      checks.OUTPUT_IS_THE_OBSERVATION = pf(
        parsed !== null &&
          parsed.probe === 'OBSERVED' &&
          JSON.stringify(parsed.identity) === JSON.stringify({ current_user: PROBE_HARNESS_PRINCIPAL, session_user: PROBE_HARNESS_PRINCIPAL, database: ROUTE_B_DATABASE, server_version_num: '170006' }) &&
          JSON.stringify(parsed.client_settings) === JSON.stringify(OEP1_EXPECTED_CLIENT_SETTINGS) &&
          JSON.stringify(parsed.derived_settings) === JSON.stringify(CANNED_DERIVED_ROWS)
      )
      // F: the connection the probe OBSERVED -- the verified peer and the anchor its verification reached, and
      // the driver digest of the files it loaded -- not the planned values echoed back.
      const cn = parsed?.connection
      checks.OUTPUT_CARRIES_THE_OBSERVED_CONNECTION = pf(
        cn !== undefined &&
          cn.host === PROBE_HARNESS_TARGET_HOST &&
          cn.port === ROUTE_B_PORT &&
          cn.database === ROUTE_B_DATABASE &&
          cn.user === PROBE_HARNESS_PRINCIPAL &&
          cn.tls?.verified === true &&
          typeof cn.tls.peer_sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(cn.tls.peer_sha256) &&
          cn.tls.anchor_sha256 === trust.anchorSha256 &&
          cn.driver_digest === pinnedDriverDigest
      )
      checks.EXIT = pf(run.status === 0)
    } else {
      checks.FAILED_LINE = pf(lines.some((l) => l.includes('"probe":"FAILED"')))
      checks.EXIT = pf(run.status !== 0)
    }
  }
  const overall = Object.values(checks).every((st) => st === 'PASSED') ? 'CONFORMS' : 'DOES_NOT_CONFORM'
  return { scenario: params.scenario, checks, overall, toolExit: run.status }
}
