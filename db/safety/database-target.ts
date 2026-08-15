// db/safety/database-target.ts
//
// CLASSIFICATION LAYER of the database access safety architecture.
//
// This module answers exactly one question: "what kind of host does this
// connection string point at?". It never decides whether an operation is
// allowed — that is db/safety/database-access.ts. Keeping the two apart is
// deliberate: a target being `local_loopback` is not authorization, and a
// target being `managed_remote` is not, by itself, production.
//
// DESIGN RULES
//
//  1. Real URL parsing (WHATWG `URL`), never substring or regex matching on
//     the raw string. `postgresql://localhost@evil.example.com/db` has the
//     hostname `evil.example.com`; a `includes('localhost')` check would call
//     it local.
//  2. Fail closed. Anything we cannot categorise with confidence becomes
//     `unknown`, and `unknown` is never granted a capability.
//  3. Never return, log or embed the original URL, its credentials, or its
//     query string. Callers get a classification plus a redacted host.
//
// A NOTE ON `postgresql:` AND OPAQUE HOSTS
//
// `postgresql:` is a non-special scheme per the URL Standard, so its host is
// parsed as an *opaque host*: no IDNA, no percent-decoding, no lowercasing.
// That is good for us (percent-encoded hosts stay literal and therefore fail
// the allow-list), but it means we must lowercase defensively ourselves and
// must treat any host still containing `%` as `unknown` rather than guessing
// what the driver will decode it to.

import { LOCAL_CONTAINER_HOSTS } from './local-stack'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Injectable environment.
 *
 * Deliberately NOT `NodeJS.ProcessEnv`: Next.js augments that interface with a
 * required `NODE_ENV` restricted to three literals, which would force every
 * test to construct a full environment and would reject the `staging` / `ci`
 * values this layer reasons about. `process.env` is assignable to this.
 */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type DatabaseTargetKind =
  /** localhost, 127.0.0.0/8, ::1 — this machine's loopback interface. */
  | 'local_loopback'
  /** A container hostname explicitly allow-listed by the caller. */
  | 'local_container'
  /** RFC1918 / CGNAT / link-local / IPv6 ULA. Private ≠ authorised. */
  | 'private_network'
  /** A publicly routable host: managed Postgres, Supabase, any public DNS/IP. */
  | 'managed_remote'
  /** Parsed, but not categorisable with confidence. Always fails closed. */
  | 'unknown'
  /** Absent, unparseable, wrong scheme, or hostless. Always fails closed. */
  | 'invalid'

export type DatabaseTargetProvider = 'supabase' | 'other'

/** Why a target ended up `unknown` or `invalid`. Diagnostics only — no values. */
export type DatabaseTargetReason =
  | 'missing'
  | 'unparseable'
  | 'unsupported_scheme'
  | 'no_hostname'
  | 'percent_encoded_host'
  | 'wildcard_address'
  | 'ipv4_mapped_ipv6'
  | 'ambiguous_ipv4_octets'
  | 'unrecognised_host'
  | 'ambiguous_authority'

export interface DatabaseTarget {
  readonly kind: DatabaseTargetKind
  /**
   * Lowercased hostname, brackets stripped for IPv6. Present for every
   * successfully parsed URL, including `unknown`. Intended for programmatic
   * comparison (allow-lists, expected hosts) — NOT for log output. Use
   * `redactedHost` whenever a value reaches a human, a log line or an error.
   */
  readonly hostname: string | null
  /** Safe-to-display host. Loopback verbatim; everything else masked. */
  readonly redactedHost: string
  /** Explicit port, or null when the URL omitted one. Never a secret. */
  readonly port: number | null
  /** Managed-provider hint. Never implies an environment. */
  readonly provider: DatabaseTargetProvider | null
  /**
   * Project reference parsed out of a Supabase host or pooler username.
   * Compared against caller expectations; never printed.
   */
  readonly projectRef: string | null
  /** True when the URL carried a username and/or password. Never their values. */
  readonly hasCredentials: boolean
  /**
   * Query parameter NAMES (never values) that postgres-js would forward into
   * the connection's startup packet.
   *
   * The driver builds `connection: { application_name, ...caller.connection,
   * ...query }` — every query key it does not recognise as one of its own
   * options lands in the startup packet AFTER whatever the caller set. So a
   * URL can override settings this repository applies deliberately:
   * `?options=-c default_transaction_read_only=off` does it, and so does the
   * shorter `?default_transaction_read_only=off`, since Postgres applies
   * startup GUCs in packet order and the later one wins.
   *
   * Non-empty means the URL can reconfigure the session. The authorization
   * layer decides which capabilities tolerate that.
   */
  readonly injectedConnectionParameters: readonly string[]
  readonly reason: DatabaseTargetReason | null
}

