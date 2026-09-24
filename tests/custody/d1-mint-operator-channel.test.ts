// tests/custody/d1-mint-operator-channel.test.ts
//
// THE OPERATOR CHANNEL (manifest FIBDB-053-D1-MINT-OPERATOR-CHANNEL-SUCCESSOR-R1:
// P-2, P-3, P-4, N-ECHO, N-ARGV, N-PARENT-ENV, N-WRONG-HOST,
// N-WRONG-VALID-UNTIL, N-WRONG-DRIVER-ROOT, N-STALE-TOOL-HASH,
// N-SYNTHETIC-MODE-REAL-HOST). The launcher's real code runs against stream,
// spawn, console and file doubles, so each refusal is observed where it
// happens: before the prompt, before the spawn, or in the child's options.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  OPERATOR_ENV_VAR_NAME,
  TOOL_ENV_ALLOWLIST,
  TOOL_SPAWN_FLAGS,
  assertToolArgvIsClean,
  buildToolEnvironment,
  inspectOperatorUrl,
  readHiddenLine,
  type HiddenInput,
} from '@/db/custody/mint-operator-channel'
import { PLAN_SCHEMA, parsePlan, runLauncher, toolArgs, type ChannelPlan, type LauncherIo } from '@/scripts/custody/d1-mint-operator-launcher'
import { buildLauncherClosure } from '@/scripts/custody/d1-mint-operator-channel-build'
import { checkExecutables, checkUtcMargin, derivePlan, deriveTargetHost, routeBDriver, verifyPlan } from '@/scripts/custody/d1-mint-operator-plan'
import { readChannelBinding } from '@/scripts/custody/d1-mint-operator-evidence'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'

const ROOT = process.cwd()
const { binding: BINDING } = readChannelBinding(ROOT)
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A console-like input: isTTY, setRawMode honoured (or not), bytes delivered on resume. */
class FakeTty extends EventEmitter implements HiddenInput {
  isRaw = false
  resumed = false
  readonly modes: boolean[] = []
  constructor(
    readonly isTTY: boolean,
    private readonly keystrokes: Buffer,
    private readonly honoursRaw = true
  ) {
    super()
  }
  setRawMode(mode: boolean): this {
    this.modes.push(mode)
    if (this.honoursRaw) this.isRaw = mode
    return this
  }
  resume(): this {
    this.resumed = true
    queueMicrotask(() => this.emit('data', Buffer.from(this.keystrokes)))
    return this
  }
  pause(): this {
    return this
  }
}

const sink = () => {
  const writes: string[] = []
  return { writes, write: (s: string) => void writes.push(s) }
}

const SYNTH_HOST = 'db.channel-test.invalid'
const REAL_LIKE_HOST = 'db.bvyzblhqymxruxdguaee.supabase.co'
const PASSWORD = 'Synth-Pass-4f9a2c'
const url = (host: string, user = 'postgres', pw = PASSWORD) => ['postgresql:', `//${user}:`, pw, '@', host, ':5432/postgres'].join('')
const TOOL_BYTES = Buffer.from('// a tool double\n')

