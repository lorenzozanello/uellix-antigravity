// tests/stripe-webhook-route.test.ts
//
// THE STRIPE GATE IS FAIL-CLOSED, AND STAYS THAT WAY (reaudit finding M4).
//
// After the runtime cutover the webhook has no database identity: there is no
// session (Stripe is the caller), and borrowing an admin's identity would
// fabricate the audit trail. The handler therefore refuses with 503 AFTER
// verifying the signature — Stripe retries a 5xx, so no event is lost.
//
// What was missing was the SYMMETRIC test: nothing failed if someone flipped
// WEBHOOK_DATABASE_IDENTITY_AVAILABLE to true without first building the
// technical identity — and the handler would then run its queries through the
// contextless `db` client, which under uellix_app returns zero rows and
// updates nothing, silently discarding billing events. This file closes that:
//
//   A. invalid signature  -> 400, ZERO database access
//   B. valid signature    -> 503 (retryable), ZERO database access, no write
//   C. the constant is pinned to `false` while no technical identity exists —
//      flipping it makes this suite fail before any contextless query ships.
//
// The db mock THROWS on any property access, so a regression that reaches the
// database at all turns into a loud failure, never a silent empty query.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const dbAccesses = vi.hoisted(() => [] as string[])

vi.mock('@/db/client', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        dbAccesses.push(String(property))
        throw new Error(
          `stripe webhook touched db.${String(property)} — it has no database identity and must not query`
        )
      },
    }
  ),
}))

const stripeMocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
}))

vi.mock('@/lib/stripe/client', () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: stripeMocks.constructEvent },
    subscriptions: {
      retrieve: vi.fn(() => {
        throw new Error('stripe webhook called the Stripe API after refusing — it must not')
      }),
    },
  }),
  mapStripePriceToQuota: vi.fn(() => 0),
  mapStripePriceToLabel: vi.fn(() => 'free'),
}))

import { POST } from '@/app/api/webhooks/stripe/route'

const WEBHOOK_URL = 'http://localhost/api/webhooks/stripe'

function webhookRequest(headers: Record<string, string> = {}): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: 'evt_test', type: 'customer.subscription.updated' }),
  })
}

describe('POST /api/webhooks/stripe — fail-closed gate', () => {
  beforeEach(() => {
    dbAccesses.length = 0
    stripeMocks.constructEvent.mockReset()
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_not_a_real_secret'
  })

  it('A1: a missing signature header gets 400 and zero database access', async () => {
    const response = await POST(webhookRequest())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid signature' })
    expect(stripeMocks.constructEvent).not.toHaveBeenCalled()
    expect(dbAccesses).toEqual([])
  })

  it('A2: an INVALID signature gets 400 and zero database access', async () => {
    stripeMocks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })

    const response = await POST(webhookRequest({ 'stripe-signature': 't=1,v1=deadbeef' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid signature' })
    expect(stripeMocks.constructEvent).toHaveBeenCalledTimes(1)
    expect(dbAccesses).toEqual([])
  })

  it('B: a VALID signature with the capability blocked gets 503 — retryable, zero access, zero writes', async () => {
    stripeMocks.constructEvent.mockReturnValue({
      id: 'evt_test',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_test', items: { data: [{ price: { id: 'price_test' } }] } } },
    })

    const response = await POST(webhookRequest({ 'stripe-signature': 't=1,v1=valid' }))

    // 503 and not 200: Stripe retries any 5xx with backoff, so the event is
    // NOT lost; a 200 with no write would discard it permanently.
    expect(response.status).toBe(503)
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(await response.json()).toEqual({ error: 'Billing webhook processing is unavailable' })
    expect(dbAccesses).toEqual([])
  })

  it('refuses AFTER signature verification, so an unsigned probe cannot map availability', async () => {
    // Same body, no valid signature: the answer must be the 400 branch, never
    // the 503 branch — otherwise the gate doubles as an unauthenticated
    // availability oracle.
    stripeMocks.constructEvent.mockImplementation(() => {
      throw new Error('invalid')
    })
    const response = await POST(webhookRequest({ 'stripe-signature': 'garbage' }))
    expect(response.status).toBe(400)
  })

  it('unconfigured environment (no secrets) also refuses with 503, before any parsing', async () => {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_WEBHOOK_SECRET

    const response = await POST(webhookRequest({ 'stripe-signature': 't=1,v1=valid' }))
    expect(response.status).toBe(503)
    expect(stripeMocks.constructEvent).not.toHaveBeenCalled()
    expect(dbAccesses).toEqual([])
  })
})

describe('C: the gate constant cannot be flipped without the technical identity', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'app', 'api', 'webhooks', 'stripe', 'route.ts'),
    'utf8'
  )

  it('WEBHOOK_DATABASE_IDENTITY_AVAILABLE is pinned to false', () => {
    // The technical identity (a least-privilege webhook role with a narrow
    // grant on organizations + audit_logs) DOES NOT EXIST YET. Until it does,
    // flipping this constant routes billing mutations through the contextless
    // uellix_app client — zero rows read, zero rows written, Stripe told 200.
    // Whoever builds the identity must update this test IN THE SAME CHANGE,
    // with the queries moved onto that identity's own connection.
    expect(source).toMatch(/const WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false/)
  })

  it('the gate actually consults the constant before the first query', () => {
    const gateIndex = source.indexOf('if (!WEBHOOK_DATABASE_IDENTITY_AVAILABLE)')
    const firstQueryIndex = source.indexOf('await db.')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(firstQueryIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(firstQueryIndex)
  })

  it('no technical webhook identity exists yet anywhere in the runtime configuration', () => {
    // The symmetric half: if a webhook identity IS introduced (a capability
    // variable, a role, a client), this assertion goes stale and fails,
    // forcing the constant, the handler and these tests to move together.
    const capabilityModule = readFileSync(
      path.join(process.cwd(), 'db', 'safety', 'resolve-capability-database-url.ts'),
      'utf8'
    )
    expect(capabilityModule).not.toMatch(/WEBHOOK/i)
    expect(source).not.toMatch(/UELLIX_WEBHOOK_DATABASE_URL/)
  })
})
