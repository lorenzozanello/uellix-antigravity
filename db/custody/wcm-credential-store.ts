// db/custody/wcm-credential-store.ts
//
// N29's READER AND N30's DEPOSITOR, AS ONE AUDITABLE MODULE WITH FIVE
// SEPARATED STAGES.
//
// The lane contract requires that these five stay distinguishable, because
// fusing any two of them is how a mechanism acquires a capability nobody
// authorised:
//
//   secret acquisition   `acquireSecretFromStdin` — db/custody/secret-intake.ts
//   credential deposit   `depositCredential`      — here (N30)
//   credential retrieval `retrieveCredential`     — here (N29's reader)
//   process delivery     `runWithDeliveredSecret` — db/custody/process-delivery.ts
//   cleanup              `removeCredential`, `sweepCredentials` — here
//
// N29 builds the READER. N30 performs the WRITE. They are separate exported
// functions here for the reason the DAG amendment gives for making them
// separate nodes: a single act that both places a secret in a store and
// certifies the mechanism that reads it is a self-report.
//
// ---------------------------------------------------------------------------
// THE INVOCATION CONTRACT IS ENFORCED, NOT DOCUMENTED
// ---------------------------------------------------------------------------
// RC-4's structural note is the reason this module accepts no argv, no shell
// string, no interpreter path and no extra PowerShell arguments from any
// caller. `bridgeArgv()` is a pure function of nothing, exported ONLY so a
// control can assert its exact contents. A caller cannot weaken
// `-NonInteractive`, cannot re-enable the profile, and cannot append a
// `-Command` that would put a value on the command line, because there is no
// parameter through which any of that could arrive.
//
// That is what makes WCM-C3 a property of every future invocation rather than
// of the one run that happened to be observed.
//
// ---------------------------------------------------------------------------
// THE VALUE CROSSES THIS MODULE AS BYTES, NEVER AS A JAVASCRIPT STRING
// ---------------------------------------------------------------------------
// A JavaScript string cannot be zeroed. The deposit framing and the retrieval
// blob therefore travel as Buffers through `db/custody/base64-bytes.ts`, and
// bridge stdout is collected as bytes. This removes avoidable copies; it does
// not make the process memory-safe, and OF-CUST-1 states what remains.

import { spawn } from 'node:child_process'
import { decodeBase64Bytes, encodeBase64Bytes } from './base64-bytes'
import { WCM_BRIDGE_POWERSHELL_SOURCE } from './wcm-powershell-source'

/** The Windows PowerShell 5.1 host. Present on every supported workstation. */
const POWERSHELL_EXECUTABLE = 'powershell.exe'

/**
 * A bridge call has been measured well under the ceiling; this exists so a
 * wedged child cannot hang a demonstration indefinitely, not as a budget.
 */
const BRIDGE_TIMEOUT_MS = 60_000

export type CustodyErrorCode =
  | 'CUSTODY_PLATFORM_UNSUPPORTED'
  | 'CUSTODY_BRIDGE_SPAWN_FAILED'
  | 'CUSTODY_BRIDGE_TIMEOUT'
  | 'CUSTODY_BRIDGE_PROTOCOL'
  | 'CUSTODY_DEPOSIT_FAILED'
  | 'CUSTODY_RETRIEVE_FAILED'
  | 'CUSTODY_PROBE_FAILED'
  | 'CUSTODY_REMOVE_FAILED'
  | 'CUSTODY_SWEEP_FAILED'
  | 'CUSTODY_TARGET_INVALID'
  | 'CUSTODY_CONSOLE_PROBE_FAILED'
  | 'CUSTODY_DELIVERY_TOPOLOGY_UNSAFE'

export class CustodyError extends Error {
  readonly name = 'CustodyError'
  readonly code: CustodyErrorCode
  /** The Win32 code where one was reported. Never a value, never a blob. */
  readonly win32?: number

  constructor(code: CustodyErrorCode, message: string, win32?: number) {
    super(message)
    this.code = code
    this.win32 = win32
  }
}

