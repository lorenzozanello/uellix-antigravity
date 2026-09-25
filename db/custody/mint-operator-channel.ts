// db/custody/mint-operator-channel.ts
//
// THE OPERATOR CHANNEL (OT-3), REPOSITORY SIDE. This file prompts for nothing,
// connects to nothing and spawns nothing on its own.
//
// Owner decisions (docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_OWNER_DECISION_v1.0.0.json):
//   AC-4  OT3_CHANNEL = OPTION_A: the operator's privileged connection string is
//         supplied ONLY through an ephemeral Node launcher run by the owner in
//         his own console, asked for without echo and handed ONLY to the
//         environment block of one child process.
//   AC-5  NON_AUTHORIZATIONS[23] narrowed for the N11/MR-2 act of this successor
//         alone (and, by PHASE 2 of OEP1_PROBE = C, for the one read-only OEP-1
//         probe run through the certified channel).
//   AC-6  SSL-06: the parent launcher is a credential-bearing surface and is
//         inventoried (N06), bounded in lifetime, and PEB-measured.
//
// THE SHAPE, AND WHY
//
//   launcher (this repository, built to bare node OUTSIDE it)
//     - refuses without a console (B-1: a console-less parent hands its child a
//       fresh conhost.exe that inherits the child's environment block);
//     - reads the connection string in raw mode, echoing nothing;
//     - checks it names the planned host (and, for the mint, the principal the
//       OEP-1 evidence observed) BEFORE any process is created;
//     - builds ONE environment block from a fixed allowlist plus the one
//       variable, never writes its own process.env, and spawns ONE tool with
//       windowsHide:false, detached:false, shell:false and a secret-free argv;
//   tool (OUTSIDE the repository, pinned by sha256)
//     - the mint tool (route B contract, OT-1..OT-12 + OT-13/OT-14 below) or
//       the OEP-1 probe tool (PROBE_CONTRACT below). Neither lives here:
//       SECRET_GENERATION_CONTRACT.generated_where forbids a repository script
//       that can reach a hosted target, and the detector in
//       mint-route-b-contract.ts enforces it for the mint.
//
// What is NOT removed and is stated: the launcher holds the connection string
// as a Buffer (zeroed) and as the one JavaScript string spawn() requires (not
// zeroable), for the launcher's short life — the OF-CUST-1 analogue.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { assertArgvIsClean } from './process-delivery'
import { encodeBase64Bytes } from './base64-bytes'

export const OPERATOR_ENV_VAR_NAME = 'UELLIX_D1_MINT_OPERATOR_DATABASE_URL'

/** The only inherited variables a tool may see (Windows process creation needs these; nothing else). */
export const TOOL_ENV_ALLOWLIST = ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP'] as const

/** The route-B driver, as measured and ratified (D1_MINT_OPERATOR_TOOL; OT-2). */
export const ROUTE_B_DRIVER = { name: 'postgres', version: '3.4.9' } as const

/** The spawn flags of the tool. Same measured reasoning as CONSUMER_SPAWN_FLAGS (process-delivery.ts), plus no shell. */
export const TOOL_SPAWN_FLAGS = { windowsHide: false, detached: false, shell: false } as const

export type ChannelMode = 'probe' | 'mint'

/** The largest connection string accepted. A limit, so a stuck pipe cannot grow the buffer without end. */
export const MAX_SECRET_BYTES = 4096

export class OperatorChannelError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OperatorChannelError'
  }
}

// ---------------------------------------------------------------------------
// The no-echo prompt
// ---------------------------------------------------------------------------

/** The part of a TTY ReadStream the prompt uses. A double stands in for it in tests. */
export interface HiddenInput {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode(mode: boolean): unknown
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  resume(): unknown
  pause(): unknown
}

export interface PromptOutput {
  write(text: string): unknown
}

export const PROMPT_TEXT = 'Operator connection string for this ONE authorized run (input is not shown): '

/** The synchronous refusal of the prompt: a non-TTY input is never read (measured by PMR-10 by calling it). */
export function hiddenPromptPrecondition(input: Pick<HiddenInput, 'isTTY'>): OperatorChannelError | null {
  return input.isTTY === true ? null : new OperatorChannelError('CHANNEL_NO_CONSOLE_INPUT', 'Standard input is not a console; the connection string can only be typed into a console.')
}

