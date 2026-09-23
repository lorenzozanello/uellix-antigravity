// scripts/custody/d1-mint-tool-contract-harness.ts
//
// MEASURE A CANDIDATE ROUTE-B MINT TOOL AGAINST THE CONTRACT, WITHOUT A
// DATABASE AND WITHOUT A REAL VALUE.
//
// The candidate is a file OUTSIDE the repository. The harness gives it:
//   - a FAKE `postgres` driver (it records every call, with its bound
//     parameters, into a log beside itself, and exports the fake marker);
//   - a FAKE N30 depositor (it records its argv, its environment and exactly
//     the bytes it received on stdin, beside itself, and answers like N30);
//   - a synthetic privileged DSN in UELLIX_D1_MINT_OPERATOR_DATABASE_URL;
//   - a working directory and TEMP/TMP of its own, which are searched after.
// The value the tool generates is synthetic by construction (the driver is
// fake, so nothing it "sets" exists anywhere), and it is recovered from the
// fake driver's log to check where else it went.
//
// It cannot see everything: a candidate could open a socket of its own or
// write outside the directories it was given. The harness measures the
// clauses OPERATOR_TOOL_CONTRACT marks `measuredBy`, and the rest stay
// statements for the certifier.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '../../db/hosted/target-identity'
import { checkDsnShape } from '../../db/custody/production-custody'
import { ROUTE_B_ROLE, ROUTE_B_STATEMENTS } from '../../db/custody/mint-route-b-contract'
import { isInsideRepositoryTree } from './build-sentinel-consumer'

export type Scenario = 'SUCCESS' | 'MINT_FAILS' | 'UNPINNED_TARGET'
type State = 'PASSED' | 'FAILED'

const FAKE_DRIVER = `'use strict'
const fs = require('node:fs'); const path = require('node:path')
const LOG = path.join(__dirname, 'driver-log.jsonl')
const rec = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\\n')
const failDo = fs.existsSync(path.join(__dirname, 'FAIL_DO'))
module.exports = function postgres(url, opts) {
  rec({ event: 'construct', host: new URL(url).hostname, ssl: opts && opts.ssl, prepare: opts && opts.prepare })
  const q = (strings, ...values) => { const text = strings.reduce((a, s, i) => a + (i ? '$' + i : '') + s, ''); rec({ event: 'query', text, params: values }); return Promise.resolve([]) }
  q.unsafe = (text, params) => { rec({ event: 'unsafe', text, params: params || [] }); if (failDo && text.includes('DO $rotate$')) return Promise.reject(Object.assign(new Error('fake failure'), { code: 'XX000' })); return Promise.resolve([]) }
  return {
    // COMMIT is HELD for 1.5s, so a value handed to the depositor before COMMIT
    // has time to arrive there first and its arrival timestamp precedes COMMIT.
    begin: async (fn) => { rec({ event: 'BEGIN' }); try { const r = await fn(q); await new Promise((res) => setTimeout(res, 1500)); rec({ event: 'COMMIT' }); return r } catch (e) { rec({ event: 'ROLLBACK' }); throw e } },
    unsafe: q.unsafe,
    end: async () => { rec({ event: 'end' }) },
  }
}
module.exports.__UELLIX_CONTRACT_FAKE__ = true
`

