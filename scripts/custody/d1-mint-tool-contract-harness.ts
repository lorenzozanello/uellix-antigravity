// scripts/custody/d1-mint-tool-contract-harness.ts
//
// MEASURE A CANDIDATE ROUTE-B MINT TOOL AGAINST THE CONTRACT, WITHOUT A
// DATABASE, WITHOUT A REAL VALUE AND WITHOUT A REAL TARGET.
//
// The candidate is a file OUTSIDE the repository. The harness gives it:
//   - a FAKE `postgres` driver that follows postgres.js's begin() shape
//     (callback in try with ROLLBACK; COMMIT AFTER the callback, outside the
//     try) and records every call, with bound parameters and the options it
//     was constructed with, beside itself;
//   - a FAKE N30 depositor that records its argv, environment and the exact
//     bytes it received on stdin, beside itself, and answers like N30;
//   - a synthetic privileged connection string and --target-host naming an
//     RFC 6761 `.invalid` host, so nothing in the harness names or could reach
//     a real project;
//   - a working directory and TEMP/TMP of its own, which are searched after.
//
// SCENARIOS pressure every commit boundary B-1 of the recertification named:
//   SUCCESS                   COMMIT acknowledged.
//   FAILS_BEFORE_TRANSACTION  BEGIN fails: no transaction, nothing committed.
//   MINT_FAILS                the DO block fails inside the callback: ROLLBACK,
//                             COMMIT never requested.
//   COMMIT_TRANSPORT_LOST     the callback completes and the connection is lost
//                             on COMMIT: the server may have committed.
//   COMMIT_TIMEOUT            ... COMMIT times out (ETIMEDOUT).
//   COMMIT_GENERIC_TRANSPORT_ERROR  ... the driver throws with no code at all.
//   COMMIT_SERVER_ERROR_SQLSTATE    ... the server answers COMMIT with an error
//                             carrying a SQLSTATE (a PostgresError shape).
//   KILLED_DURING_COMMIT      the process dies on COMMIT: no terminal line.
//   COMMIT_NO_FINAL_OUTPUT    COMMIT never answers; the run is ended from outside
//                             and leaves no terminal line.
// and every refusal that must happen BEFORE any driver call:
//   UNPINNED_TARGET, HOST_LOOKALIKE (a host that only shares a prefix),
//   URL_WITH_QUERY (a startup GUC riding in the URL), WRONG_DATABASE, WRONG_PORT,
//   WRONG_DRIVER_VERSION, DRIVER_DIGEST_MISMATCH, WRONG_OPERATOR_PRINCIPAL,
//   TOOL_INSIDE_GIT_TREE.
//
// PLAINTEXT ELIMINATION (owner decision N11_PASSWORD_TRANSPORT =
// CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER; OT-15): the plaintext is
// recovered from the depositor's stdin (the one place it is allowed to go),
// then searched for in EVERY recorded driver event — statement texts, bind
// values and construction options. It must occur zero times, and the value
// bound by SET_VERIFIER must be a SCRAM-SHA-256 verifier of it.
//
// It cannot see everything: a candidate could open a socket of its own or
// write outside the directories it was given. The harness measures the
// clauses OPERATOR_TOOL_CONTRACT marks `measuredBy`.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { checkDsnShape } from '../../db/custody/production-custody'
import { COMMIT_UNKNOWN_TOKEN, ROUTE_B_DATABASE, ROUTE_B_PORT, ROUTE_B_ROLE, ROUTE_B_STATEMENTS, classifyToolRun } from '../../db/custody/mint-route-b-contract'
import { SCRAM_VERIFIER_PATTERN, verifierMatches } from '../../db/custody/scram-verifier'
import { driverDigest } from '../../db/custody/mint-operator-channel'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { syntheticCa } from './synthetic-x509'

