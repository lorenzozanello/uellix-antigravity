// db/custody/secret-intake.ts
//
// SECRET ACQUISITION. The first of the five separated stages, and the one that
// decides whether the other four can be honest.
//
// The value the real N30 deposit will carry is minted at N11, on the hosted
// management plane, and does not exist in this lane. What exists here is the
// CHANNEL it must arrive through, built and tested now so that the execution
// beat does not have to invent one under time pressure with a live credential
// in hand.
//
// ---------------------------------------------------------------------------
// THE CHANNEL, AND WHY EVERY ALTERNATIVE IS REFUSED
// ---------------------------------------------------------------------------
//   argv                  REFUSED by N29 and N30's first absolute constraint.
//                         Process-table-visible to every process on the
//                         workstation for as long as the process lives.
//
//   an environment
//   variable on this
//   process               REFUSED. A persistent user-scope variable is
//                         prohibited outright and never via setx; a
//                         process-scoped one on THIS process would then be
//                         inherited by every child it spawns, including the
//                         PowerShell bridge, which is the opposite of what
//                         process-scoped delivery means.
//
//   a temp file           REFUSED. It survives the process, it survives a
//                         crash, and on Windows its contents survive deletion
//                         until the sectors are reused.
//
//   an interactive
//   prompt                REFUSED as the DEFAULT. A TTY read echoes unless the
//                         terminal is put into raw mode, and a terminal
//                         scrollback is a history sink WCM-C3 would then have
//                         to reach. `assertNonEchoingChannel` refuses a TTY
//                         outright rather than trying to tame one.
//
//   stdin, as a pipe      SELECTED. It exists only while the process runs, it
//                         is not in the process table, it is not a file, and
//                         the producer on the other end is whatever the
//                         execution beat decides — a vault export, a paste
//                         into a non-echoing reader, a hosted API response.
//                         This module does not choose the producer, because
//                         choosing it is the production-invocation decision
//                         the lane defers until its constraints are measured.

import { CustodyError } from './wcm-credential-store'

/** A hosted PostgreSQL DSN is long; anything past this is not one. */
const MAX_SECRET_BYTES = 8192

/**
 * Refuse a channel that would echo.
 *
 * Exported so the refusal is testable without a TTY: the check is a pure
 * function of the two booleans, not of the real stdin.
 */
export function assertNonEchoingChannel(params: {
  readonly isTTY: boolean
  readonly argv: readonly string[]
}): void {
  if (params.isTTY) {
    throw new CustodyError(
      'CUSTODY_DEPOSIT_FAILED',
      'stdin is a terminal. Refusing to read a credential from an echoing channel: the ' +
        'value would land in the terminal scrollback, which WCM-C3 treats as a history sink. ' +
        'Pipe the value in instead.'
    )
  }
  // A caller who passes the value as an argument has already breached WCM-C2
  // before this function runs. It cannot be un-breached, but it can be
  // reported rather than silently accepted.
  const suspicious = params.argv.find(
    (a) => /^--?(secret|password|pass|value|dsn|url)=/i.test(a) || /postgres(?:ql)?:\/\//i.test(a)
  )
  if (suspicious !== undefined) {
    throw new CustodyError(
      'CUSTODY_DEPOSIT_FAILED',
      'A command-line argument appears to carry a credential. WCM-C2 prohibits the value ' +
        'appearing in any process-table-visible form, and it is already visible. Rotate it.'
    )
  }
}

/**
 * Read the value from stdin as bytes.
 *
 * Returns a Buffer, not a string, so the caller can zero it — and the caller
 * MUST, because nothing else will. A trailing newline is stripped, because a
 * value piped from any ordinary producer carries one and a DSN never ends in
 * whitespace.
 */
export async function acquireSecretFromStdin(
  stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  argv: readonly string[] = process.argv
): Promise<Buffer> {
  assertNonEchoingChannel({ isTTY: stream.isTTY === true, argv })

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    total += buf.length
    if (total > MAX_SECRET_BYTES) {
      for (const c of chunks) c.fill(0)
      buf.fill(0)
      throw new CustodyError(
        'CUSTODY_DEPOSIT_FAILED',
        `Refusing a value larger than ${MAX_SECRET_BYTES} bytes. A connection string is not this long, ` +
          'and reading an unbounded stream into memory is how a mistake becomes a memory-pressure bug.'
      )
    }
    chunks.push(buf)
  }

  const joined = Buffer.concat(chunks)
  for (const c of chunks) c.fill(0)

  // Strip exactly one trailing CRLF or LF, and nothing else. Trimming
  // generally would silently alter a value whose own bytes include padding.
  let end = joined.length
  if (end > 0 && joined[end - 1] === 0x0a) end -= 1
  if (end > 0 && joined[end - 1] === 0x0d) end -= 1
  const value = Buffer.from(joined.subarray(0, end))
  joined.fill(0)

  if (value.length === 0) {
    throw new CustodyError('CUSTODY_DEPOSIT_FAILED', 'stdin carried no value.')
  }
  return value
}