export interface ClassifyOptions {
  /** Extra hostnames that count as `local_container`. Exact, lowercased match. */
  readonly containerHosts?: readonly string[]
  /** Accepted URL schemes, without the colon. Defaults to postgres/postgresql. */
  readonly allowedSchemes?: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const POSTGRES_SCHEMES = Object.freeze(['postgres', 'postgresql'])
const HTTP_SCHEMES = Object.freeze(['http', 'https'])

const LOOPBACK_HOSTNAMES = Object.freeze(['localhost'])
const IPV6_LOOPBACK = Object.freeze(['::1', '0:0:0:0:0:0:0:1'])

/** `*.supabase.co` / `*.supabase.com`, including the shared poolers. */
const SUPABASE_SUFFIXES = Object.freeze(['.supabase.co', '.supabase.com'])

/**
 * Query parameters postgres-js consumes as its OWN options instead of
 * forwarding them into the startup packet.
 *
 * NOTE: `sslrootcert` is deliberately NOT here. It looks like a driver option
 * and it does influence `ssl`, but it is absent from the driver`s `defaults`
 * object, so the `k in defaults` filter keeps it and it IS forwarded. An
 * allow-list is only as good as its accuracy, so it is derived from what the
 * driver actually consumes, not from what its names suggest.
 *
 * Mirrors the `defaults` object plus the two TLS keys it special-cases, in
 * src/index.js `parseOptions` (postgres@3.4.9). The comparison is exact and
 * case-sensitive because the driver's own test is `k in defaults` — so
 * `SSLMODE` is NOT recognised and would be forwarded, which is precisely why
 * an allow-list is the right shape here and a denylist of known-bad names
 * would not be.
 */
const DRIVER_CONSUMED_QUERY_KEYS: ReadonlySet<string> = new Set([
  'max',
  'ssl',
  'sslmode',
  'sslnegotiation',
  'idle_timeout',
  'connect_timeout',
  'max_lifetime',
  'max_pipeline',
  'backoff',
  'keep_alive',
  'prepare',
  'debug',
  'fetch_types',
  'publications',
  'target_session_attrs',
])

/* -------------------------------------------------------------------------- */
/* Host primitives                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Strict dotted-quad parser.
 *
 * Rejects leading zeros (`127.0.0.01`): glibc and several drivers read those
 * as octal, so the address the guard sees would differ from the address the
 * driver dials. An ambiguous literal must never be classified as loopback.
 */
function parseIPv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith('0')) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

/** Loose IPv6 shape test — enough to route classification, not a validator. */
function looksLikeIPv6(host: string): boolean {
  return host.includes(':')
}

