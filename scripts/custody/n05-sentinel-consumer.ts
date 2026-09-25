// scripts/custody/n05-sentinel-consumer.ts
//
// THE CONSUMING PROCESS OF THE N05 DEMONSTRATION.
//
// It is the REAL consumer, not a stand-in: it calls
// `resolveAuditorDatabaseUrl` from `db/safety/resolve-capability-database-url.ts`,
// which ES-3 measured as the one and only surface that reads
// `UELLIX_AUDITOR_DATABASE_URL`, performs no file read, imports no dotenv
// loader, and opens no socket. Demonstrating delivery into a purpose-built
// echo script would prove delivery into a variable nothing consults.
//
// IT NEVER PRINTS THE VALUE. RC-2's standard of proof asks for the value to be
// observed present "by the consumer's own successful resolution of it and not
// by printing it", so this process reports a boolean and the non-secret role
// name the resolver returns, and nothing else.
//
// The three modes exist because the readiness contract needs three different
// exits from the SAME code path:
//
//   success              the consumer resolves and exits 0 (RC-5 success path).
//   fail-after-resolve   the consumer resolves — so the value was genuinely
//                        live in its environment — and THEN fails, exiting 1.
//                        This is RC-5's failure path done honestly: mutant NM7
//                        is a failure injected after removal, which exercises
//                        the success path wearing a failure label.
//   expect-absent        the consumer runs with no delivery and must fail to
//                        resolve. This is the negative exercise of the
//                        variable-scope check, in the SAME scope and through
//                        the SAME code path as the positive one, which is what
//                        RC-6 requires and what stops the check returning
//                        absent for the wrong reason.

import {
  CapabilityDatabaseUrlError,
  resolveAuditorDatabaseUrl,
} from '../../db/safety/resolve-capability-database-url'

type Mode = 'success' | 'fail-after-resolve' | 'expect-absent'

/**
 * Hold the process alive, with the value live in its environment, long enough
 * for the EXTERNAL observer to see it.
 *
 * This is not padding. RC-3 requires the command line of every process in the
 * demonstration's tree to be observed FROM OUTSIDE *while they are running*,
 * and RC-7 requires the consuming process's children to be enumerated from
 * actual observation. A consumer that resolves a variable and exits in fifty
 * milliseconds is never caught by a poller, and both controls then report
 * clean because they saw nothing at all — a pass with no subject, which is the
 * exact shape of the cheap demonstration the readiness contract is written to
 * refuse. The dwell makes the observation possible; it does not make it
 * easier.
 *
 * Synchronous on purpose: the value must be live in this process's environment
 * for the whole dwell, and an async sleep would complicate nothing usefully.
 */
function dwell(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function parseDwellMs(argv: readonly string[]): number {
  const raw = argv.find((a) => a.startsWith('--dwell-ms='))?.slice('--dwell-ms='.length)
  const parsed = Number(raw ?? '0')
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 30_000) : 0
}

function parseMode(argv: readonly string[]): Mode {
  const raw = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
  if (raw === 'success' || raw === 'fail-after-resolve' || raw === 'expect-absent') return raw
  throw new Error(`--mode must be success, fail-after-resolve or expect-absent (got ${String(raw)})`)
}

function main(): number {
  const mode = parseMode(process.argv.slice(2))
  const dwellMs = parseDwellMs(process.argv.slice(2))

  let resolved = false
  let declaredRole: string | null = null
  let errorCode: string | null = null

  try {
    const result = resolveAuditorDatabaseUrl(process.env)
    resolved = true
    declaredRole = result.declaredRole
  } catch (error) {
    if (error instanceof CapabilityDatabaseUrlError) {
      errorCode = error.code
    } else {
      errorCode = 'UNEXPECTED'
    }
  }

  // Stay alive, with whatever was delivered still in this process's
  // environment, so the external observer has something to observe.
  dwell(dwellMs)

  // The only thing this process writes. No value, no length, no host, no
  // userinfo — a boolean, a role name and an error code.
  process.stdout.write(`${JSON.stringify({ resolved, declaredRole, errorCode })}\n`)

  if (mode === 'expect-absent') return resolved ? 1 : 0
  if (!resolved) return 1
  // The value WAS resolved. The failure below is therefore a real failure of
  // the consumer with the value live in its environment, which is the only
  // thing that makes the failure-path removal observation mean anything.
  return mode === 'fail-after-resolve' ? 1 : 0
}

process.exit(main())
