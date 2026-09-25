// @vitest-environment node
// tests/custody/custody-delivery-isolation.test.ts
//
// THE DELIVERY AND BRIDGE INVARIANTS, KILLED ON EVERY PLATFORM.
//
// The independent certification of the first custody candidate showed that
// the invariants this mechanism rests on had NO control that could fail on
// the only runners this repository has. Six mutants survived the whole custody
// suite: the value appended to the bridge argv, `process.env` written during
// delivery (outright, or written and deleted again), the consumer-argv check
// disabled, the ambient-value refusal disabled, and the base64 value appended
// to the consumer argv. A seventh — the consumer spawned with
// `windowsHide: true`, which gives it a conhost.exe that inherits the value —
// was the blocker B-1 itself.
//
// Here `node:child_process` is replaced by a fake that plays the bridge's wire
// protocol and records every spawn: its command, argv, options and exactly the
// bytes that reached its stdin. Nothing in this file touches a real vault or
// starts a real process, so every assertion runs on ubuntu-latest.

import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

import { spawn } from 'node:child_process'
import { encodeBase64Bytes } from '@/db/custody/base64-bytes'
import {
  CustodyError,
  bridgeArgv,
  depositCredential,
  retrieveCredential,
  sweepCredentials,
} from '@/db/custody/wcm-credential-store'
import { CONSUMER_SPAWN_FLAGS, runWithDeliveredSecret } from '@/db/custody/process-delivery'

const VAR = 'UELLIX_AUDITOR_DATABASE_URL'
const TARGET = 'UELLIX-N05-SENTINEL-UNITTEST'
// A synthetic value, assembled at run time so no credential-shaped literal sits in the file.
const VALUE = Buffer.from(['postgresql:', '//unit:', 'q'.repeat(24), '@unit.invalid:5432/unit'].join(''), 'utf8')

interface SpawnRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean; detached?: boolean }
  /** Bytes as the child actually received them, copied when the write FLUSHED. */
  readonly stdin: Buffer[]
}

const spawns: SpawnRecord[] = []
const vault = new Map<string, Buffer>()
let consoleAttached = true
let corruptBlobLine = false
/** When true the fake bridge ignores the enumeration prefix and returns every entry. */
let sweepOverReturns = false

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

class FakeChild extends EventEmitter {
  readonly pid = 4242 + spawns.length
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  constructor(private readonly rec: SpawnRecord, private readonly isBridge: boolean) {
    super()
    this.stdin = new Writable({
      // The copy is taken on the NEXT tick, the way a real pipe drains a queued
      // write. A caller that zeroes its buffer before the flush callback — the
      // race the first implementation had — is caught delivering zeros.
      write: (chunk: Buffer, _enc, cb) => {
        setImmediate(() => {
          rec.stdin.push(Buffer.from(chunk))
          cb()
        })
      },
    })
    this.stdin.on('finish', () => this.respond())
    if (!isBridge) setImmediate(() => this.close(0))
  }
  kill(): boolean {
    this.close(null)
    return true
  }
  private close(code: number | null): void {
    setImmediate(() => this.emit('close', code, null))
  }
  private respond(): void {
    if (!this.isBridge) return
    const lines = Buffer.concat(this.rec.stdin).toString('ascii').split('\n').filter(Boolean)
    const req = JSON.parse(Buffer.from(lines[0]!, 'base64').toString('utf8')) as {
      op: string
      target?: string
      prefix?: string
    }
    const out: string[] = []
    const reply = (o: object): number => out.push(b64(JSON.stringify(o)))
    if (req.op === 'deposit') {
      vault.set(req.target!, Buffer.from(lines[1]!, 'base64'))
      reply({ ok: true, win32: 0 })
    } else if (req.op === 'retrieve') {
      const v = vault.get(req.target!)
      if (v === undefined) reply({ ok: false, present: false, win32: 1168 })
      else {
        reply({ ok: true, present: true, win32: 0, blobFollows: true })
        out.push(corruptBlobLine ? 'not*base64' : v.toString('base64'))
      }
    } else if (req.op === 'probe') {
      reply({ ok: true, present: vault.has(req.target!), win32: 0 })
    } else if (req.op === 'remove') {
      reply({ ok: true, deleted: vault.delete(req.target!), win32: 0 })
    } else if (req.op === 'sweep') {
      const all = [...vault.keys()]
      reply({ ok: true, targets: sweepOverReturns ? all : all.filter((k) => k.startsWith(req.prefix!)), win32: 0 })
    } else if (req.op === 'console') {
      reply({ ok: true, attached: consoleAttached, win32: consoleAttached ? 0 : 6 })
    }
    setImmediate(() => {
      this.stdout.end(Buffer.from(`${out.join('\r\n')}\r\n`, 'ascii'))
      this.close(0)
    })
  }
}

