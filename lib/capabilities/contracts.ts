// lib/capabilities/contracts.ts
//
// THE APPLICATION-SIDE CONTRACTS FOR CAP-01 … CAP-05.
//
// Owned by the CAPABILITIES workstream (docs/ops/workstreams/CAPABILITIES.md).
// PRODUCT and RELEASE consume this module; neither modifies it. Every change
// here is a contract change and goes through docs/ops/contracts/.
//
// ---------------------------------------------------------------------------
// WHY A CONTRACT MODULE AT ALL
// ---------------------------------------------------------------------------
// The five capability packages answer in a deliberately impoverished
// vocabulary. Each SECURITY DEFINER function collapses "you are not permitted",
// "no such row" and "that argument is out of range" into ONE refusal —
// `capability request denied`, SQLSTATE U0001 — precisely so that a caller
// cannot use the difference as an oracle. That property is worth keeping, and
// it is also exactly what makes a driver error the wrong thing to hand a UI: it
// carries a message, sometimes the statement text, and no stable shape.
//
// So the boundary is stated once, here, as a closed set of OUTCOMES:
//
//   succeeded    the capability did the thing
//   idempotent   it had already done the thing; nothing changed, and that is
//                a success, not an error — CAP-03's duplicate event and
//                CAP-05's replayed idempotency key both land here
//   denied       a terminal refusal (U0001, or U0002 for a taken slug).
//                Retrying with the same input will refuse again
//   contended    a TRANSIENT lock/serialisation conflict (U0003). Retrying is
//                the correct response, and distinguishing it from `denied` is
//                the whole reason U0003 exists as its own SQLSTATE
//   unavailable  the capability is switched off — the package is not applied,
//                or its feature flag is false. Nothing was attempted
//
// `unavailable` is NOT a failure mode of the database. It is the state every
// capability is in today: five packages designed, none applied, every flag
// false. A caller that cannot express "off" as a first-class outcome ends up
// spelling it as an exception, and then "off" and "broken" become the same
// line in a log.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE MAY NEVER DO
// ---------------------------------------------------------------------------
// It imports nothing. No `@/db/client`, no driver, no Stripe SDK, no `zod`.
// It is types plus frozen constants, so importing it from a client component,
// a server action, a test or a route costs nothing and opens nothing. The
// moment it needs a connection it stops being a contract.

/* -------------------------------------------------------------------------- */
/* Capability identity                                                        */
/* -------------------------------------------------------------------------- */

export const CAPABILITY_IDS = ['CAP-01', 'CAP-02', 'CAP-03', 'CAP-04', 'CAP-05'] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/**
 * SQLSTATEs the five packages raise. These are the ONLY database-level codes
 * this boundary understands; anything else is an unexpected error and must
 * propagate rather than be folded into an outcome.
 *
 *   U0001  refused, terminal. Uniform by design — see the header.
 *   U0002  CAP-05 only: the organisation slug is already taken. It is a
 *          SEPARATE code because it is the one refusal a user can act on
 *          ("pick another name"), and collapsing it into U0001 would make a
 *          correctable form error indistinguishable from a denial.
 *   U0003  contended, transient, retryable.
 */
export const CAPABILITY_SQLSTATE = {
  DENIED: 'U0001',
  SLUG_TAKEN: 'U0002',
  CONTENDED: 'U0003',
} as const

export type CapabilitySqlState = (typeof CAPABILITY_SQLSTATE)[keyof typeof CAPABILITY_SQLSTATE]

/** The terminal (non-retryable) refusal codes. */
export type CapabilityDenialSqlState =
  | typeof CAPABILITY_SQLSTATE.DENIED
  | typeof CAPABILITY_SQLSTATE.SLUG_TAKEN

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

export const CAPABILITY_OUTCOMES = [
  'succeeded',
  'idempotent',
  'denied',
  'contended',
  'unavailable',
] as const

export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number]

/**
 * Why a capability is switched off. Three distinct operational facts that a
 * single boolean would have flattened:
 *
 *   feature_flag_disabled          the code path exists and is gated off
 *   database_identity_unavailable  the technical login role / credential for
 *                                  this capability is not provisioned
 *   package_not_applied            the SQL package is prepared but not applied,
 *                                  so the function does not exist (42883)
 *   policy_unavailable             no policy applies to the connecting role, so
 *                                  the statement would affect zero rows
 */
export const CAPABILITY_UNAVAILABLE_REASONS = [
  'feature_flag_disabled',
  'database_identity_unavailable',
  'package_not_applied',
  'policy_unavailable',
] as const

