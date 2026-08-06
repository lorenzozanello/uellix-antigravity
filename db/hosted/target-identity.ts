// db/hosted/target-identity.ts
// TRAIN 5B — "is this database the staging one?", answered fail-closed.
//
// ---------------------------------------------------------------------------
// THREE INDEPENDENT SIGNALS, ALL REQUIRED
// ---------------------------------------------------------------------------
// Train 5A's rule was that a name containing "staging" proves nothing, and that
// isolation needs at least two independent signals. This module requires three,
// and they are independent in the sense that matters — they fail differently:
//
//   1. declared-environment    — what the OPERATOR says, in the invocation.
//   2. host-derived-project-ref— what the CONNECTION says, parsed from the host
//                                and compared against the declaration.
//   3. in-database-sentinel    — what the DATABASE says about itself, written
//                                once at provisioning by a human looking at the
//                                dashboard.
//
// A pasted connection string defeats (1) alone. A copied invocation defeats (2)
// alone. Neither can defeat (3): a row in the wrong database is not something a
// tired operator produces by accident, because producing it requires having
// deliberately provisioned that database as staging.
//
// ---------------------------------------------------------------------------
// AND ONE VETO THAT OUTRANKS ALL THREE
// ---------------------------------------------------------------------------
// KNOWN_PRODUCTION_IDENTIFIERS is checked FIRST and refuses regardless of what
// the other signals say. Three agreeing signals are a reason to proceed; a
// known production identifier is a reason to stop, and a design where enough
// forged agreement can outvote a known-production match is a design where the
// worst outcome is reachable by the most determined mistake.

/** A refusal code. Stable — the gates and the runbook cite these by name. */
export type TargetIdentityFailureCode =
  | 'HOSTED_TARGET_IS_PRODUCTION'
  | 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'
  | 'HOSTED_TARGET_PROJECT_REF_INVALID'
  | 'HOSTED_TARGET_HOST_NOT_SUPABASE'
  | 'HOSTED_TARGET_PROJECT_REF_MISMATCH'
  | 'HOSTED_TARGET_SENTINEL_MISSING'
  | 'HOSTED_TARGET_SENTINEL_NOT_STAGING'
  | 'HOSTED_TARGET_SENTINEL_MISMATCH'

/** The sentinel row, as read by a read-only query. Never written by this code. */
export interface StagingSentinel {
  readonly environment: string
  readonly projectRef: string
}

export interface HostedTargetInput {
  /** What the operator declared. Compared with `===` against 'staging'. */
  readonly declaredEnvironment: string
  /** What the operator declared. A Supabase project ref: 20 lowercase letters. */
  readonly declaredProjectRef: string
  /** Host component only — never the connection string. */
  readonly connectionHost: string
  /** The row read from uellix_bootstrap.staging_sentinel, or null if absent. */
  readonly sentinel: StagingSentinel | null
}

export type TargetIdentityVerdict =
  | { readonly ok: true; readonly projectRef: string; readonly signals: readonly string[] }
  | { readonly ok: false; readonly code: TargetIdentityFailureCode; readonly message: string }

/**
 * Identifiers known to belong to PRODUCTION.
 *
 * The Vercel origin is not a guess: Train 5A's adversarial review found it
 * hardcoded at `lib/site.ts:26` as the last-resort fallback of
 * `resolveSiteUrl()`, and it is the only production identity the repository
 * contains. The Supabase production project ref is deliberately EMPTY and must
 * be filled at provisioning time — see
 * docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md.
 *
 * An empty list is not a safe default and this module does not treat it as one:
 * the three positive signals are required regardless, so an unfilled denylist
 * removes a veto, not a gate.
 */
export interface ProductionIdentifiers {
  readonly hosts: readonly string[]
  readonly projectRefs: readonly string[]
}

export const KNOWN_PRODUCTION_IDENTIFIERS: ProductionIdentifiers = {
  hosts: ['uellix-antigravity.vercel.app', 'app.uellix.com', 'uellix.com'],
  projectRefs: [],
}

const PROJECT_REF = /^[a-z]{20}$/

/**
 * Derives a Supabase project ref from a host, or null.
 *
 * Returns null for the shared pooler (`aws-0-*.pooler.supabase.com`) on purpose:
 * that host does NOT name a project — the ref travels in
 * `?options=reference%3D<ref>` or in the username — so deriving one from it
 * would be inventing a signal. A null here means "this host cannot corroborate
 * the declaration", and the caller refuses rather than falling back to trusting
 * the operator.
 */
export function projectRefFromHost(host: string): string | null {
  if (!host) return null
  const normalized = host.trim().toLowerCase()
  if (!normalized.endsWith('.supabase.co')) return null

  const labels = normalized.slice(0, -'.supabase.co'.length).split('.')
  const candidate = labels[0] === 'db' ? labels[1] : labels[0]
  if (!candidate || !PROJECT_REF.test(candidate)) return null
  return candidate
}

const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi
// The third segment is `{2,}` rather than `{5,}` on purpose: a real signature
// is long, but a TRUNCATED token in a log is still a token, and a redactor that
// only recognises well-formed secrets is a redactor that leaks the malformed ones.
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g
// Two Supabase key shapes, and the second was missing: the legacy `sbp_<hex>`
// personal-access form, and the current `sb_secret_<...>` / `sb_publishable_<...>`
// form, whose underscore comes immediately after `sb`. Adversarial review A.
const SUPABASE_KEY = /\bsb[a-z]?_(?:[a-z]+_)?[A-Za-z0-9_-]{20,}\b/g