const FAKE_DEPOSITOR = `'use strict'
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
  writeFileSync(join(driverDir, 'package.json'), '{"name":"postgres","main":"index.js"}')
  writeFileSync(join(driverDir, 'index.js'), FAKE_DRIVER)
  if (params.scenario === 'MINT_FAILS') writeFileSync(join(driverDir, 'FAIL_DO'), '')
  const depositor = join(depositorDir, 'fake-n30-deposit.js')
  writeFileSync(depositor, FAKE_DEPOSITOR)

  const adminPassword = `harness-admin-${Date.now().toString(36)}-synthetic`
  const host =
    params.scenario === 'UNPINNED_TARGET'
      ? `db.${KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0] ?? 'abcdefghijklmnopqrst'}.supabase.co`
      : `db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`
  const adminUrl = ['postgresql:', '//postgres:', adminPassword, '@', host, ':5432/postgres'].join('')

  const env: Record<string, string> = { UELLIX_D1_MINT_OPERATOR_DATABASE_URL: adminUrl, TEMP: temp, TMP: temp }
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path']) {
    const val = process.env[k]
    if (val !== undefined) env[k] = val
  }
  const run = spawnSync(process.execPath, [resolvePath(params.toolPath), `--driver-root=${driverRoot}`, `--depositor=${depositor}`, `--valid-until=${params.validUntil}`], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  const toolOutput = `${run.stdout ?? ''}${run.stderr ?? ''}`

  const driverLog = join(driverDir, 'driver-log.jsonl')
  const events = existsSync(driverLog)
    ? readFileSync(driverLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { at: number; event: string; text?: string; params?: unknown[]; host?: string; ssl?: unknown })
    : []
  const depLogPath = join(depositorDir, 'depositor-log.json')
  const dep = existsSync(depLogPath) ? (JSON.parse(readFileSync(depLogPath, 'utf8')) as { at: number; argv: string[]; env: Record<string, string>; stdin: string }) : null

  const pwQuery = events.find((e) => e.event === 'query' && e.text === ROUTE_B_STATEMENTS.SET_PASSWORD)
  const secret = typeof pwQuery?.params?.[0] === 'string' ? (pwQuery.params[0] as string) : null
  const reps = secret === null ? [] : [secret, Buffer.from(secret).toString('base64')]
  const leaks = (text: string): boolean => reps.some((r) => text.includes(r))
  const adminLeaks = (text: string): boolean => text.includes(adminPassword) || text.includes(adminUrl)

  if (params.scenario === 'UNPINNED_TARGET') {
    checks.REFUSES_UNPINNED_TARGET = pf(run.status !== 0 && events.length === 0 && !adminLeaks(toolOutput))
  } else {
    const shape = events.map((e) => (e.event === 'query' || e.event === 'unsafe' ? `${e.event}:${e.text}` : e.event))
    const expected = [
      'construct',
      'BEGIN',
      `query:${ROUTE_B_STATEMENTS.SET_ROLE}`,
      `query:${ROUTE_B_STATEMENTS.SET_PASSWORD}`,
      `query:${ROUTE_B_STATEMENTS.SET_VALID_UNTIL}`,
      `unsafe:${ROUTE_B_STATEMENTS.DO_BLOCK}`,
      params.scenario === 'MINT_FAILS' ? 'ROLLBACK' : 'COMMIT',
      'end',
    ]
    checks.SEQUENCE = pf(JSON.stringify(shape) === JSON.stringify(expected))
    checks.TLS_REQUIRED = pf(events[0]?.ssl === 'require')
    const roleQ = events.find((e) => e.text === ROUTE_B_STATEMENTS.SET_ROLE)
    const vuQ = events.find((e) => e.text === ROUTE_B_STATEMENTS.SET_VALID_UNTIL)
    const doQ = events.find((e) => e.event === 'unsafe')
    checks.BOUND_ONLY = pf(
      secret !== null &&
        events.every((e) => !(e.text ?? '').includes(secret)) &&
        roleQ?.params?.length === 1 &&
        roleQ.params[0] === ROUTE_B_ROLE &&
        pwQuery?.params?.length === 1 &&
        (doQ?.params?.length ?? 0) === 0
    )
    checks.SECRET_SHAPE = pf(secret !== null && /^[A-Za-z0-9_-]{43,}$/.test(secret))
    checks.VALID_UNTIL_EQUALS_N09 = pf(vuQ?.params?.length === 1 && vuQ.params[0] === params.validUntil)
    checks.OUTPUT_CLEAN = pf(!leaks(toolOutput) && !adminLeaks(toolOutput))
    const toolFiles = [...filesUnder(cwd), ...filesUnder(temp)]
    checks.FILES_CLEAN = pf(toolFiles.every((f) => !leaks(readFileSync(f, 'latin1')) && !adminLeaks(readFileSync(f, 'latin1'))))
    checks.DEPOSITOR_ARGV_CLEAN = pf(dep !== null && !dep.argv.some((a) => leaks(a) || adminLeaks(a)))
    checks.DEPOSITOR_ENV_CLEAN = pf(
      dep !== null &&
        dep.env.UELLIX_D1_MINT_OPERATOR_DATABASE_URL === undefined &&
        Object.values(dep.env).every((v) => !leaks(v) && !adminLeaks(v))
    )
    if (params.scenario === 'SUCCESS') {
      const commitAt = events.find((e) => e.event === 'COMMIT')?.at ?? Number.POSITIVE_INFINITY
      const line = dep?.stdin.replace(/\r?\n$/, '') ?? ''
      const expectedDsn = secret === null ? null : ['postgresql:', `//${ROUTE_B_ROLE}:`, secret, `@db.${KNOWN_STAGING_PROJECT_REF}.supabase.co:5432/postgres`].join('')
      checks.HANDOFF_AFTER_COMMIT = pf(
        dep !== null && dep.at >= commitAt && line === expectedDsn && checkDsnShape(Buffer.from(line), 'production') === null && (dep.stdin.match(/\n/g)?.length ?? 0) <= 1
      )
      checks.EXIT = pf(run.status === 0)
    } else {
      checks.NO_HANDOFF_WITHOUT_COMMIT = pf(dep !== null && dep.stdin.length === 0)
      checks.EXIT = pf(run.status !== 0)
    }
  }
  const overall = Object.values(checks).every((s) => s === 'PASSED') ? 'CONFORMS' : 'DOES_NOT_CONFORM'
  return { scenario: params.scenario, checks, overall, toolExit: run.status }
}
