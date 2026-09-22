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
// any path. The value exists in precisely one environment block — the one
// CreateProcess builds for the consuming child — and that block is destroyed
// by the operating system when the child exits, whether it exits cleanly,
// crashes, or is killed.
//
// The consequences are worth stating plainly, because they are what makes the
// five conditions cheap to discharge here and expensive to discharge in the
// obvious design:
//
//   WCM-C1  The fresh-shell check cannot find the variable, because no shell,
//           session or persistent store was ever written to. RC-2's second
//           observation passes for a structural reason rather than because a
//           cleanup step happened to run.
//   WCM-C2  A Windows environment block is not argv. It is not in the process
//           table, `Get-CimInstance Win32_Process` does not report it, and
//           reading it from outside requires PROCESS_VM_READ on that specific
//           process.
//   WCM-C4  "Removed immediately after the consuming process exits" is
//           satisfied by process exit itself, on the success path, on the
//           failure path, and on the kill path the authority's two-path text
//           does not reach.
//
// ---------------------------------------------------------------------------
// THE ONE EXPOSURE THIS DESIGN DOES NOT REMOVE, STATED RATHER THAN HIDDEN
// ---------------------------------------------------------------------------
// `child_process.spawn` takes `env` as strings. A JavaScript string is
// immutable and cannot be zeroed, so between `retrieveCredential` and the
// `spawn` call the value exists as an unzeroable string in this process's
// heap, at the mercy of the garbage collector. The Buffer is zeroed; the
// string it was converted from cannot be.
//
// The design that removes this hop is measured and NOT built here: let the
// PowerShell bridge itself spawn the consumer, so the value never enters the
// Node heap at all. It is not built because the lane that authorises this work
// is explicit that the final production invocation must not be invented before
// its source and runtime constraints are measured, and the consumer for the
// real credential is not yet fixed. The hop is recorded as an open finding
// against the production invocation decision rather than quietly accepted.

import { spawn } from 'node:child_process'
import { CustodyError, retrieveCredential } from './wcm-credential-store'

export interface DeliveryResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
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
}

const DEFAULT_CONSUMER_TIMEOUT_MS = 120_000

/**
 * Refuse to launch a consumer whose own argv carries the value.
 *
 * WCM-C2 is about the mechanism, but a caller can breach it without the
 * mechanism's help by passing the secret through as an argument. The check is
 * cheap and it closes the gap between "this module does not put the value in
 * argv" and "the value is not in argv".
 */
function assertArgvIsClean(args: readonly string[], secret: Buffer): void {
  const needle = secret.toString('utf8')
  for (const arg of args) {
    if (arg.includes(needle)) {
      throw new CustodyError(
        'CUSTODY_RETRIEVE_FAILED',
        'Refusing to launch: the consumer argv carries the retrieved value. ' +
          'WCM-C2 prohibits the value appearing in any process-table-visible form.'
      )
    }
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
    // is not touched — reading it produces a copy.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [request.envVarName]: secret.toString('utf8'),
    }

    return await new Promise<DeliveryResult>((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        env: childEnv,
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
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
        resolve({ exitCode: code, signal, stdout, stderr })
      })
    })
  } finally {
    // The Buffer is zeroed on every path. The string derived from it above is
    // not zeroable and is disclosed in this file's header rather than papered
    // over with a `delete` that would achieve nothing.
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