export type Scenario =
  | 'SUCCESS'
  | 'FAILS_BEFORE_TRANSACTION'
  | 'MINT_FAILS'
  | 'COMMIT_TRANSPORT_LOST'
  | 'COMMIT_TIMEOUT'
  | 'COMMIT_GENERIC_TRANSPORT_ERROR'
  | 'COMMIT_SERVER_ERROR_SQLSTATE'
  | 'KILLED_DURING_COMMIT'
  | 'COMMIT_NO_FINAL_OUTPUT'
  | 'UNPINNED_TARGET'
  /** OT-16: a host that only shares a prefix with --target-host (a startsWith comparison would accept it). */
  | 'HOST_LOOKALIKE'
  /** OT-16: a query parameter in the operator URL (postgres.js would forward it as a startup GUC). */
  | 'URL_WITH_QUERY'
  /** OT-16: another database than --target-database. */
  | 'WRONG_DATABASE'
  /** OT-16: another port than --target-port. */
  | 'WRONG_PORT'
  /** OT-13: a driver at --driver-root whose package version is not the route-B one. */
  | 'WRONG_DRIVER_VERSION'
  /** OT-17: a driver whose files differ from --driver-digest. */
  | 'DRIVER_DIGEST_MISMATCH'
  /** OT-14: the operator URL names another principal than --operator-principal. */
  | 'WRONG_OPERATOR_PRINCIPAL'
  /** OT-1 at run time: the tool file lies inside a git work tree. */
  | 'TOOL_INSIDE_GIT_TREE'
  /** OT-18: the pinned CA file is absent. */
  | 'CA_MISSING'
  /** OT-18: the CA file's bytes are not the pinned ones. */
  | 'CA_MODIFIED'
  /** OT-19: ambient PG* / TLS variables in the tool's environment. */
  | 'AMBIENT_PG_ENV'
type State = 'PASSED' | 'FAILED'

/** The scenarios the tool must refuse before any driver call, with the check that measures each. */
export const REFUSAL_SCENARIOS: Readonly<Partial<Record<Scenario, string>>> = {
  UNPINNED_TARGET: 'REFUSES_UNPINNED_TARGET',
  HOST_LOOKALIKE: 'REFUSES_HOST_LOOKALIKE',
  URL_WITH_QUERY: 'REFUSES_URL_QUERY',
  WRONG_DATABASE: 'REFUSES_WRONG_DATABASE',
  WRONG_PORT: 'REFUSES_WRONG_PORT',
  WRONG_DRIVER_VERSION: 'REFUSES_WRONG_DRIVER_VERSION',
  DRIVER_DIGEST_MISMATCH: 'REFUSES_DRIVER_DIGEST_MISMATCH',
  WRONG_OPERATOR_PRINCIPAL: 'REFUSES_WRONG_OPERATOR_PRINCIPAL',
  CA_MISSING: 'REFUSES_CA_MISSING',
  CA_MODIFIED: 'REFUSES_CA_MODIFIED',
  AMBIENT_PG_ENV: 'REFUSES_AMBIENT_PG_ENV',
  TOOL_INSIDE_GIT_TREE: 'REFUSES_INSIDE_GIT_TREE',
}

/** How the fake driver fails AFTER COMMIT was requested, per scenario. `throw` carries the error's own properties. */
export type CommitFailure =
  | { readonly mode: 'throw'; readonly message: string; readonly props: Readonly<Record<string, unknown>> }
  | { readonly mode: 'exit' }
  | { readonly mode: 'hang' }

/** Every post-COMMIT-request failure the harness drives, with the COMMIT_FAILURE_MATRIX row it realizes. */
export const COMMIT_FAILURES: Readonly<Partial<Record<Scenario, CommitFailure & { readonly cfRow: string }>>> = {
  COMMIT_TRANSPORT_LOST: { mode: 'throw', message: 'fake connection lost', props: { code: 'CONNECTION_CLOSED' }, cfRow: 'CF-7' },
  COMMIT_TIMEOUT: { mode: 'throw', message: 'fake read timeout', props: { code: 'ETIMEDOUT', errno: -4039, syscall: 'read' }, cfRow: 'CF-8' },
  COMMIT_GENERIC_TRANSPORT_ERROR: { mode: 'throw', message: 'fake socket hang up', props: {}, cfRow: 'CF-9' },
  COMMIT_SERVER_ERROR_SQLSTATE: {
    mode: 'throw',
    message: 'fake could not serialize access due to read/write dependencies among transactions',
    props: { name: 'PostgresError', severity: 'ERROR', severity_local: 'ERROR', code: '40001', routine: 'PreCommit_CheckForSerializationFailure' },
    cfRow: 'CF-5',
  },
  KILLED_DURING_COMMIT: { mode: 'exit', cfRow: 'CF-10' },
  COMMIT_NO_FINAL_OUTPUT: { mode: 'hang', cfRow: 'CF-10' },
}

