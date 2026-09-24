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
  readonly username: string
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
  return { host: url.hostname.toLowerCase(), username: decodeURIComponent(url.username), passwordRaw: Buffer.from(url.password, 'utf8') }
}

/** The pre-spawn checks the plan binds: the host is N04's, and for the mint the principal is the one OEP-1 observed. */
export function checkOperatorUrlAgainstPlan(facts: OperatorUrlFacts, plan: { readonly targetHost: string; readonly operatorPrincipal: string | null }): void {
  if (facts.host !== plan.targetHost.toLowerCase()) {
    throw new OperatorChannelError('CHANNEL_WRONG_HOST', 'The connection string does not name the planned target host (derived from N04). Nothing was spawned.')
  }
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
  { id: 'OC-4', clause: 'Before any process is created, the string must name the planned host (N04) and, for the mint, the principal the certified OEP-1 evidence observed.', source: 'EXECUTION_PROCEDURE "target-host derivado exclusivamente de N04 ... cualquier mismatch => STOP"', measuredBy: 'N-WRONG-HOST' },
  { id: 'OC-5', clause: 'The launcher refuses to run if the variable is already set in its own environment, and never writes process.env.', source: 'AC-6 "no dejar secreto en parent process.env"', measuredBy: 'N-PARENT-ENV' },
  { id: 'OC-6', clause: 'The tool receives the value only in its own environment block, built from TOOL_ENV_ALLOWLIST plus the one variable; argv carries neither the string nor its password, raw or base64.', source: 'AC-4 "no aparece en argv"; AC-6 "no transmitirlo a procesos no autorizados"', measuredBy: 'N-ARGV, P-3' },
  { id: 'OC-7', clause: 'The tool is spawned with windowsHide:false, detached:false, shell:false, so it shares the launcher console (no new conhost) and stays inside its kill-on-close job.', source: 'AC-6 "probar ausencia de herencia accidental hacia conhost"', measuredBy: 'P-3, N-CONHOST' },
  { id: 'OC-8', clause: 'The tool file is the pinned one: its sha256 equals the plan and the CHANNEL_BINDING pin, checked before the prompt.', source: 'TOOL_BINDING', measuredBy: 'N-STALE-TOOL-HASH' },
  { id: 'OC-9', clause: 'The launcher zeroes its Buffer after spawn, relays only the tool\'s JSON lines, writes no file, and exits with the tool.', source: 'AC-6 "tener lifetime acotado; ser destruida después del child"', measuredBy: 'N-FILE-TEMP, P-10' },
  { id: 'OC-10', clause: 'The plan (target host, valid-until, driver root and version, depositor, tool and launcher hashes, principal) is re-derived from the repository by the pre-execution gate; any field that differs is STOP.', source: 'EXECUTION_PROCEDURE', measuredBy: 'N-WRONG-HOST, N-WRONG-VALID-UNTIL, N-WRONG-DRIVER-ROOT, N-STALE-TOOL-HASH' },
]

// ---------------------------------------------------------------------------
// OEP-1: the minimal non-secret verification of the hosted logging posture
// ---------------------------------------------------------------------------

/**
 * The CLOSED list of settings the probe observes. Every one decides whether the
 * mint's statements (three bound set_config SELECTs, one DO block whose EXECUTE
 * formats the password into a nested ALTER ROLE) could be recorded with the
 * value, or names a library that could record it.
 */
export const OEP1_CORE_SETTINGS = [
  'log_statement',
  'log_min_duration_statement',
  'log_min_duration_sample',
  'log_statement_sample_rate',
  'log_transaction_sample_rate',
  'log_parameter_max_length',
  'log_parameter_max_length_on_error',
  'log_min_error_statement',
  'debug_print_parse',
  'debug_print_rewritten',
  'debug_print_plan',
  'shared_preload_libraries',
  'session_preload_libraries',
  'local_preload_libraries',
] as const

/** Library-scoped settings, required visible only when their library is preloaded. */
export const OEP1_LIBRARY_SETTINGS = {
  pgaudit: ['pgaudit.log', 'pgaudit.log_parameter', 'pgaudit.log_statement', 'pgaudit.role'],
  auto_explain: ['auto_explain.log_min_duration', 'auto_explain.log_nested_statements', 'auto_explain.log_parameter_max_length'],
  pg_stat_statements: ['pg_stat_statements.track', 'pg_stat_statements.track_utility'],
} as const

/** Libraries that record statement text and for which no rule is derived here: loaded -> INCONCLUSIVE. */
export const OEP1_UNRULED_STATEMENT_RECORDERS = ['pg_stat_monitor', 'pg_store_plans', 'pg_qualstats'] as const

export const OEP1_SETTINGS: readonly string[] = [...OEP1_CORE_SETTINGS, ...Object.values(OEP1_LIBRARY_SETTINGS).flat()].sort()

