// lib/supabase/project-identity.ts
//
// SYS-03 — WHICH SUPABASE PROJECT DOES THE AUTH URL NAME?
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL
// ---------------------------------------------------------------------------
// SYS-02 pinned the POSTGRES side: a hosted runtime must structurally prove it
// is talking to the project its environment expects. Supabase Auth is
// configured through a completely separate value — `NEXT_PUBLIC_SUPABASE_URL` —
// and until SYS-03 nothing looked at it. Every factory did the same thing:
//
//     createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, ...)
//
// A `!` is not a check. A staging deployment handed the production Auth URL
// would authenticate users against production GoTrue, take the verified `sub`
// from that project, and hand it to a staging database as `request.jwt.claims`
// — so every RLS policy would evaluate `auth.uid()` for a subject the rows do
// not belong to. Nothing in the runtime could have noticed: SYS-02 was
// satisfied, because the DATABASE was the right one.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS, AND WHERE IT MAY BE IMPORTED
// ---------------------------------------------------------------------------
// Pure, total, and BROWSER-SAFE. It parses a string and returns a verdict; it
// reads no secret, opens no socket, and imports nothing server-only. That
// matters because `NEXT_PUBLIC_SUPABASE_URL` is consumed in three bundles —
// browser, Node server and the proxy/edge bundle — and a guard that only one of
// them can import is a guard the other two do without.
//
// Its only imports are the CANONICAL project registry and the CANONICAL
// Supabase host parser, both from db/hosted/target-identity.ts by way of
// db/safety/runtime-project-pins.ts. There is deliberately no second copy of
// either: SYS-02's registry is the source of truth, and the failure mode of an
// out-of-sync safety registry is that the stale half silently authorises the
// wrong project.
//
// Everything it can reach is PUBLIC. A Supabase project ref appears in every
// URL the project serves; no credential, key or connection string is reachable
// from this module, which is the property that makes it safe to bundle for the
// browser.

import { classifySupabaseHost } from '@/db/hosted/target-identity'
import { RUNTIME_PROJECT_PINS } from '@/db/safety/runtime-project-pins'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Why an Auth URL failed to name a project. Stable; never carries a value. */
export type SupabaseApiIdentityCode =
  /** Absent, empty, or whitespace only. */
  | 'AUTH_URL_MISSING'
  /** `new URL()` refused it. */
  | 'AUTH_URL_UNPARSEABLE'
  /** Neither `http:` nor `https:`. */
  | 'AUTH_URL_UNSUPPORTED_SCHEME'
  /** A percent-escape inside the authority. Refused rather than decoded. */
  | 'AUTH_URL_ENCODED_AUTHORITY'
  /** A username and/or password in the URL. Refused even on the right host. */
  | 'AUTH_URL_HAS_USERINFO'
  /** A hosted (non-loopback) target reached over plaintext. */
  | 'AUTH_URL_NOT_HTTPS'
  /** Parsed and HTTPS, but the HOST is not a Supabase project API host. */
  | 'AUTH_URL_NOT_SUPABASE_PROJECT_HOST'

export type SupabaseApiIdentity =
  /** `https://<project-ref>.supabase.co` — the project is proven. */
  | { readonly kind: 'hosted'; readonly projectRef: string }
  /**
   * This machine's loopback Supabase stack. A DISTINCT class, never a hosted
   * project with an unknown ref: local development must keep working, and
   * localhost must never be able to pretend it is staging.
   */
  | { readonly kind: 'local'; readonly hostname: string }
  /** Nothing structural named a project. Every caller treats this as refusal. */
  | { readonly kind: 'unproven'; readonly code: SupabaseApiIdentityCode }

export class SupabaseAuthIdentityError extends Error {
  readonly name = 'SupabaseAuthIdentityError'
  readonly code: SupabaseApiIdentityCode | 'AUTH_URL_UNKNOWN_PROJECT'

  constructor(code: SupabaseApiIdentityCode | 'AUTH_URL_UNKNOWN_PROJECT', detail: string) {
    super(`[${code}] Supabase Auth URL refused: ${detail}`)
    this.code = code
  }
}

/* -------------------------------------------------------------------------- */
/* Loopback                                                                   */
/* -------------------------------------------------------------------------- */

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1'])