/** The only target the harness ever names. RFC 6761: guaranteed never to resolve. */
export const HARNESS_TARGET_HOST = 'db.harness-target.invalid'
const OTHER_HOST = 'db.harness-other.invalid'
/** A host that STARTS WITH the target host. */
const LOOKALIKE_HOST = `${HARNESS_TARGET_HOST}.lookalike.invalid`
/** The principal the harness's synthetic operator URL names, passed as --operator-principal. */
export const HARNESS_OPERATOR_PRINCIPAL = 'postgres'
/** The route-B driver version the fake driver reports (OT-13). */
export const HARNESS_DRIVER_VERSION = '3.4.9'
/** The only construction option keys a conforming tool passes (OT-16: no `connection`, no URL). */
export const ALLOWED_DRIVER_OPTION_KEYS = ['database', 'host', 'max', 'onnotice', 'password', 'port', 'prepare', 'ssl', 'username'] as const

/**
 * OT-18 as a fake driver can see it: the SHAPE of the `ssl` option (never the
 * CA bytes, never a function). Shared by both fake drivers.
 */
export const FAKE_DRIVER_SSL_SHAPE = `const sslShape = (s) => (s && typeof s === 'object' ? { kind: 'object', rejectUnauthorized: s.rejectUnauthorized, servername: s.servername, minVersion: s.minVersion, caCount: Array.isArray(s.ca) ? s.ca.length : 0, caSha256: Array.isArray(s.ca) && s.ca.length === 1 ? require('node:crypto').createHash('sha256').update(s.ca[0]).digest('hex') : null, checkServerIdentity: typeof s.checkServerIdentity } : s)`

/** What OT-18 requires of that shape: the one pinned CA, verification on, the target as servername. */
export function sslShapeReasons(shape: unknown, host: string, caSha256: string): string[] {
  const s = shape as { kind?: string; rejectUnauthorized?: unknown; servername?: unknown; minVersion?: unknown; caCount?: unknown; caSha256?: unknown; checkServerIdentity?: unknown } | null | undefined
  if (s === null || s === undefined || s.kind !== 'object') return ['ssl is not an options object (a mode string cannot pin a CA)']
  const r: string[] = []
  if (s.rejectUnauthorized !== true) r.push('rejectUnauthorized is not true')
  if (s.caCount !== 1 || s.caSha256 !== caSha256) r.push('the trust anchors are not exactly the pinned CA')
  if (s.servername !== host) r.push('servername is not the target host')
  if (s.minVersion !== 'TLSv1.2') r.push('minVersion is not TLSv1.2')
  if (s.checkServerIdentity !== 'function') r.push('no hostname check')
  return r
}

/** The ambient variables OT-19 must refuse (and the channel must never pass down). */
export const HOSTILE_AMBIENT_ENV: Readonly<Record<string, string>> = {
  PGHOST: 'db.hostile.invalid',
  PGPORT: '6543',
  PGDATABASE: 'template1',
  PGOPTIONS: '-c log_statement=all',
  PGSERVICE: 'hostile',
  PGSSLMODE: 'disable',
  PGAPPNAME: 'hostile',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
}