/** The probe's statements, as the driver sends them ($n = bound). The probe sends these and nothing else, inside BEGIN READ ONLY. */
export const OEP1_PROBE_STATEMENTS = {
  IDENTITY: 'SELECT current_user AS current_user_name, session_user AS session_user_name',
  SETTINGS: 'SELECT name, setting, source FROM pg_catalog.pg_settings WHERE name = ANY($1::text[]) ORDER BY name',
  EXTENSIONS: 'SELECT extname FROM pg_catalog.pg_extension WHERE extname = ANY($1::text[]) ORDER BY extname',
} as const

export const OEP1_EXTENSION_NAMES = [...Object.keys(OEP1_LIBRARY_SETTINGS), ...OEP1_UNRULED_STATEMENT_RECORDERS].sort()

export interface Oep1Observation {
  readonly rows: readonly { readonly name: string; readonly setting: string; readonly source?: string }[]
  readonly extensions: readonly string[]
}

export type Oep1Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

/** Library names out of a *_preload_libraries value: comma list, quoting and $libdir/ prefixes removed. */
export function preloadedLibraries(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(','))
    .map((x) => x.trim().replace(/^"|"$/g, '').replace(/^\$libdir\//, '').toLowerCase())
    .filter((x) => x !== '')
}

/**
 * The verdict. PASS only when every required setting is VISIBLE and every rule
 * holds; any invisible required setting is INCONCLUSIVE; any unsafe value is
 * FAIL. Only PASS closes OEP-1.
 */
export function evaluateOep1(o: Oep1Observation): { readonly verdict: Oep1Verdict; readonly failures: readonly string[]; readonly missing: readonly string[] } {
  const by = new Map(o.rows.map((r) => [r.name, String(r.setting)]))
  const failures: string[] = []
  const missing: string[] = []
  const need = (name: string): string | null => {
    const v = by.get(name)
    if (v === undefined) {
      missing.push(name)
      return null
    }
    return v.trim().toLowerCase()
  }
  const rule = (ok: boolean, why: string): void => {
    if (!ok) failures.push(why)
  }
  for (const name of o.rows.map((r) => r.name)) if (!OEP1_SETTINGS.includes(name)) failures.push(`the observation carries ${name}, which is not in the closed list`)

  const logStatement = need('log_statement')
  if (logStatement !== null) rule(logStatement === 'none' || logStatement === 'ddl', `log_statement = ${logStatement} would log the SELECT set_config statements with their parameters`)
  const minDur = need('log_min_duration_statement')
  if (minDur !== null) rule(minDur === '-1', `log_min_duration_statement = ${minDur} logs statements (with parameters) by duration`)
  const sampleDur = need('log_min_duration_sample')
  const sampleRate = need('log_statement_sample_rate')
  if (sampleDur !== null && sampleRate !== null) rule(sampleDur === '-1' || Number(sampleRate) === 0, `log_min_duration_sample = ${sampleDur} with log_statement_sample_rate = ${sampleRate} samples statements into the log`)
  const txRate = need('log_transaction_sample_rate')
  if (txRate !== null) rule(Number(txRate) === 0, `log_transaction_sample_rate = ${txRate} logs every statement of sampled transactions`)
  need('log_parameter_max_length')
  const onError = need('log_parameter_max_length_on_error')
  if (onError !== null) rule(onError === '0', `log_parameter_max_length_on_error = ${onError} writes bound parameters of a failing statement to the log`)
  need('log_min_error_statement')
  for (const d of ['debug_print_parse', 'debug_print_rewritten', 'debug_print_plan']) {
    const v = need(d)
    if (v !== null) rule(v === 'off', `${d} = ${v} writes query trees (including the EXECUTEd statement) to the log`)
  }
  const preload = ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries'].map((n) => need(n)).filter((v): v is string => v !== null)
  const libs = preloadedLibraries(preload)

  if (libs.includes('pgaudit')) {
    const log = need('pgaudit.log')
    const role = need('pgaudit.role')
    need('pgaudit.log_parameter')
    need('pgaudit.log_statement')
    if (log !== null) rule(log === 'none' || log === '', `pgaudit.log = ${log}: session audit logging could record the nested ALTER ROLE`)
    if (role !== null) rule(role === '', `pgaudit.role = ${role}: object audit logging is configured`)
  }
  if (libs.includes('auto_explain')) {
    const d = need('auto_explain.log_min_duration')
    need('auto_explain.log_nested_statements')
    need('auto_explain.log_parameter_max_length')
    if (d !== null) rule(d === '-1', `auto_explain.log_min_duration = ${d} logs statement text`)
  }
  if (libs.includes('pg_stat_statements')) {
    const track = need('pg_stat_statements.track')
    const utility = need('pg_stat_statements.track_utility')
    if (track !== null && utility !== null) rule(!(track === 'all' && utility === 'on'), 'pg_stat_statements.track = all with track_utility = on stores the nested ALTER ROLE text')
  }
  for (const r of OEP1_UNRULED_STATEMENT_RECORDERS) {
    if (libs.includes(r)) missing.push(`(${r} is preloaded and no rule for it is derived)`)
  }
  const verdict: Oep1Verdict = failures.length > 0 ? 'FAIL' : missing.length > 0 ? 'INCONCLUSIVE' : 'PASS'
  return { verdict, failures, missing }
}
