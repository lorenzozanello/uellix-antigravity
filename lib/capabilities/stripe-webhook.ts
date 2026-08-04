// lib/capabilities/stripe-webhook.ts
//
// CAP-03 — THE TYPED LAYER BETWEEN A SIGNED STRIPE EVENT AND THE PREPARED
// CAPABILITY FUNCTIONS. It replaces the three `db.update(organizations).set({…})`
// statements that lived in app/api/webhooks/stripe/route.ts.
//
// ---------------------------------------------------------------------------
// WHY THOSE THREE STATEMENTS HAD TO GO EVEN THOUGH THEY WERE UNREACHABLE
// ---------------------------------------------------------------------------
// They sat behind `WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false`, so they never
// ran. That made them harmless to EXECUTE and not harmless to KEEP:
//
//   * `stella_0011` removed `stella_monthly_quota`, `stella_plan_label` and the
//     three `stripe_*` columns from every runtime UPDATE grant. Those three
//     statements would raise 42501 the instant the flag was flipped — a
//     failure whose cause (an ACL applied weeks earlier) is nowhere near the
//     line that fails. RR-CAP-10-A is exactly this ordering hazard, recorded
//     for the two platform-admin call sites and left open for this one.
//   * They were the last place in the tree where the SHAPE of the old design
//     survived: read the organisation with the ORM, decide in TypeScript which
//     row a Stripe event belongs to, write it. Every argument CAP-03 makes
//     about tenancy depends on that decision NOT being made here.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE
// ---------------------------------------------------------------------------
// WHICH ORGANISATION. It never resolves one, never holds one, and never
// receives one back. It forwards the two identifiers Stripe issued and put
// inside the signed event; `stripe_apply_subscription` resolves the row, and
// the RESTRICTIVE policies `cap_stripe_only_claimed_read` /
// `cap_stripe_only_claimed_org` bound what that resolution can even see to
// rows a claimed, in-flight, non-expired event is addressed to.
//
// That is why the `checkout.session.completed` branch is gone rather than
// rewritten. It resolved the organisation from `session.client_reference_id`,
// a field whoever creates the checkout session chooses — a Stripe Payment Link
// accepts it as a buyer-supplied parameter. No predicate over the current row
// can tell a legitimate first subscription from a hostile claim, because the
// only evidence either way is the attacker-supplied field itself. So the first
// binding of an organisation to a Stripe customer is a first-party
// authenticated flow (DP-CAP-15) and the webhook refuses to be it.
//
// ---------------------------------------------------------------------------
// THE EXECUTOR IS INJECTED, AND THAT IS THE SECOND BOUNDARY
// ---------------------------------------------------------------------------
// This module imports no driver and no connection. It cannot reach the
// application pool even by accident, which matters because the application
// pool authenticates as `uellix_app` and `uellix_app` holds no EXECUTE on
// these three functions — by design, since that is what stops any endpoint
// from moving a quota. The caller supplies an executor bound to
// `uellix_stripe`, whose credential is provisioned out of band and shared with
// nothing else.
//
// There is no fallback path and no second way in. A fallback would keep the
// removed statement alive in the tree, which is the thing being removed.

import {
  CAPABILITY_SQLSTATE,
  type CapabilityUnavailableReason,
  type StripeClaimResult,
  type StripeEventResult,
  type StripeFailureCode,
} from './contracts'

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The login role this capability connects as. It holds EXECUTE on three
 * functions and NO privilege of any kind on any relation in `public` — proven
 * by the postconditions of `db/prepared/stella_0008_stripe_webhook_identity.sql`
 * across all four DML modes.
 */
export const STRIPE_CAPABILITY_ROLE = 'uellix_stripe'

/**
 * One variable per capability, same rule as `db/safety/resolve-capability-database-url.ts`.
 * It is NOT `UELLIX_RUNTIME_DATABASE_URL` and NOT the pre-cutover shared
 * `DATABASE_URL`: a single name for several capabilities means the most
 * privileged reading wins.
 *
 * Provisioned out of band and available to the webhook handler alone. Nothing
 * in this unit reads it — the capability is off.
 */
export const STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR = 'UELLIX_STRIPE_DATABASE_URL'

/**
 * The three functions, with the arity the package declares. Kept as data so a
 * signature drift in `stella_0008` fails a focused test rather than a live
 * webhook — `stripe_begin_event` already lost its two-argument form once, in
 * the RR-CAP-14 revision, and a stale caller would have claimed events with no
 * address at all.
 */