export type CapabilityUnavailableReason = (typeof CAPABILITY_UNAVAILABLE_REASONS)[number]

export interface CapabilitySucceeded<T> {
  readonly outcome: 'succeeded'
  readonly capability: CapabilityId
  readonly value: T
  readonly retryable?: false
}

/**
 * The capability had already applied this request. `value` is what the earlier
 * application produced where the package can still return it (CAP-05 returns
 * the organisation it created for a replayed idempotency key); it is `null`
 * where the package deliberately cannot (CAP-03 records a duplicate event but
 * holds no payload, and CAP-04 `RETURNS void` so a duplicate lead is
 * indistinguishable from a new one — by design, since reading back would give
 * a public endpoint an existence oracle).
 */
export interface CapabilityIdempotent<T> {
  readonly outcome: 'idempotent'
  readonly capability: CapabilityId
  readonly value: T | null
  readonly retryable?: false
}

export interface CapabilityDenied {
  readonly outcome: 'denied'
  readonly capability: CapabilityId
  readonly sqlState: CapabilityDenialSqlState
  readonly retryable: false
}

export interface CapabilityContended {
  readonly outcome: 'contended'
  readonly capability: CapabilityId
  readonly sqlState: typeof CAPABILITY_SQLSTATE.CONTENDED
  readonly retryable: true
}

export interface CapabilityUnavailable {
  readonly outcome: 'unavailable'
  readonly capability: CapabilityId
  readonly reason: CapabilityUnavailableReason
  /**
   * Whether RETRYING THIS CALL can plausibly succeed without a deploy. A
   * feature flag being off is NOT retryable — the answer stays the same until
   * someone ships — but a missing credential often is, because it is
   * provisioned out of band.
   *
   * IT IS NOT A TRANSPORT DIRECTIVE, and the distinction is not academic
   * (adversarial finding A-F2). A capability whose caller is an external system
   * may have to answer "try again" at the transport layer even when this field
   * says the answer will not change: CAP-03 replies 503 to EVERY `unavailable`,
   * including `feature_flag_disabled`, because Stripe abandons delivery after a
   * 2xx or a 4xx — and an abandoned delivery is a subscription change that
   * never lands, whereas a redelivered one merely arrives after the flag is on.
   *
   * So the two answers CAN differ, and where they do it is a decision, not a
   * drift. `stripeCapabilityUnavailable` is the one place that makes the
   * difference explicit; `tests/stripe-webhook-capability.test.ts` pins both
   * values for `feature_flag_disabled`, the reason where they diverge.
   */
  readonly retryable: boolean
}

export type CapabilityResult<T> =
  | CapabilitySucceeded<T>
  | CapabilityIdempotent<T>
  | CapabilityDenied
  | CapabilityContended
  | CapabilityUnavailable

/**
 * Compile-time exhaustiveness guard.
 *
 * Every consumer that switches on `outcome` should end with
 * `default: return assertNeverCapabilityOutcome(x)`. Adding a member to
 * `CapabilityOutcome` then breaks the build at every call site instead of
 * silently falling through — which is the only way a closed set stays closed
 * across four workstreams.
 */
export function assertNeverCapabilityOutcome(outcome: never): never {
  throw new Error(`Unhandled capability outcome: ${JSON.stringify(outcome)}`)
}

/**
 * Retryability WITHOUT reading a message.
 *
 * The single most important property of this contract: a caller decides
 * whether to retry from the outcome, never from `error.message`. Message
 * matching is how the pre-cutover code would have had to distinguish a lock
 * conflict from a permission denial, and a message is not an interface.
 */
export function isRetryableCapabilityResult<T>(result: CapabilityResult<T>): boolean {
  switch (result.outcome) {
    case 'succeeded':
    case 'idempotent':
      return false
    case 'denied':
      return false
    case 'contended':
      return true
    case 'unavailable':
      return result.retryable
    default:
      return assertNeverCapabilityOutcome(result)
  }
}

/* -------------------------------------------------------------------------- */
/* Capability descriptors                                                     */
/* -------------------------------------------------------------------------- */

export interface CapabilityDescriptor {
  readonly id: CapabilityId
  /** The prepared package that creates this capability's objects. */
  readonly package: string
  /** Fully-qualified function names, exactly as the package declares them. */
  readonly functions: readonly string[]
  /** The feature flag (or absence of one) that gates the application path. */
  readonly featureFlag: string | null
  /** True while the package is prepared but not applied anywhere. */
  readonly enabled: false
}