/**
 * Read one line from a console in raw mode and write NOTHING of it.
 *
 * Raw mode clears the console's echo and line input (libuv sets the console
 * mode on Windows), so no byte typed is displayed and nothing reaches a shell's
 * line editor or its history: the keystrokes go to this process only. The
 * prompt refuses anything that is not a TTY, refuses a stream that does not
 * report raw after setRawMode(true), restores the previous mode on every path,
 * and keeps the bytes in one Buffer the caller zeroes.
 *
 * Enter ends the line. Backspace removes one byte. Ctrl-C aborts.
 */
export function readHiddenLine(input: HiddenInput, output: PromptOutput, promptText: string = PROMPT_TEXT): Promise<Buffer> {
  const refused = hiddenPromptPrecondition(input)
  if (refused !== null) return Promise.reject(refused)
  output.write(promptText)
  const wasRaw = input.isRaw === true
  input.setRawMode(true)
  if (input.isRaw !== true) {
    input.setRawMode(wasRaw)
    return Promise.reject(new OperatorChannelError('CHANNEL_ECHO_NOT_DISABLED', 'The console did not enter raw mode, so typed characters could be echoed. Refusing.'))
  }
  const buf = Buffer.alloc(MAX_SECRET_BYTES)
  let len = 0
  return new Promise<Buffer>((resolve, reject) => {
    const finish = (err: OperatorChannelError | null): void => {
      input.removeListener('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
      if (err !== null) {
        buf.fill(0)
        reject(err)
        return
      }
      const out = Buffer.from(buf.subarray(0, len))
      buf.fill(0)
      resolve(out)
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      try {
        for (const b of bytes) {
          if (b === 0x03) return finish(new OperatorChannelError('CHANNEL_ABORTED', 'Aborted at the prompt (Ctrl-C). Nothing was spawned.'))
          if (b === 0x0d || b === 0x0a) return finish(null)
          if (b === 0x08 || b === 0x7f) {
            if (len > 0) buf[--len] = 0
            continue
          }
          if (len >= MAX_SECRET_BYTES) return finish(new OperatorChannelError('CHANNEL_INPUT_TOO_LONG', `The input exceeded ${MAX_SECRET_BYTES} bytes.`))
          buf[len++] = b
        }
      } finally {
        if (typeof chunk !== 'string') chunk.fill(0)
      }
    }
    input.on('data', onData)
    input.resume()
  })
}

/**
 * SYNTHETIC input only: one line from a pipe. Accepted by the launcher ONLY when
 * the planned target is an RFC 6761 `.invalid` host (see acceptsPipedInput), so
 * it can never carry a real operator credential to a real target.
 */
export function readPipedLine(input: NodeJS.ReadableStream): Promise<Buffer> {
  const buf = Buffer.alloc(MAX_SECRET_BYTES)
  let len = 0
  return new Promise<Buffer>((resolve, reject) => {
    let done = false
    const end = (err: OperatorChannelError | null): void => {
      if (done) return
      done = true
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      if (err !== null) {
        buf.fill(0)
        reject(err)
        return
      }
      const out = Buffer.from(buf.subarray(0, len))
      buf.fill(0)
      resolve(out)
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      for (const b of bytes) {
        if (b === 0x0d || b === 0x0a) return end(null)
        if (len >= MAX_SECRET_BYTES) return end(new OperatorChannelError('CHANNEL_INPUT_TOO_LONG', `The input exceeded ${MAX_SECRET_BYTES} bytes.`))
        buf[len++] = b
      }
    }
    const onEnd = (): void => end(len > 0 ? null : new OperatorChannelError('CHANNEL_NO_INPUT', 'No connection string was supplied.'))
    input.on('data', onData)
    input.on('end', onEnd)
  })
}

/** Piped (non-console) input is a synthetic-demonstration path, bound to hosts that can never resolve. */
export function acceptsPipedInput(targetHost: string): boolean {
  return /\.invalid$/i.test(targetHost)
}

// ---------------------------------------------------------------------------
// The value, checked before any process exists
// ---------------------------------------------------------------------------

export interface OperatorUrlFacts {
  readonly host: string
  readonly port: string
  readonly database: string
  readonly username: string
  /** A query or fragment would become startup parameters in postgres.js (OC-11). */
  readonly hasStartupParameters: boolean
  /** The password bytes as they appear in the string (percent-encoded form), for argv checks. */
  readonly passwordRaw: Buffer
}

/**
 * Parse the connection string far enough to check WHERE it points and WHO it
 * names. Never returns or logs the value; refusals name the failed property only.
 */
export function inspectOperatorUrl(secret: Buffer): OperatorUrlFacts {
  if (secret.length === 0) throw new OperatorChannelError('CHANNEL_NO_INPUT', 'No connection string was supplied.')
  for (const b of secret) {
    if (b < 0x21 || b === 0x7f) throw new OperatorChannelError('CHANNEL_MALFORMED_INPUT', 'The connection string contains whitespace or a control byte.')
  }
  let url: URL
  try {
    url = new URL(secret.toString('utf8'))
  } catch {
    throw new OperatorChannelError('CHANNEL_MALFORMED_INPUT', 'The input is not a connection URL.')
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new OperatorChannelError('CHANNEL_MALFORMED_INPUT', 'The input is not a PostgreSQL connection URL.')
  if (url.username === '' || url.password === '') throw new OperatorChannelError('CHANNEL_MALFORMED_INPUT', 'The connection URL names no user or no password.')
  return {
    host: url.hostname.toLowerCase(),
    port: url.port === '' ? '5432' : url.port,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    username: decodeURIComponent(url.username),
    hasStartupParameters: url.search !== '' || url.hash !== '',
    passwordRaw: Buffer.from(url.password, 'utf8'),
  }
}

/**
 * The pre-spawn checks the plan binds (OC-4, OC-11): no startup parameters; the
 * host is N04's EXACTLY (never a prefix or suffix); the port and database are
 * the route-B session's; for the mint, the principal is the one OEP-1 observed.
 */
export function checkOperatorUrlAgainstPlan(
  facts: OperatorUrlFacts,
  plan: { readonly targetHost: string; readonly targetPort: number; readonly targetDatabase: string; readonly operatorPrincipal: string | null }
): void {
  if (facts.hasStartupParameters) {
    throw new OperatorChannelError('CHANNEL_STARTUP_PARAMETERS', 'The connection string carries a query or fragment, which the driver would send as startup parameters. Nothing was spawned.')
  }
  if (facts.host !== plan.targetHost.toLowerCase()) {
    throw new OperatorChannelError('CHANNEL_WRONG_HOST', 'The connection string does not name the planned target host (derived from N04). Nothing was spawned.')
  }
  if (facts.port !== String(plan.targetPort)) throw new OperatorChannelError('CHANNEL_WRONG_PORT', 'The connection string does not name the planned port. Nothing was spawned.')
  if (facts.database !== plan.targetDatabase) throw new OperatorChannelError('CHANNEL_WRONG_DATABASE', 'The connection string does not name the planned database. Nothing was spawned.')
  if (plan.operatorPrincipal !== null && facts.username !== plan.operatorPrincipal) {
    throw new OperatorChannelError('CHANNEL_WRONG_PRINCIPAL', 'The connection string names a different principal from the one the OEP-1 evidence observed. Nothing was spawned.')
  }
}

/**
 * The tool's environment block: the allowlist, copied from `base`, plus the one
 * variable. Built as a NEW object; `base` (the launcher's process.env) is read,
 * never written.
 */
export function buildToolEnvironment(base: Readonly<Record<string, string | undefined>>, secret: Buffer): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of TOOL_ENV_ALLOWLIST) {
    const v = base[k]
    if (v !== undefined) env[k] = v
  }
  env[OPERATOR_ENV_VAR_NAME] = secret.toString('utf8')
  return env
}