export const STRIPE_CAPABILITY_FUNCTIONS = Object.freeze({
  beginEvent: Object.freeze({ name: 'uellix_capability.stripe_begin_event', arity: 4 }),
  applySubscription: Object.freeze({
    name: 'uellix_capability.stripe_apply_subscription',
    arity: 8,
  }),
  failEvent: Object.freeze({ name: 'uellix_capability.stripe_fail_event', arity: 2 }),
})

/* -------------------------------------------------------------------------- */
/* The executor                                                               */
/* -------------------------------------------------------------------------- */

export interface StripeBeginEventInput {
  readonly eventId: string
  readonly eventType: string
  readonly stripeCustomerId: string | null
  readonly stripeSubscriptionId: string | null
}

export interface StripeApplySubscriptionInput {
  readonly eventId: string
  readonly matchKind: StripeMatchKind
  readonly matchValue: string
  readonly stripeCustomerId: string | null
  readonly stripeSubscriptionId: string | null
  readonly stripePriceId: string | null
  readonly quota: number
  readonly planLabel: string
}

/**
 * The only surface through which this capability reaches PostgreSQL. Three
 * methods, one per prepared function, and nothing that resembles a query.
 *
 * `failEvent` takes positional arguments because it is called from a catch
 * path where the pair (event, code) is the whole meaning.
 */
