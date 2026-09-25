// tests/custody/d1-pre-node-boundary.test.ts
//
// NB-1 (owner R4; manifest amendment v1.0.3 R4-P-BOUNDARY, R4-N-PRELOAD,
// R4-N-RUNTIME-INPUTS, R4-N-NODE-PIN, R4-N-DIRECT). A NODE_OPTIONS preload runs
// inside node before any launcher line, so the channel's first boundary is a
// script the operator's shell runs BEFORE node exists. These tests run the REAL
// pinned script under the real shell (Windows PowerShell; pwsh elsewhere) with a
// preload that records its own execution and tries to capture the synthetic
// operator string from stdin.
//
//   PRELOAD_EXECUTIONS_BEFORE_GOVERNED_SECRET must be 0 through the boundary.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  PRE_NODE_BOUNDARY_ENV,
  PRE_NODE_BOUNDARY_FILE,
  PRE_NODE_BOUNDARY_PS1,
  PRE_NODE_ENV_ALLOWLIST,
  PRE_NODE_HOSTILE_SOURCE,
  PRE_NODE_REFUSAL_EXIT,
  boundaryEnvironment,
  preNodeBoundarySha256,
} from '@/db/custody/pre-node-boundary'
import { buildLauncherClosure, writeLauncherBuild } from '@/scripts/custody/d1-mint-operator-channel-build'
import { PLAN_SCHEMA, type ChannelPlan } from '@/scripts/custody/d1-mint-operator-launcher'

const ROOT = process.cwd()
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const SHELL_AVAILABLE = spawnSync(SHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0
const HOSTILE = new RegExp(PRE_NODE_HOSTILE_SOURCE, 'i')
const SENTINEL = `postgresql://postgres:d1-r4-synthetic-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12)}@db.boundary-test.invalid:5432/postgres`

let dir = ''
let planPath = ''
let boundaryPath = ''
let launcherEntry = ''
let marker = ''
let capture = ''
let preloadCjs = ''
let preloadMjs = ''

/** The test's own environment without anything the boundary refuses (the host itself may carry NODE_* variables). */
function baseEnv(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOSTILE.test(k)) e[k] = v
  return e
}

