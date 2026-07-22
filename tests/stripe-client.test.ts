import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Stripe client configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('can be imported during a build without a Stripe secret', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    vi.resetModules()

    const stripeModule = await import('@/lib/stripe/client')

    expect(() => stripeModule.getStripeClient()).toThrow('Stripe is not configured')
  })
})