/**
 * WCM-C2's analogue for the operator value: no argument carries the whole
 * string, or its password component, raw or base64.
 */
export function assertToolArgvIsClean(args: readonly string[], secret: Buffer, passwordRaw: Buffer): void {
  assertArgvIsClean(args, secret)
  const b64 = encodeBase64Bytes(passwordRaw)
  try {
    for (const a of args) {
      const bytes = Buffer.from(a, 'utf8')
      if (bytes.includes(passwordRaw) || bytes.includes(b64)) {
        throw new OperatorChannelError('CHANNEL_ARGV_CARRIES_SECRET', 'Refusing to spawn: an argument carries the operator password (raw or base64).')
      }
    }
  } finally {
    b64.fill(0)
  }
}

// ---------------------------------------------------------------------------
// The contract clauses of the channel (measured by the tests and the PEB demonstration)
// ---------------------------------------------------------------------------

export interface ChannelClause {
  readonly id: string
  readonly clause: string
  readonly source: string
  readonly measuredBy: string
}

export const OPERATOR_CHANNEL_CONTRACT: readonly ChannelClause[] = [
  { id: 'OC-1', clause: 'The launcher runs only from a console: stdin is a TTY and the process is attached to a console (bridge `console` op), checked before any prompt.', source: 'AC-4 "en su propio entorno con consola"; process-delivery B-1 model', measuredBy: 'N-CONHOST, P-3' },
  { id: 'OC-2', clause: 'The connection string is read in raw mode; no byte of it is written to any stream; a stream that does not report raw is refused.', source: 'AC-4 "se solicita sin eco"', measuredBy: 'N-ECHO' },
  { id: 'OC-3', clause: 'Piped input is refused unless the planned target is an RFC 6761 .invalid host (synthetic demonstration only).', source: 'AC-4 "solo ... durante la ejecución autorizada"', measuredBy: 'N-SYNTHETIC-MODE-REAL-HOST' },
  { id: 'OC-4', clause: 'Before any process is created, the string must name the planned host (N04) EXACTLY and, for the mint, the principal the certified OEP-1 evidence observed.', source: 'EXECUTION_PROCEDURE "target-host derivado exclusivamente de N04 ... cualquier mismatch => STOP"', measuredBy: 'N-WRONG-HOST, R2-N-STARTUP' },
  { id: 'OC-5', clause: 'The launcher refuses to run if the variable is already set in its own environment, and never writes process.env.', source: 'AC-6 "no dejar secreto en parent process.env"', measuredBy: 'N-PARENT-ENV, R2-N-L1, R3-N-L1X' },
  { id: 'OC-6', clause: 'The tool receives the value only in its own environment block, built from TOOL_ENV_ALLOWLIST plus the one variable; argv carries neither the string nor its password, raw or base64.', source: 'AC-4 "no aparece en argv"; AC-6 "no transmitirlo a procesos no autorizados"', measuredBy: 'N-ARGV, P-3, R2-N-X08, R3-N-X08X' },
  { id: 'OC-7', clause: 'The tool is spawned with windowsHide:false, detached:false, shell:false, so it shares the launcher console (no new conhost) and stays inside its kill-on-close job.', source: 'AC-6 "probar ausencia de herencia accidental hacia conhost"', measuredBy: 'P-3, N-CONHOST' },
  { id: 'OC-8', clause: 'The tool file is the pinned one: its sha256 equals the plan and the CHANNEL_BINDING pin, checked before the prompt.', source: 'TOOL_BINDING', measuredBy: 'N-STALE-TOOL-HASH' },
  { id: 'OC-9', clause: 'The launcher zeroes its Buffers after spawn, relays only the tool\'s JSON lines, writes no file, and exits with the tool. Its heap still holds several non-zeroable copies of the string (the environment entry and what Node/libuv derive from it): disclosed, not claimed away.', source: 'AC-6 "tener lifetime acotado; ser destruida después del child"; recertification nonblocker (6-8 heap copies)', measuredBy: 'N-FILE-TEMP, P-10' },
  { id: 'OC-10', clause: 'The plan (target host, port, database, valid-until, driver root, version and digest, depositor, tool and launcher hashes, principal) is re-derived from the repository by the pre-execution gate; any field that differs is STOP, as is a dirty worktree.', source: 'EXECUTION_PROCEDURE', measuredBy: 'N-WRONG-HOST, N-WRONG-VALID-UNTIL, N-WRONG-DRIVER-ROOT, N-STALE-TOOL-HASH, R2-N-P1, R2-N-P6, R2-N-P10, R3-N-P6X' },
  { id: 'OC-11', clause: 'The session is bound and its startup is closed: the string carries no query and no fragment, and names exactly the planned port and database; the tools build the driver from explicit options (OT-16), whose only client-sourced settings are the ones measured for postgres.js 3.4.9 (OEP1_EXPECTED_CLIENT_SETTINGS).', source: 'recertification of 979b1440 (startup GUC via URL; database not bound; host startsWith survived)', measuredBy: 'R2-N-STARTUP' },
  { id: 'OC-12', clause: 'The probe is planned only after a terminal-PASS certification event certifies an ancestor candidate whose operator-channel authority carries the same CHANNEL_BINDING.', source: 'owner OEP1_PROBE = C ("se ejecutará por el canal ya certificado"); recertification nonblocker', measuredBy: 'R2-N-PROBE-UNCERTIFIED' },
  { id: 'OC-13', clause: 'The server is authenticated: the plan names the pinned project certificate and the sha256 of its bytes; the launcher refuses before the prompt when the file is absent or differs; the tools use it as their ONLY trust anchor with rejectUnauthorized and hostname verification, and download nothing (OT-18).', source: 'owner AC-8 TLS_TRUST_POLICY = VERIFY_FULL_PINNED_CA, CA_TRUST_ROOT_SOURCE = PROJECT_SPECIFIC_SUPABASE_CERTIFICATE; recertification of fa43b396 (TLS = B)', measuredBy: 'R3-P-TLS, R3-N-TLS-*, R3-N-CA-MISSING, R3-N-CA-MODIFIED' },
  { id: 'OC-14', clause: 'No ambient variable that steers postgres.js (PG*) or the TLS stack reaches a tool: its environment is the allowlist plus the one variable, and each tool refuses to work when such a variable is present (OT-19).', source: 'recertification of fa43b396 (X08x: postgres.js reads PG<OPTION> for every option not given)', measuredBy: 'R3-N-X08X' },
  { id: 'OC-15', clause: 'The channel starts ONLY through the pre-node boundary: a fixed, pinned script run by the operator shell refuses every Node runtime/trust variable (NODE_*, OPENSSL_*, SSL_CERT_FILE/DIR, LD_*/DYLD_* preload variables) BEFORE any Node process exists, checks the node binary against its sha256 pin, and starts node with no flags and an allowlisted environment carrying its mark; the launcher refuses to prompt without that mark, with runtime flags, or with any NODE_* variable (defence in depth).', source: 'owner R4 NB-1 (the final recertification of b4ca05ac: a NODE_OPTIONS preload captured the credential before the launcher could refuse)', measuredBy: 'R4-P-BOUNDARY, R4-N-PRELOAD, R4-N-RUNTIME-INPUTS, R4-N-NODE-PIN, R4-N-DIRECT' },
]