// A libpq keyword/value DSN carries no scheme, so CONNECTION_STRING never sees
// it, and `password=` is the part that matters. Also `PGPASSWORD=`.
const DSN_PASSWORD = /\b(pg)?password\s*=\s*\S+/gi

/**
 * Scrubs anything credential-shaped out of a line destined for a log.
 *
 * Deliberately NOT a denylist of known secret names: the failure mode this
 * guards against is a driver error message that embeds the host and the
 * userinfo it was built from, and those carry no recognisable key name. So the
 * rule is shape-based, and a whole URL is removed rather than parsed — the
 * lesson `docs/ops/DATABASE_TARGET_SAFETY.md` records as "cuando el mensaje se
 * construye a partir del dato sensible, se descarta el mensaje".
 *
 * The project ref survives on purpose: it is public in every URL the project
 * serves, and it is the single most useful thing an operator can see when
 * diagnosing a wrong target.
 */
export function redactForHostedLog(line: string): string {
  return line
    .replace(CONNECTION_STRING, '[redacted]')
    .replace(DSN_PASSWORD, '[redacted]')
    .replace(JWT, '[redacted]')
    .replace(SUPABASE_KEY, '[redacted]')
}

/**
 * Echoes an operator-supplied value into a refusal message, bounded.
 *
 * The refusals below quote what the operator declared, because "it must be
 * exactly 'staging'" is unactionable without showing what arrived. But that
 * field is also the likeliest place for a mispaste — a whole connection string
 * typed into the wrong argument — so the echo is scrubbed AND truncated. The
 * scrubbing catches what it recognises; the truncation bounds what it does not.
 */
function echoOperatorValue(value: string): string {
  const scrubbed = redactForHostedLog(value)
  return scrubbed.length > 40 ? `${JSON.stringify(scrubbed.slice(0, 40))}… (truncated)` : JSON.stringify(scrubbed)
}

function refuse(code: TargetIdentityFailureCode, message: string): TargetIdentityVerdict {
  return { ok: false, code, message: redactForHostedLog(message) }
}

export function verifyStagingTarget(
  input: HostedTargetInput,
  /**
   * Injectable so provisioning can supply the real production ref without
   * editing this module, and so the veto is testable rather than asserted.
   */
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
): TargetIdentityVerdict {
  const host = input.connectionHost.trim().toLowerCase()

  // (0) THE VETO. First, and unconditional.
  if (
    production.hosts.some((h) => host === h || host.endsWith(`.${h}`)) ||
    production.projectRefs.includes(input.declaredProjectRef) ||
    (input.sentinel && production.projectRefs.includes(input.sentinel.projectRef))
  ) {
    return refuse(
      'HOSTED_TARGET_IS_PRODUCTION',
      `refused: the target matches a known production identifier. No combination of declarations ` +
        `or sentinel rows overrides this. host=${host || '(none)'}`,
    )
  }

  // (1) What the operator declared.
  if (input.declaredEnvironment !== 'staging') {
    return refuse(
      'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING',
      `refused: declared environment must be exactly 'staging' (got ${echoOperatorValue(input.declaredEnvironment)}). ` +
        `There is no default and no normalization: trailing space, different case and an empty ` +
        `string are all refusals, because each of them is a typo that would otherwise widen the ` +
        `set of databases this runner accepts.`,
    )
  }

  if (!PROJECT_REF.test(input.declaredProjectRef)) {
    return refuse(
      'HOSTED_TARGET_PROJECT_REF_INVALID',
      `refused: declared project ref is not a Supabase project ref (20 lowercase letters).`,
    )
  }

  // (2) What the connection says.
  const derived = projectRefFromHost(host)
  if (derived === null) {
    return refuse(
      'HOSTED_TARGET_HOST_NOT_SUPABASE',
      `refused: no Supabase project ref can be derived from the connection host, so the ` +
        `connection cannot corroborate the declaration. A direct host (db.<ref>.supabase.co) is ` +
        `required; the shared pooler does not name a project in its hostname.`,
    )
  }

  if (derived !== input.declaredProjectRef) {
    return refuse(
      'HOSTED_TARGET_PROJECT_REF_MISMATCH',
      `refused: the connection host names project ${derived}, the operator declared ` +
        `${input.declaredProjectRef}. One of the two is wrong and this runner will not guess which.`,
    )
  }

  // (3) What the database says about itself.
  if (input.sentinel === null) {
    return refuse(
      'HOSTED_TARGET_SENTINEL_MISSING',
      `refused: uellix_bootstrap.staging_sentinel holds no row. A connection string can be pasted ` +
        `from the wrong tab; a sentinel row in the wrong database cannot. Provision the target ` +
        `first — see docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md.`,
    )
  }

  if (input.sentinel.environment !== 'staging') {
    return refuse(
      'HOSTED_TARGET_SENTINEL_NOT_STAGING',
      `refused: the database declares itself ${echoOperatorValue(input.sentinel.environment)}. What ` +
        `the database says about itself outranks what the invocation says about it.`,
    )
  }

  if (input.sentinel.projectRef !== input.declaredProjectRef) {
    return refuse(
      'HOSTED_TARGET_SENTINEL_MISMATCH',
      `refused: the sentinel names project ${input.sentinel.projectRef}, the connection and the ` +
        `declaration name ${input.declaredProjectRef}. A sentinel that disagrees with its own host ` +
        `means one of the two was copied from somewhere else.`,
    )
  }

  return {
    ok: true,
    projectRef: input.declaredProjectRef,
    signals: ['declared-environment', 'host-derived-project-ref', 'in-database-sentinel'],
  }
}