/**
 * Is this host this machine's loopback interface?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `classifyDatabaseTarget`
 * ---------------------------------------------------------------------------
 * db/safety/database-target.ts already answers this, more thoroughly, and
 * reusing it would normally be right. It is not reused here for one reason:
 * this module is bundled for the BROWSER, and that module's import graph
 * reaches db/safety/local-stack.ts, which exports the local stack's Postgres
 * URL. Those are the Supabase CLI's published fixed development credentials
 * rather than a secret, and they only authenticate against a loopback
 * container — but shipping a connection string into a public bundle and
 * relying on tree-shaking to remove it is not a guarantee worth making.
 *
 * The duplication is bounded and its failure direction is CLOSED: this
 * predicate is narrower than the classifier, so the worst it can do is fail to
 * recognise an exotic local address, which makes the URL `unproven` and refuses
 * it. A local developer sees a refusal; nothing hosted is ever widened.
 *
 * Leading zeros are rejected for the same reason database-target.ts rejects
 * them: `127.0.0.01` is read as octal by some resolvers, so an address that two
 * parsers could disagree about is never called local.
 */
function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_NAMES.has(host)) return true
  const octets = host.split('.')
  if (octets.length !== 4) return false
  if (!octets.every((part) => /^\d{1,3}$/.test(part) && !(part.length > 1 && part.startsWith('0')))) {
    return false
  }
  return octets.every((part) => Number(part) <= 255) && Number(octets[0]) === 127
}

/**
 * True when the authority region of the RAW url carries a percent-escape.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS REFUSED EVEN THOUGH IT IS UNAMBIGUOUS
 * ---------------------------------------------------------------------------
 * Measured, not assumed: `https:` is a SPECIAL scheme, so WHATWG percent-decodes
 * the host and runs domain-to-ASCII over it. `https://<ref>%2esupabase.co`
 * therefore parses to hostname `<ref>.supabase.co` — the real project — and
 * `fetch` inside supabase-js would resolve it identically. There is no parser
 * divergence here of the kind db/safety/database-target.ts exists to catch.
 *
 * It is refused anyway because the alternative is a standing obligation to
 * re-verify that EVERY consumer of this URL decodes it the same way, forever,
 * across supabase-js versions and runtimes. No value the Supabase dashboard
 * emits contains a percent sign, so refusing costs nothing real and removes the
 * obligation. Strictness, declared as such — not a claim that this is an attack.
 */