/* -------------------------------------------------------------------------- */
/* CAP-01 — Invitation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What `uellix_capability.accept_invitation(text)` returns: the organisation
 * joined and the role granted. The token itself never comes back — a caller
 * that already holds it gains nothing, and one that does not must not.
 */
export interface InvitationAcceptance {
  readonly organizationId: string
  readonly memberRole: string
}

export type InvitationCapabilityResult = CapabilityResult<InvitationAcceptance>

export const INVITATION_CAPABILITY: CapabilityDescriptor = Object.freeze({
  id: 'CAP-01',
  package: 'db/prepared/stella_0006_invitation_capability.sql',
  functions: Object.freeze(['uellix_capability.accept_invitation']),
  featureFlag: null,
  enabled: false,
})

/* -------------------------------------------------------------------------- */
/* CAP-02 — Public verification                                               */
/* -------------------------------------------------------------------------- */

/**
 * The public face of a report, and nothing more. Every field here is one an
 * organisation has explicitly disclosed; the money columns are `numeric` in
 * PostgreSQL and stay STRINGS on this side.
 *
 * That is not a convenience decision. `numeric` is arbitrary precision and
 * JavaScript's `number` is binary64: parsing here would silently round a value
 * that the pipeline computes with decimal.js precisely so it does not round.
 * The consumer formats the string or feeds it to a decimal library.
 *
 * `verified: false` is a NORMAL answer, not an error — an unknown hash is
 * indistinguishable from a hash whose report was withdrawn, which is what
 * stops the endpoint from being an enumeration oracle.
 */
export interface PublicVerification {
  readonly verified: boolean
  readonly organizationName: string | null
  readonly reportTitle: string | null
  readonly publicSummary: string | null
  /** ISO-8601 date (`YYYY-MM-DD`), never a `Date` — this crosses a wire. */
  readonly issuedOn: string | null
  readonly reportVariant: string | null
  readonly disclosureVersion: number | null
  readonly headlineRatio: string | null
  readonly totalInvestment: string | null
  readonly netSocialValue: string | null
  readonly currency: string | null
}

export type PublicVerificationResult = CapabilityResult<PublicVerification>

export const PUBLIC_VERIFICATION_CAPABILITY: CapabilityDescriptor = Object.freeze({
  id: 'CAP-02',
  package: 'db/prepared/stella_0007_public_verification_capability.sql',
  functions: Object.freeze([
    'uellix_capability.verify_report',
    'uellix_capability.record_verification_hit',
  ]),
  featureFlag: null,
  enabled: false,
})

/* -------------------------------------------------------------------------- */
/* CAP-03 — Stripe event result                                               */
/* -------------------------------------------------------------------------- */

/**
 * What `stripe_begin_event` answers. The handler proceeds only on `claimed`.
 */
export const STRIPE_CLAIM_RESULTS = ['claimed', 'duplicate', 'in_progress'] as const
export type StripeClaimResult = (typeof STRIPE_CLAIM_RESULTS)[number]

/**
 * The fixed error CODES `stripe_fail_event` accepts — mirrored from the
 * `stripe_webhook_events_error_code_check` CHECK constraint in stella_0008.
 *
 * They are codes and not messages on purpose: a PostgreSQL error message can
 * quote a row value, and a Stripe payload is payment data.
 */
export const STRIPE_FAILURE_CODES = [
  'signature',
  'org_not_resolved',
  'price_unmapped',
  'internal',
  'not_applicable',
] as const

export type StripeFailureCode = (typeof STRIPE_FAILURE_CODES)[number]

/**
 * How one signed Stripe delivery ended. This is the contract RELEASE asserts
 * against and PRODUCT reads for billing state.
 *
 *   applied      the subscription change landed, with its audit row, in one
 *                transaction
 *   duplicate    already completed — the idempotent answer
 *   ignored      deliberately not applied. Either an event type this
 *                capability does not handle, or one it handles but must
 *                refuse (DP-CAP-15: a webhook never performs the FIRST
 *                binding of an organisation to a Stripe customer)
 *   retry        transient: another delivery holds the claim, or the row was
 *                contended (U0003). The event is still claimable
 *   refused      the capability said no and the event was marked failed with
 *                a code. Still a 5xx, because the row is re-claimable and the
 *                cause is usually fixable out of band
 *   unavailable  nothing was attempted — the flag is off or the identity is
 *                not provisioned
 *
 * EVERY non-terminal disposition is a 5xx and never a 4xx. Stripe stops
 * retrying a 4xx, and a delivery Stripe stops retrying is a subscription
 * change that never lands — the silent loss this whole capability exists to
 * prevent.
 */