function classifyIPv6(host: string): { kind: DatabaseTargetKind; reason: DatabaseTargetReason | null } {
  const normalised = host.toLowerCase()
  if (IPV6_LOOPBACK.includes(normalised)) return { kind: 'local_loopback', reason: null }

  // ::ffff:127.0.0.1 and friends. The embedded IPv4 makes "is this local?"
  // depend on driver and OS behaviour, so we refuse to guess.
  if (normalised.startsWith('::ffff:') || normalised.startsWith('::0000:ffff:')) {
    return { kind: 'unknown', reason: 'ipv4_mapped_ipv6' }
  }

  if (normalised === '::') return { kind: 'unknown', reason: 'wildcard_address' }

  const firstHextet = parseInt(normalised.split(':')[0] || '0', 16)
  if (!Number.isNaN(firstHextet)) {
    // fc00::/7 unique local, fe80::/10 link-local.
    if ((firstHextet & 0xfe00) === 0xfc00) return { kind: 'private_network', reason: null }
    if ((firstHextet & 0xffc0) === 0xfe80) return { kind: 'private_network', reason: null }
  }

  return { kind: 'managed_remote', reason: null }
}

/**
 * A DNS name we are willing to treat as a real, routable hostname.
 *
 * Underscores are accepted even though they are not strictly legal in
 * hostnames, and the check runs AFTER the loopback/container/IP branches. Both
 * choices only ever move a host from `unknown` to `managed_remote`, which is
 * the safe direction: every local capability refuses both, so local safety is
 * unchanged, while `app_runtime` stops refusing a legitimate production URL
 * merely because we could not categorise it.
 */