/** ERROR_NOT_FOUND. The only Win32 code this module reads as an absence. */
export const ERROR_NOT_FOUND = 1168

/**
 * The fixed argv. A pure function of nothing.
 *
 * `-EncodedCommand` takes base64 of UTF-16LE, which is why the encoding is
 * spelled out rather than defaulted. The encoded payload is the bridge SOURCE:
 * non-secret code, and the only thing this process ever puts on a command
 * line.
 */
export function bridgeArgv(): readonly string[] {
  const encoded = Buffer.from(WCM_BRIDGE_POWERSHELL_SOURCE, 'utf16le').toString('base64')
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ]
}

/**
 * Entry target names this module will touch.
 *
 * A target name is not a secret, but an unconstrained one is a way to make
 * this module read or delete a credential it was never meant to. The grammar
 * is deliberately narrow, and `sweepCredentials` additionally refuses any
 * prefix outside `SWEEPABLE_TARGET_PREFIXES`.
 */
const TARGET_NAME_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}$/

/**
 * The ONLY namespace a sweep may enumerate, and so the only one a recovery
 * may delete from.
 *
 * A sweep is the recovery path for a demonstration killed between deposit and
 * cleanup (OF-CUST-3). It must never reach the real credential: removing the
 * real entry is the rotation act N28 governs, not a cleanup. Bounding the
 * sweep here, in the mechanism, makes that a property of the code rather than
 * of whoever calls it.
 */
export const SWEEPABLE_TARGET_PREFIXES = ['UELLIX-N05-SENTINEL'] as const

function assertValidTarget(target: string): void {
  if (!TARGET_NAME_GRAMMAR.test(target)) {
    throw new CustodyError(
      'CUSTODY_TARGET_INVALID',
      'Credential target name is not in the permitted grammar. It must begin with an ' +
        'alphanumeric and contain only alphanumerics, dot, underscore, colon and hyphen.'
    )
  }
}

/**
 * The environment variables the bridge is allowed to inherit.
 *
 * Exported so a control can assert the list rather than trust this comment,
 * and so a future reader can see that nothing application-specific is on it.
 */
export const BRIDGE_ENV_ALLOWLIST = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  // PowerShell itself uses the temp directory; a bridge started without it
  // failed before reaching any operation.
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const

function bridgeEnvironment(): NodeJS.ProcessEnv {
  // `NODE_ENV` is present only because Next.js declares it required on
  // `ProcessEnv`. The bridge does not read it.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV }
  for (const name of BRIDGE_ENV_ALLOWLIST) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface BridgeRequest {
  readonly op: 'deposit' | 'retrieve' | 'probe' | 'remove' | 'sweep' | 'console'
  readonly target?: string
  readonly username?: string
  readonly prefix?: string
  readonly pid?: number
}

interface BridgeResponse {
  readonly ok: boolean
  readonly present?: boolean | null
  readonly deleted?: boolean
  readonly attached?: boolean | null
  readonly win32?: number
  readonly blobFollows?: boolean
  readonly targets?: string[]
  readonly error?: string
  readonly exceptionType?: string
}

interface BridgeResult {
  readonly response: BridgeResponse
  /** The decoded second line, for a successful retrieve only. Caller zeroes. */
  readonly blob: Buffer | null
}

/**
 * True on a platform where Windows Credential Manager exists.
 *
 * Exported because the demonstration harness must be able to report NOT_RUN as
 * a distinct state. It is never used to SKIP a control silently — see
 * `db/custody/n05-control-state.ts` for why that distinction is load-bearing.
 */
export function isWindowsCredentialManagerAvailable(): boolean {
  return process.platform === 'win32'
}

/**
 * Anything in child stderr that looks like a connection string is refused
 * passage into an Error message.
 *
 * The bridge is written not to emit one. This is the second lock: an error
 * path is the one place a value reaches a log without anyone deciding it
 * should, and "the bridge does not do that" is a claim about code rather than
 * a guarantee about output.
 */
function scrubDiagnostic(text: string): string {
  const withoutDsn = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED-DSN]')
  return withoutDsn.length > 2000 ? `${withoutDsn.slice(0, 2000)}…` : withoutDsn
}

