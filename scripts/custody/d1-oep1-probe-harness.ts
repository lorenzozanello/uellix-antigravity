// scripts/custody/d1-oep1-probe-harness.ts
//
// MEASURE A CANDIDATE OEP-1 PROBE TOOL AGAINST ITS CONTRACT, WITHOUT A
// DATABASE, WITHOUT A REAL CREDENTIAL AND WITHOUT A REAL TARGET.
//
// The candidate is a file OUTSIDE the repository (the pinned probe tool, or a
// fake-only fixture in tests). The harness gives it a FAKE `postgres` driver
// that follows postgres.js's begin([options,] fn) shape, records every call
// with its bound parameters, and answers the three pinned statements with
// canned rows; a synthetic operator URL naming an RFC 6761 `.invalid` host;
// and a working directory and TEMP of its own, searched after.
//
// PROBE_CONTRACT (the probe is PHASE 2 of OEP1_PROBE = C; it is only ever run
// through the certified channel):
//   PC-1  ONE transaction, opened READ ONLY; nothing outside it.
//   PC-2  exactly the three OEP1_PROBE_STATEMENTS, in order, with the closed
//         lists as their only bound parameters; nothing through unsafe().
//   PC-3  no child process, no generated value, no mutation text: the tool's
//         source carries none of the tokens a mint or a write needs.
//   PC-4  the operator URL must name --target-host, and the driver at
//         --driver-root must be postgres 3.4.9, BEFORE any driver call.
//   PC-5  one non-secret output line: the identity names and the rows, exactly
//         as observed; the URL and its password never appear in output or files.
//   PC-6  a failing statement ends in ROLLBACK, a non-zero exit and a FAILED line.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { OEP1_EXTENSION_NAMES, OEP1_PROBE_STATEMENTS, OEP1_SETTINGS, OPERATOR_ENV_VAR_NAME, ROUTE_B_DRIVER } from '../../db/custody/mint-operator-channel'
import { isInsideRepositoryTree } from './build-sentinel-consumer'

export type ProbeScenario = 'SUCCESS' | 'UNPINNED_TARGET' | 'WRONG_DRIVER_VERSION' | 'QUERY_FAILS' | 'TOOL_INSIDE_GIT_TREE'
type State = 'PASSED' | 'FAILED'

export const PROBE_HARNESS_TARGET_HOST = 'db.probe-harness-target.invalid'
const OTHER_HOST = 'db.probe-harness-other.invalid'
export const PROBE_HARNESS_PRINCIPAL = 'postgres'

/** The canned posture the fake driver answers with: a SAFE one, so evaluateOep1 of it is PASS. */
export const CANNED_SAFE_ROWS: readonly { name: string; setting: string; source: string }[] = [
  { name: 'debug_print_parse', setting: 'off', source: 'default' },
  { name: 'debug_print_plan', setting: 'off', source: 'default' },
  { name: 'debug_print_rewritten', setting: 'off', source: 'default' },
  { name: 'local_preload_libraries', setting: '', source: 'default' },
  { name: 'log_min_duration_sample', setting: '-1', source: 'default' },
  { name: 'log_min_duration_statement', setting: '-1', source: 'default' },
  { name: 'log_min_error_statement', setting: 'error', source: 'default' },
  { name: 'log_parameter_max_length', setting: '-1', source: 'default' },
  { name: 'log_parameter_max_length_on_error', setting: '0', source: 'default' },
  { name: 'log_statement', setting: 'ddl', source: 'configuration file' },
  { name: 'log_statement_sample_rate', setting: '1', source: 'default' },
  { name: 'log_transaction_sample_rate', setting: '0', source: 'default' },
  { name: 'pg_stat_statements.track', setting: 'top', source: 'default' },
  { name: 'pg_stat_statements.track_utility', setting: 'on', source: 'default' },
  { name: 'session_preload_libraries', setting: '', source: 'default' },
  { name: 'shared_preload_libraries', setting: 'pg_stat_statements', source: 'configuration file' },
].sort((a, b) => a.name.localeCompare(b.name))

