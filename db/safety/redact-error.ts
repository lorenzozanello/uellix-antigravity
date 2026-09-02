// db/safety/redact-error.ts
//
// Credential-free rendering of ANY error a database entry point can produce.
//
// The guard's own errors are redacted by construction. The hazard is the first
// error AFTER the guard: postgres-js builds connection failures as
// `'write ' + code + ' ' + host + ':' + port` and attaches `address`/`port`
// (src/errors.js), so a script that does `console.error('Failed:', err)`
// prints the full remote hostname — and, for Supabase, the project reference —
// even though every guard message was careful not to.
//
// Every entry point routes its catch-all through `describeError`.

import { redactHost } from './database-target'

interface DriverErrorShape {
  message?: unknown
  code?: unknown
  address?: unknown
  hostname?: unknown
  port?: unknown
  errno?: unknown
  name?: unknown
  cause?: unknown
}

/**
 * Error codes whose MESSAGE is built from the host and must never be printed.
 *
 * `ENOTFOUND` is the important one: DNS failures carry `hostname` rather than
 * `address`, so an address-only check missed them and
 * `getaddrinfo ENOTFOUND db.<ref>.example.net` reached the log intact.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTO',
  'CONNECT_TIMEOUT',
  'CONNECTION_REFUSED',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
])

function isNetworkErrorCode(code: unknown): boolean {
  return typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || code.startsWith('CONNECT'))
}

/**
 * Extract a host from a value that may be a string OR an array.
 *
 * postgres-js sets `address: options.path || host`, and `options.host` is an
 * ARRAY (`host.split(',').map(...)` in src/index.js). A `typeof === 'string'`
 * check therefore never matched a real driver connection error, which left
 * the whole path depending on the errno list.
 */
function hostOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry !== '')
    return typeof first === 'string' ? first : null
  }
  return null
}

/** Depth-limited search for the network layer's host, which `fetch` nests. */
function findAddress(error: unknown, depth = 0): { address: string; port?: number; code?: string } | null {
  if (depth > 4 || typeof error !== 'object' || error === null) return null
  const candidate = error as DriverErrorShape
  const host = hostOf(candidate.address) ?? hostOf(candidate.hostname)
  if (host !== null) {
    const port = Array.isArray(candidate.port) ? candidate.port[0] : candidate.port
    return {
      address: host,
      port: typeof port === 'number' ? port : undefined,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
    }
  }
  // `TypeError: fetch failed` carries the real ECONNREFUSED under `cause`;
  // an AggregateError carries its members under `errors`. Search BOTH — an
  // early return on `cause` made the `errors` branch dead whenever both were
  // present.
  if (candidate.cause !== undefined) {
    const found = findAddress(candidate.cause, depth + 1)
    if (found) return found
  }
  if (Array.isArray((error as { errors?: unknown }).errors)) {
    for (const nested of (error as { errors: unknown[] }).errors) {
      const found = findAddress(nested, depth + 1)
      if (found) return found
    }
  }
  return null
}

/**
 * True when the error came from the network layer.
 *
 * A host-bearing field, or a connect-class errno. Deliberately NOT "has any
 * `errno`": every Node syscall error carries one, so that version reported a
 * missing fixture file as `ENOENT (network failure)` — a fabricated diagnosis.
 */
function looksLikeNetworkError(candidate: DriverErrorShape): boolean {
  return (
    candidate.address !== undefined ||
    candidate.hostname !== undefined ||
    isNetworkErrorCode(candidate.code)
  )
}

/** SQLSTATE is exactly five alphanumerics. Anything else is not a server error. */
function isSqlState(code: unknown): boolean {
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
}

/**
 * Unwrap an ORM error that embeds the statement in its own message.
 *
 * `DrizzleQueryError` builds `Failed query: ${query}\nparams: ${params}` —
 * the full SQL AND every bound parameter value. It carries no `address` and
 * no `errno`, so it fell through to the generic branch and those lines were
 * printed verbatim into run reports. Bound parameters routinely contain
 * emails and other personal data.
 */
function unwrapQueryError(candidate: DriverErrorShape): DriverErrorShape | null {
  const wrapper = candidate as DriverErrorShape & { query?: unknown; params?: unknown }
  if (wrapper.query === undefined && wrapper.params === undefined) return null
  return (wrapper.cause ?? { message: 'no cause reported' }) as DriverErrorShape
}