interface Run {
  code: number | null
  stdout: string
}
function run(cmd: string, args: string[], env: Record<string, string>, stdin: string): Promise<Run> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { env: env as unknown as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false })
    let out = ''
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', (d: string) => (out += d))
    c.stderr.on('data', () => undefined)
    c.stdin.end(stdin)
    c.on('close', (code) => res({ code, stdout: out }))
  })
}
const viaBoundary = (extra: Record<string, string>, plan = planPath) =>
  run(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', boundaryPath, '-Plan', plan], { ...baseEnv(), ...extra }, `${SENTINEL}\n`)
const preloadExecutions = (): number => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0)
const captured = (): boolean => existsSync(capture) && readFileSync(capture, 'utf8').includes('d1-r4-synthetic')
const resetTraps = () => {
  rmSync(marker, { force: true })
  rmSync(capture, { force: true })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'd1-r4-boundary-'))
  launcherEntry = writeLauncherBuild(ROOT, dir, buildLauncherClosure(ROOT))
  boundaryPath = join(dir, PRE_NODE_BOUNDARY_FILE)
  writeFileSync(boundaryPath, PRE_NODE_BOUNDARY_PS1, 'utf8')
  marker = join(dir, 'preload-executed.txt')
  capture = join(dir, 'preload-captured.txt')
  // The attacker's preload: it records that it ran and captures whatever arrives on stdin.
  const body = (fsExpr: string) =>
    `${fsExpr}.appendFileSync(${JSON.stringify(marker)}, 'executed\\n'); process.stdin.on('data', (d) => ${fsExpr}.appendFileSync(${JSON.stringify(capture)}, d))\n`
  preloadCjs = join(dir, 'preload.cjs')
  writeFileSync(preloadCjs, body("require('node:fs')"))
  preloadMjs = join(dir, 'preload.mjs')
  writeFileSync(preloadMjs, `import * as fs from 'node:fs'\n${body('fs')}`)
  const tool = join(dir, 'tool.js')
  writeFileSync(tool, "process.stdout.write(JSON.stringify({ probe: 'OBSERVED' }) + '\\n')\n")
  const ca = join(dir, 'ca.crt')
  writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n')
  const plan: ChannelPlan = {
    schema: PLAN_SCHEMA,
    mode: 'probe',
    targetHost: 'db.boundary-test.invalid',
    targetPort: 5432,
    targetDatabase: 'postgres',
    operatorPrincipal: null,
    validUntil: null,
    driverRoot: dir,
    driverVersion: '3.4.9',
    driverDigest: 'c'.repeat(64),
    caFile: ca,
    caSha256: sha(readFileSync(ca)),
    nodeExecutable: { path: process.execPath, sha256: sha(readFileSync(process.execPath)) },
    preNodeBoundarySha256: preNodeBoundarySha256(),
    depositor: null,
    tool: { path: tool, sha256: sha(readFileSync(tool)) },
    launcherDigest: 'a'.repeat(64),
    derivedAtHead: 'b'.repeat(40),
    derivedAtUtc: new Date().toISOString(),
  }
  planPath = join(dir, 'plan-probe.json')
  writeFileSync(planPath, JSON.stringify(plan))
  writeFileSync(join(dir, 'plan-bad-node.json'), JSON.stringify({ ...plan, nodeExecutable: { path: process.execPath, sha256: 'f'.repeat(64) } }))
}, 120_000)

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('the boundary script is the pinned, fixed text the TypeScript side describes', () => {
  it('carries exactly the exported hostile pattern and allowlist, and nothing interpolated', () => {
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`$_.Name -match '${PRE_NODE_HOSTILE_SOURCE}'`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`@(${PRE_NODE_ENV_ALLOWLIST.map((k) => `'${k}'`).join(', ')})`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`$psi.EnvironmentVariables['${PRE_NODE_BOUNDARY_ENV}'] = $self`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain('$psi.EnvironmentVariables.Clear()')
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`exit ${PRE_NODE_REFUSAL_EXIT}`)
    expect(PRE_NODE_BOUNDARY_PS1).not.toMatch(/\$\{|`/)
    expect(preNodeBoundarySha256()).toBe(sha(PRE_NODE_BOUNDARY_PS1))
  })
  it('the TypeScript mirror of step (3) is the allowlist plus the mark, nothing inherited', () => {
    const env = boundaryEnvironment({ PATH: '/bin', SystemRoot: 'C:/W', NODE_OPTIONS: '--require=x', SECRET: 's', TEMP: '/t' }, 'e'.repeat(64))
    expect(env).toEqual({ PATH: '/bin', SystemRoot: 'C:/W', TEMP: '/t', [PRE_NODE_BOUNDARY_ENV]: 'e'.repeat(64) })
  })
  it('the hostile pattern covers every input the owner named, in any case', () => {
    for (const n of ['NODE_OPTIONS', 'node_options', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_SYSTEM_CA', 'OPENSSL_CONF', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'UELLIX_D1_MINT_OPERATOR_DATABASE_URL'])
      expect(HOSTILE.test(n), n).toBe(true)
    for (const n of ['PATH', 'SystemRoot', 'TEMP', 'NODEX', 'MY_NODE_OPTIONS']) expect(HOSTILE.test(n), n).toBe(false)
  })
})

describe('R4-N-DIRECT control: WITHOUT the boundary the preload runs and captures (the attack is real)', () => {
  it('node started directly under NODE_OPTIONS=--require: the preload executes and captures the sentinel; the launcher then refuses (too late)', async () => {
    resetTraps()
    const r = await run(process.execPath, [launcherEntry, `--plan=${planPath}`], { ...baseEnv(), NODE_OPTIONS: `--require=${preloadCjs}` }, `${SENTINEL}\n`)
    await new Promise((res) => setTimeout(res, 200))
    expect(preloadExecutions()).toBeGreaterThanOrEqual(1)
    expect(captured()).toBe(true)
    expect(r.stdout).toContain('CHANNEL_NO_PRE_NODE_BOUNDARY')
  }, 60_000)
})

describe.runIf(SHELL_AVAILABLE)('R4-N-PRELOAD / R4-N-RUNTIME-INPUTS: through the boundary nothing runs before the governed check', () => {
  it.each([
    ['NODE_OPTIONS=--require', () => ({ NODE_OPTIONS: `--require=${preloadCjs}` })],
    ['NODE_OPTIONS=-r', () => ({ NODE_OPTIONS: `-r ${preloadCjs}` })],
    ['NODE_OPTIONS=--import', () => ({ NODE_OPTIONS: `--import=${pathToFileURL(preloadMjs).href}` })],
  ])('%s: refused before node exists; PRELOAD_EXECUTIONS_BEFORE_GOVERNED_SECRET = 0; nothing captured', async (_n, env) => {
    resetTraps()
    const r = await viaBoundary(env())
    expect(r.code).toBe(PRE_NODE_REFUSAL_EXIT)
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ boundary: 'REFUSED', code: 'PRE_NODE_AMBIENT_RUNTIME', names: ['NODE_OPTIONS'] })
    expect(preloadExecutions()).toBe(0)
    expect(captured()).toBe(false)
  }, 60_000)
  it.each([['NODE_PATH'], ['NODE_EXTRA_CA_CERTS'], ['NODE_TLS_REJECT_UNAUTHORIZED'], ['NODE_USE_SYSTEM_CA'], ['OPENSSL_CONF'], ['SSL_CERT_FILE'], ['SSL_CERT_DIR']])(
    '%s alone is refused before node exists',
    async (name) => {
      resetTraps()
      const r = await viaBoundary({ [name]: name === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : join(dir, 'hostile') })
      expect(r.code).toBe(PRE_NODE_REFUSAL_EXIT)
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ code: 'PRE_NODE_AMBIENT_RUNTIME', names: [name] })
    },
    60_000
  )
  it.runIf(process.platform === 'win32')('a lower-case node_options is the same variable on Windows and is refused', async () => {
    resetTraps()
    const r = await viaBoundary({ node_options: `--require=${preloadCjs}` })
    expect(r.code).toBe(PRE_NODE_REFUSAL_EXIT)
    expect(preloadExecutions()).toBe(0)
  }, 60_000)
  it('R4-N-NODE-PIN: a node binary that is not the pinned one is refused before it starts', async () => {
    const r = await viaBoundary({}, join(dir, 'plan-bad-node.json'))
    expect(r.code).toBe(PRE_NODE_REFUSAL_EXIT)
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ code: 'PRE_NODE_NODE_NOT_PINNED' })
  }, 60_000)
})

describe.runIf(SHELL_AVAILABLE)('R4-P-BOUNDARY step (3), measured: what node itself receives from the boundary', () => {
  // A stand-in at the launcher's path reports the environment and flags node was started with, so step (3) is
  // measured on the process the boundary starts, not read from the script's text.
  it('only the allowlist and the mark reach node; an inherited non-hostile variable does not; no flags', async () => {
    const d = mkdtempSync(join(tmpdir(), 'd1-r4-env-'))
    try {
      const script = join(d, PRE_NODE_BOUNDARY_FILE)
      writeFileSync(script, PRE_NODE_BOUNDARY_PS1, 'utf8')
      const standIn = join(d, 'launcher', 'scripts', 'custody')
      mkdirSync(standIn, { recursive: true })
      writeFileSync(join(standIn, 'd1-mint-operator-launcher.js'), 'process.stdout.write(JSON.stringify({ keys: Object.keys(process.env).sort(), execArgv: process.execArgv, mark: process.env.' + PRE_NODE_BOUNDARY_ENV + ' ?? null }) + "\\n")\n')
      const r = await run(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Plan', planPath], { ...baseEnv(), UELLIX_R4_INHERITED_CANARY: 'must-not-reach-node' }, '')
      expect(r.code).toBe(0)
      const seen = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { keys: string[]; execArgv: string[]; mark: string | null }
      const allowed = new Set<string>([...PRE_NODE_ENV_ALLOWLIST, PRE_NODE_BOUNDARY_ENV].map((k) => k.toUpperCase()))
      expect(seen.keys.filter((k) => !allowed.has(k.toUpperCase()))).toEqual([])
      expect(seen.keys).not.toContain('UELLIX_R4_INHERITED_CANARY')
      expect(seen.execArgv).toEqual([])
      expect(seen.mark).toBe(sha(readFileSync(script)))
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.runIf(SHELL_AVAILABLE && process.platform === 'win32')('R4-P-BOUNDARY: a clean console runs the channel through the boundary', () => {
  it('node starts with no flags and the allowlisted environment; the launcher accepts the mark and the tool runs; no preload ran', async () => {
    resetTraps()
    const r = await viaBoundary({})
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('"launcher":"TOOL_SPAWNED"')
    expect(r.stdout).toContain('"probe":"OBSERVED"')
    expect(r.stdout).not.toContain('d1-r4-synthetic')
    expect(preloadExecutions()).toBe(0)
  }, 90_000)
})