/** Exported for the operator-channel PEB demonstration. A HOLD file (ms) keeps the transaction open so an external observer can see the tool. */
export const FAKE_PROBE_DRIVER = `'use strict'
const fs = require('node:fs'); const path = require('node:path')
const LOG = path.join(__dirname, 'driver-log.jsonl')
const rec = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\\n')
const CANNED = JSON.parse(fs.readFileSync(path.join(__dirname, 'canned.json'), 'utf8'))
const flag = (n) => fs.existsSync(path.join(__dirname, n))
module.exports = function postgres(url, opts) {
  rec({ event: 'construct', host: new URL(url).hostname, ssl: opts && opts.ssl, prepare: opts && opts.prepare })
  const q = (strings, ...values) => {
    const text = strings.reduce((a, s, i) => a + (i ? '$' + i : '') + s, '')
    rec({ event: 'query', text, params: values })
    if (flag('FAIL_SETTINGS') && text.includes('pg_settings')) return Promise.reject(Object.assign(new Error('fake failure'), { code: '42501' }))
    const hit = CANNED.find((c) => c.text === text)
    return Promise.resolve(hit ? hit.rows : [])
  }
  q.unsafe = (text, params) => { rec({ event: 'unsafe', text, params: params || [] }); return Promise.resolve([]) }
  return {
    begin: async (a, b) => {
      const fn = typeof a === 'function' ? a : b
      const mode = typeof a === 'string' ? a : null
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
  const identityRow = { current_user_name: PROBE_HARNESS_PRINCIPAL, session_user_name: PROBE_HARNESS_PRINCIPAL }
  const canned = [
    { text: OEP1_PROBE_STATEMENTS.IDENTITY, rows: [identityRow] },
    { text: OEP1_PROBE_STATEMENTS.SETTINGS, rows: CANNED_SAFE_ROWS },
    { text: OEP1_PROBE_STATEMENTS.EXTENSIONS, rows: [{ extname: 'pg_stat_statements' }] },
  ]
  writeFileSync(join(driverDir, 'canned.json'), JSON.stringify(canned))
  if (params.scenario === 'QUERY_FAILS') writeFileSync(join(driverDir, 'FAIL_SETTINGS'), '')

  const adminPassword = `probe-harness-${Date.now().toString(36)}-synthetic`
  const host = params.scenario === 'UNPINNED_TARGET' ? OTHER_HOST : PROBE_HARNESS_TARGET_HOST
  const adminUrl = ['postgresql:', `//${PROBE_HARNESS_PRINCIPAL}:`, adminPassword, '@', host, ':5432/postgres'].join('')
  const env: Record<string, string> = { [OPERATOR_ENV_VAR_NAME]: adminUrl, TEMP: temp, TMP: temp }
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
  const run = spawnSync(process.execPath, [toolToRun, `--driver-root=${driverRoot}`, `--target-host=${PROBE_HARNESS_TARGET_HOST}`], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const leaks = (t: string): boolean => t.includes(adminPassword) || t.includes(adminUrl)
  const log = join(driverDir, 'driver-log.jsonl')
  const events = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; text?: string; params?: unknown[]; mode?: string | null; ssl?: unknown })
    : []
  checks.OUTPUT_CLEAN = pf(!leaks(output))
  checks.FILES_CLEAN = pf([...filesUnder(cwd), ...filesUnder(temp)].every((f) => !leaks(readFileSync(f, 'latin1'))))

  if (params.scenario === 'UNPINNED_TARGET' || params.scenario === 'WRONG_DRIVER_VERSION' || params.scenario === 'TOOL_INSIDE_GIT_TREE') {
    checks[`REFUSES_${params.scenario}`] = pf(run.status !== 0 && events.length === 0)
  } else {
    const shape = events.map((e) => (e.event === 'query' || e.event === 'unsafe' ? `${e.event}:${e.text}` : e.event === 'BEGIN' ? `BEGIN:${e.mode ?? '(read write)'}` : e.event))
    const statements = [`query:${OEP1_PROBE_STATEMENTS.IDENTITY}`, `query:${OEP1_PROBE_STATEMENTS.SETTINGS}`, `query:${OEP1_PROBE_STATEMENTS.EXTENSIONS}`]
    const expected =
      params.scenario === 'SUCCESS'
        ? ['construct', 'BEGIN:read only', ...statements, 'COMMIT', 'end']
        : ['construct', 'BEGIN:read only', statements[0]!, statements[1]!, 'ROLLBACK', 'end']
    checks.SEQUENCE = pf(JSON.stringify(shape) === JSON.stringify(expected))
    checks.TLS_REQUIRED = pf(events[0]?.ssl === 'require')
    checks.READ_ONLY_ONLY = pf(events.filter((e) => e.event === 'BEGIN').length === 1 && events.every((e) => e.event !== 'BEGIN' || e.mode === 'read only'))
    checks.NO_UNSAFE = pf(events.every((e) => e.event !== 'unsafe'))
    const idQ = events.find((e) => e.text === OEP1_PROBE_STATEMENTS.IDENTITY)
    const setQ = events.find((e) => e.text === OEP1_PROBE_STATEMENTS.SETTINGS)
    const extQ = events.find((e) => e.text === OEP1_PROBE_STATEMENTS.EXTENSIONS)
    checks.CLOSED_LISTS_BOUND = pf(
      (idQ?.params?.length ?? -1) === 0 &&
        JSON.stringify(setQ?.params) === JSON.stringify([OEP1_SETTINGS]) &&
        (params.scenario !== 'SUCCESS' || JSON.stringify(extQ?.params) === JSON.stringify([OEP1_EXTENSION_NAMES]))
    )
    const lines = (run.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '')
    if (params.scenario === 'SUCCESS') {
      type Observed = { probe?: string; identity?: unknown; rows?: unknown; extensions?: unknown }
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
          JSON.stringify(parsed.identity) === JSON.stringify({ current_user: PROBE_HARNESS_PRINCIPAL, session_user: PROBE_HARNESS_PRINCIPAL }) &&
          JSON.stringify(parsed.rows) === JSON.stringify(CANNED_SAFE_ROWS) &&
          JSON.stringify(parsed.extensions) === JSON.stringify(['pg_stat_statements'])
      )
      checks.EXIT = pf(run.status === 0)
    } else {
      checks.FAILED_LINE = pf(lines.some((l) => l.includes('"probe":"FAILED"')))
      checks.EXIT = pf(run.status !== 0)
    }
  }
  const overall = Object.values(checks).every((s) => s === 'PASSED') ? 'CONFORMS' : 'DOES_NOT_CONFORM'
  return { scenario: params.scenario, checks, overall, toolExit: run.status }
}
