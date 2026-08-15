// db/safety/runtime-project-pins.ts
//
// SYS-02 — WHICH SUPABASE PROJECT IS THIS ENVIRONMENT ALLOWED TO REACH?
//
// ---------------------------------------------------------------------------
// WHY THE ROLE, THE DATABASE NAME AND THE HOST CLASS ARE ALL INSUFFICIENT
// ---------------------------------------------------------------------------
// Production and Staging are provisioned from the same migrations, so both
// expose a login role called `uellix_app`, both call the database `postgres`,
// both terminate TLS, and both present a `*.supabase.co` host. Every predicate
// the authorization layer used to apply is therefore true of BOTH projects, and
// the audit line the two produced was byte-identical:
//
//   capability=app_runtime target=managed_remote host=***.supabase.co
//     port=5432 env=staging readOnly=false tls=from-url
//
// A staging deployment handed the production connection string could not have
// discovered its mistake from anything the guard printed, before or after.
//
// So the contract here is POSITIVE IDENTITY, not a wider denylist:
//
//   EXPECTED_PROJECT_IDENTITY (from the environment)
//     must equal
//   OBSERVED_PROJECT_IDENTITY (proven structurally by the connection)
//
// and an identity that cannot be PROVEN is a refusal. A denylist answers "is
// this the one target I already know is wrong?"; a pin answers "is this the one
// target I know is right?", and only the second question fails closed against
// the project nobody thought to list.
//
// ---------------------------------------------------------------------------
// ONE REGISTRY, NOT TWO
// ---------------------------------------------------------------------------
// The refs are IMPORTED from db/hosted/target-identity.ts, which is where the
// operator-facing provisioning chain already reads them and where the reasoning
// behind each value is recorded. A second copy would be a second thing to keep
// in sync, and the failure mode of an out-of-sync safety registry is that the
// stale half silently authorises the wrong database.
//
// The parsers are imported from the same module for the same reason. That
// module's derivation is the one an adversarial review already hardened
// (exact label counts, no trailing-label wildcards, contradictions refused
// rather than resolved); re-deriving a project ref here would mean two answers
// to one question.
//
// NOT SECRET. A Supabase project ref is public in every URL the project serves.
// It is nevertheless kept out of this layer's error messages — see
// `db/safety/database-access.ts` — because the safety layer's log rule is
// stricter than the operator path's.

import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  classifySupabaseHost,
  deriveConnectionIdentity,
  projectRefFromPoolerUser,
  type ConnectionMechanism,
} from '../hosted/target-identity'

/* -------------------------------------------------------------------------- */
/* The pins                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Supabase project each HOSTED environment may reach, and no other.
 *
 * `development`, `test` and `ci` are deliberately ABSENT rather than mapped to
 * null-ish placeholders: they have no hosted project, and the authorization
 * layer turns "no pin" into "no managed remote at all". That asymmetry is the
 * point — a missing entry must never read as a wildcard.
 */
export const RUNTIME_PROJECT_PINS: Readonly<Record<string, string>> = Object.freeze({
  staging: KNOWN_STAGING_PROJECT_REF,
  production: KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0],
})

/**
 * The project ref pinned for an environment, or null when that environment has
 * no hosted project.
 *
 * Takes a plain string rather than `DeploymentEnvironment` so this module never
 * imports the authorization layer that imports it.
 */
export function runtimeProjectPinFor(environment: string): string | null {
  return Object.prototype.hasOwnProperty.call(RUNTIME_PROJECT_PINS, environment)
    ? RUNTIME_PROJECT_PINS[environment]
    : null
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How the project was proven.
 *
 * `supavisor-reference` is the one mechanism the hosted operator path does not
 * know about, because operators connect with a `postgres.<ref>` login role
 * while a DEPLOYMENT may legitimately use the shared pooler's routing
 * parameter instead: `?options=reference%3D<ref>`. That parameter is not
 * decoration — it is the value Supavisor routes the connection by, which gives
 * it exactly the same standing as the login role.
 */
export type TargetIdentityMechanism = ConnectionMechanism | 'supavisor-reference'

export type TargetProjectIdentity =
  | {
      readonly proven: true
      readonly projectRef: string
      readonly mechanism: TargetIdentityMechanism
      /** Every independent source that named this project. Diagnostics only. */
      readonly corroboratedBy: readonly string[]
    }
  | {
      readonly proven: false
      /** Stable reason code. Never carries a value from the URL. */
      readonly code: string
    }

const UNPROVEN = (code: string): TargetProjectIdentity => ({ proven: false, code })

/** A Supabase project ref: 20 lowercase letters. Mirrors the hosted module. */
const PROJECT_REF = /^[a-z]{20}$/

/** A repeated `options` key: the guard and the driver would read it differently. */
const AMBIGUOUS_OPTIONS = Symbol('ambiguous_options')

/**
 * The ref inside an `options=reference=<ref>` startup parameter.
 *
 * ---------------------------------------------------------------------------
 * WHY A REPEATED KEY IS REFUSED RATHER THAN RESOLVED
 * ---------------------------------------------------------------------------
 * postgres-js builds its query map as
 *
 *     [...url.searchParams].reduce((a, [b, c]) => (a[b] = c, a), {})
 *
 * (src/index.js `parseOptions`, postgres@3.4.9), so a repeated key resolves to
 * the LAST value. `URLSearchParams.get()` returns the FIRST. That is a parser
 * divergence of exactly the kind `hasAmbiguousAuthority` already refuses for
 * multihost authorities, arriving through the query string instead:
 *
 *     ?options=reference%3D<staging>&options=reference%3D<production>
 *       guard  -> staging     (matches the pin, allowed)
 *       driver -> production  (routes to production)
 *
 * Reading the last value instead would fix this ONE case by emulating a driver
 * whose parser may change. Refusing the ambiguity is stable: no legitimate
 * connection string in this repository repeats `options`, and a repetition that
 * agrees with itself is refused too, because the refusal is about the ambiguity
 * and not about the values.
 *
 * The `reference=` match is anchored on token boundaries rather than searched
 * for loosely, because `options` is free-form text the driver forwards into the
 * startup packet — a substring search would let `-c app=reference=<ref>`
 * masquerade as routing metadata.
 */
function referenceParameterRef(
  optionsValues: readonly string[]
): string | typeof AMBIGUOUS_OPTIONS | null {
  if (optionsValues.length > 1) return AMBIGUOUS_OPTIONS
  const optionsValue = optionsValues[0]
  if (optionsValue === undefined) return null
  const match = /(?:^|\s)reference=([a-z]{20})(?:\s|$)/.exec(optionsValue.trim().toLowerCase())
  return match && PROJECT_REF.test(match[1]) ? match[1] : null
}

/**
 * Decode a URL userinfo field the way the driver will.
 *
 * postgres-js runs `decodeURIComponent` over the username, so a guard that
 * reads the RAW value would derive its identity from a different string than
 * the one the connection actually authenticates with — `postgres%2E<ref>` is
 * `postgres.<ref>` by the time it reaches the server.
 */
function decodeUserinfo(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    // A malformed percent-escape. Treat as absent rather than guessing: an
    // unreadable source must not become an accidentally-trusted one.
    return ''
  }
}

