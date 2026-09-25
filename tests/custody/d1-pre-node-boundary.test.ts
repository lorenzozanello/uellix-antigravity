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
  PRE_NODE_INJECTION_SOURCE,
  PRE_NODE_OUTER_BOUNDARY_CMD,
  PRE_NODE_OUTER_BOUNDARY_FILE,
  PRE_NODE_OUTER_SANITIZED,
  PRE_NODE_REFUSAL_EXIT,
  boundaryEnvironment,
  preNodeBoundarySha256,
  preNodeOuterBoundarySha256,
} from '@/db/custody/pre-node-boundary'
import { buildLauncherClosure, writeLauncherBuild } from '@/scripts/custody/d1-mint-operator-channel-build'
import { PLAN_SCHEMA, type ChannelPlan } from '@/scripts/custody/d1-mint-operator-launcher'

const ROOT = process.cwd()
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const CMD_EXE = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
const SHELL_AVAILABLE = spawnSync(SHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0
const HOSTILE = new RegExp(PRE_NODE_HOSTILE_SOURCE, 'i')
const INJECTION = new RegExp(PRE_NODE_INJECTION_SOURCE, 'i')
const SENTINEL = `postgresql://postgres:d1-r4-synthetic-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12)}@db.boundary-test.invalid:5432/postgres`

let dir = ''
let planPath = ''
let boundaryPath = ''
let outerPath = ''
let launcherEntry = ''
let marker = ''
let capture = ''
let preloadCjs = ''
let preloadMjs = ''
let psmodRoot = ''
let moduleMarker = ''
let trojanMarker = ''

/** The test's own environment without any variable the boundary refuses, nor a startup-injection input the outer boundary clears. */
function baseEnv(): Record<string, string> {
  const e: Record<string, string> = {}
  const sanitized = new Set(PRE_NODE_OUTER_SANITIZED.map((k) => k.toUpperCase()))
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOSTILE.test(k) && !INJECTION.test(k) && !sanitized.has(k.toUpperCase())) e[k] = v
  return e
}
const moduleExecutions = (): number => (existsSync(moduleMarker) ? readFileSync(moduleMarker, 'utf8').split('\n').filter(Boolean).length : 0)
const trojanExecutions = (): number => (existsSync(trojanMarker) ? readFileSync(trojanMarker, 'utf8').split('\n').filter(Boolean).length : 0)

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
/** Direct invocation of the INNER script (defence-in-depth path; not the governed entry). */
const viaBoundary = (extra: Record<string, string>, plan = planPath) =>
  run(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', boundaryPath, '-Plan', plan], { ...baseEnv(), ...extra }, `${SENTINEL}\n`)
/** The governed entry: cmd.exe /d runs the OUTER boundary, which sanitizes startup inputs and launches the inner script. */
const viaOuter = (extra: Record<string, string>, plan = planPath) =>
  run(CMD_EXE, ['/d', '/c', outerPath, plan], { ...baseEnv(), ...extra }, `${SENTINEL}\n`)
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
  outerPath = join(dir, PRE_NODE_OUTER_BOUNDARY_FILE)
  writeFileSync(outerPath, PRE_NODE_OUTER_BOUNDARY_CMD, 'utf8')
  marker = join(dir, 'preload-executed.txt')
  capture = join(dir, 'preload-captured.txt')
  // R5-A: a malicious PowerShell module on PSModulePath that, on import, records itself and runs a node "trojan".
  psmodRoot = join(dir, 'psmod')
  const evilDir = join(psmodRoot, 'EvilMod')
  mkdirSync(evilDir, { recursive: true })
  moduleMarker = join(dir, 'evil-module-executed.txt')
  trojanMarker = join(dir, 'trojan-executed.txt')
  const trojanScript = join(dir, 'node-trojan.js')
  writeFileSync(trojanScript, `require('node:fs').appendFileSync(${JSON.stringify(trojanMarker)}, 'trojan\\n')\n`)
  writeFileSync(join(evilDir, 'EvilMod.psm1'), `[System.IO.File]::AppendAllText('${moduleMarker}', 'module' + [Environment]::NewLine)\n& '${process.execPath}' '${trojanScript}'\n`)
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
    preNodeOuterBoundarySha256: preNodeOuterBoundarySha256(),
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

describe('the boundary artifacts are the pinned, fixed text the TypeScript side describes', () => {
  it('the inner script carries the exported patterns and allowlist, makes trust decisions with .NET (no autoloadable cmdlet), and nothing is interpolated', () => {
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`$hostile = '${PRE_NODE_HOSTILE_SOURCE}'`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`$injection = '${PRE_NODE_INJECTION_SOURCE}'`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`@(${PRE_NODE_ENV_ALLOWLIST.map((k) => `'${k}'`).join(', ')})`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`$psi.EnvironmentVariables['${PRE_NODE_BOUNDARY_ENV}'] = $self`)
    expect(PRE_NODE_BOUNDARY_PS1).toContain('$psi.EnvironmentVariables.Clear()')
    expect(PRE_NODE_BOUNDARY_PS1).toContain(`exit ${PRE_NODE_REFUSAL_EXIT}`)
    // R5-A: the environment is read and the trust decisions are made with .NET APIs, not autoloadable cmdlets a
    // poisoned PSModulePath could shadow; PSModulePath is cleared before any command that could autoload.
    expect(PRE_NODE_BOUNDARY_PS1).toContain('[System.Environment]::GetEnvironmentVariables()')
    expect(PRE_NODE_BOUNDARY_PS1).toContain('[System.IO.File]::Exists')
    expect(PRE_NODE_BOUNDARY_PS1).toContain("$env:PSModulePath = ''")
    for (const cmdlet of ['Get-FileHash', 'Get-Content', 'Test-Path', 'Get-ChildItem']) expect(PRE_NODE_BOUNDARY_PS1, cmdlet).not.toContain(cmdlet)
    expect(PRE_NODE_BOUNDARY_PS1).not.toMatch(/\$\{|`/)
    expect(preNodeBoundarySha256()).toBe(sha(PRE_NODE_BOUNDARY_PS1))
  })
  it('the outer cmd clears every startup-injection input and launches PowerShell and the script by absolute paths, with /d and without AutoRun', () => {
    for (const k of PRE_NODE_OUTER_SANITIZED) expect(PRE_NODE_OUTER_BOUNDARY_CMD, k).toContain(`set "${k}="`)
    expect(PRE_NODE_OUTER_BOUNDARY_CMD).toContain('@echo off')
    expect(PRE_NODE_OUTER_BOUNDARY_CMD).toContain('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(PRE_NODE_OUTER_BOUNDARY_CMD).toContain(`-File "%~dp0${PRE_NODE_BOUNDARY_FILE}"`)
    expect(PRE_NODE_OUTER_SANITIZED).toContain('PSModulePath')
    expect(preNodeOuterBoundarySha256()).toBe(sha(PRE_NODE_OUTER_BOUNDARY_CMD))
  })
  it('the TypeScript mirror of step (3) is the allowlist plus the mark, nothing inherited', () => {
    const env = boundaryEnvironment({ PATH: '/bin', SystemRoot: 'C:/W', NODE_OPTIONS: '--require=x', SECRET: 's', TEMP: '/t' }, 'e'.repeat(64))
    expect(env).toEqual({ PATH: '/bin', SystemRoot: 'C:/W', TEMP: '/t', [PRE_NODE_BOUNDARY_ENV]: 'e'.repeat(64) })
  })
  it('the hostile pattern covers every Node/OpenSSL/loader input the owner named, in any case', () => {
    for (const n of ['NODE_OPTIONS', 'node_options', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_SYSTEM_CA', 'OPENSSL_CONF', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'UELLIX_D1_MINT_OPERATOR_DATABASE_URL'])
      expect(HOSTILE.test(n), n).toBe(true)
    for (const n of ['PATH', 'SystemRoot', 'TEMP', 'NODEX', 'MY_NODE_OPTIONS']) expect(HOSTILE.test(n), n).toBe(false)
  })
  it('the injection pattern covers the CLR profiler and startup-hook inputs, in any case', () => {
    for (const n of ['COR_ENABLE_PROFILING', 'cor_profiler', 'COR_PROFILER_PATH', 'COR_PROFILER_PATH_64', 'CORECLR_ENABLE_PROFILING', 'CORECLR_PROFILER', 'coreclr_profiler_path', 'DOTNET_STARTUP_HOOKS', 'DOTNET_ADDITIONAL_DEPS'])
      expect(INJECTION.test(n), n).toBe(true)
    // PSModulePath is NOT refused (PowerShell always populates it); it is sanitized by the outer cmd and neutralized by using .NET only.
    for (const n of ['PSModulePath', 'DOTNET_ROOT', 'PATH']) expect(INJECTION.test(n), n).toBe(false)
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

describe.runIf(SHELL_AVAILABLE)('R5-A: the module-shadowing attack, and the boundary against it', () => {
  it('CONTROL: the malicious module is armed — imported from PSModulePath it executes and runs the node trojan', async () => {
    rmSync(moduleMarker, { force: true })
    rmSync(trojanMarker, { force: true })
    const r = await run(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Import-Module EvilMod -Force; exit 0'], { ...baseEnv(), PSModulePath: psmodRoot }, '')
    expect(r.code).toBe(0)
    expect(moduleExecutions()).toBeGreaterThanOrEqual(1)
    expect(trojanExecutions()).toBeGreaterThanOrEqual(1)
  }, 60_000)
  it('the inner script makes trust decisions with .NET only, so a poisoned PSModulePath autoloads nothing: 0 module, 0 trojan', async () => {
    rmSync(moduleMarker, { force: true })
    rmSync(trojanMarker, { force: true })
    await viaBoundary({ PSModulePath: psmodRoot })
    expect(moduleExecutions()).toBe(0)
    expect(trojanExecutions()).toBe(0)
  }, 60_000)
  it.each([['COR_PROFILER', '{01020304-0506-0708-090a-0b0c0d0e0f10}'], ['CORECLR_PROFILER', '{01020304-0506-0708-090a-0b0c0d0e0f10}'], ['DOTNET_STARTUP_HOOKS', join('C:', 'hook.dll')]])(
    'the inner script refuses %s present at entry (fail closed, CLR may be hooked)',
    async (name, value) => {
      const r = await viaBoundary({ [name]: value })
      expect(r.code).toBe(PRE_NODE_REFUSAL_EXIT)
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ code: 'PRE_NODE_AMBIENT_RUNTIME', names: [name] })
    },
    60_000
  )
})

describe.runIf(SHELL_AVAILABLE && process.platform === 'win32')('R5-A (Windows): the outer cmd sanitizes startup-injection inputs before PowerShell starts', () => {
  it('the outer cmd clears the CLR profiler / startup-hook inputs and removes the attacker PSModulePath entry before PowerShell', async () => {
    const d = mkdtempSync(join(tmpdir(), 'd1-r5-outer-'))
    try {
      writeFileSync(join(d, PRE_NODE_OUTER_BOUNDARY_FILE), PRE_NODE_OUTER_BOUNDARY_CMD, 'utf8')
      // A probe standing in for the inner script (same file name) that reports what the CLR process it runs in received.
      writeFileSync(
        join(d, PRE_NODE_BOUNDARY_FILE),
        "param($Plan)\nforeach ($n in @('PSModulePath','COR_PROFILER','CORECLR_PROFILER','DOTNET_STARTUP_HOOKS')) { [Console]::Out.WriteLine($n + '=' + [System.Environment]::GetEnvironmentVariable($n)) }\n",
        'utf8'
      )
      const attacker = join(d, 'attacker-modules')
      const r = await run(CMD_EXE, ['/d', '/c', join(d, PRE_NODE_OUTER_BOUNDARY_FILE), planPath], { ...baseEnv(), PSModulePath: attacker, COR_PROFILER: '{deadbeef-0000-0000-0000-000000000000}', CORECLR_PROFILER: '{deadbeef-0000-0000-0000-000000000000}', DOTNET_STARTUP_HOOKS: join(d, 'hook.dll') }, '')
      expect(r.code).toBe(0)
      const seen = Object.fromEntries(r.stdout.trim().split(/\r?\n/).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      expect(seen.COR_PROFILER).toBe('')
      expect(seen.CORECLR_PROFILER).toBe('')
      expect(seen.DOTNET_STARTUP_HOOKS).toBe('')
      expect(seen.PSModulePath ?? '').not.toContain(attacker)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  }, 90_000)
  it('end to end through the outer boundary, a malicious PSModulePath executes nothing and the channel still runs', async () => {
    rmSync(moduleMarker, { force: true })
    rmSync(trojanMarker, { force: true })
    resetTraps()
    const r = await viaOuter({ PSModulePath: psmodRoot })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('"probe":"OBSERVED"')
    expect(moduleExecutions()).toBe(0)
    expect(trojanExecutions()).toBe(0)
    expect(preloadExecutions()).toBe(0)
  }, 90_000)
})