function hasEncodedAuthority(raw: string): boolean {
  const schemeEnd = raw.indexOf('://')
  if (schemeEnd === -1) return false
  return raw.slice(schemeEnd + 3).split(/[/?#]/)[0].includes('%')
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

const unproven = (code: SupabaseApiIdentityCode): SupabaseApiIdentity => ({ kind: 'unproven', code })

/**
 * What Supabase project does this API URL STRUCTURALLY name?
 *
 * Pure and total. It judges nothing about which project is WANTED — that is the
 * caller's pin — and it never falls back to a looser reading when the strict one
 * fails, because every loosening is a lookalike domain waiting to be accepted.
 *
 * Only the HOST can name a project. A ref appearing in the path, the query, the
 * fragment, the username or the password names nothing: none of those decide
 * where the session token is sent.
 */
export function deriveSupabaseApiIdentity(url: string | null | undefined): SupabaseApiIdentity {
  if (typeof url !== 'string' || url.trim() === '') return unproven('AUTH_URL_MISSING')
  const raw = url.trim()

  if (hasEncodedAuthority(raw)) return unproven('AUTH_URL_ENCODED_AUTHORITY')

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return unproven('AUTH_URL_UNPARSEABLE')
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return unproven('AUTH_URL_UNSUPPORTED_SCHEME')

  // Checked before the host is trusted for anything. `https://<ref>@attacker.example`
  // puts a ref-shaped string where a careless reader looks for one, and
  // `https://u:p@<ref>.supabase.co` would embed a credential in a value that is
  // inlined into the public browser bundle.
  if (parsed.username !== '' || parsed.password !== '') return unproven('AUTH_URL_HAS_USERINFO')

  // `URL` already lowercased and IDNA-normalised a special-scheme host; the
  // brackets are stripped so an IPv6 loopback compares as a plain address.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host === '') return unproven('AUTH_URL_NOT_SUPABASE_PROJECT_HOST')

  // LOCAL FIRST, and independent of the scheme: the Supabase CLI serves its
  // local stack over plain HTTP on loopback, and demanding TLS there would
  // break `pnpm dev` to protect a transport that never leaves the machine.
  if (isLoopbackHost(host)) return { kind: 'local', hostname: host }

  // Everything below is a HOSTED target, where the anon key and the session
  // token travel over the wire. `classifySupabaseApiTarget` accepts `http:` —
  // correctly, since it answers "what kind of host is this?" and a host has no
  // transport — so the transport contract has to be stated here instead.
  if (scheme !== 'https') return unproven('AUTH_URL_NOT_HTTPS')

  // The ONE accepted hosted form, via the canonical parser. `rest` is exactly
  // `<20-lowercase-letters>.supabase.co`, with no extra labels in either
  // direction: `db.<ref>.supabase.co` is the DATABASE host and is refused here,
  // `<ref>.supabase.co.attacker.example` does not end in `.supabase.co` at all,
  // and a trailing dot survives into the hostname so it does not either.
  //
  // THE PORT AND THE PATH ARE DELIBERATELY NOT CONSULTED, and the reasoning is
  // recorded rather than left to be re-derived. Neither can move the request to
  // another project: TLS is verified against this hostname, so only Supabase can
  // answer for it on any port, and supabase-js appends `/auth/v1/...` to
  // whatever path it is given without ever crossing the origin. A non-standard
  // port or a stray path is therefore an OUTAGE (nothing listens; the endpoint
  // 404s), not a cross-project leak — and refusing outages here would trade a
  // clear runtime failure for a config refusal while buying no isolation.
  //
  // The consequence worth knowing: a Supabase CUSTOM AUTH DOMAIN would be
  // refused, because it is opaque and cannot structurally name a project.
  // Enabling one is a registry change, not a parser relaxation.
  if (classifySupabaseHost(host) !== 'rest') return unproven('AUTH_URL_NOT_SUPABASE_PROJECT_HOST')

  return { kind: 'hosted', projectRef: host.slice(0, host.indexOf('.')) }
}

/* -------------------------------------------------------------------------- */
/* The browser-safe assertion                                                 */
/* -------------------------------------------------------------------------- */

/** Every project this application is ever deployed against. Public refs only. */
const DEPLOYED_PROJECT_REFS: readonly string[] = Object.freeze(
  Object.values(RUNTIME_PROJECT_PINS)
)

/**
 * The browser's half of the SYS-03 contract.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS WEAKER THAN THE SERVER'S, AND WHY THAT IS ENOUGH
 * ---------------------------------------------------------------------------
 * The server compares the Auth project against the project pinned for THIS
 * environment. The browser cannot: `UELLIX_APP_ENV` and `VERCEL_ENV` are not
 * `NEXT_PUBLIC_`, so no bundle shipped to a browser knows which environment it
 * is. Inventing a new public variable to tell it would be a second registry of
 * exactly the kind SYS-03 is supposed to avoid.
 *
 * What the browser CAN enforce is positive identity without an environment:
 * the URL must structurally name a Supabase project API host, and that project
 * must be one this application is deployed against — never an arbitrary third
 * project, never a lookalike, never plaintext.
 *
 * And the gap that leaves is closed by construction rather than by hope:
 * `NEXT_PUBLIC_SUPABASE_URL` is inlined at BUILD time into the browser bundle,
 * the Node server bundle and the proxy bundle from ONE value, so the string the
 * browser validates is the same string the server validated against the
 * environment pin. The server's check is strictly stronger and covers the same
 * constant.
 *
 * Returns the URL it validated, rather than a boolean, so the caller passes the
 * checked value straight into `createBrowserClient`. A guard that approves one
 * string while the caller reads the variable a second time is a guard that can
 * be handed a different answer than the one it gave.
 */
export function assertBrowserSupabaseAuthUrl(
  // The default is read as a STATIC member expression on purpose: that is the
  // form Next.js replaces with a literal at build time. A dynamic lookup would
  // read a runtime value the bundle never actually uses.
  url: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL
): string {
  const identity = deriveSupabaseApiIdentity(url)

  if (identity.kind === 'unproven') {
    throw new SupabaseAuthIdentityError(
      identity.code,
      'NEXT_PUBLIC_SUPABASE_URL does not structurally name a Supabase project. Expected exactly ' +
        'https://<project-ref>.supabase.co, or this machine\'s local Supabase stack on loopback. ' +
        'A project reference in a path, a query, a fragment or a userinfo field names nothing, ' +
        'because none of those decide where the session token is sent'
    )
  }

  if (identity.kind === 'hosted' && !DEPLOYED_PROJECT_REFS.includes(identity.projectRef)) {
    // The ref is public, but it is still not printed: the value that makes this
    // actionable is "not one of this application's projects", and echoing
    // configuration back into a browser console adds nothing to that.
    throw new SupabaseAuthIdentityError(
      'AUTH_URL_UNKNOWN_PROJECT',
      'NEXT_PUBLIC_SUPABASE_URL names a well-formed Supabase project that this application is not ' +
        'deployed against. This is a positive pin, not a denylist: an unrecognised project is ' +
        'refused rather than trusted because nobody thought to list it'
    )
  }

  // The TRIMMED value, which is the exact string the derivation judged. Handing
  // back the raw one would return a value that was never validated.
  return (url as string).trim()
}
