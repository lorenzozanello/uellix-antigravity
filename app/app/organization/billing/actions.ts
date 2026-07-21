'use server'

import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLES } from '@/lib/auth/roles'
import { getStripeClient } from '@/lib/stripe/client'
import { redirect } from 'next/navigation'

export async function createStripePortalSession() {
  const ctx = await requireOrganizationAccess()

  if (ctx.membership.role !== ROLES.SUPER_ADMIN && ctx.membership.role !== ROLES.ORGANIZATION_ADMIN) {
    throw new Error('Only organization admins can manage billing')
  }

  const { organization } = ctx

  const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/app/organization/billing`

  if (organization.stripeCustomerId) {
    // If they already have a customer ID, send them to the customer portal
    const stripe = getStripeClient()
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: organization.stripeCustomerId,
      return_url: returnUrl,
    })

    redirect(portalSession.url)
  } else {
    // Otherwise, create a checkout session for the 'Pro' plan by default, or just let them choose.
    // Since we don't have a specific price ID yet, we will just redirect to a checkout if configured
    // Wait, typically they select a plan on a pricing page.
    // For this B2B MVP, we will send them to an existing payment link or redirect with an error if no default price is set.

    // In a real app, you would pass `line_items: [{ price: 'price_id', quantity: 1 }]`
    // For now, we will throw an error telling them to contact sales if they don't have a plan.
    throw new Error('No active subscription found. Please contact sales to upgrade.')
  }
}
