import Stripe from 'stripe'

let stripeClient: Stripe | null = null

/**
 * Create the Stripe client only while handling a billing request. Keeping this
 * lazy allows builds and closed-beta environments without billing credentials.
 */
export function getStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY

  if (!secretKey) {
    throw new Error('Stripe is not configured')
  }

  stripeClient ??= new Stripe(secretKey, {
    appInfo: {
      name: 'Uellix B2B Platform',
      version: '1.0.0',
    },
  })

  return stripeClient
}

export const STRIPE_QUOTAS = {
  free: 10,
  pro: 250,
  enterprise: 1000,
} as const

/**
 * Map Stripe Price IDs to Stella AI monthly quotas.
 * 
 * SECURITY: Uses exact Price ID matching from environment variables.
 * Never use substring matching (e.g. `includes('pro')`) as it can cause
 * mis-classification (e.g. `price_promotion_test` would match 'pro').
 *
 * Configure your Stripe Price IDs in environment variables:
 *   STRIPE_PRICE_PRO=price_xxxxx
 *   STRIPE_PRICE_ENTERPRISE=price_yyyyy
 */
const PRICE_ID_MAP: Record<string, { quota: number; label: string }> = {}

// Build the map from environment at module load time
if (process.env.STRIPE_PRICE_PRO) {
  PRICE_ID_MAP[process.env.STRIPE_PRICE_PRO] = { quota: STRIPE_QUOTAS.pro, label: 'Pro' }
}
if (process.env.STRIPE_PRICE_ENTERPRISE) {
  PRICE_ID_MAP[process.env.STRIPE_PRICE_ENTERPRISE] = { quota: STRIPE_QUOTAS.enterprise, label: 'Enterprise' }
}

export function mapStripePriceToQuota(priceId: string | null): number {
  if (!priceId) return STRIPE_QUOTAS.free
  return PRICE_ID_MAP[priceId]?.quota ?? STRIPE_QUOTAS.free
}

export function mapStripePriceToLabel(priceId: string | null): string {
  if (!priceId) return 'Free'
  return PRICE_ID_MAP[priceId]?.label ?? 'Custom'
}