/** A synthetic CA for a harness run, pinned; CA_MODIFIED writes other bytes under the same pin, CA_MISSING none. */
export function writeHarnessCa(dir: string, scenario: string): { caFile: string; caSha256: string; anchorSha256: string } {
  mkdirSync(dir, { recursive: true })
  const ca = syntheticCa('d1 harness synthetic ca')
  const caFile = join(dir, 'project-ca.crt')
  const caSha256 = createHash('sha256').update(ca.certPem).digest('hex')
  if (scenario === 'CA_MODIFIED') writeFileSync(caFile, syntheticCa('d1 harness other ca').certPem)
  else if (scenario !== 'CA_MISSING') writeFileSync(caFile, ca.certPem)
  return { caFile, caSha256, anchorSha256: ca.derSha256 }
}

/** Exported for the operator-channel PEB demonstration and the disposable proof (same bytes the harness uses). */
export const FAKE_DRIVER = `'use strict'
const fs = require('node:fs'); const path = require('node:path')
${FAKE_DRIVER_SSL_SHAPE}
const LOG = path.join(__dirname, 'driver-log.jsonl')
const rec = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\\n')
const flag = (n) => fs.existsSync(path.join(__dirname, n))
module.exports = function postgres(a, b) {
  if (typeof a === 'string') rec({ event: 'construct', form: 'url', host: new URL(a).hostname, query: new URL(a).search, ssl: sslShape(b && b.ssl), prepare: b && b.prepare, keys: Object.keys(b || {}).sort(), connection: (b && b.connection) || null })
  else rec({ event: 'construct', form: 'options', host: a.host, port: a.port, database: a.database, username: a.username, hasPassword: typeof a.password === 'string', ssl: sslShape(a.ssl), prepare: a.prepare, keys: Object.keys(a).sort(), connection: a.connection || null })
  const q = (strings, ...values) => { const text = strings.reduce((acc, s, i) => acc + (i ? '$' + i : '') + s, ''); rec({ event: 'query', text, params: values }); return Promise.resolve([]) }
  q.unsafe = (text, params) => { rec({ event: 'unsafe', text, params: params || [] }); if (flag('FAIL_DO') && text.includes('DO $rotate$')) return Promise.reject(Object.assign(new Error('fake failure'), { code: 'XX000' })); return Promise.resolve([]) }
  return {
    // postgres.js scope(): callback inside try/catch with ROLLBACK; COMMIT after it, OUTSIDE the try.
    begin: async (fn) => {
      if (flag('FAIL_BEGIN')) { rec({ event: 'BEGIN_FAILED' }); throw Object.assign(new Error('fake begin failure'), { code: 'ECONNREFUSED' }) }
      rec({ event: 'BEGIN' })
      let r
      try { r = await fn(q) } catch (e) { rec({ event: 'ROLLBACK' }); throw e }
      // COMMIT is HELD 1.5s so a value handed over before COMMIT arrives first.
      await new Promise((res) => setTimeout(res, 1500))
      rec({ event: 'COMMIT_REQUESTED' })
      const f = flag('COMMIT_FAILURE') ? JSON.parse(fs.readFileSync(path.join(__dirname, 'COMMIT_FAILURE'), 'utf8')) : null
      if (f && f.mode === 'exit') process.exit(137)
      if (f && f.mode === 'hang') { setInterval(() => undefined, 1000); await new Promise(() => undefined) }
      if (f && f.mode === 'throw') { rec({ event: 'COMMIT_NOT_ACKNOWLEDGED' }); throw Object.assign(new Error(f.message), f.props) }
      rec({ event: 'COMMIT' })
      return r
    },
    unsafe: q.unsafe,
    end: async () => { rec({ event: 'end' }) },
  }
}
module.exports.__UELLIX_CONTRACT_FAKE__ = true
`

export const FAKE_DEPOSITOR = `'use strict'
const fs = require('node:fs'); const path = require('node:path')
const chunks = []
let firstAt = null
process.stdin.on('data', (c) => { if (firstAt === null) firstAt = Date.now(); chunks.push(c) })
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks)
  fs.writeFileSync(path.join(__dirname, 'depositor-log.json'), JSON.stringify({ at: firstAt === null ? Date.now() : firstAt, argv: process.argv.slice(2), env: process.env, stdin: stdin.toString('utf8') }))
  const got = stdin.length > 0
  process.stdout.write(JSON.stringify({ node: 'N30', n30ExitMet: got }) + '\\n')
  process.exitCode = got ? 0 : 1
})
`

