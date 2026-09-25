// db/custody/process-delivery.ts
//
// PROCESS-SCOPED DELIVERY. WCM-C1's stage, and the one place where the value
// leaves the custody module.
//
// ---------------------------------------------------------------------------
// WHY THIS SATISFIES WCM-C1 STRUCTURALLY AND NOT BY CLEANING UP AFTERWARDS
// ---------------------------------------------------------------------------
// The obvious implementation sets the variable, runs the command, and unsets
// it. That implementation is correct only for as long as its teardown runs,
// which is exactly the property RC-5's derived gap observes it cannot promise:
// a killed process runs no teardown.
//
// This implementation never sets the variable anywhere that could outlive the
// consumer. `process.env` of THIS process is not written to, at any point, on
// any path. The value exists in the environment block CreateProcess builds for
// the consuming child, and that block is destroyed by the operating system
// when the child exits, whether it exits cleanly, crashes, or is killed.
//
// ---------------------------------------------------------------------------
// THE PROCESS-CREATION MODEL, AS MEASURED (B-1)
// ---------------------------------------------------------------------------
// "Exactly one process holds the value" is a claim about Windows process
// creation, not about this file, and the first version of it was wrong. The
// independent certification read the environment block of every descendant
// and found a conhost.exe, child of the consumer, carrying the variable and
// its value. The cause, measured on this workstation by reading each
// process's environment block from outside:
//
//   consumer spawned with windowsHide:true   Node passes CREATE_NO_WINDOW, the
//                                            consumer gets a NEW console, and
//                                            the conhost.exe hosting it
//                                            inherits the consumer's block.
//   windowsHide:false, launcher HAS console  The consumer shares the launcher's
//                                            existing console. No conhost is
//                                            created. Only the consumer holds
//                                            the value.
//   windowsHide:false, launcher NO console   Windows creates a console for the
//                                            consumer anyway, and its conhost
//                                            inherits the value again.
//   detached:true                            No conhost, but the consumer is
//                                            also taken OUT of the launcher's
//                                            kill-on-close job object, so it
//                                            survives an abrupt launcher kill
//                                            with the value in its block.
//
// Hence the two rules below: the consumer is spawned with windowsHide:false
// and never detached, and delivery REFUSES to run unless the launcher is
// attached to a console. The job object Node places every non-detached child
// in is kept, and was measured to kill the consumer when the launcher is
// killed.
//
// ---------------------------------------------------------------------------
// THE ONE EXPOSURE THIS DESIGN DOES NOT REMOVE, STATED RATHER THAN HIDDEN
// ---------------------------------------------------------------------------
// `child_process.spawn` takes `env` as strings. This file creates exactly ONE
// JavaScript string of the value — the environment entry — and it cannot be
// zeroed. It and the UTF-16 block libuv builds from it remain in this
// process's memory for as long as the launcher lives. OF-CUST-1 records this
// residual; nothing here claims to zero it. The launcher must therefore be a
// short-lived process, and it belongs on the custody inventory's list of
// processes that hold the value.

import { spawn } from 'node:child_process'
import { encodeBase64Bytes } from './base64-bytes'
import { CustodyError, isProcessAttachedToConsole, retrieveCredential } from './wcm-credential-store'

export interface DeliveryResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** The consumer's process id, so an external observer can find its tree. */
  readonly pid: number | undefined
}

export interface DeliveryRequest {
  /** The Credential Manager entry to read. */
  readonly target: string
  /** The environment variable name the consumer reads. Never the value. */
  readonly envVarName: string
  /** The consuming executable. */
  readonly command: string
  /** Its arguments. Asserted secret-free below — see `assertArgvIsClean`. */
  readonly args: readonly string[]
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Called once with the consumer's pid, right after it is created. */
  readonly onSpawn?: (pid: number | undefined) => void
}

const DEFAULT_CONSUMER_TIMEOUT_MS = 120_000

/**
 * The spawn flags for the consumer. Exported so a control can assert them:
 * `windowsHide: true` is the measured cause of B-1, and `detached: true`
 * trades it for a consumer that outlives a killed launcher.
 */
export const CONSUMER_SPAWN_FLAGS = { windowsHide: false, detached: false } as const