function plan(over: Partial<ChannelPlan> = {}): ChannelPlan {
  return {
    schema: PLAN_SCHEMA,
    mode: 'probe',
    targetHost: SYNTH_HOST,
    operatorPrincipal: null,
    validUntil: null,
    driverRoot: 'C:/driver-root',
    driverVersion: '3.4.9',
    depositor: null,
    tool: { path: 'C:/tools/probe.js', sha256: sha(TOOL_BYTES) },
    launcherDigest: 'a'.repeat(64),
    derivedAtHead: 'b'.repeat(40),
    derivedAtUtc: '2026-09-24T00:00:00.000Z',
    ...over,
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: { env: Record<string, string>; windowsHide: boolean; detached: boolean; shell: boolean; stdio: unknown }
}

function harness(o: { stdin: FakeTty | PassThrough; plan?: ChannelPlan; env?: Record<string, string>; console?: boolean; toolBytes?: Buffer }) {
  const calls: SpawnCall[] = []
  const stdout = sink()
  const stderr = sink()
  const p = o.plan ?? plan()
  const io: LauncherIo = {
    stdin: o.stdin as unknown as LauncherIo['stdin'],
    stdout,
    stderr,
    env: o.env ?? { PATH: 'C:/bin', SystemRoot: 'C:/Windows', HOME_SECRET_LIKE: 'must-not-pass', TEMP: 'C:/t' },
    readFile: (path: string) => (path === 'plan.json' ? Buffer.from(JSON.stringify(p)) : (o.toolBytes ?? TOOL_BYTES)),
    isAttachedToConsole: async () => o.console ?? true,
    spawn: ((command: string, args: string[], options: SpawnCall['options']) => {
      calls.push({ command, args, options })
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 4242
      setTimeout(() => {
        child.stdout.end('{"probe":"OBSERVED"}\n')
        child.emit('close', 0, null)
      }, 5)
      return child
    }) as unknown as LauncherIo['spawn'],
    execPath: 'C:/node.exe',
  }
  return { io, calls, stdout, stderr, run: () => runLauncher(['--plan=plan.json'], io) }
}

const tty = (text: string, honoursRaw = true) => new FakeTty(true, Buffer.from(text, 'utf8'), honoursRaw)

// ---------------------------------------------------------------------------

describe('P-2: the launcher build is deterministic and pinned', () => {
  it('rebuilding from this repository gives exactly CHANNEL_BINDING.launcher_build_digest', () => {
    expect(BINDING).not.toBeNull()
    expect(buildLauncherClosure(ROOT).digest).toBe(BINDING!.launcher_build_digest)
  })
  it('CRLF and LF checkouts of the same sources build the same bytes', () => {
    const lf = buildLauncherClosure(ROOT, (abs) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'))
    const crlf = buildLauncherClosure(ROOT, (abs) => readFileSync(abs, 'utf8').replace(/\r?\n/g, '\r\n'))
    expect(crlf.digest).toBe(lf.digest)
    expect(Object.keys(lf.files).length).toBeGreaterThan(1)
  })
  it('a one-byte source change changes the digest (a stale pin is detectable)', () => {
    const changed = buildLauncherClosure(ROOT, (abs) => readFileSync(abs, 'utf8') + (abs.endsWith('d1-mint-operator-launcher.ts') ? '\n// x\n' : ''))
    expect(changed.digest).not.toBe(BINDING!.launcher_build_digest)
  })
})

describe('N-ECHO: the prompt echoes nothing', () => {
  it('reads the line in raw mode, writes only the prompt and a newline, restores cooked mode', async () => {
    const input = tty(`${url(SYNTH_HOST)}\r`)
    const out = sink()
    const got = await readHiddenLine(input, out)
    expect(got.toString('utf8')).toBe(url(SYNTH_HOST))
    expect(input.modes).toEqual([true, false])
    expect(out.writes.join('')).not.toContain(PASSWORD)
    expect(out.writes.join('').replace(/[^\n]/g, '')).toBe('\n')
    expect(out.writes.every((w) => !/[a-z]{3,}:\/\//.test(w))).toBe(true)
  })
  it('backspace removes a byte, and nothing is written for it', async () => {
    const out = sink()
    const got = await readHiddenLine(tty(`abX\x7fc\r`), out)
    expect(got.toString()).toBe('abc')
    expect(out.writes.join('')).not.toMatch(/ab|X|\x08/)
  })
  it('refuses a non-TTY input before writing or reading anything', async () => {
    const input = new FakeTty(false, Buffer.from('x\r'))
    const out = sink()
    await expect(readHiddenLine(input, out)).rejects.toMatchObject({ code: 'CHANNEL_NO_CONSOLE_INPUT' })
    expect(out.writes).toEqual([])
    expect(input.resumed).toBe(false)
  })
  it('refuses a console that does not enter raw mode (echo would stay on), and restores it', async () => {
    const input = tty('secret\r', false)
    await expect(readHiddenLine(input, sink())).rejects.toMatchObject({ code: 'CHANNEL_ECHO_NOT_DISABLED' })
    expect(input.resumed).toBe(false)
  })
  it('Ctrl-C aborts with nothing returned', async () => {
    await expect(readHiddenLine(tty('abc\x03'), sink())).rejects.toMatchObject({ code: 'CHANNEL_ABORTED' })
  })
})

describe('P-3: one child, the value only in its environment block', () => {
  it('spawns exactly one tool with the allowlisted environment plus the one variable, and the pinned flags', async () => {
    const h = harness({ stdin: tty(`${url(SYNTH_HOST)}\r`) })
    const before = { ...h.io.env }
    expect(await h.run()).toBe(0)
    expect(h.calls).toHaveLength(1)
    const c = h.calls[0]!
    expect(c.command).toBe('C:/node.exe')
    expect(c.args).toEqual(toolArgs(plan()))
    expect(Object.keys(c.options.env).sort()).toEqual([...TOOL_ENV_ALLOWLIST.filter((k) => h.io.env[k] !== undefined), OPERATOR_ENV_VAR_NAME].sort())
    expect(c.options.env[OPERATOR_ENV_VAR_NAME]).toBe(url(SYNTH_HOST))
    expect(c.options.env.HOME_SECRET_LIKE).toBeUndefined()
    // Literal, not TOOL_SPAWN_FLAGS: a comparison with the constant under test would accept any value it held.
    expect({ windowsHide: c.options.windowsHide, detached: c.options.detached, shell: c.options.shell }).toEqual({ windowsHide: false, detached: false, shell: false })
    expect(TOOL_SPAWN_FLAGS).toEqual({ windowsHide: false, detached: false, shell: false })
    // N-PARENT-ENV: the launcher's own environment is unchanged.
    expect(h.io.env).toEqual(before)
    expect(h.io.env[OPERATOR_ENV_VAR_NAME]).toBeUndefined()
    // Nothing of the value reached the launcher's streams.
    const all = [...h.stdout.writes, ...h.stderr.writes].join('')
    expect(all).not.toContain(PASSWORD)
    expect(all).toContain('"launcher":"TOOL_EXITED"')
  })
  it('the mint tool argv carries the plan fields and nothing secret', () => {
    const p = plan({ mode: 'mint', operatorPrincipal: 'postgres', validUntil: '2026-09-29T14:00:00.000Z', depositor: 'C:/c/deposit.js' })
    const args = toolArgs(p)
    expect(args).toEqual([p.tool.path, '--driver-root=C:/driver-root', `--target-host=${SYNTH_HOST}`, '--depositor=C:/c/deposit.js', '--valid-until=2026-09-29T14:00:00.000Z', '--operator-principal=postgres'])
    expect(() => assertToolArgvIsClean(args, Buffer.from(url(SYNTH_HOST)), Buffer.from(PASSWORD))).not.toThrow()
  })
})

describe('refusals, each before anything is spawned', () => {
  const refused = async (h: ReturnType<typeof harness>, code: string) => {
    await expect(h.run()).rejects.toMatchObject({ code })
    expect(h.calls).toEqual([])
  }
  it('N-PARENT-ENV: an ambient operator variable in the launcher is refused', async () => {
    await refused(harness({ stdin: tty(`${url(SYNTH_HOST)}\r`), env: { PATH: 'x', [OPERATOR_ENV_VAR_NAME]: url(SYNTH_HOST) } }), 'CHANNEL_AMBIENT_VALUE')
  })
  it('N-WRONG-HOST: a string naming another host is refused', async () => {
    await refused(harness({ stdin: tty(`${url('db.elsewhere.invalid')}\r`) }), 'CHANNEL_WRONG_HOST')
  })
  it('N-WRONG-HOST (principal): for the mint, a string naming another principal is refused', async () => {
    const p = plan({ mode: 'mint', operatorPrincipal: 'postgres', validUntil: '2026-09-29T14:00:00.000Z', depositor: 'C:/d.js' })
    await refused(harness({ stdin: tty(`${url(SYNTH_HOST, 'someone_else')}\r`), plan: p }), 'CHANNEL_WRONG_PRINCIPAL')
  })
  it('N-STALE-TOOL-HASH: a tool whose bytes differ from the plan pin is refused before the prompt', async () => {
    const input = tty(`${url(SYNTH_HOST)}\r`)
    await refused(harness({ stdin: input, toolBytes: Buffer.from('// tampered\n') }), 'CHANNEL_TOOL_HASH_MISMATCH')
    expect(input.resumed).toBe(false)
  })
  it('OC-1: a launcher without a console is refused before the prompt', async () => {
    const input = tty(`${url(SYNTH_HOST)}\r`)
    await refused(harness({ stdin: input, console: false }), 'CHANNEL_NO_CONSOLE')
    expect(input.resumed).toBe(false)
  })
  it('N-SYNTHETIC-MODE-REAL-HOST: piped input is refused for a real-looking host', async () => {
    const pipe = new PassThrough()
    pipe.end(`${url(REAL_LIKE_HOST)}\n`)
    await refused(harness({ stdin: pipe, plan: plan({ targetHost: REAL_LIKE_HOST }) }), 'CHANNEL_NO_CONSOLE_INPUT')
  })
  it('piped input IS accepted for an RFC 6761 .invalid host (the synthetic demonstration path)', async () => {
    const pipe = new PassThrough()
    pipe.end(`${url(SYNTH_HOST)}\n`)
    const h = harness({ stdin: pipe })
    expect(await h.run()).toBe(0)
    expect(h.calls).toHaveLength(1)
  })
  it('a malformed plan or extra argument is refused', async () => {
    const h = harness({ stdin: tty('x\r') })
    await expect(runLauncher(['--plan=plan.json', '--extra'], h.io)).rejects.toMatchObject({ code: 'CHANNEL_ARGUMENTS' })
    expect(() => parsePlan(JSON.stringify({ ...plan(), mode: 'mint' }))).toThrow(/shape/)
    expect(() => parsePlan(JSON.stringify({ ...plan(), tool: { path: 'x', sha256: 'nothex' } }))).toThrow(/shape/)
  })
})

describe('N-ARGV: the argv guard', () => {
  const s = Buffer.from(url(SYNTH_HOST))
  const pw = Buffer.from(PASSWORD)
  it.each([
    ['the whole string', [`--x=${url(SYNTH_HOST)}`]],
    ['the password alone', [`--x=${PASSWORD}`]],
    ['the password in base64', [`--x=${Buffer.from(PASSWORD).toString('base64')}`]],
  ])('%s is refused', (_n, args) => {
    expect(() => assertToolArgvIsClean(args, s, pw)).toThrow()
  })
})

describe('the value is checked before any process exists', () => {
  it.each([
    ['not a URL', 'not a url'],
    ['another scheme', 'https://u:p@h/x'],
    ['no password', 'postgresql://u@h/x'],
    ['a space', `${url(SYNTH_HOST)} `],
  ])('%s is refused', (_n, v) => {
    expect(() => inspectOperatorUrl(Buffer.from(v))).toThrow()
  })
  it('an allowlisted environment never includes an unlisted variable', () => {
    const env = buildToolEnvironment({ PATH: 'p', AWS_SECRET_ACCESS_KEY: 'x', NODE_OPTIONS: '--require evil' }, Buffer.from('v'))
    expect(env).toEqual({ PATH: 'p', [OPERATOR_ENV_VAR_NAME]: 'v' })
  })
})

describe('P-4 and the execution-procedure STOPs (plan derived from the repository only)', () => {
  const NOW = '2026-09-24T12:00:00.000Z'
  const derived = derivePlan(ROOT, { mode: 'probe', toolsDir: 'C:/tools', depositor: null, head: 'c'.repeat(40), nowUtc: NOW })
  it('the probe plan derives with no reason, from N04, route B and the binding', () => {
    expect(derived.reasons).toEqual([])
    const p = derived.plan!
    expect(p.targetHost).toBe(deriveTargetHost(ROOT).host)
    expect(p.driverVersion).toBe('3.4.9')
    expect(p.driverRoot).toBe(routeBDriver(ROOT).driverRoot)
    expect(p.tool).toEqual({ path: join('C:/tools', BINDING!.tools.probe.file), sha256: BINDING!.tools.probe.sha256 })
    expect(p.launcherDigest).toBe(BINDING!.launcher_build_digest)
    expect(verifyPlan(p, p)).toEqual([])
  })
  it.each([
    ['targetHost', { targetHost: 'db.elsewhere.supabase.co' }],
    ['validUntil', { validUntil: '2099-01-01T00:00:00.000Z' }],
    ['driverRoot', { driverRoot: 'C:/another-root' }],
    ['driverVersion', { driverVersion: '3.4.8' }],
    ['tool.sha256', { tool: { path: join('C:/tools', BINDING!.tools.probe.file), sha256: 'f'.repeat(64) } }],
    ['launcherDigest', { launcherDigest: 'f'.repeat(64) }],
    ['operatorPrincipal', { operatorPrincipal: 'someone' }],
  ] as Array<[string, Partial<ChannelPlan>]>)('a plan on disk whose %s differs -> STOP_PLAN_MISMATCH', (field, over) => {
    const r = verifyPlan({ ...derived.plan!, ...over }, derived.plan!)
    expect(r).toEqual([`STOP_PLAN_MISMATCH: ${field} on disk differs from the repository derivation`])
  })
  it('the mint cannot be planned without closed OEP-1 evidence', () => {
    const m = derivePlan(ROOT, { mode: 'mint', toolsDir: 'C:/tools', depositor: 'C:/c/deposit.js', head: 'c'.repeat(40), nowUtc: NOW })
    expect(m.plan).toBeNull()
    expect(m.reasons.join(' ')).toMatch(/OEP-1: no OEP-1 evidence exists/)
  })
  it('N-STALE-TOOL-HASH / launcher: the files that will run are compared with the pins', () => {
    const p = { ...derived.plan!, tool: { path: 'tool.js', sha256: sha(TOOL_BYTES) } }
    expect(checkExecutables({ plan: p, launcherDiskDigest: p.launcherDigest, readFile: () => TOOL_BYTES })).toEqual([])
    expect(checkExecutables({ plan: p, launcherDiskDigest: p.launcherDigest, readFile: () => Buffer.from('// one byte off\n') })).toEqual(['STOP_STALE_TOOL_HASH: the tool file on disk is not the pinned bytes'])
    expect(checkExecutables({ plan: p, launcherDiskDigest: '0'.repeat(64), readFile: () => TOOL_BYTES })).toEqual(['STOP_STALE_LAUNCHER_HASH: the launcher build on disk is not the pinned build'])
    expect(
      checkExecutables({
        plan: p,
        launcherDiskDigest: p.launcherDigest,
        readFile: () => {
          throw new Error('absent')
        },
      })
    ).toEqual(['STOP_TOOL_MISSING: the pinned tool file cannot be read'])
  })
  it('the UTC clock is checked against the effective N08 (NB-3)', () => {
    const n08 = deriveEffectiveSchedule(ROOT).N08!
    expect(checkUtcMargin(new Date(Date.parse(n08) - 3_600_000).toISOString(), n08)).toEqual({ reasons: [], marginMs: 3_600_000 })
    expect(checkUtcMargin(n08, n08).reasons).toEqual(['STOP_SCHEDULE_ELAPSED: the UTC clock is at or past N08'])
  })
})
