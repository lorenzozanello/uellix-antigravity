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
  OPERATOR_POOLER_ROLE,
  classifySupabaseHost,
  deriveConnectionIdentity,
  parseQualifiedPoolerUser,
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
 * Two of these are mechanisms the hosted operator path does not know about,
 * because operators connect with a `postgres.<ref>` login role while a
 * DEPLOYMENT legitimately connects other ways:
 *
 * `supavisor-qualified-role` — the runtime authenticates as
 * `uellix_app.<ref>`. Supavisor qualifies EVERY login role with the project
 * ref, not just `postgres`, and the qualifier is not decoration: it is the
 * value the connection is routed by, which gives it exactly the same standing
 * as the operator form. Reading it required treating the username as the TWO
 * identities it is — a role and a project — rather than as one string.
 *
 * `supavisor-reference` — the shared pooler's routing parameter,
 * `?options=reference%3D<ref>`, used where the username carries no qualifier.
 */
export type TargetIdentityMechanism =
  | ConnectionMechanism
  | 'supavisor-reference'
  | 'supavisor-qualified-role'

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

  // The username, split into the two identities a Supavisor login role encodes.
  // Null for a bare role such as `uellix_app`, which names no project at all,
  // and null for anything that merely resembles a qualified role.
  const qualified = parseQualifiedPoolerUser(username)
  const qualifiedRef = qualified === null ? null : qualified.projectRef

  // Only the OPERATOR form is forwarded to the hosted derivation. Its pooler
  // contract is `postgres.<ref>` and the provisioning chain depends on that
  // narrowness, so the general form is read HERE instead of by widening a
  // module five operator-facing call sites share.
  //
  // A username that is not qualified at all is still passed as null rather than
  // verbatim: the hosted derivation refuses a login role it cannot parse when
  // one is supplied, which is correct for an operator who declared a pooler
  // role and wrong here, where the username is simply whichever role the DSN
  // authenticates as and `uellix_app` is the normal answer.
  const poolerUser =
    qualified !== null && qualified.databaseRole === OPERATOR_POOLER_ROLE ? username : null

  const verdict = deriveConnectionIdentity({ connectionHost: host, poolerUser })
  const reference = referenceParameterRef(input.optionsParameters ?? [])

  // Checked BEFORE anything else is trusted: when the guard and the driver
  // would read this parameter differently, no source in the URL can be relied
  // on to name the project — including the ones that parsed cleanly.
  if (reference === AMBIGUOUS_OPTIONS) return UNPROVEN('AMBIGUOUS_OPTIONS_PARAMETER')
  const referenceRef = reference

  if (verdict.ok) {
    // EVERY source that named a project must have named the SAME one. A
    // routing parameter or a qualified login role alongside a ref-bearing host
    // is an ADDITIONAL source, and sources that disagree are a contradiction,
    // never a choice — a silent preference is how a contradiction becomes a
    // pass.
    if (referenceRef !== null && referenceRef !== verdict.projectRef) {
      return UNPROVEN('IDENTITY_CONTRADICTION')
    }
    if (qualifiedRef !== null && qualifiedRef !== verdict.projectRef) {
      return UNPROVEN('IDENTITY_CONTRADICTION')
    }
    return {
      proven: true,
      projectRef: verdict.projectRef,
      mechanism: verdict.mechanism,
      corroboratedBy: [
        ...verdict.corroboratedBy,
        // Counted only when it is a SEPARATE source. When the verdict itself
        // came from the login role, naming it again would overstate how many
        // independent things agreed.
        ...(qualifiedRef !== null && poolerUser === null ? ['supavisor qualified login role'] : []),
        ...(referenceRef !== null ? ['supavisor reference parameter'] : []),
      ],
    }
  }

  // The host names no project and no OPERATOR login role did either. The shared
  // pooler is the ONE case where that is expected rather than suspicious: the
  // host is regional, so the project travels in the qualified login role or in
  // the routing parameter instead.
  //
  // Both are gated on the host actually being a recognised Supabase pooler.
  // Without that gate, a qualified-looking username or a
  // `?options=reference=<ref>` appended to ANY host at all would "prove" a
  // project, which is precisely the substring-matching failure this module
  // exists to avoid.
  if (classifySupabaseHost(host) === 'pooler') {
    if (qualifiedRef !== null) {
      if (referenceRef !== null && referenceRef !== qualifiedRef) {
        return UNPROVEN('IDENTITY_CONTRADICTION')
      }
      return {
        proven: true,
        projectRef: qualifiedRef,
        mechanism: 'supavisor-qualified-role',
        corroboratedBy: [
          'supavisor qualified login role',
          ...(referenceRef !== null ? ['supavisor reference parameter'] : []),
        ],
      }
    }

    if (referenceRef !== null) {
      return {
        proven: true,
        projectRef: referenceRef,
        mechanism: 'supavisor-reference',
        corroboratedBy: ['supavisor reference parameter'],
      }
    }
  }

  return UNPROVEN(verdict.code)
}