/**
 * Format a bridge failure for an Error message.
 *
 * The exception TYPE travels; the exception MESSAGE never does. Omitting the
 * type entirely was a real cost the first time this mechanism was exercised: a
 * missing TEMP variable made Add-Type throw, and the error said only
 * "CredWriteW failed", which pointed at the one call that had not run.
 */
function describeBridgeFailure(res: BridgeResponse): string {
  const parts = [res.error, res.exceptionType].filter((p): p is string => typeof p === 'string')
  return parts.length === 0 ? '' : ` (${parts.join(': ')})`
}

/**
 * Split raw stdout bytes into lines without converting them to a string.
 * A CR before the LF is dropped and empty lines are skipped.
 */
function splitLines(raw: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw[i] === 0x0a) {
      let end = i
      if (end > start && raw[end - 1] === 0x0d) end -= 1
      if (end > start) lines.push(raw.subarray(start, end))
      start = i + 1
    }
  }
  return lines
}

async function invokeBridge(request: BridgeRequest, secret?: Buffer): Promise<BridgeResult> {
  if (!isWindowsCredentialManagerAvailable()) {
    throw new CustodyError(
      'CUSTODY_PLATFORM_UNSUPPORTED',
      `Windows Credential Manager is only reachable on win32; this process is on ${process.platform}. ` +
        'This is a NOT_RUN condition, never a pass.'
    )
  }

  const requestLine = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')

  return await new Promise<BridgeResult>((resolve, reject) => {
    const child = spawn(POWERSHELL_EXECUTABLE, bridgeArgv(), {
      // Every stream is a pipe. No stream is inherited, so nothing the bridge
      // writes can reach a console, and nothing a console holds can reach it.
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      // The bridge gets its own hidden console, and with it a conhost.exe. That
      // conhost inherits the bridge's environment — which is the ALLOWLIST
      // below and never carries the delivery variable. The consumer is a
      // different matter; see process-delivery.ts.
      windowsHide: true,
      // The bridge inherits an ALLOWLIST, not this process's environment. An
      // inherited block is how a variable reaches a process nobody intended it
      // to reach, and the bridge needs very little.
      //
      // TEMP and TMP are on the list for a measured reason: a bridge started
      // without them failed before it ever reached an operation.
      env: bridgeEnvironment(),
    })

    // stdout is collected as BYTES. The retrieval blob travels on it, and a
    // string accumulator would leave an unzeroable copy of the value here.
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    let settled = false
    const zeroStdout = (): void => {
      for (const c of stdoutChunks) c.fill(0)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      zeroStdout()
      reject(
        new CustodyError(
          'CUSTODY_BRIDGE_TIMEOUT',
          `The credential bridge did not respond within ${BRIDGE_TIMEOUT_MS}ms and was killed.`
        )
      )
    }, BRIDGE_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    // A bridge that dies before reading stdin makes the write fail with EPIPE.
    // Without a listener that is an uncaught exception in the launcher; with
    // one, the 'close' handler below reports the real outcome.
    child.stdin.on('error', () => {})

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      zeroStdout()
      reject(
        new CustodyError(
          'CUSTODY_BRIDGE_SPAWN_FAILED',
          `Could not start ${POWERSHELL_EXECUTABLE}: ${scrubDiagnostic(err.message)}`
        )
      )
    })

    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const raw = Buffer.concat(stdoutChunks)
      zeroStdout()
      try {
        const lines = splitLines(raw)
        const head = lines[0]
        if (head === undefined) {
          reject(
            new CustodyError(
              'CUSTODY_BRIDGE_PROTOCOL',
              `The credential bridge produced no response line. stderr: ${scrubDiagnostic(stderr)}`
            )
          )
          return
        }
        let response: BridgeResponse
        try {
          // The response line is NON-SECRET by protocol, so a string is fine.
          response = JSON.parse(decodeBase64Bytes(head).toString('utf8')) as BridgeResponse
        } catch {
          reject(
            new CustodyError(
              'CUSTODY_BRIDGE_PROTOCOL',
              `The credential bridge response was not decodable. stderr: ${scrubDiagnostic(stderr)}`
            )
          )
          return
        }
        let blob: Buffer | null = null
        if (response.blobFollows === true) {
          const blobLine = lines[1]
          if (blobLine === undefined) {
            reject(new CustodyError('CUSTODY_BRIDGE_PROTOCOL', 'The bridge announced a blob and sent none.'))
            return
          }
          try {
            blob = decodeBase64Bytes(blobLine)
          } catch {
            reject(new CustodyError('CUSTODY_BRIDGE_PROTOCOL', 'The blob line was not valid base64.'))
            return
          }
        }
        resolve({ response, blob })
      } finally {
        raw.fill(0)
      }
    })

    // THE SECRET CROSSES HERE AND NOWHERE ELSE: one write to an anonymous
    // pipe, base64-framed, immediately after the non-secret request line.
    //
    // THE ZEROING IS DEFERRED TO THE FLUSH CALLBACK, AND THAT IS NOT A DETAIL.
    // `writable.write()` is asynchronous: it may only have queued the buffer
    // when it returns. Zeroing immediately after the call — the obvious way to
    // write this — races the flush and sends the bridge base64 of NUL bytes,
    // which surfaces as a FormatException inside the bridge and reads, at the
    // top of the stack, as "CredWriteW failed".
    child.stdin.write(Buffer.from(`${requestLine}\n`, 'ascii'))
    if (secret === undefined) {
      child.stdin.end()
    } else {
      // Framed from bytes to bytes: `secret.toString('base64')` would leave an
      // unzeroable string copy of the value in this heap.
      const encoded = encodeBase64Bytes(secret)
      const framed = Buffer.alloc(encoded.length + 1)
      encoded.copy(framed)
      encoded.fill(0)
      framed[framed.length - 1] = 0x0a
      child.stdin.end(framed, () => {
        framed.fill(0)
      })
    }
  })
}