export interface StripeCapabilityExecutor {
  beginEvent(input: StripeBeginEventInput): Promise<StripeClaimResult>
  applySubscription(input: StripeApplySubscriptionInput): Promise<void>
  failEvent(eventId: string, code: StripeFailureCode): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* The event, structurally                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The minimum this module needs from a verified Stripe event. Typed
 * structurally rather than as `Stripe.Event` so the layer carries no SDK
 * dependency and stays testable with a literal — the signature check that
 * makes the event trustworthy happens in the route, before this is called.
 */
export interface StripeEventEnvelope {
  readonly id: string
  readonly type: string
  readonly data: { readonly object: unknown }
}

export type StripeMatchKind = 'customer' | 'subscription'

export const STRIPE_NOT_APPLICABLE_REASONS = [
  /** DP-CAP-15: a webhook never performs an organisation's FIRST Stripe binding. */
  'first_binding_requires_first_party_flow',
  /** The subscription branch of the package requires a non-null customer id. */
  'incomplete_stripe_identity',
] as const

export type StripeNotApplicableReason = (typeof STRIPE_NOT_APPLICABLE_REASONS)[number]

export type StripeEventPlan =
  | {
      readonly kind: 'apply'
      readonly matchKind: StripeMatchKind
      readonly matchValue: string
      readonly stripeCustomerId: string
      readonly stripeSubscriptionId: string | null
      readonly stripePriceId: string | null
    }
  | {
      readonly kind: 'not_applicable'
      readonly reason: StripeNotApplicableReason
      readonly stripeCustomerId: string | null
      readonly stripeSubscriptionId: string | null
    }
  | { readonly kind: 'unsupported' }

/* -------------------------------------------------------------------------- */
/* Reading the payload                                                        */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * Stripe expands a reference either to a bare id string or to a nested object
 * with an `id`. Reading only the string form would silently produce `null` for
 * an expanded payload, and a null identity is what `stripe_begin_event`
 * refuses — a whole class of deliveries would fail with no obvious cause.
 */
function readStripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  const nested = asRecord(value)
  const id = nested?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** The price of the first line item, or `null` when there is none. */
function readFirstPriceId(object: Record<string, unknown>): string | null {
  const items = asRecord(object.items)
  const data = items?.data
  if (!Array.isArray(data) || data.length === 0) return null
  const price = asRecord(asRecord(data[0])?.price)
  const id = price?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decide, from the signed event alone, HOW this delivery correlates to a
 * Stripe identity — never to an organisation.
 *
 * Pure and total: it opens nothing, so the correlation rules can be asserted
 * without a database and without the flag being on.
 */
export function planStripeEvent(event: StripeEventEnvelope): StripeEventPlan {
  const object = asRecord(event.data?.object) ?? {}

  switch (event.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = readStripeId(object.id)
      const customerId = readStripeId(object.customer)

      // Both branches of the package's tenancy guard require the customer id,
      // and the subscription branch requires it explicitly non-null: an event
      // that cannot state whose subscription it is cannot be applied to anyone.
      if (subscriptionId === null || customerId === null) {
        return {
          kind: 'not_applicable',
          reason: 'incomplete_stripe_identity',
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
        }
      }

      return {
        kind: 'apply',
        matchKind: 'subscription',
        matchValue: subscriptionId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        // A deletion carries no price. `null` is the VALUE that clears
        // `stripe_price_id` and maps to the free quota, which is what the
        // removed `customer.subscription.deleted` branch did too.
        stripePriceId:
          event.type === 'customer.subscription.deleted' ? null : readFirstPriceId(object),
      }
    }

    case 'checkout.session.completed': {
      // Recorded, never applied. The removed branch read the organisation from
      // a buyer-supplied field; the capability has no match kind that would
      // accept it, and inventing one here would put the decision back in
      // TypeScript where no policy can bound it.
      return {
        kind: 'not_applicable',
        reason: 'first_binding_requires_first_party_flow',
        stripeCustomerId: readStripeId(object.customer),
        stripeSubscriptionId: readStripeId(object.subscription),
      }
    }

    default:
      return { kind: 'unsupported' }
  }
}

/* -------------------------------------------------------------------------- */
/* Price resolution                                                           */
/* -------------------------------------------------------------------------- */

export interface StripeResolvedPlan {
  readonly quota: number
  readonly label: string
}

/**
 * `null` means UNMAPPED — a price Stripe knows about and this deployment does
 * not. It must never be silently applied.
 */
export type StripePlanResolver = (priceId: string | null) => StripeResolvedPlan | null

/**
 * Wrap the existing price mapping so an unknown price becomes a REFUSAL
 * instead of a downgrade.
 *
 * `lib/stripe/client.ts` maps an unrecognised price to the free quota and the
 * label `'Custom'`. As a default for a read that is harmless; as the input to
 * an UPDATE of `stella_monthly_quota` it is a silent downgrade of a paying
 * customer whenever a price is added in Stripe before it is added to the
 * environment — and every layer would say yes, because "free" is a perfectly
 * valid quota. The sentinel label is the only signal the existing mapping
 * exposes, so it is what this reads; making the mapping return an explicit
 * "unmapped" is a change to a shared module with its own call sites and
 * belongs to enabling the capability, not here. Recorded in
 * docs/ops/workstreams/CAPABILITIES.md.
 */
export function stripePlanResolverFrom(
  mapPriceToQuota: (priceId: string | null) => number,
  mapPriceToLabel: (priceId: string | null) => string,
  unmappedLabel = 'Custom',
): StripePlanResolver {
  return (priceId) => {
    const label = mapPriceToLabel(priceId)
    if (priceId !== null && label === unmappedLabel) return null
    return { quota: mapPriceToQuota(priceId), label }
  }
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

function result(
  disposition: StripeEventResult['disposition'],
  eventId: string,
  extra: Partial<StripeEventResult> = {},
): StripeEventResult {
  const retryable = disposition === 'retry' || disposition === 'refused' || disposition === 'unavailable'
  return {
    capability: 'CAP-03',
    disposition,
    eventId,
    // 503 and never 4xx for anything unfinished: Stripe retries a 5xx with
    // backoff and abandons a 4xx, and an abandoned delivery is a subscription
    // change that never lands.
    httpStatus: retryable ? 503 : 200,
    retryable,
    ...extra,
  }
}

/** The capability is switched off. Nothing was attempted. */
export function stripeCapabilityUnavailable(
  eventId: string,
  reason: CapabilityUnavailableReason,
): StripeEventResult {
  return result('unavailable', eventId, { unavailableReason: reason })
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read a SQLSTATE off a driver error without reading its message.
 *
 * Message matching is what this contract exists to avoid: a PostgreSQL error
 * message can quote a row value, and a Stripe payload is payment data. Only
 * the five-character code is ever consulted, and only three codes are
 * recognised — everything else is unexpected and must propagate.
 */
function readSqlState(error: unknown): string | null {
  const record = asRecord(error)
  const code = record?.code
  return typeof code === 'string' ? code : null
}

/* -------------------------------------------------------------------------- */
/* The handler                                                                */
/* -------------------------------------------------------------------------- */

export interface ProcessStripeEventOptions {
  /** A signature-verified Stripe event. Verification happens in the route. */
  readonly event: StripeEventEnvelope
  readonly executor: StripeCapabilityExecutor
  readonly resolvePlan: StripePlanResolver
}

/**
 * Process one signed delivery.
 *
 * Throws only for UNEXPECTED failures. A capability refusal, a contention and
 * a duplicate are all values, because each has a different correct answer to
 * Stripe and collapsing them into an exception is how the pre-cutover handler
 * would have turned a lock conflict into a 4xx and dropped the delivery.
 */
export async function processStripeEvent(
  options: ProcessStripeEventOptions,
): Promise<StripeEventResult> {
  const { event, executor, resolvePlan } = options
  const eventId = event.id
  const plan = planStripeEvent(event)

  // An event type this capability does not handle reaches NOTHING. Claiming it
  // would put a row in `stripe_webhook_events` for every unrelated Stripe
  // delivery, and DP-CAP-07 (retention) is still unresolved.
  if (plan.kind === 'unsupported') {
    return result('ignored', eventId)
  }

  // An event with no Stripe identity cannot be claimed either: the package
  // refuses a claim carrying neither identifier, because such a claim matches
  // no organisation and could never apply anything.
  if (
    plan.kind === 'not_applicable' &&
    plan.stripeCustomerId === null &&
    plan.stripeSubscriptionId === null
  ) {
    return result('ignored', eventId, { failureCode: 'not_applicable' })
  }

  const claim = await executor.beginEvent({
    eventId,
    eventType: event.type,
    stripeCustomerId: plan.stripeCustomerId,
    stripeSubscriptionId: plan.stripeSubscriptionId,
  })

  // Already completed. The idempotent answer, and a 200 — Stripe has nothing
  // left to do.
  if (claim === 'duplicate') {
    return result('duplicate', eventId)
  }

  // Another delivery of the same event holds the claim, or the claim itself was
  // contended. Both are transient and both leave the row claimable.
  if (claim === 'in_progress') {
    return result('retry', eventId)
  }

  // Claimed, and deliberately not applied. Closing it as `ignored` is what
  // keeps the row out of a permanent `processing` state, where it would be
  // indistinguishable from a worker that died mid-flight.
  if (plan.kind === 'not_applicable') {
    await executor.failEvent(eventId, 'not_applicable')
    return result('ignored', eventId, { failureCode: 'not_applicable' })
  }

  const resolved = resolvePlan(plan.stripePriceId)
  if (resolved === null) {
    await executor.failEvent(eventId, 'price_unmapped')
    return result('refused', eventId, { failureCode: 'price_unmapped' })
  }

  try {
    await executor.applySubscription({
      eventId,
      matchKind: plan.matchKind,
      matchValue: plan.matchValue,
      stripeCustomerId: plan.stripeCustomerId,
      stripeSubscriptionId: plan.stripeSubscriptionId,
      stripePriceId: plan.stripePriceId,
      quota: resolved.quota,
      planLabel: resolved.label,
    })
  } catch (error: unknown) {
    const sqlState = readSqlState(error)

    // U0003 — contended. The subtransaction rolled back, so the row is intact
    // and still `processing`; it stays claimable and Stripe retries. It is NOT
    // marked failed: there is nothing to record, and a second round trip on a
    // lock conflict is the wrong place to spend the 10s statement timeout.
    if (sqlState === CAPABILITY_SQLSTATE.CONTENDED) {
      return result('retry', eventId)
    }

    // U0001 — refused. Uniform by design, so the handler cannot tell "no such
    // organisation" from "the identifiers disagree"; `org_not_resolved` is the
    // honest code for the whole class. Still a 5xx: a `failed` row is
    // re-claimable, and the usual cause is a binding that has not happened yet
    // (DP-CAP-15), which an operator can fix inside Stripe's retry window.
    if (sqlState === CAPABILITY_SQLSTATE.DENIED) {
      await executor.failEvent(eventId, 'org_not_resolved')
      return result('refused', eventId, { failureCode: 'org_not_resolved' })
    }

    // ANYTHING ELSE PROPAGATES. A dropped connection, a 42883 because the
    // package was never applied, a 42501 because it was applied without the
    // grant — none of those is a billing outcome, and answering "retry" to all
    // of them would turn a permanent defect into an infinite retry loop, which
    // is the same silent loss wearing the opposite mask.
    throw error
  }

  return result('applied', eventId)
}