/**
 * What project does this connection PROVE it is pointing at?
 *
 * Pure and total. It judges nothing about which project is wanted — that is the
 * caller's pin — and it never prefers one source over another when they
 * disagree, because a silent preference is how a contradiction becomes a pass.
 *
 * THE PORT IS DELIBERATELY NOT CONSULTED. `deriveConnectionIdentity` refuses
 * the transaction pooler (6543) for the provisioning chain, because `psql -1`
 * plus `\ir` plus `SET LOCAL` need session affinity. That is a statement about
 * how a BASELINE is applied, not about which project a connection names, and
 * the application runtime legitimately uses transaction mode. Passing the port
 * through would have converted an identity check into a production outage.
 */
export function deriveTargetProjectIdentity(input: {
  readonly host: string
  /** The raw userinfo username, still percent-encoded. Never the password. */
  readonly username: string
  /**
   * EVERY value the `options` query key carried, already percent-decoded, in
   * URL order. An array rather than a single value so a repeated key is
   * VISIBLE here — see `referenceParameterRef`.
   */
  readonly optionsParameters?: readonly string[]
}): TargetProjectIdentity {
  const host = (input.host ?? '').trim().toLowerCase()
  const username = decodeUserinfo(input.username ?? '')

  // Only a POOLER-SHAPED username is offered as an identity source. The hosted
  // derivation refuses a login role that does not parse as `postgres.<ref>`
  // when one is supplied — correct for an operator who declared a pooler role,
  // wrong here, where the username is simply whichever role the DSN
  // authenticates as and `uellix_app` is the normal answer.
  const poolerUser = projectRefFromPoolerUser(username) !== null ? username : null

  const verdict = deriveConnectionIdentity({ connectionHost: host, poolerUser })
  const reference = referenceParameterRef(input.optionsParameters ?? [])

  // Checked BEFORE anything else is trusted: when the guard and the driver
  // would read this parameter differently, no source in the URL can be relied
  // on to name the project — including the ones that parsed cleanly.
  if (reference === AMBIGUOUS_OPTIONS) return UNPROVEN('AMBIGUOUS_OPTIONS_PARAMETER')
  const referenceRef = reference

  if (verdict.ok) {
    // A routing parameter alongside a ref-bearing host or login role is a
    // SECOND source. Two sources that disagree are a contradiction, never a
    // choice.
    if (referenceRef !== null && referenceRef !== verdict.projectRef) {
      return UNPROVEN('IDENTITY_CONTRADICTION')
    }
    return {
      proven: true,
      projectRef: verdict.projectRef,
      mechanism: verdict.mechanism,
      corroboratedBy:
        referenceRef === null
          ? verdict.corroboratedBy
          : [...verdict.corroboratedBy, 'supavisor reference parameter'],
    }
  }

  // The host names no project and no login role did either. The shared pooler
  // is the ONE case where that is expected rather than suspicious, and the
  // routing parameter is the source it leaves instead.
  //
  // Gated on the host actually being a recognised Supabase pooler: without
  // that, `?options=reference=<ref>` appended to any host at all would "prove"
  // a project, which is precisely the substring-matching failure this module
  // exists to avoid.
  if (referenceRef !== null && classifySupabaseHost(host) === 'pooler') {
    return {
      proven: true,
      projectRef: referenceRef,
      mechanism: 'supavisor-reference',
      corroboratedBy: ['supavisor reference parameter'],
    }
  }

  return UNPROVEN(verdict.code)
}