/**
 * N30. Write the value into EXACTLY ONE generic Credential Manager entry.
 *
 * `secret` is a Buffer rather than a string so the caller can zero it. This
 * function zeroes nothing it did not allocate: ownership of the input stays
 * with the caller, and `db/custody/secret-intake.ts` is where that ownership
 * is discharged.
 */
export async function depositCredential(params: {
  readonly target: string
  readonly username: string
  readonly secret: Buffer
}): Promise<void> {
  assertValidTarget(params.target)
  if (params.secret.length === 0) {
    throw new CustodyError('CUSTODY_DEPOSIT_FAILED', 'Refusing to deposit an empty value.')
  }
  const { response: res } = await invokeBridge(
    { op: 'deposit', target: params.target, username: params.username },
    params.secret
  )
  if (!res.ok) {
    throw new CustodyError(
      'CUSTODY_DEPOSIT_FAILED',
      `CredWriteW failed for target "${params.target}"${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
}

/**
 * N29's reader. Return the stored value as a Buffer, or null when the entry is
 * absent.
 *
 * The caller owns the returned Buffer and is expected to zero it. It is
 * decoded from bridge stdout BYTES; no JavaScript string of the value is
 * created on this path.
 */
export async function retrieveCredential(target: string): Promise<Buffer | null> {
  assertValidTarget(target)
  const { response: res, blob } = await invokeBridge({ op: 'retrieve', target })
  if (!res.ok) {
    blob?.fill(0)
    if (res.win32 === ERROR_NOT_FOUND) return null
    throw new CustodyError(
      'CUSTODY_RETRIEVE_FAILED',
      `CredReadW failed for target "${target}"${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
  if (blob === null) {
    throw new CustodyError('CUSTODY_BRIDGE_PROTOCOL', 'Retrieve succeeded but returned no blob.')
  }
  return blob
}

/**
 * The absence check of WCM-C5, and the only one this module offers.
 *
 * It returns a boolean from a READ of the same scope a deposit writes. It
 * never infers absence from the fact that a removal was issued, and it never
 * converts an unexpected Win32 failure into `false` — a failed check throws,
 * because "the check could not run" and "the entry is gone" are the two facts
 * RC-6 exists to keep apart.
 */
export async function probeCredential(target: string): Promise<boolean> {
  assertValidTarget(target)
  const { response: res } = await invokeBridge({ op: 'probe', target })
  if (!res.ok || typeof res.present !== 'boolean') {
    throw new CustodyError(
      'CUSTODY_PROBE_FAILED',
      `The absence check could not be completed for target "${target}". ` +
        'This is a FAILED CHECK and must never be recorded as an absence.',
      res.win32
    )
  }
  return res.present
}

/**
 * Cleanup. Idempotent: an already-absent entry is a successful removal.
 *
 * Returns true when an entry was actually deleted, false when there was
 * nothing to delete. Both are success; the distinction exists so a sweeper can
 * report what it found.
 */
export async function removeCredential(target: string): Promise<boolean> {
  assertValidTarget(target)
  const { response: res } = await invokeBridge({ op: 'remove', target })
  if (!res.ok) {
    throw new CustodyError(
      'CUSTODY_REMOVE_FAILED',
      `CredDeleteW failed for target "${target}"${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
  return res.deleted === true
}

/**
 * Enumerate generic entries under a prefix inside `SWEEPABLE_TARGET_PREFIXES`.
 *
 * This is the recovery path for the one case RC-5's derived gap names and the
 * two removal paths do not reach: a process killed between deposit and
 * cleanup leaves the VAULT ENTRY behind, because the entry is
 * CRED_PERSIST_LOCAL_MACHINE by design and no teardown in a dead process can
 * run (OF-CUST-3). The environment variable is not at risk in that case — it
 * never existed outside the consuming child's own block, and the child dies
 * with its launcher's job — but the entry is, and a sweep is the only thing
 * that finds it.
 */
export async function sweepCredentials(prefix: string): Promise<string[]> {
  assertValidTarget(prefix)
  if (!SWEEPABLE_TARGET_PREFIXES.some((p) => prefix === p || prefix.startsWith(`${p}-`))) {
    throw new CustodyError(
      'CUSTODY_TARGET_INVALID',
      `Refusing to sweep "${prefix}": only ${SWEEPABLE_TARGET_PREFIXES.join(', ')} may be swept. ` +
        'Removing a real credential entry is the rotation act N28 governs, never a sweep.'
    )
  }
  const { response: res } = await invokeBridge({ op: 'sweep', prefix })
  if (!res.ok) {
    throw new CustodyError(
      'CUSTODY_SWEEP_FAILED',
      `CredEnumerateW failed for prefix "${prefix}"${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
  return res.targets ?? []
}

/**
 * Whether process `pid` is attached to a console, answered by the bridge,
 * which detaches from its own console and calls AttachConsole(pid).
 *
 * Process delivery asks this about ITS OWN pid before reading the vault. A
 * launcher with no console makes Windows give the consumer a fresh
 * conhost.exe, and that conhost inherits the consumer's environment block,
 * value included — the measured blocker B-1. A probe that fails throws:
 * "could not tell" is never read as "has a console".
 */
export async function isProcessAttachedToConsole(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new CustodyError('CUSTODY_CONSOLE_PROBE_FAILED', `Not a process id: ${String(pid)}.`)
  }
  const { response: res } = await invokeBridge({ op: 'console', pid })
  if (!res.ok || typeof res.attached !== 'boolean') {
    throw new CustodyError(
      'CUSTODY_CONSOLE_PROBE_FAILED',
      `The console-attachment probe could not be completed${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
  return res.attached
}