export const STRIPE_EVENT_DISPOSITIONS = [
  'applied',
  'duplicate',
  'ignored',
  'retry',
  'refused',
  'unavailable',
] as const

export type StripeEventDisposition = (typeof STRIPE_EVENT_DISPOSITIONS)[number]

export interface StripeEventResult {
  readonly capability: 'CAP-03'
  readonly disposition: StripeEventDisposition
  readonly eventId: string
  /** The status the webhook route must answer Stripe with. */
  readonly httpStatus: 200 | 503
  readonly retryable: boolean
  /** The code the event row was marked with, when one was recorded. */
  readonly failureCode?: StripeFailureCode
  /** Present only for `unavailable`, so "off" and "broken" stay distinct. */
  readonly unavailableReason?: CapabilityUnavailableReason
}

export const STRIPE_EVENT_CAPABILITY: CapabilityDescriptor = Object.freeze({
  id: 'CAP-03',
  package: 'db/prepared/stella_0008_stripe_webhook_identity.sql',
  functions: Object.freeze([
    'uellix_capability.stripe_begin_event',
    'uellix_capability.stripe_apply_subscription',
    'uellix_capability.stripe_fail_event',
  ]),
  featureFlag: 'WEBHOOK_DATABASE_IDENTITY_AVAILABLE',
  enabled: false,
})

/* -------------------------------------------------------------------------- */
/* CAP-04 — Public lead submission                                            */
/* -------------------------------------------------------------------------- */

/**
 * `uellix_capability.submit_lead` RETURNS void, and that is a security
 * decision the contract must preserve rather than paper over: with no return
 * value a duplicate submission is indistinguishable from a new one, so a
 * public unauthenticated endpoint cannot be used to test whether an address is
 * already known.
 *
 * `accepted: true` is therefore the ONLY field, and it means "the capability
 * did not refuse" — never "this address was new".
 */
export interface PublicLeadSubmission {
  readonly accepted: true
}

export type PublicLeadSubmissionResult = CapabilityResult<PublicLeadSubmission>

export const PUBLIC_LEAD_CAPABILITY: CapabilityDescriptor = Object.freeze({
  id: 'CAP-04',
  package: 'db/prepared/stella_0009_public_lead_capability.sql',
  functions: Object.freeze(['uellix_capability.submit_lead']),
  featureFlag: 'LEAD_CAPTURE_POLICY_AVAILABLE',
  enabled: false,
})

/* -------------------------------------------------------------------------- */
/* CAP-05 — Organization bootstrap                                            */
/* -------------------------------------------------------------------------- */

/**
 * What `bootstrap_organization` returns. The slug comes back because the
 * capability may have had to settle a collision, so the caller must read the
 * slug it GOT rather than the slug it asked for.
 *
 * A replayed `idempotencyKey` returns the SAME organisation as an
 * `idempotent` outcome — it is not an error, and treating it as one is how a
 * double-submitted signup form ends up as two organisations or one error page.
 */
export interface OrganizationBootstrap {
  readonly organizationId: string
  readonly slug: string
}

export type OrganizationBootstrapResult = CapabilityResult<OrganizationBootstrap>

export const ORGANIZATION_BOOTSTRAP_CAPABILITY: CapabilityDescriptor = Object.freeze({
  id: 'CAP-05',
  package: 'db/prepared/stella_0010_organization_bootstrap_capability.sql',
  functions: Object.freeze(['uellix_capability.bootstrap_organization']),
  featureFlag: null,
  enabled: false,
})

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every capability, keyed by id. RELEASE asserts against this that nothing is
 * enabled; PRODUCT reads it to render an honest "unavailable" state instead of
 * a spinner that never resolves.
 */
export const CAPABILITY_REGISTRY: Readonly<Record<CapabilityId, CapabilityDescriptor>> =
  Object.freeze({
    'CAP-01': INVITATION_CAPABILITY,
    'CAP-02': PUBLIC_VERIFICATION_CAPABILITY,
    'CAP-03': STRIPE_EVENT_CAPABILITY,
    'CAP-04': PUBLIC_LEAD_CAPABILITY,
    'CAP-05': ORGANIZATION_BOOTSTRAP_CAPABILITY,
  })

/** Build the `unavailable` result for a capability that is switched off. */
export function capabilityUnavailable(
  capability: CapabilityId,
  reason: CapabilityUnavailableReason,
): CapabilityUnavailable {
  return {
    outcome: 'unavailable',
    capability,
    reason,
    // A flag that is off answers the same way until someone deploys. Everything
    // else is provisioned out of band and can appear without a deploy.
    retryable: reason !== 'feature_flag_disabled',
  }
}