/**
 * Redact hosts that appear inside a free-text message.
 *
 * Deliberately conservative: only full URLs and names ending in a common TLD
 * are rewritten. A pattern like "any dotted token" would mangle the useful
 * part of Postgres server errors, where `public.users` is a table, not a host.
 */
function scrubMessage(message: string): string {
  return (
    message
      .replace(
        /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|co|io|net|org|dev|app|cloud|sh|ai)\b/gi,
        (match) => redactHost(match)
      )
      // Dotted quads. `redactHost` passes loopback through unchanged, so a
      // local diagnostic stays readable while a public address is masked.
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (match) => redactHost(match))
      // URLs LAST. Running this first fed its own output back into the TLD
      // rule above, so `db.<ref>.supabase.co` came out as `***.***.co`
      // instead of `***.supabase.co` — safe, but less useful for diagnosis.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (match) => {
        try {
          const parsed = new URL(match)
          return `${parsed.protocol}//${redactHost(parsed.hostname)}`
        } catch {
          return '(redacted url)'
        }
      })
  )
}

/**
 * Render an error as a single line that can safely be printed, logged, or
 * pasted into a committed run report.
 *
 * `DatabaseSafetyError` (and anything else carrying a `code` we produced) is
 * already safe and passes through. A driver error is reduced to its error
 * code plus a REDACTED host and port — never its message, which embeds the
 * host verbatim.
 */
export function describeError(error: unknown, depth = 0): string {
  if (typeof error !== 'object' || error === null) return '(non-error value)'

  const candidate = error as DriverErrorShape

  // Our own errors are built from known-safe parts: the typed guard errors,
  // and anything carrying a `DB_`-prefixed code (e.g. the restriction errors
  // in db/client.ts), whose messages are explanatory and host-free.
  if (
    candidate.name === 'DatabaseSafetyError' ||
    candidate.name === 'LocalDatabaseUrlResolutionError' ||
    (typeof candidate.code === 'string' && candidate.code.startsWith('DB_'))
  ) {
    return String(candidate.message ?? candidate.name)
  }

  // A network/driver error — possibly nested under `cause`, which is how
  // `TypeError: fetch failed` from the Supabase client carries ECONNREFUSED.
  // Report the classification, never the message: postgres-js builds it as
  // 'write ' + code + ' ' + host + ':' + port.
  const network = findAddress(candidate)
  if (network) {
    const code = network.code ?? (typeof candidate.code === 'string' ? candidate.code : 'CONNECTION_ERROR')
    return `${code} while connecting to host=${redactHost(network.address)} port=${network.port ?? 'unset'}`
  }

  // A network failure that exposed no structured host: its message is built
  // FROM the host, so it is dropped entirely rather than scrubbed. Scrubbing
  // is a pattern match and cannot be exhaustive — it cannot know every TLD,
  // and it must not mask dotted SQL identifiers like `public.users`.
  if (looksLikeNetworkError(candidate)) {
    const code = typeof candidate.code === 'string' ? candidate.code : 'CONNECTION_ERROR'
    return `${code} (network failure; host withheld)`
  }

  // An ORM wrapper whose own message is the statement plus its bound
  // parameters. Report the underlying error instead; the SQL and the
  // parameter values are dropped entirely.
  //
  // RECURSES rather than reading the cause directly, so the cause is held to
  // exactly the same rules — a TLS or DNS failure surfaced on the first query
  // arrives wrapped, and reading its message directly would have leaked the
  // host that the top-level branches are careful to withhold. The depth cap
  // also covers a wrapper whose cause is another wrapper.
  const unwrapped = unwrapQueryError(candidate)
  if (unwrapped) {
    return depth < 4
      ? `query failed: ${describeError(unwrapped, depth + 1)}`
      : 'query failed: (nested; details withheld)'
  }

  // A Postgres server error. SQLSTATE is exactly five alphanumerics; its
  // message describes the statement's problem, not the connection, so it is
  // the most useful thing we can show. Still scrubbed, since an application
  // error can embed a URL in its text.
  if (isSqlState(candidate.code)) {
    return `[${String(candidate.code)}] ${scrubMessage(String(candidate.message ?? 'unknown error'))}`
  }

  // A code that is NOT a SQLSTATE means the error came from somewhere whose
  // message conventions we do not control — a syscall, a driver, an HTTP
  // client. Pattern-scrubbing cannot be exhaustive (it cannot know every
  // TLD), so the message is withheld rather than guessed at.
  if (typeof candidate.code === 'string') {
    return `${candidate.code} (message withheld; not a server error)`
  }

  return scrubMessage(String(candidate.message ?? 'unknown error'))
}
