// scripts/custody/d1-consumer-shell.ts
//
// THE SHELL EVERY PRODUCTION D-1 AUDITOR CONSUMER RUNS IN (N13, N14, N21, N22).
//
// One place for what must not drift between consumers:
//
//   - the argument allowlist: --mode, --dwell-ms, --driver-root, and nothing
//     else. An unknown argument is refused without being echoed, because a
//     consumer that tolerated extra arguments would tolerate one carrying the
//     value;
//   - the modes: dry-run / dry-run-fail / expect-absent never open a session;
//     execute does, through the one real transport, loaded lazily from an
//     explicit driver root, reserved for a separately authorized lane;
//   - the output: exactly one JSON line of booleans, codes and pinned
//     statement texts. Never the value, its length, its host or its userinfo.
//
// Each consumer reads the value ONLY from its own environment block, as the
// N05 delivery path left it, through resolveAuditorDatabaseUrl.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { N13Connect, N13Transport, Row } from '../../db/custody/n13-verification'

export type ConsumerMode = 'dry-run' | 'dry-run-fail' | 'expect-absent' | 'execute'

const KNOWN_ARGUMENTS = ['--mode=', '--dwell-ms=', '--driver-root='] as const

export function assertKnownArguments(argv: readonly string[]): void {
  for (const a of argv) {
    if (!KNOWN_ARGUMENTS.some((k) => a.startsWith(k))) {
      throw Object.assign(new Error('Unrecognised consumer argument (not echoed).'), { code: 'CONSUMER_UNKNOWN_ARGUMENT' })
    }
  }
}

export function parseMode(argv: readonly string[]): ConsumerMode {
  const raw = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
  if (raw === 'dry-run' || raw === 'dry-run-fail' || raw === 'expect-absent' || raw === 'execute') return raw
  throw new Error('--mode must be dry-run, dry-run-fail, expect-absent or execute.')
}

function dwell(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The one real transport. Loaded lazily, ONLY in execute mode, from an
 * explicit driver root, so a dry run never has a driver in memory at all.
 * One reserved connection, so BEGIN READ ONLY, the reads and the ROLLBACK
 * share a backend; no prepared statements; TLS required; notices discarded.
 */
export function postgresTransport(driverRoot: string): N13Connect {
  return async (url: string): Promise<N13Transport> => {
    const req = createRequire(join(driverRoot, 'package.json'))
    const postgres = req('postgres') as (u: string, o: Record<string, unknown>) => {
      reserve(): Promise<{ unsafe(q: string): Promise<readonly Row[]>; release(): void }>
      end(o: { timeout: number }): Promise<void>
    }
    const sql = postgres(url, {
      max: 1,
      prepare: false,
      ssl: 'require',
      connect_timeout: 15,
      idle_timeout: 5,
      onnotice: () => undefined,
      connection: { application_name: 'uellix-d1-auditor' },
    })
    const reserved = await sql.reserve()
    return {
      query: async (q: string) => Array.from(await reserved.unsafe(q)),
      close: async () => {
        reserved.release()
        await sql.end({ timeout: 5 })
      },
    }
  }
}

/** What each node reports back to the shell. */
export interface ConsumerRun {
  readonly resolved: boolean
  readonly connected: boolean
  readonly ok: boolean
  readonly report: Readonly<Record<string, unknown>>
}

export async function consumerMain(
  node: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  run: (env: Readonly<Record<string, string | undefined>>, connect: N13Connect | undefined) => Promise<ConsumerRun>
): Promise<number> {
  assertKnownArguments(argv)
  const mode = parseMode(argv)
  const dwellMs = Math.min(Math.max(Number(argv.find((a) => a.startsWith('--dwell-ms='))?.slice(11) ?? '0') || 0, 0), 30_000)
  let connect: N13Connect | undefined
  if (mode === 'execute') {
    const driverRoot = argv.find((a) => a.startsWith('--driver-root='))?.slice('--driver-root='.length)
    if (driverRoot === undefined || driverRoot === '') throw new Error('--mode=execute requires --driver-root.')
    connect = postgresTransport(driverRoot)
  }

  const r = await run(env, connect)
  if (mode !== 'execute') dwell(dwellMs)

  process.stdout.write(`${JSON.stringify({ node, mode, resolved: r.resolved, connected: r.connected, ok: r.ok, ...r.report })}\n`)

  switch (mode) {
    case 'execute':
      return r.ok ? 0 : 1
    case 'expect-absent':
      return r.resolved ? 1 : 0
    case 'dry-run':
      return r.resolved && !r.connected ? 0 : 1
    case 'dry-run-fail':
      return 1
  }
}

/** The shared CLI tail: run main when this file is the entry point, report failure by code only. */
export function runIfEntry(pattern: RegExp, node: string, main: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>): void {
  if (!pattern.test(process.argv[1] ?? '')) return
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      process.stdout.write(`${JSON.stringify({ node, aborted: true, code: (e as { code?: string }).code ?? `${node}_ABORTED` })}\n`)
      process.exitCode = 2
    })
}