// ---------------------------------------------------------------------------
// OEP-1, reconstructed around PLAINTEXT_PASSWORD_SERVER_EXPOSURE = IMPOSSIBLE_BY_CONSTRUCTION
// ---------------------------------------------------------------------------
//
// The failed design asked a hosted server, through a closed list of logging
// settings, whether it would log the plaintext. The recertification showed the
// class is open (any emitter during the nested EXECUTE quotes it). The plaintext
// no longer reaches the server at all (route-B RB-DELTA-4, OT-15), so OEP-1 no
// longer infers anything about logging for the PLAINTEXT. What it still needs,
// and what the PHASE 2 probe proves, is that the privileged session the mint
// will use is the one the channel was certified for:
//
//   PLAINTEXT_NOT_SERVER_VISIBLE      by construction (transport, DO guard,
//                                     certified mint tool), never from logs
//   TARGET_SESSION_BOUND              observed: principal, database; bound: N04 host, port
//   STARTUP_PARAMETERS_CLOSED         observed: the client-sourced settings are exactly
//                                     the measured postgres.js set
//   TOOL_HASH_BOUND                   evidence hashes = the certified pins
//   PROBE_MINT_CONFIGURATION_COHERENT the probe's session fingerprint = the mint's
//
// DERIVED_MATERIAL_EXPOSURE (can the VERIFIER be logged?) is classified
// separately and never counted as, or confused with, PLAINTEXT_NOT_PRESENT.