function fakeSpawn(command: string, args: readonly string[], options: SpawnRecord['options']): FakeChild {
  const rec: SpawnRecord = { command, args: [...args], options, stdin: [] }
  spawns.push(rec)
  return new FakeChild(rec, command === 'powershell.exe')
}

const bridgeSpawns = (): SpawnRecord[] => spawns.filter((s) => s.command === 'powershell.exe')
const consumerSpawns = (): SpawnRecord[] => spawns.filter((s) => s.command !== 'powershell.exe')
const bridgeOps = (): string[] =>
  bridgeSpawns().map(
    (s) => (JSON.parse(Buffer.from(Buffer.concat(s.stdin).toString('ascii').split('\n')[0]!, 'base64').toString('utf8')) as { op: string }).op
  )

/** Every governed representation the mechanism creates: the raw value and its base64. */
function carriesValue(text: string): boolean {
  const bytes = Buffer.from(text, 'utf8')
  return bytes.includes(VALUE) || bytes.includes(encodeBase64Bytes(VALUE))
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
})
beforeEach(() => {
  spawns.length = 0
  vault.clear()
  consoleAttached = true
  corruptBlobLine = false
  sweepOverReturns = false
  delete process.env[VAR]
  vi.mocked(spawn).mockImplementation(fakeSpawn as unknown as typeof spawn)
})
afterEach(() => {
  delete process.env[VAR]
})

async function seed(): Promise<void> {
  await depositCredential({ target: TARGET, username: 'unit', secret: Buffer.from(VALUE) })
  spawns.length = 0
}

describe('the bridge: the value crosses on stdin, never on argv (kills M05 and the zeroing race)', () => {
  it('launches the bridge with exactly bridgeArgv(), which carries no representation of the value', async () => {
    await depositCredential({ target: TARGET, username: 'unit', secret: Buffer.from(VALUE) })
    const [b] = bridgeSpawns()
    expect(b!.args).toEqual([...bridgeArgv()])
    for (const a of b!.args) expect(carriesValue(a)).toBe(false)
  })

  it('gives the bridge an allowlisted environment that does not carry the delivery variable', async () => {
    process.env.UELLIX_UNRELATED_SECRET_PROBE = 'must-not-inherit'
    try {
      await depositCredential({ target: TARGET, username: 'unit', secret: Buffer.from(VALUE) })
      const env = (bridgeSpawns()[0]!.options.env ?? {}) as NodeJS.ProcessEnv
      expect(env[VAR]).toBeUndefined()
      expect(env.UELLIX_UNRELATED_SECRET_PROBE).toBeUndefined()
    } finally {
      delete process.env.UELLIX_UNRELATED_SECRET_PROBE
    }
  })

  it('delivers the real bytes, not zeros: the buffer is zeroed only after the pipe flushed', async () => {
    await depositCredential({ target: TARGET, username: 'unit', secret: Buffer.from(VALUE) })
    expect(vault.get(TARGET)!.equals(VALUE)).toBe(true)
  })

  it('returns the stored bytes from a retrieval, decoded from the blob line', async () => {
    await seed()
    const got = await retrieveCredential(TARGET)
    expect(got?.equals(VALUE)).toBe(true)
  })

  it('refuses a blob line that is not strict base64 instead of returning a wrong value', async () => {
    await seed()
    corruptBlobLine = true
    await expect(retrieveCredential(TARGET)).rejects.toMatchObject({ code: 'CUSTODY_BRIDGE_PROTOCOL' })
  })
})

