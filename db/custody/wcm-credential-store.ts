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

import { spawn } from 'node:child_process'
import { WCM_BRIDGE_POWERSHELL_SOURCE } from './wcm-powershell-source'

/** The Windows PowerShell 5.1 host. Present on every supported workstation. */
const POWERSHELL_EXECUTABLE = 'powershell.exe'

/**
 * The bridge compiles C# on first use via `Add-Type`. A cold run has been
 * measured in the low seconds; this ceiling exists so a wedged child cannot
 * hang a demonstration indefinitely, not as a performance budget.
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
 * prefix outside the reserved namespaces.
 */
const TARGET_NAME_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}$/

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
  // csc, invoked by Add-Type, writes its intermediates here.
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
  readonly op: 'deposit' | 'retrieve' | 'probe' | 'remove' | 'sweep'
  readonly target?: string
  readonly username?: string
  readonly prefix?: string
}

interface BridgeResponse {
  readonly ok: boolean
  readonly present?: boolean | null
  readonly deleted?: boolean
  readonly win32?: number
  readonly blobBase64?: string
  readonly targets?: string[]
  readonly error?: string
  readonly exceptionType?: string
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

async function invokeBridge(
  request: BridgeRequest,
  secret?: Buffer
): Promise<BridgeResponse> {
  if (!isWindowsCredentialManagerAvailable()) {
    throw new CustodyError(
      'CUSTODY_PLATFORM_UNSUPPORTED',
      `Windows Credential Manager is only reachable on win32; this process is on ${process.platform}. ` +
        'This is a NOT_RUN condition, never a pass.'
    )
  }

  const requestLine = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')

  return await new Promise<BridgeResponse>((resolve, reject) => {
    const child = spawn(POWERSHELL_EXECUTABLE, bridgeArgv(), {
      // Every stream is a pipe. No stream is inherited, so nothing the bridge
      // writes can reach a console, and nothing a console holds can reach it.
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      windowsHide: true,
      // The bridge inherits an ALLOWLIST, not this process's environment. An
      // inherited block is how a variable reaches a process nobody intended it
      // to reach, and the bridge needs very little.
      //
      // TEMP and TMP are on the list for a measured reason: `Add-Type`
      // compiles the C# through csc, which writes to the temp directory, and a
      // bridge started without them fails inside Add-Type before it ever
      // reaches an operation. The first run of this harness failed exactly
      // there, and the failure surfaced as a CredWriteW error because the
      // bridge's catch reported the exception without its type. Both were
      // fixed: the allowlist below, and the exception type now travelling in
      // the error message.
      env: bridgeEnvironment(),
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(
        new CustodyError(
          'CUSTODY_BRIDGE_TIMEOUT',
          `The credential bridge did not respond within ${BRIDGE_TIMEOUT_MS}ms and was killed.`
        )
      )
    }, BRIDGE_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
      if (line === undefined) {
        reject(
          new CustodyError(
            'CUSTODY_BRIDGE_PROTOCOL',
            `The credential bridge produced no response line. stderr: ${scrubDiagnostic(stderr)}`
          )
        )
        return
      }
      try {
        resolve(JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as BridgeResponse)
      } catch {
        reject(
          new CustodyError(
            'CUSTODY_BRIDGE_PROTOCOL',
            `The credential bridge response was not decodable. stderr: ${scrubDiagnostic(stderr)}`
          )
        )
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
    // top of the stack, as "CredWriteW failed". It is a data-loss bug wearing
    // a Win32 error's clothes, and it was found by running the mechanism
    // rather than by reading it.
    child.stdin.write(Buffer.from(`${requestLine}\n`, 'ascii'))
    if (secret === undefined) {
      child.stdin.end()
    } else {
      const framed = Buffer.from(`${secret.toString('base64')}\n`, 'ascii')
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
  const res = await invokeBridge(
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
 * The caller owns the returned Buffer and is expected to zero it. A Buffer is
 * returned rather than a string because a JavaScript string cannot be zeroed;
 * see `db/custody/process-delivery.ts` for where that limitation becomes
 * unavoidable and how it is disclosed.
 */
export async function retrieveCredential(target: string): Promise<Buffer | null> {
  assertValidTarget(target)
  const res = await invokeBridge({ op: 'retrieve', target })
  if (!res.ok) {
    if (res.win32 === ERROR_NOT_FOUND) return null
    throw new CustodyError(
      'CUSTODY_RETRIEVE_FAILED',
      `CredReadW failed for target "${target}"${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
  if (typeof res.blobBase64 !== 'string') {
    throw new CustodyError('CUSTODY_BRIDGE_PROTOCOL', 'Retrieve succeeded but returned no blob.')
  }
  return Buffer.from(res.blobBase64, 'base64')
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
  const res = await invokeBridge({ op: 'probe', target })
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
  const res = await invokeBridge({ op: 'remove', target })
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
 * Enumerate generic entries under a prefix.
 *
 * This is the recovery path for the one case RC-5's derived gap names and the
 * two removal paths do not reach: a process killed between deposit and
 * cleanup leaves the VAULT ENTRY behind, because the entry is
 * CRED_PERSIST_LOCAL_MACHINE by design and no teardown in a dead process can
 * run. The environment variable is not at risk in that case — it never existed
 * outside the consuming child's own block — but the entry is, and a sweep is
 * the only thing that finds it.
 */
export async function sweepCredentials(prefix: string): Promise<string[]> {
  assertValidTarget(prefix)
  const res = await invokeBridge({ op: 'sweep', prefix })
  if (!res.ok) {
    throw new CustodyError(
      'CUSTODY_SWEEP_FAILED',
      `CredEnumerateW failed for prefix "${prefix}"${describeBridgeFailure(res)}.`,
      res.win32
    )
  }
  return res.targets ?? []
}
