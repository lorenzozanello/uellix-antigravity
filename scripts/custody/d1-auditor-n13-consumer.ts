// scripts/custody/d1-auditor-n13-consumer.ts
//
// THE PRODUCTION CONSUMER OF THE DELIVERED D-1 AUDITOR CREDENTIAL (DAG N13).
//
// Built to plain CommonJS by build-production-entrypoints.ts and started ONLY
// by the N05 delivery path (scripts/custody/d1-deliver-n13.ts), which puts the
// value into this process's environment block as UELLIX_AUDITOR_DATABASE_URL
// at CreateProcess time and nowhere else. It never takes the value as an
// argument; its arguments are a mode, and in execute mode the directory the
// PostgreSQL driver is loaded from.
//
//   --mode=dry-run          resolve the delivered value, run every check that
//                           precedes a socket, and STOP before opening one.
//                           Exit 0 when the value was resolved and no session
//                           was opened. This is the only mode a lane without
//                           a fresh HC-1 chain may run.
//   --mode=dry-run-fail     the same, then exit 1: a real consumer failure with
//                           the value live, for the failure-path removal proof.
//   --mode=expect-absent    run with NO delivery; exit 0 only if nothing resolved.
//   --mode=execute          open ONE session through the driver and run N13.
//                           Requires --driver-root. Authorized only by the
//                           separate execution lane after a fresh HC-1 chain.
//   --dwell-ms=<n>          hold the value live for an external observer
//                           (dry-run modes only; capped at 30s).
//
// It prints exactly one JSON line of booleans, codes and pinned statement
// texts. Never the value, its length, its host or its userinfo.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runN13Verification, type N13Connect, type N13Transport, type Row } from '../../db/custody/n13-verification'

type Mode = 'dry-run' | 'dry-run-fail' | 'expect-absent' | 'execute'

const KNOWN_ARGUMENTS = ['--mode=', '--dwell-ms=', '--driver-root='] as const

/**
 * Every argument must be one of the three known, non-secret flags. An unknown
 * argument is refused rather than ignored: a consumer that tolerated extra
 * arguments would tolerate one carrying the value, and the process table would
 * already have shown it by the time anything noticed. The refusal never echoes
 * the argument.
 */
export function assertKnownArguments(argv: readonly string[]): void {
  for (const a of argv) {
    if (!KNOWN_ARGUMENTS.some((k) => a.startsWith(k))) {
      throw Object.assign(new Error('Unrecognised consumer argument (not echoed).'), { code: 'N13_UNKNOWN_ARGUMENT' })
    }
  }
}

function parseMode(argv: readonly string[]): Mode {
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
      connection: { application_name: 'uellix-d1-n13' },
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

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  assertKnownArguments(argv)
  const mode = parseMode(argv)
  const dwellMs = Math.min(Math.max(Number(argv.find((a) => a.startsWith('--dwell-ms='))?.slice(11) ?? '0') || 0, 0), 30_000)
  let connect: N13Connect | undefined
  if (mode === 'execute') {
    const driverRoot = argv.find((a) => a.startsWith('--driver-root='))?.slice('--driver-root='.length)
    if (driverRoot === undefined || driverRoot === '') throw new Error('--mode=execute requires --driver-root.')
    connect = postgresTransport(driverRoot)
  }

  const result = await runN13Verification({ env, connect })
  const resolved = result.failedAt !== 'RESOLVE'
  if (mode !== 'execute') dwell(dwellMs)

  process.stdout.write(`${JSON.stringify({ node: 'N13', mode, resolved, ...result })}\n`)

  switch (mode) {
    case 'execute':
      return result.ok ? 0 : 1
    case 'expect-absent':
      return resolved ? 1 : 0
    case 'dry-run':
      return resolved && !result.connected ? 0 : 1
    case 'dry-run-fail':
      return 1
  }
}

if (/d1-auditor-n13-consumer\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      process.stdout.write(`${JSON.stringify({ node: 'N13', aborted: true, code: (e as { code?: string }).code ?? 'N13_ABORTED' })}\n`)
      process.exitCode = 2
    })
}