/** Measured on disposable PostgreSQL 17.6 (supabase image) with postgres.js 3.4.9 built from explicit options. */
export const OEP1_EXPECTED_CLIENT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['application_name', 'postgres.js'],
  ['client_encoding', 'UTF8'],
]

/** Settings read ONLY to classify derived-material (verifier) exposure. Informational; they gate nothing about the plaintext. */
export const OEP1_DERIVED_MATERIAL_SETTINGS: readonly string[] = [
  'auto_explain.log_min_duration',
  'auto_explain.log_nested_statements',
  'debug_print_parse',
  'debug_print_plan',
  'debug_print_rewritten',
  'log_lock_waits',
  'log_min_duration_statement',
  'log_min_error_statement',
  'log_parser_stats',
  'log_planner_stats',
  'log_statement',
  'log_statement_stats',
  'pg_stat_statements.track',
  'pg_stat_statements.track_utility',
  'pgaudit.log',
  'pgaudit.role',
  'pgtle.enable_password_check',
  'shared_preload_libraries',
].sort()

/** The probe's statements, as the driver sends them ($n = bound). Nothing else, inside BEGIN READ ONLY. */
export const OEP1_PROBE_STATEMENTS = {
  IDENTITY: "SELECT current_user AS current_user_name, session_user AS session_user_name, current_database() AS database_name, current_setting('server_version_num') AS server_version_num",
  CLIENT_SETTINGS: "SELECT name, setting FROM pg_catalog.pg_settings WHERE source = 'client' ORDER BY name",
  DERIVED_MATERIAL_SETTINGS: 'SELECT name, setting, source FROM pg_catalog.pg_settings WHERE name = ANY($1::text[]) ORDER BY name',
} as const