function isPlausibleDnsName(host: string): boolean {
  if (!host.includes('.')) return false
  return /^(?!-)[a-z0-9_-]+(\.(?!-)[a-z0-9_-]+)+$/.test(host) && !host.endsWith('-')
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce a host string that is safe to print in an error, a log line or a
 * committed run report.
 *
 * Loopback and explicitly allow-listed container hosts pass through verbatim
 * — they identify nothing. Everything else is masked: for DNS names we keep
 * only the last two labels (so `db.<project-ref>.supabase.co` becomes
 * `***.supabase.co` and the project reference never leaks), and for IP
 * literals we keep only the leading octets/hextet.
 */
export function redactHost(host: string | null, containerHosts: readonly string[] = []): string {
  if (!host) return '(no host)'
  const lower = host.toLowerCase()

  if (LOOPBACK_HOSTNAMES.includes(lower) || IPV6_LOOPBACK.includes(lower)) return lower
  if (containerHosts.includes(lower)) return lower

  const octets = parseIPv4(lower)
  if (octets) {
    if (octets[0] === 127) return lower
    return `${octets[0]}.${octets[1]}.x.x`
  }

  if (looksLikeIPv6(lower)) {
    const head = lower.split(':')[0]
    return head ? `${head}:***` : '***:***'
  }

  // Everything organisation-identifying is masked, REGARDLESS of label count.
  //
  // An earlier version kept the last two labels, which returned a two-label
  // host verbatim: `acme-prod.com` would have reached error messages, audit
  // lines and committed run reports intact. The invariant is "no unredacted
  // remote host", not "no unredacted subdomain".
  //
  // Known managed-provider suffixes are kept because they name a public
  // service, not a customer — `***.supabase.co` says something useful for
  // diagnosis while still hiding the project reference. Everything else is
  // reduced to its TLD.
  const labels = lower.split('.')
  if (labels.length < 2) return '***'
  const providerSuffix = SUPABASE_SUFFIXES.find((suffix) => lower.endsWith(suffix))
  if (providerSuffix) return `***${providerSuffix}`
  return `***.${labels[labels.length - 1]}`
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

function invalid(reason: DatabaseTargetReason): DatabaseTarget {
  return {
    kind: 'invalid',
    hostname: null,
    redactedHost: '(no host)',
    port: null,
    provider: null,
    projectRef: null,
    hasCredentials: false,
    injectedConnectionParameters: [],
    reason,
  }
}

/**
 * Detect an authority that this module and the postgres-js driver would read
 * DIFFERENTLY. This is the single most dangerous divergence in the whole
 * design, so it is checked structurally rather than trusted.
 *
 * `URL` follows the WHATWG rule that the userinfo ends at the LAST `@`.
 * postgres-js re-parses the raw string itself (src/index.js `parseUrl`) with
 * `host.slice(host.indexOf('@') + 1)` — the FIRST `@` — then treats a comma as
 * a MULTIHOST list and connects to the first entry. Verified against
 * postgres@3.4.9:
 *
 *   postgresql://u:p@db.<ref>.supabase.co:5432,127.0.0.1@127.0.0.1:56322/postgres
 *     new URL(...).hostname -> 127.0.0.1   (classifies local_loopback:56322)
 *     driver's first host   -> db.<ref>.supabase.co
 *
 * The guard would authorise a local seed and the driver would dial a managed
 * remote. Rather than emulate the driver (whose parser may change), any
 * authority that is not unambiguous is rejected outright: no legitimate
 * connection string in this repository contains a comma, a second `@`, or a
 * percent-encoded host.
 */
function hasAmbiguousAuthority(raw: string): boolean {
  const schemeEnd = raw.indexOf('://')
  if (schemeEnd === -1) return false

  // The authority is cut EXACTLY where postgres-js cuts it: `split(/[?/]/)`.
  // An earlier version also split on `#`, which reintroduced the bypass in one
  // character — `URL` treats `#` as the start of a fragment, the driver does
  // not, so everything after it stayed invisible to this check:
  //
  // secret-scan-ok: the "password" below is a port number and a '#' — the parser disagreement itself, not a credential.
  //   postgresql://127.0.0.1:56322#@evil.example.com,127.0.0.1/postgres
  //     guard  -> local_loopback:56322   (allowed)
  //     driver -> host ["evil.example.com", "127.0.0.1"]
  //
  // Cutting where the driver cuts makes the `@` and the comma visible again.
  const authority = raw.slice(schemeEnd + 3).split(/[?/]/)[0]

  // A `#` inside the authority region guarantees the two parsers disagree
  // about where the authority ends, whatever follows it.
  if (authority.includes('#')) return true

  // More than one `@`: WHATWG and the driver disagree on where userinfo ends.
  if ((authority.match(/@/g) ?? []).length > 1) return true

  // Everything below tests the HOST region only — the same region the driver
  // tests. Scanning the whole authority also rejected a password containing a
  // literal comma, which is a legitimate production credential and not a
  // multihost list.
  const hostPart = authority.slice(authority.indexOf('@') + 1)

  // Multihost list: the driver connects to the first entry, we classify the last.
  if (hostPart.includes(',')) return true

  // The driver runs decodeURIComponent over the host; we deliberately do not.
  try {
    if (decodeURIComponent(hostPart) !== hostPart) return true
  } catch {
    // Malformed percent sequence — unusable either way.
    return true
  }

  return false
}

/** Supabase project ref from `db.<ref>.supabase.co` or a `postgres.<ref>` user. */
function supabaseProjectRef(host: string, username: string): string | null {
  const labels = host.split('.')
  // db.<ref>.supabase.co / <ref>.supabase.co
  if (labels.length >= 3) {
    const candidate = labels[0] === 'db' || labels[0] === 'api' ? labels[1] : labels[0]
    if (candidate && candidate !== 'pooler' && !candidate.startsWith('aws-')) return candidate
  }
  // Shared pooler: aws-0-<region>.pooler.supabase.com with user `postgres.<ref>`
  const dot = username.indexOf('.')
  if (dot > 0) {
    const candidate = username.slice(dot + 1)
    if (candidate) return candidate
  }
  return null
}

/**
 * Classify a connection URL. Never throws: an unusable input becomes
 * `invalid`, which every capability rejects.
 */
export function classifyDatabaseTarget(
  url: string | null | undefined,
  options: ClassifyOptions = {}
): DatabaseTarget {
  const containerHosts = (options.containerHosts ?? LOCAL_CONTAINER_HOSTS).map((h) => h.toLowerCase())
  const allowedSchemes = options.allowedSchemes ?? POSTGRES_SCHEMES

  if (typeof url !== 'string' || url.trim() === '') return invalid('missing')

  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return invalid('unparseable')
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!allowedSchemes.includes(scheme)) return invalid('unsupported_scheme')

  // WHATWG keeps IPv6 hosts bracketed; opaque hosts keep their original case.
  // A single trailing dot is the fully-qualified form of the SAME name
  // (`db.example.com.` resolves identically), so it is normalised away rather
  // than dropped into `unknown` — otherwise a legitimate production URL
  // written that way would be refused at runtime.
  const rawHost = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  const host = rawHost.toLowerCase().replace(/\.$/, '')
  if (host === '') return invalid('no_hostname')

  const port = parsed.port === '' ? null : Number(parsed.port)
  const hasCredentials = parsed.username !== '' || parsed.password !== ''

  const base = {
    hostname: host,
    redactedHost: redactHost(host, containerHosts),
    port: port !== null && Number.isFinite(port) ? port : null,
    hasCredentials,
    injectedConnectionParameters: [...parsed.searchParams.keys()].filter(
      (key) => !DRIVER_CONSUMED_QUERY_KEYS.has(key)
    ),
  }

  const finish = (
    kind: DatabaseTargetKind,
    reason: DatabaseTargetReason | null = null
  ): DatabaseTarget => {
    const isSupabase = SUPABASE_SUFFIXES.some((suffix) => host.endsWith(suffix))
    return {
      ...base,
      kind,
      provider: kind === 'managed_remote' ? (isSupabase ? 'supabase' : 'other') : null,
      projectRef: isSupabase ? supabaseProjectRef(host, parsed.username) : null,
      reason,
    }
  }

  // An authority the driver would read differently than we do. Checked FIRST:
  // every other branch below reasons about `parsed.hostname`, which is exactly
  // the value that cannot be trusted when this returns true.
  if (hasAmbiguousAuthority(url.trim())) return finish('unknown', 'ambiguous_authority')

  // Percent-encoding survives opaque-host parsing untouched; we refuse to
  // predict what the driver decodes it to.
  if (host.includes('%')) return finish('unknown', 'percent_encoded_host')

  if (LOOPBACK_HOSTNAMES.includes(host)) return finish('local_loopback')

  const octets = parseIPv4(host)
  if (octets) {
    if (octets[0] === 0) return finish('unknown', 'wildcard_address') // 0.0.0.0
    if (octets[0] === 127) return finish('local_loopback')
    if (isPrivateIPv4(octets)) return finish('private_network')
    return finish('managed_remote')
  }

  // Dotted but not a valid quad (`127.0.0.01`, `1.2.3.4.5`, `10.0.0.256`).
  if (/^[\d.]+$/.test(host)) return finish('unknown', 'ambiguous_ipv4_octets')

  if (looksLikeIPv6(host)) {
    const { kind, reason } = classifyIPv6(host)
    return finish(kind, reason)
  }

  if (containerHosts.includes(host)) return finish('local_container')

  if (isPlausibleDnsName(host)) return finish('managed_remote')

  // Bare hostname with no dots and no allow-list entry: could be a compose
  // service, could be a search-domain expansion. Not guessable.
  return finish('unknown', 'unrecognised_host')
}

/** Same classifier for Supabase HTTP API URLs (GoTrue admin, PostgREST). */
export function classifySupabaseApiTarget(
  url: string | null | undefined,
  options: Omit<ClassifyOptions, 'allowedSchemes'> = {}
): DatabaseTarget {
  return classifyDatabaseTarget(url, { ...options, allowedSchemes: HTTP_SCHEMES })
}

/** True for targets that are physically on this host or an allow-listed container. */
export function isLocalTarget(target: DatabaseTarget): boolean {
  return target.kind === 'local_loopback' || target.kind === 'local_container'
}