describe('delivery: the value reaches ONE child environment and nothing else', () => {
  it('spawns the consumer without CREATE_NO_WINDOW and without DETACHED_PROCESS (B-1 regression)', async () => {
    await seed()
    await runWithDeliveredSecret({ target: TARGET, envVarName: VAR, command: 'consumer.exe', args: ['--mode=success'] })
    const [c] = consumerSpawns()
    expect(c!.options.windowsHide).toBe(false)
    expect(c!.options.detached).not.toBe(true)
    expect(CONSUMER_SPAWN_FLAGS).toEqual({ windowsHide: false, detached: false })
  })

  it('puts the value in the consumer environment block, and the argv carries no representation of it (kills D13)', async () => {
    await seed()
    await runWithDeliveredSecret({ target: TARGET, envVarName: VAR, command: 'consumer.exe', args: ['--mode=success'] })
    const [c] = consumerSpawns()
    expect(c!.options.env?.[VAR]).toBe(VALUE.toString('utf8'))
    expect(c!.args).toEqual(['--mode=success'])
    for (const a of c!.args) expect(carriesValue(a)).toBe(false)
  })

  it('never writes this process environment, not even transiently (kills M06 and D11)', async () => {
    await seed()
    const real = process.env
    const writes: string[] = []
    process.env = new Proxy(real, {
      set(t, k, v) {
        writes.push(`set ${String(k)}`)
        return Reflect.set(t, k, v)
      },
      deleteProperty(t, k) {
        writes.push(`delete ${String(k)}`)
        return Reflect.deleteProperty(t, k)
      },
      defineProperty(t, k, d) {
        writes.push(`define ${String(k)}`)
        return Reflect.defineProperty(t, k, d)
      },
    })
    try {
      await runWithDeliveredSecret({ target: TARGET, envVarName: VAR, command: 'consumer.exe', args: [] })
      await new Promise((r) => setTimeout(r, 150))
    } finally {
      process.env = real
    }
    expect(writes).toEqual([])
    expect(process.env[VAR]).toBeUndefined()
  })

  it.each([
    ['the raw value', (): string => VALUE.toString('utf8')],
    ['the base64 value', (): string => VALUE.toString('base64')],
    ['the raw value inside a flag', (): string => `--dsn=${VALUE.toString('utf8')}`],
  ])('refuses a consumer argv carrying %s, before any consumer starts (kills M07)', async (_label, arg) => {
    await seed()
    await expect(
      runWithDeliveredSecret({ target: TARGET, envVarName: VAR, command: 'consumer.exe', args: [arg()] })
    ).rejects.toBeInstanceOf(CustodyError)
    expect(consumerSpawns()).toHaveLength(0)
  })

  it('refuses to run beside an ambient value, before touching the vault (kills M08)', async () => {
    await seed()
    process.env[VAR] = 'ambient'
    await expect(
      runWithDeliveredSecret({ target: TARGET, envVarName: VAR, command: 'consumer.exe', args: [] })
    ).rejects.toBeInstanceOf(CustodyError)
    expect(spawns).toHaveLength(0)
  })

  it('refuses a launcher with no console BEFORE the vault is read (B-1 precondition)', async () => {
    await seed()
    consoleAttached = false
    await expect(
      runWithDeliveredSecret({ target: TARGET, envVarName: VAR, command: 'consumer.exe', args: [] })
    ).rejects.toMatchObject({ code: 'CUSTODY_DELIVERY_TOPOLOGY_UNSAFE' })
    expect(bridgeOps()).toEqual(['console'])
    expect(consumerSpawns()).toHaveLength(0)
  })
})

describe('the recovery sweep is bounded to the sentinel namespace (OF-CUST-3)', () => {
  it.each(['GIT', 'UELLIX', 'UELLIX-AUDITOR', 'UELLIX-N05-SENTINELX'])('refuses to sweep %s without starting a bridge', async (prefix) => {
    await expect(sweepCredentials(prefix)).rejects.toMatchObject({ code: 'CUSTODY_TARGET_INVALID' })
    expect(spawns).toHaveLength(0)
  })

  it('sweeps inside the namespace', async () => {
    await seed()
    await expect(sweepCredentials('UELLIX-N05-SENTINEL')).resolves.toEqual([TARGET])
  })

  it('enumerates the namespace WITH its separator, so a UELLIX-N05-SENTINELX-* decoy survives', async () => {
    const DECOY = 'UELLIX-N05-SENTINELX-DECOY'
    vault.set(DECOY, Buffer.from('decoy'))
    await seed()
    await expect(sweepCredentials('UELLIX-N05-SENTINEL')).resolves.toEqual([TARGET])
    const firstLine = Buffer.concat(bridgeSpawns()[0]!.stdin).toString('ascii').split(/\r?\n/)[0]!
    const req = JSON.parse(Buffer.from(firstLine, 'base64').toString('utf8')) as { prefix: string }
    expect(req.prefix).toBe('UELLIX-N05-SENTINEL-')
    expect(vault.has(DECOY)).toBe(true)
  })

  it('re-filters what the bridge returns, so an over-returning enumeration cannot widen a sweep', async () => {
    const DECOY = 'UELLIX-N05-SENTINELX-DECOY'
    vault.set(DECOY, Buffer.from('decoy'))
    vault.set('GIT-UNRELATED', Buffer.from('other'))
    await seed()
    sweepOverReturns = true
    await expect(sweepCredentials('UELLIX-N05-SENTINEL')).resolves.toEqual([TARGET])
  })
})