/**
 * Refuse to launch a consumer whose own argv carries the value in any form
 * this mechanism creates.
 *
 * The mechanism creates exactly two representations of the value: the raw
 * bytes (the environment entry) and their base64 (the stdin framing of a
 * deposit and the blob line of a retrieval). Both are searched, as bytes, in
 * every argument. WCM-C2 is about the mechanism, but a caller can breach it
 * without the mechanism's help by passing the value through as an argument.
 */
export function assertArgvIsClean(args: readonly string[], secret: Buffer): void {
  const b64 = encodeBase64Bytes(secret)
  try {
    for (const arg of args) {
      const bytes = Buffer.from(arg, 'utf8')
      if (bytes.includes(secret) || bytes.includes(b64)) {
        throw new CustodyError(
          'CUSTODY_RETRIEVE_FAILED',
          'Refusing to launch: the consumer argv carries the retrieved value (raw or base64). ' +
            'WCM-C2 prohibits the value appearing in any process-table-visible form.'
        )
      }
    }
  } finally {
    b64.fill(0)
  }
}

/**
 * Read the entry and run ONE command with the value in that command's
 * environment and nowhere else.
 *
 * Returns the consumer's exit status and captured streams. The captured
 * streams are returned to the caller unmodified: this function does not know
 * what the consumer prints, and a consumer that prints its own credential is a
 * defect in the consumer, which `db/safety/resolve-capability-database-url.ts`
 * is written not to be.
 */
export async function runWithDeliveredSecret(request: DeliveryRequest): Promise<DeliveryResult> {
  const before = process.env[request.envVarName]
  if (before !== undefined) {
    throw new CustodyError(
      'CUSTODY_RETRIEVE_FAILED',
      `${request.envVarName} is already set in this process's own environment. ` +
        'Process-scoped delivery refuses to run alongside an ambient value, because a ' +
        'consumer that succeeded would not prove which of the two it read.'
    )
  }

  // B-1: without a console of its own, the launcher's consumer would get a
  // fresh conhost.exe that inherits the value. Checked BEFORE the vault is
  // read, so a refusal leaves nothing to clean up.
  if (!(await isProcessAttachedToConsole(process.pid))) {
    throw new CustodyError(
      'CUSTODY_DELIVERY_TOPOLOGY_UNSAFE',
      'This launcher is not attached to a console. A consumer started from it would be given a ' +
        'new conhost.exe that inherits the delivered value (B-1). Run the launcher from a console.'
    )
  }

  const secret = await retrieveCredential(request.target)
  if (secret === null) {
    throw new CustodyError(
      'CUSTODY_RETRIEVE_FAILED',
      `No credential entry named "${request.target}" exists, so there is nothing to deliver.`
    )
  }

  try {
    assertArgvIsClean(request.args, secret)

    // The child's environment block: this process's environment, plus the one
    // variable, built here and passed to CreateProcess. `process.env` itself
    // is not touched — spreading it produces a copy.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [request.envVarName]: secret.toString('utf8'),
    }

    return await new Promise<DeliveryResult>((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        env: childEnv,
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...CONSUMER_SPAWN_FLAGS,
      })
      request.onSpawn?.(child.pid)

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
            `The consuming process exceeded ${request.timeoutMs ?? DEFAULT_CONSUMER_TIMEOUT_MS}ms and was killed.`
          )
        )
      }, request.timeoutMs ?? DEFAULT_CONSUMER_TIMEOUT_MS)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c: string) => {
        stdout += c
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (c: string) => {
        stderr += c
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CustodyError('CUSTODY_BRIDGE_SPAWN_FAILED', err.message))
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ exitCode: code, signal, stdout, stderr, pid: child.pid })
      })
    })
  } finally {
    // The Buffer is zeroed on every path. The one string derived from it above
    // is not zeroable and is disclosed in this file's header rather than
    // papered over with a `delete` that would achieve nothing.
    secret.fill(0)
  }
}

/**
 * The parent-scope assertion RC-2's first half needs as its companion.
 *
 * True when this process's own environment does not carry the name. It is
 * NOT the fresh-shell observation — that one has to happen in a shell this
 * process did not create, and `scripts/custody/n05-sentinel-demonstration.ts`
 * performs it by launching one.
 */
export function isAbsentFromThisProcessEnvironment(envVarName: string): boolean {
  return process.env[envVarName] === undefined
}
