import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getStripeClient, mapStripePriceToQuota, mapStripePriceToLabel } from '@/lib/stripe/client'
import { resolveStripeCapabilityExecutor } from '@/db/capabilities/stripe-capability-executor'
import {
  processStripeEvent,
  stripeCapabilityUnavailable,
  stripePlanResolverFrom,
} from '@/lib/capabilities/stripe-webhook'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Stripe Webhook Handler — processes subscription lifecycle events.
 *
 * SECURITY:
 * - Signature verification via `constructEvent()` ensures only Stripe can call this.
 * - Idempotency: one row per Stripe event id, keyed by PRIMARY KEY, claimed
 *   atomically. Not a check-then-act against the audit trail.
 * - Audit logging: the plan change and its audit row are written by the
 *   capability in ONE transaction, so neither can land without the other.
 *
 * ---------------------------------------------------------------------------
 * STILL BLOCKED BY DESIGN — WHAT CHANGED AND WHAT DID NOT
 * ---------------------------------------------------------------------------
 * WHAT DID NOT CHANGE: this handler has no DATABASE identity, the flag below
 * is still `false`, and a signature-verified event still gets 503. Stripe
 * retries a 5xx, so nothing is lost; a 200 with no write would discard the
 * subscription change permanently and look healthy doing it.
 *
 * WHAT CHANGED: the code behind the flag. It used to hold three direct
 * ORM update statements against the billing columns, plus a separate
 * audit insert, plus an organisation resolved in TypeScript from a
 * buyer-supplied checkout field. All three properties were defects
 * independently of the flag:
 *
 *   * The billing columns left every runtime UPDATE grant in `stella_0011`, so
 *     those statements would raise 42501 the instant the flag was flipped —
 *     the ordering hazard recorded as RR-CAP-10-A, closed for the two
 *     platform-admin call sites and left open for this one.
 *   * The update and the audit insert were separate awaited statements: a
 *     failure between them left a quota moved with no record of why, which is
 *     the worst partial state possible in billing.
 *   * The organisation came from `session.client_reference_id`, a value
 *     whoever creates the checkout session chooses.
 *
 * The path now goes through `lib/capabilities/stripe-webhook.ts` onto the three
 * prepared functions of `db/prepared/stella_0008_stripe_webhook_identity.sql`.
 * This module resolves no tenant, holds no tenant, and issues no statement.
 *
 * ---------------------------------------------------------------------------
 * WHAT ENABLING STILL REQUIRES — NOT DONE HERE, AND NOT CLAIMED
 * ---------------------------------------------------------------------------
 * `stella_0008` is prepared and applied nowhere. `UELLIX_STRIPE_DATABASE_URL`
 * is provisioned nowhere. Flipping the flag below without both is refused by
 * the resolver rather than silently answering 200 with no write. Enabling is a
 * separate, reviewed act with its own rollout — see CAP_03_STRIPE.md §13.
 */
const WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false

// An unknown price must never be applied. The shared mapping falls back to the
// free quota for a price it does not recognise, which is a safe default for a
// read and a silent downgrade of a paying customer when it is the input to a
// quota write — see `stripePlanResolverFrom`.
const resolveStripePlan = stripePlanResolverFrom(mapStripePriceToQuota, mapStripePriceToLabel)

// The refusal, as a typed value rather than a literal 503 written twice. The
// status comes from the contract, so "unavailable is retryable" is stated in
// one place and cannot drift between the two branches that use it.
function refuseUnavailable(
  event: Stripe.Event,
  reason: 'feature_flag_disabled' | 'database_identity_unavailable'
): NextResponse {
  const outcome = stripeCapabilityUnavailable(event.id, reason)
  console.error('[stripe-webhook] refusing event: billing capability is not enabled', {
    type: event.type,
    reason: outcome.unavailableReason,
  })
  return NextResponse.json(
    { error: 'Billing webhook processing is unavailable' },
    { status: outcome.httpStatus }
  )
}

export async function POST(req: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!process.env.STRIPE_SECRET_KEY || !webhookSecret) {
    return NextResponse.json({ error: 'Billing service unavailable' }, { status: 503 })
  }

  const body = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    const stripe = getStripeClient()
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (error: unknown) {
    console.error(
      '[stripe-webhook] Signature verification failed:',
      getErrorMessage(error, 'Unknown signature verification error')
    )
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Refuse AFTER signature verification, so an unsigned request still gets 400
  // and this branch never becomes an unauthenticated availability probe.
  if (!WEBHOOK_DATABASE_IDENTITY_AVAILABLE) {
    return refuseUnavailable(event, 'feature_flag_disabled')
  }

  // Resolving the executor reads ONE environment variable and opens nothing.
  // With no credential provisioned it is `null` — a distinct operational fact
  // from "the flag is off", and one that deserves its own reason rather than
  // being flattened into the same line.
  const executor = resolveStripeCapabilityExecutor()
  if (executor === null) {
    return refuseUnavailable(event, 'database_identity_unavailable')
  }

  try {
    const outcome = await processStripeEvent({
      event,
      executor,
      resolvePlan: resolveStripePlan,
    })

    // One shape for every finished delivery. `disposition` is a closed set, so
    // an operator reading a log line never has to infer what happened from an
    // HTTP status alone.
    return NextResponse.json(
      {
        received: true,
        disposition: outcome.disposition,
        ...(outcome.failureCode ? { code: outcome.failureCode } : {}),
      },
      { status: outcome.httpStatus }
    )
  } catch (error: unknown) {
    // NAME ONLY. This was RR-CAP-03-B: the previous `console.error(error)`
    // logged the whole error object, and a driver error can quote a row value
    // it failed on — which here is payment data. The capability functions
    // already collapse their own errors to a code for the same reason.
    console.error(
      '[stripe-webhook] Error processing event:',
      error instanceof Error ? error.name : 'unknown'
    )
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