const FLAG_FOR: Partial<Record<Scenario, string>> = {
  FAILS_BEFORE_TRANSACTION: 'FAIL_BEGIN',
  MINT_FAILS: 'FAIL_DO',
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

export interface HarnessResult {
  readonly scenario: Scenario
  readonly checks: Readonly<Record<string, State>>
  readonly overall: 'CONFORMS' | 'DOES_NOT_CONFORM'
  readonly toolExit: number | null
  /** The governed classification of the run, from the tool's own output only. */
  readonly classification: ReturnType<typeof classifyToolRun>
}

/** The plaintext the tool handed to the depositor, parsed from the auditor DSN on its stdin (null if none). */
function plaintextOf(dsn: string): string | null {
  const m = /^postgresql:\/\/uellix_auditor:([^@]+)@/.exec(dsn)
  return m === null ? null : m[1]!
}

export function runMintToolContractHarness(params: {
  readonly repoRoot: string
  readonly toolPath: string
  readonly workRoot: string
  readonly validUntil: string
  readonly scenario: Scenario
}): HarnessResult {
  const checks: Record<string, State> = {}
  const pf = (b: boolean): State => (b ? 'PASSED' : 'FAILED')
  const work = resolvePath(params.workRoot)
  if (isInsideRepositoryTree(params.repoRoot, work)) throw new Error('The harness work root must be outside the repository.')
  checks.OUTSIDE_REPOSITORY = pf(!isInsideRepositoryTree(params.repoRoot, resolvePath(params.toolPath)))

  const driverRoot = join(work, 'driver-root')
  const driverDir = join(driverRoot, 'node_modules', 'postgres')
  const depositorDir = join(work, 'depositor')
  const cwd = join(work, 'cwd')
  const temp = join(work, 'temp')
  for (const d of [driverDir, depositorDir, cwd, temp]) mkdirSync(d, { recursive: true })
  writeFileSync(join(driverRoot, 'package.json'), '{"name":"harness-driver-root","private":true}')
  writeFileSync(join(driverDir, 'package.json'), JSON.stringify({ name: 'postgres', main: 'index.js', version: params.scenario === 'WRONG_DRIVER_VERSION' ? '3.4.8' : HARNESS_DRIVER_VERSION }))
  writeFileSync(join(driverDir, 'index.js'), FAKE_DRIVER)
  const flag = FLAG_FOR[params.scenario]
  if (flag !== undefined) writeFileSync(join(driverDir, flag), '')
  const commitFailure = COMMIT_FAILURES[params.scenario]
  if (commitFailure !== undefined) writeFileSync(join(driverDir, 'COMMIT_FAILURE'), JSON.stringify(commitFailure))
  // OT-17: the digest the plan would carry, of the driver as it lies BEFORE the run.
  const pinnedDriverDigest = params.scenario === 'DRIVER_DIGEST_MISMATCH' ? '0'.repeat(64) : driverDigest(driverDir)
  const trust = writeHarnessCa(join(work, 'trust'), params.scenario)
  // Carrier lost: the run leaves no terminal line (killed, or ended from outside while COMMIT hangs).
  const carrierLost = commitFailure?.mode === 'exit' || commitFailure?.mode === 'hang'
  const depositor = join(depositorDir, 'fake-n30-deposit.js')
  writeFileSync(depositor, FAKE_DEPOSITOR)

  const adminPassword = `harness-admin-${Date.now().toString(36)}-synthetic`
  const host = params.scenario === 'UNPINNED_TARGET' ? OTHER_HOST : params.scenario === 'HOST_LOOKALIKE' ? LOOKALIKE_HOST : HARNESS_TARGET_HOST
  const database = params.scenario === 'WRONG_DATABASE' ? 'template1' : ROUTE_B_DATABASE
  const port = params.scenario === 'WRONG_PORT' ? 6543 : ROUTE_B_PORT
  const query = params.scenario === 'URL_WITH_QUERY' ? '?debug_print_parse=on' : ''
  const adminUrl = ['postgresql:', `//${HARNESS_OPERATOR_PRINCIPAL}:`, adminPassword, '@', host, `:${port}/${database}${query}`].join('')

  const env: Record<string, string> = { UELLIX_D1_MINT_OPERATOR_DATABASE_URL: adminUrl, TEMP: temp, TMP: temp, ...(params.scenario === 'AMBIENT_PG_ENV' ? HOSTILE_AMBIENT_ENV : {}) }
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path']) {
    const val = process.env[k]
    if (val !== undefined) env[k] = val
  }
  // OT-1 at run time: the same bytes, copied under a directory that carries a .git entry.
  let toolToRun = resolvePath(params.toolPath)
  if (params.scenario === 'TOOL_INSIDE_GIT_TREE') {
    const gitTree = join(work, 'in-git-tree')
    mkdirSync(join(gitTree, '.git'), { recursive: true })
    toolToRun = join(gitTree, 'tool.js')
    writeFileSync(toolToRun, readFileSync(resolvePath(params.toolPath)))
  }
  const principal = params.scenario === 'WRONG_OPERATOR_PRINCIPAL' ? 'someone_else' : HARNESS_OPERATOR_PRINCIPAL
  const run = spawnSync(
    process.execPath,
    [
      toolToRun,
      `--driver-root=${driverRoot}`,
      `--driver-digest=${pinnedDriverDigest}`,
      `--depositor=${depositor}`,
      `--valid-until=${params.validUntil}`,
      `--target-host=${HARNESS_TARGET_HOST}`,
      `--target-port=${ROUTE_B_PORT}`,
      `--target-database=${ROUTE_B_DATABASE}`,
      `--operator-principal=${principal}`,
      `--ca-file=${trust.caFile}`,
      `--ca-sha256=${trust.caSha256}`,
    ],
    { cwd, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: commitFailure?.mode === 'hang' ? 8_000 : 60_000, windowsHide: true }
  )
  const toolOutput = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const classification = classifyToolRun(run.stdout ?? '')

  const driverLog = join(driverDir, 'driver-log.jsonl')
  const rawEvents = existsSync(driverLog) ? readFileSync(driverLog, 'utf8') : ''
  const events = rawEvents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at: number; event: string; text?: string; params?: unknown[]; host?: string; port?: unknown; database?: unknown; username?: unknown; form?: string; query?: string; keys?: string[]; connection?: unknown; ssl?: unknown })
  const depLogPath = join(depositorDir, 'depositor-log.json')
  const dep = existsSync(depLogPath) ? (JSON.parse(readFileSync(depLogPath, 'utf8')) as { at: number; argv: string[]; env: Record<string, string>; stdin: string }) : null

  const verifierQuery = events.find((e) => e.event === 'query' && e.text === ROUTE_B_STATEMENTS.SET_VERIFIER)
  const verifier = typeof verifierQuery?.params?.[0] === 'string' ? (verifierQuery.params[0] as string) : null
  const received = dep?.stdin.replace(/\r?\n$/, '') ?? ''
  const plaintext = dep === null ? null : plaintextOf(received)
  const reps = (s: string | null): string[] => (s === null ? [] : [s, Buffer.from(s).toString('base64')])
  const leaksPlain = (text: string): boolean => reps(plaintext).some((r) => text.includes(r))
  const leaksDerived = (text: string): boolean => verifier !== null && text.includes(verifier)
  const adminLeaks = (text: string): boolean => text.includes(adminPassword) || text.includes(adminUrl)
  const expectedDsn = plaintext === null ? null : ['postgresql:', `//${ROUTE_B_ROLE}:`, plaintext, `@${HARNESS_TARGET_HOST}:${ROUTE_B_PORT}/${ROUTE_B_DATABASE}`].join('')
  const handedOver = dep !== null && expectedDsn !== null && received === expectedDsn && checkDsnShape(Buffer.from(received), 'synthetic') === null && (dep.stdin.match(/\n/g)?.length ?? 0) <= 1

  const refusal = REFUSAL_SCENARIOS[params.scenario]
  if (refusal !== undefined) {
    checks[refusal] = pf(run.status !== 0 && events.length === 0 && dep === null && !adminLeaks(toolOutput))
  } else if (params.scenario === 'FAILS_BEFORE_TRANSACTION') {
    checks.SEQUENCE = pf(JSON.stringify(events.map((e) => e.event)) === JSON.stringify(['construct', 'BEGIN_FAILED', 'end']))
    checks.CLASSIFIED_DEFINITELY_NOT_COMMITTED = pf(classification.outcome === 'DEFINITELY_NOT_COMMITTED')
    checks.NO_HANDOFF_WITHOUT_COMMIT = pf(dep !== null && dep.stdin.length === 0)
    checks.OUTPUT_CLEAN = pf(!adminLeaks(toolOutput))
    checks.EXIT = pf(run.status !== 0)
  } else {
    const shape = events.map((e) => (e.event === 'query' || e.event === 'unsafe' ? `${e.event}:${e.text}` : e.event))
    const tail: string[] =
      params.scenario === 'SUCCESS'
        ? ['COMMIT_REQUESTED', 'COMMIT', 'end']
        : params.scenario === 'MINT_FAILS'
          ? ['ROLLBACK', 'end']
          : carrierLost
            ? ['COMMIT_REQUESTED']
            : ['COMMIT_REQUESTED', 'COMMIT_NOT_ACKNOWLEDGED', 'end']
    const expected = [
      'construct',
      'BEGIN',
      `query:${ROUTE_B_STATEMENTS.SET_ROLE}`,
      `query:${ROUTE_B_STATEMENTS.SET_VERIFIER}`,
      `query:${ROUTE_B_STATEMENTS.SET_VALID_UNTIL}`,
      `unsafe:${ROUTE_B_STATEMENTS.DO_BLOCK}`,
      ...tail,
    ]
    checks.SEQUENCE = pf(JSON.stringify(shape) === JSON.stringify(expected))
    // OT-18: the driver was handed the pinned CA as its only anchor, with verification and the hostname check on.
    checks.TLS_VERIFY_FULL_PINNED = pf(sslShapeReasons(events[0]?.ssl, HARNESS_TARGET_HOST, trust.caSha256).length === 0)
    // OT-16: explicit options, the exact session, nothing that can carry a startup GUC.
    const c = events[0]
    checks.STARTUP_CLOSED = pf(
      c !== undefined &&
        c.form === 'options' &&
        c.host === HARNESS_TARGET_HOST &&
        c.port === ROUTE_B_PORT &&
        c.database === ROUTE_B_DATABASE &&
        c.username === HARNESS_OPERATOR_PRINCIPAL &&
        c.connection === null &&
        (c.keys ?? []).every((k) => (ALLOWED_DRIVER_OPTION_KEYS as readonly string[]).includes(k))
    )
    const roleQ = events.find((e) => e.text === ROUTE_B_STATEMENTS.SET_ROLE)
    const vuQ = events.find((e) => e.text === ROUTE_B_STATEMENTS.SET_VALID_UNTIL)
    const doQ = events.find((e) => e.event === 'unsafe')
    checks.BOUND_ONLY = pf(
      verifier !== null &&
        events.every((e) => !(e.text ?? '').includes(verifier)) &&
        roleQ?.params?.length === 1 &&
        roleQ.params[0] === ROUTE_B_ROLE &&
        verifierQuery?.params?.length === 1 &&
        (doQ?.params?.length ?? 0) === 0
    )
    checks.VERIFIER_FORMAT = pf(verifier !== null && SCRAM_VERIFIER_PATTERN.test(verifier))
    checks.VALID_UNTIL_EQUALS_N09 = pf(vuQ?.params?.length === 1 && vuQ.params[0] === params.validUntil)
    checks.OUTPUT_CLEAN = pf(!leaksPlain(toolOutput) && !leaksDerived(toolOutput) && !adminLeaks(toolOutput))
    const toolFiles = [...filesUnder(cwd), ...filesUnder(temp)]
    checks.FILES_CLEAN = pf(toolFiles.every((f) => !leaksPlain(readFileSync(f, 'latin1')) && !leaksDerived(readFileSync(f, 'latin1')) && !adminLeaks(readFileSync(f, 'latin1'))))
    if (plaintext !== null) {
      // OT-15: the plaintext is known ONLY because the depositor received it; it must be nowhere the driver saw.
      checks.SECRET_SHAPE = pf(/^[A-Za-z0-9_-]{43,}$/.test(plaintext))
      checks.VERIFIER_ONLY = pf(verifier !== null && verifier !== plaintext && verifierMatches(verifier, plaintext))
      checks.PLAINTEXT_NEVER_SENT = pf(rawEvents.length > 0 && !leaksPlain(rawEvents))
    }
    if (!carrierLost) {
      checks.DEPOSITOR_ARGV_CLEAN = pf(dep !== null && !dep.argv.some((a) => leaksPlain(a) || leaksDerived(a) || adminLeaks(a)))
      checks.DEPOSITOR_ENV_CLEAN = pf(
        dep !== null && dep.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL === undefined && Object.values(dep.env).every((v) => !leaksPlain(v) && !leaksDerived(v) && !adminLeaks(v))
      )
    }
    const commitRequestedAt = events.find((e) => e.event === 'COMMIT_REQUESTED')?.at ?? Number.POSITIVE_INFINITY
    if (params.scenario === 'SUCCESS') {
      const commitAt = events.find((e) => e.event === 'COMMIT')?.at ?? Number.POSITIVE_INFINITY
      checks.HANDOFF_AFTER_COMMIT = pf(handedOver && dep !== null && dep.at >= commitAt)
      checks.CLASSIFIED_COMMITTED = pf(classification.outcome === 'COMMITTED')
      checks.EXIT = pf(run.status === 0)
    } else if (params.scenario === 'MINT_FAILS') {
      checks.CLASSIFIED_DEFINITELY_NOT_COMMITTED = pf(classification.outcome === 'DEFINITELY_NOT_COMMITTED')
      checks.NO_HANDOFF_WITHOUT_COMMIT = pf(dep !== null && dep.stdin.length === 0)
      checks.EXIT = pf(run.status !== 0)
    } else if (!carrierLost) {
      // B-1 / NB-1: an unacknowledged COMMIT is UNKNOWN whatever error it carried, and the possibly-live value goes into custody.
      checks.CLASSIFIED_COMMIT_OUTCOME_UNKNOWN = pf(classification.outcome === 'COMMIT_OUTCOME_UNKNOWN' && classification.token === COMMIT_UNKNOWN_TOKEN)
      checks.CANDIDATE_RETAINED_IN_CUSTODY = pf(handedOver && dep !== null && dep.at >= commitRequestedAt)
      checks.EXIT_IS_STOP = pf(run.status === 4)
    } else {
      // KILLED_DURING_COMMIT / COMMIT_NO_FINAL_OUTPUT: no terminal line; the governed reading is UNKNOWN, carrier lost.
      checks.CLASSIFIED_COMMIT_OUTCOME_UNKNOWN = pf(classification.outcome === 'COMMIT_OUTCOME_UNKNOWN' && classification.carrier === 'NO_TERMINAL_LINE')
      checks.NO_VALUE_ESCAPED = pf(dep === null || dep.stdin.length === 0 || handedOver)
    }
  }
  const overall = Object.values(checks).every((s) => s === 'PASSED') ? 'CONFORMS' : 'DOES_NOT_CONFORM'
  return { scenario: params.scenario, checks, overall, toolExit: run.status, classification }
}
