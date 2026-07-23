import { NextResponse } from 'next/server'
import { getStripeClient, mapStripePriceToQuota, mapStripePriceToLabel } from '@/lib/stripe/client'
import { db } from '@/db/client'
import { organizations, auditLogs } from '@/db/schema'
import { eq } from 'drizzle-orm'
import Stripe from 'stripe'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Stripe Webhook Handler — processes subscription lifecycle events.
 *
 * SECURITY:
 * - Signature verification via `constructEvent()` ensures only Stripe can call this.
 * - Idempotency: Each event is processed exactly once using the Stripe event ID.
 * - Audit logging: All quota/plan mutations are recorded in audit_logs.
 */
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
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      webhookSecret
    )
  } catch (error: unknown) {
    console.error(
      '[stripe-webhook] Signature verification failed:',
      getErrorMessage(error, 'Unknown signature verification error')
    )
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ---------------------------------------------------------------------------
  // Idempotency check — skip already-processed events
  // ---------------------------------------------------------------------------
  const existingLog = await db.query.auditLogs.findFirst({
    where: eq(auditLogs.reason, `stripe_event:${event.id}`),
  })

  if (existingLog) {
    return NextResponse.json({ received: true, deduplicated: true })
  }

  try {
    const stripe = getStripeClient()
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const organizationId = session.client_reference_id
        
        if (organizationId && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription as string)
          const priceId = subscription.items.data[0].price.id
          const newQuota = mapStripePriceToQuota(priceId)
          const newLabel = mapStripePriceToLabel(priceId)

          await db.update(organizations)
            .set({
              stripeCustomerId: session.customer as string,
              stripeSubscriptionId: subscription.id,
              stripePriceId: priceId,
              stellaMonthlyQuota: newQuota,
              stellaPlanLabel: newLabel,
              updatedAt: new Date(),
            })
            .where(eq(organizations.id, organizationId))

          await logStripeEvent(event.id, organizationId, 'subscription.created', {
            priceId, quota: newQuota, label: newLabel,
          })
        }
        break
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const priceId = subscription.items.data[0].price.id
        const newQuota = mapStripePriceToQuota(priceId)
        const newLabel = mapStripePriceToLabel(priceId)

        // Find the org to log the before state
        const [org] = await db.select()
          .from(organizations)
          .where(eq(organizations.stripeSubscriptionId, subscription.id))
          .limit(1)

        await db.update(organizations)
          .set({
            stripePriceId: priceId,
            stellaMonthlyQuota: newQuota,
            stellaPlanLabel: newLabel,
            updatedAt: new Date(),
          })
          .where(eq(organizations.stripeSubscriptionId, subscription.id))

        if (org) {
          await logStripeEvent(event.id, org.id, 'subscription.updated', {
            priceId, quota: newQuota, label: newLabel,
          }, {
            previousPriceId: org.stripePriceId, previousQuota: org.stellaMonthlyQuota,
            previousLabel: org.stellaPlanLabel,
          })
        }
        break
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const freeQuota = mapStripePriceToQuota(null)
        const freeLabel = mapStripePriceToLabel(null)

        const [org] = await db.select()
          .from(organizations)
          .where(eq(organizations.stripeSubscriptionId, subscription.id))
          .limit(1)

        await db.update(organizations)
          .set({
            stripePriceId: null,
            stellaMonthlyQuota: freeQuota,
            stellaPlanLabel: freeLabel,
            updatedAt: new Date(),
          })
          .where(eq(organizations.stripeSubscriptionId, subscription.id))

        if (org) {
          await logStripeEvent(event.id, org.id, 'subscription.deleted', {
            quota: freeQuota, label: freeLabel,
          }, {
            previousPriceId: org.stripePriceId, previousQuota: org.stellaMonthlyQuota,
            previousLabel: org.stellaPlanLabel,
          })
        }
        break
      }
    }

    return NextResponse.json({ received: true })
  } catch (error: unknown) {
    console.error('[stripe-webhook] Error processing event:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Audit helper — records Stripe webhook events in the audit trail
// ---------------------------------------------------------------------------
async function logStripeEvent(
  stripeEventId: string,
  organizationId: string,
  action: string,
  afterJson: Record<string, unknown>,
  beforeJson?: Record<string, unknown>,
) {
  await db.insert(auditLogs).values({
    organizationId,
    entityType: 'organization',
    entityId: organizationId,
    action: `stripe.${action}`,
    afterJson,
    beforeJson: beforeJson ?? null,
    reason: `stripe_event:${stripeEventId}`,
  })
}