export interface Oep1Observation {
  readonly identity: { readonly current_user: string; readonly session_user: string; readonly database: string; readonly server_version_num: string }
  readonly client_settings: ReadonlyArray<readonly [string, string]>
  readonly derived_settings: ReadonlyArray<{ readonly name: string; readonly setting: string; readonly source?: string }>
}

export type SubVerdict = 'PASS' | 'FAIL'

/** The two sub-verdicts an observation decides by itself. */
export function evaluateOep1Session(o: Oep1Observation, expect: { readonly principal: string; readonly database: string }): {
  readonly TARGET_SESSION_BOUND: SubVerdict
  readonly STARTUP_PARAMETERS_CLOSED: SubVerdict
  readonly reasons: readonly string[]
} {
  const r: string[] = []
  const id = o.identity
  const bound = id.current_user === expect.principal && id.session_user === expect.principal && id.database === expect.database && Number(id.server_version_num) >= 100000
  if (!bound) r.push('TARGET_SESSION_BOUND: the observed principal/database/server version is not the planned session')
  const closed = JSON.stringify(o.client_settings.map(([n, s]) => [n, s])) === JSON.stringify(OEP1_EXPECTED_CLIENT_SETTINGS.map(([n, s]) => [n, s]))
  if (!closed) r.push('STARTUP_PARAMETERS_CLOSED: the client-sourced settings are not exactly the measured postgres.js set')
  return { TARGET_SESSION_BOUND: bound ? 'PASS' : 'FAIL', STARTUP_PARAMETERS_CLOSED: closed ? 'PASS' : 'FAIL', reasons: r }
}

/**
 * Could the VERIFIER (derived material) reach a server log? Informational:
 * POSSIBLE when any known emitter is on, NOT_INDICATED when none of the read
 * settings indicates it, UNKNOWN when a setting was not visible. The class is
 * open (the recertification's lesson), so NOT_INDICATED is never "absent".
 */
export function classifyDerivedMaterialExposure(derived: Oep1Observation['derived_settings']): { readonly classification: 'POSSIBLE' | 'NOT_INDICATED' | 'UNKNOWN'; readonly emitters: readonly string[] } {
  const by = new Map(derived.map((d) => [d.name, String(d.setting).trim().toLowerCase()]))
  const emitters: string[] = []
  const on = (n: string, pred: (v: string) => boolean) => {
    const v = by.get(n)
    if (v !== undefined && pred(v)) emitters.push(n)
  }
  for (const n of ['debug_print_parse', 'debug_print_plan', 'debug_print_rewritten', 'log_lock_waits', 'log_parser_stats', 'log_planner_stats', 'log_statement_stats', 'pgtle.enable_password_check']) on(n, (v) => v === 'on')
  on('log_statement', (v) => v !== 'none')
  on('log_min_duration_statement', (v) => v !== '-1')
  on('auto_explain.log_min_duration', (v) => v !== '-1')
  on('pgaudit.log', (v) => v !== '' && v !== 'none')
  on('pgaudit.role', (v) => v !== '')
  on('pg_stat_statements.track', (v) => v === 'all')
  const missing = OEP1_DERIVED_MATERIAL_SETTINGS.filter((n) => !by.has(n) && !n.includes('.'))
  return { classification: emitters.length > 0 ? 'POSSIBLE' : missing.length > 0 ? 'UNKNOWN' : 'NOT_INDICATED', emitters }
}

// ---------------------------------------------------------------------------
// OT-17: the driver bound by content, not only by version
// ---------------------------------------------------------------------------

/**
 * sha256 over the sorted "<relative posix path>:<sha256 of bytes>\n" lines of
 * every file of the package directory, after resolving symlinks (pnpm links
 * node_modules/postgres into its store). The tools compute the same thing,
 * inline, before loading the driver.
 */
export function driverDigest(packageDir: string): string {
  const root = realpathSync(packageDir)
  const lines: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else lines.push(`${relative(root, p).split(sep).join('/')}:${createHash('sha256').update(readFileSync(p)).digest('hex')}\n`)
    }
  }
  walk(root)
  return createHash('sha256').update(lines.sort().join('')).digest('hex')
}
