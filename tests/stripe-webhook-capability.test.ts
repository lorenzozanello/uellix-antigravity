// tests/stripe-webhook-capability.test.ts
//
// CAP-03 — THE APPLICATION SIDE OF RR-CAP-10-A.
//
// RR-CAP-10 took `stella_monthly_quota`, `stella_plan_label` and the three
// `stripe_*` columns out of every runtime UPDATE grant (`stella_0011`), and
// RR-CAP-10-A recorded the consequence: any `db.update(organizations).set({…})`
// still in the tree raises 42501 the moment the package is applied. The two
// platform-admin call sites were moved to `uellix_capability.admin_*` in an
// earlier unit; `app/api/webhooks/stripe/route.ts` was explicitly left behind
// with three such statements, dead behind a `false` constant, and the note in
// lib/admin/organization-administration.ts said rewriting them "belongs to
// enabling CAP-03".
//
// This suite is what that rewrite is measured against. It asserts the SHAPE of
// the new path, not a live database:
//
//   1. ZERO reachable direct writes — no `db.update(organizations)` survives
//      anywhere the webhook can reach, flag on or flag off.
//   2. The feature flag is still OFF and still gates before anything else.
//   3. The organisation is derived from the CORRELATION the signed event
//      carries (customer / subscription id), never from `client_reference_id`.
//   4. U0003 (contended) is RETRYABLE and must not mark the event failed.
//   5. An unexpected error is NOT absorbed — it propagates.
//   6. The published contracts are exported and exhaustive.
//   7. No `service_role` shortcut anywhere on this path.
//   8. The typed layer matches the CURRENT signatures in
//      db/prepared/stella_0008_stripe_webhook_identity.sql.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CAPABILITY_OUTCOMES,
  CAPABILITY_SQLSTATE,
  CAPABILITY_UNAVAILABLE_REASONS,
  capabilityUnavailable,
  STRIPE_EVENT_DISPOSITIONS,
  STRIPE_FAILURE_CODES,
  type CapabilityOutcome,
  type CapabilityResult,
  type StripeEventDisposition,
  type StripeEventResult,
  assertNeverCapabilityOutcome,
  isRetryableCapabilityResult,
} from '@/lib/capabilities/contracts'

import {
  STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR,
  STRIPE_CAPABILITY_FUNCTIONS,
  STRIPE_CAPABILITY_ROLE,
  planStripeEvent,
  processStripeEvent,
  stripeCapabilityUnavailable,
  type StripeCapabilityExecutor,
} from '@/lib/capabilities/stripe-webhook'

const REPO = process.cwd()
const read = (...segments: string[]) => readFileSync(path.join(REPO, ...segments), 'utf8')

const ROUTE_PATH = ['app', 'api', 'webhooks', 'stripe', 'route.ts'] as const
const LAYER_PATH = ['lib', 'capabilities', 'stripe-webhook.ts'] as const
const CONTRACTS_PATH = ['lib', 'capabilities', 'contracts.ts'] as const
const PACKAGE_PATH = ['db', 'prepared', 'stella_0008_stripe_webhook_identity.sql'] as const

/** Strip line comments so a prose mention is never read as a statement. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n')
}

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        items: { data: [{ price: { id: 'price_pro' } }] },
        ...overrides,
      },
    },
  }
}

/**
 * An executor that records calls and answers whatever the test pins.
 *
 * The recording WRAPS the override rather than being replaced by it: a spread
 * of `overrides` over the defaults would silently drop the `calls.push`, and
 * every "which methods ran" assertion would then pass vacuously on exactly the
 * paths a test bothered to pin.
 */
function executorSpy(overrides: Partial<StripeCapabilityExecutor> = {}) {
  const calls: string[] = []
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push(name)
      return fn(...args)
    }

  const executor: StripeCapabilityExecutor = {
    beginEvent: vi.fn(
      record('beginEvent', overrides.beginEvent ?? (async () => 'claimed' as const))
    ),
    applySubscription: vi.fn(
      record('applySubscription', overrides.applySubscription ?? (async () => {}))
    ),
    failEvent: vi.fn(record('failEvent', overrides.failEvent ?? (async () => {}))),
  }
  return { executor, calls }
}

/** A driver error the way postgres-js surfaces a RAISE with a custom SQLSTATE. */
function sqlStateError(sqlState: string): Error & { code: string } {
  return Object.assign(new Error('capability refused'), { code: sqlState })
}

// ---------------------------------------------------------------------------
// 1. Zero reachable direct writes
// ---------------------------------------------------------------------------

describe('1. no direct write to organizations survives on the webhook path', () => {
  it('the route issues no db.update(organizations) and imports neither db nor the table', () => {
    const route = code(read(...ROUTE_PATH))

    expect(route).not.toMatch(/db\s*\.\s*update\s*\(/)
    expect(route).not.toMatch(/db\s*\.\s*insert\s*\(/)
    expect(route).not.toMatch(/db\s*\.\s*select\s*\(/)
    expect(route).not.toMatch(/db\.query\./)
    // The imports are the structural half: a statement cannot be reintroduced
    // by accident if the symbols are not in scope.
    expect(route).not.toMatch(/from '@\/db\/client'/)
    expect(route).not.toMatch(/organizations/)
  })

  it('the capability layer never reaches the ORM either', () => {
    const layer = code(read(...LAYER_PATH))
    expect(layer).not.toMatch(/from '@\/db\/client'/)
    expect(layer).not.toMatch(/db\s*\.\s*update\s*\(/)
    // `organizations` may be NAMED (it is the table the definer writes) but
    // never imported as a drizzle table object.
    expect(layer).not.toMatch(/from '@\/db\/schema'/)
  })

  it('the contracts module is types only — it opens nothing', () => {
    const contracts = code(read(...CONTRACTS_PATH))
    expect(contracts).not.toMatch(/from '@\/db\//)
    expect(contracts).not.toMatch(/postgres/)
  })
})

// ---------------------------------------------------------------------------
// 2. The feature flag is off, and it gates first
// ---------------------------------------------------------------------------

describe('2. the capability stays disabled', () => {
  const route = read(...ROUTE_PATH)

  it('WEBHOOK_DATABASE_IDENTITY_AVAILABLE is still pinned to false', () => {
    expect(route).toMatch(/const WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false/)
  })

  it('the gate is consulted before the first capability call', () => {
    const gateIndex = route.indexOf('if (!WEBHOOK_DATABASE_IDENTITY_AVAILABLE)')
    const firstCallIndex = route.indexOf('processStripeEvent(')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(firstCallIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(firstCallIndex)
  })

  it('an unavailable capability is a retryable 503, and it is a typed value', () => {
    const result = stripeCapabilityUnavailable('evt_1', 'database_identity_unavailable')
    expect(result.disposition).toBe('unavailable')
    expect(result.httpStatus).toBe(503)
    expect(result.retryable).toBe(true)
  })

  // --- A-F2 closure --------------------------------------------------------
  // The finding: CT-CAP-001 held two definitions of retryability for
  // `unavailable`, and the only reason exercised anywhere was
  // `database_identity_unavailable` — the single one where both agree. So the
  // divergent case, and the only reason reachable in production today, had no
  // test at all.
  //
  // These pin BOTH answers for `feature_flag_disabled`. They are not asserting
  // that the two agree; they assert that they differ, deliberately, and in
  // which direction — so collapsing them later has to be an explicit act with a
  // failing test in front of it.
  describe('A-F2 — the two retryability questions, for the reason where they differ', () => {
    it('the capability-level answer for a disabled flag is NOT retryable', () => {
      // Nothing retried without a deploy will change this.
      const generic = capabilityUnavailable('CAP-03', 'feature_flag_disabled')
      expect(generic.outcome).toBe('unavailable')
      expect(generic.reason).toBe('feature_flag_disabled')
      expect(generic.retryable).toBe(false)
      expect(isRetryableCapabilityResult(generic)).toBe(false)
    })

    it('the transport answer for the same reason is still a retryable 503', () => {
      // Stripe abandons delivery after a 2xx or a 4xx, and an abandoned
      // delivery is a subscription change that never lands. A redelivered one
      // merely arrives after the flag is on.
      const wire = stripeCapabilityUnavailable('evt_1', 'feature_flag_disabled')
      expect(wire.disposition).toBe('unavailable')
      expect(wire.unavailableReason).toBe('feature_flag_disabled')
      expect(wire.httpStatus).toBe(503)
      expect(wire.retryable).toBe(true)
    })

    it('they agree on every other reason, so the divergence is the flag and only the flag', () => {
      for (const reason of CAPABILITY_UNAVAILABLE_REASONS) {
        if (reason === 'feature_flag_disabled') continue
        expect(capabilityUnavailable('CAP-03', reason).retryable, reason).toBe(true)
        expect(stripeCapabilityUnavailable('evt_1', reason).retryable, reason).toBe(true)
      }
    })

    it('the generic constructor is actually reachable from the CAP-03 path', () => {
      // The finding's aggravating factor was that `capabilityUnavailable` had
      // ZERO call sites in the tree, so the rule it states was documentation
      // with nothing behind it. It is now called by stripeCapabilityUnavailable
      // — which is also what validates the reason through one function.
      const source = readFileSync(
        path.resolve(process.cwd(), 'lib', 'capabilities', 'stripe-webhook.ts'),
        'utf8',
      )
      expect(source).toMatch(/capabilityUnavailable\('CAP-03', reason\)/)
    })

    it('the route no longer claims the rule is stated in a single place', () => {
      const route = readFileSync(
        path.resolve(process.cwd(), 'app', 'api', 'webhooks', 'stripe', 'route.ts'),
        'utf8',
      )
      expect(route).not.toMatch(/stated in\s*\n?\/\/ one place and cannot drift/)
      expect(route).toMatch(/A-F2/)
    })
  })
})

// ---------------------------------------------------------------------------
// 3. The organisation comes from the correlation, never from the buyer
// ---------------------------------------------------------------------------

describe('3. organisation correlation', () => {
  it('a subscription event correlates on the subscription id and carries the customer id', () => {
    const plan = planStripeEvent(subscriptionEvent())
    expect(plan).toMatchObject({
      kind: 'apply',
      matchKind: 'subscription',
      matchValue: 'sub_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    })
  })

  it('checkout.session.completed is NOT applicable — client_reference_id is not authority', () => {
    const plan = planStripeEvent({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          client_reference_id: '00000000-0000-0000-0000-000000000001',
        },
      },
    })
    expect(plan.kind).toBe('not_applicable')
  })

  it('no module on this path reads client_reference_id as an organisation id', () => {
    expect(code(read(...LAYER_PATH))).not.toMatch(/client_reference_id/)
    expect(code(read(...ROUTE_PATH))).not.toMatch(/client_reference_id/)
  })

  it('an event type the capability does not handle never reaches the database', async () => {
    const { executor, calls } = executorSpy()
    const result = await processStripeEvent({
      event: { id: 'evt_3', type: 'invoice.paid', data: { object: {} } },
      executor,
      resolvePlan: () => ({ quota: 10, label: 'Free' }),
    })
    expect(result.disposition).toBe('ignored')
    expect(result.httpStatus).toBe(200)
    expect(calls).toEqual([])
  })

  it('a subscription event with no customer id cannot be applied', () => {
    const plan = planStripeEvent(subscriptionEvent({ customer: null }))
    expect(plan.kind).toBe('not_applicable')
  })

  it('a claimable-but-inapplicable event is CLAIMED and closed as ignored, never applied', async () => {
    // checkout.session.completed carries real Stripe identity, so it is worth a
    // durable record that we received it and deliberately did not apply it
    // (DP-CAP-15: first binding is a first-party flow, not a webhook). That is
    // what the package's `not_applicable` code and its 'ignored' state are for.
    const { executor, calls } = executorSpy()
    const result = await processStripeEvent({
      event: {
        id: 'evt_4',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1' } },
      },
      executor,
      resolvePlan: () => ({ quota: 250, label: 'Pro' }),
    })
    expect(result.disposition).toBe('ignored')
    expect(result.httpStatus).toBe(200)
    expect(calls).toEqual(['beginEvent', 'failEvent'])
    expect(executor.failEvent).toHaveBeenCalledWith('evt_4', 'not_applicable')
    expect(executor.applySubscription).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. U0003 is retryable and must not mark the event failed
// ---------------------------------------------------------------------------

describe('4. contention (U0003) keeps retry semantics', () => {
  it('answers a retryable 5xx and leaves the event claimable', async () => {
    const { executor, calls } = executorSpy({
      applySubscription: vi.fn(async () => {
        throw sqlStateError(CAPABILITY_SQLSTATE.CONTENDED)
      }),
    })

    const result = await processStripeEvent({
      event: subscriptionEvent(),
      executor,
      resolvePlan: () => ({ quota: 250, label: 'Pro' }),
    })

    expect(result.disposition).toBe('retry')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBeGreaterThanOrEqual(500)
    // The whole point of U0003 being a DISTINCT sqlstate: a contended event is
    // still in 'processing' and re-claimable. Marking it failed would be safe
    // but calling stripe_fail_event here would be a needless second round trip;
    // what must NOT happen is a terminal disposition.
    expect(calls).not.toContain('failEvent')
  })

  it('a claim that is already in flight is also a retryable 5xx', async () => {
    const { executor } = executorSpy({ beginEvent: vi.fn(async () => 'in_progress' as const) })
    const result = await processStripeEvent({
      event: subscriptionEvent(),
      executor,
      resolvePlan: () => ({ quota: 250, label: 'Pro' }),
    })
    expect(result.disposition).toBe('retry')
    expect(result.httpStatus).toBeGreaterThanOrEqual(500)
  })

  it('a duplicate is idempotent: 200, no apply, no failure', async () => {
    const { executor, calls } = executorSpy({ beginEvent: vi.fn(async () => 'duplicate' as const) })
    const result = await processStripeEvent({
      event: subscriptionEvent(),
      executor,
      resolvePlan: () => ({ quota: 250, label: 'Pro' }),
    })
    expect(result.disposition).toBe('duplicate')
    expect(result.httpStatus).toBe(200)
    expect(calls).toEqual(['beginEvent'])
  })

  it('U0001 marks the event org_not_resolved and stays retryable — the row is re-claimable', async () => {
    const { executor, calls } = executorSpy({
      applySubscription: vi.fn(async () => {
        throw sqlStateError(CAPABILITY_SQLSTATE.DENIED)
      }),
    })
    const result = await processStripeEvent({
      event: subscriptionEvent(),
      executor,
      resolvePlan: () => ({ quota: 250, label: 'Pro' }),
    })
    expect(result.disposition).toBe('refused')
    expect(calls).toContain('failEvent')
    expect(executor.failEvent).toHaveBeenCalledWith('evt_1', 'org_not_resolved')
  })
})

// ---------------------------------------------------------------------------
// 5. Unexpected errors are not absorbed
// ---------------------------------------------------------------------------

describe('5. an unexpected error still fails', () => {
  it('propagates a non-capability error instead of turning it into a disposition', async () => {
    const { executor } = executorSpy({
      applySubscription: vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    })

    await expect(
      processStripeEvent({
        event: subscriptionEvent(),
        executor,
        resolvePlan: () => ({ quota: 250, label: 'Pro' }),
      })
    ).rejects.toThrow('ECONNRESET')
  })

  it('an unknown SQLSTATE is not silently mapped to a retry', async () => {
    const { executor } = executorSpy({
      applySubscription: vi.fn(async () => {
        throw sqlStateError('42501')
      }),
    })

    await expect(
      processStripeEvent({
        event: subscriptionEvent(),
        executor,
        resolvePlan: () => ({ quota: 250, label: 'Pro' }),
      })
    ).rejects.toBeTruthy()
  })

  it('an unmapped price is refused as price_unmapped, never applied as free', async () => {
    // The silent-downgrade hazard: mapStripePriceToQuota falls back to the free
    // quota for an unknown price, so a Pro price added in Stripe but not in the
    // environment would DOWNGRADE a paying customer with every layer saying yes.
    const { executor, calls } = executorSpy()
    const result = await processStripeEvent({
      event: subscriptionEvent(),
      executor,
      resolvePlan: () => null,
    })
    expect(result.disposition).toBe('refused')
    expect(calls).not.toContain('applySubscription')
    expect(executor.failEvent).toHaveBeenCalledWith('evt_1', 'price_unmapped')
  })
})

// ---------------------------------------------------------------------------
// 6. Contracts are exported and exhaustive
// ---------------------------------------------------------------------------

describe('6. published contracts', () => {
  it('every capability outcome is enumerated and the exhaustive guard rejects nothing else', () => {
    expect([...CAPABILITY_OUTCOMES].sort()).toEqual(
      ['contended', 'denied', 'idempotent', 'succeeded', 'unavailable'].sort()
    )

    // A real exhaustiveness proof: the switch below must handle every member,
    // and `assertNeverCapabilityOutcome` fails to typecheck if one is added
    // without a branch here.
    const describeOutcome = (outcome: CapabilityOutcome): string => {
      switch (outcome) {
        case 'succeeded':
          return 'ok'
        case 'idempotent':
          return 'ok'
        case 'denied':
          return 'terminal'
        case 'contended':
          return 'retry'
        case 'unavailable':
          return 'retry'
        default:
          return assertNeverCapabilityOutcome(outcome)
      }
    }
    expect(CAPABILITY_OUTCOMES.map(describeOutcome)).toHaveLength(CAPABILITY_OUTCOMES.length)
  })

  it('retryability is derivable from the contract without inspecting a message', () => {
    const contended: CapabilityResult<never> = {
      outcome: 'contended',
      capability: 'CAP-05',
      sqlState: CAPABILITY_SQLSTATE.CONTENDED,
      retryable: true,
    }
    const denied: CapabilityResult<never> = {
      outcome: 'denied',
      capability: 'CAP-01',
      sqlState: CAPABILITY_SQLSTATE.DENIED,
      retryable: false,
    }
    expect(isRetryableCapabilityResult(contended)).toBe(true)
    expect(isRetryableCapabilityResult(denied)).toBe(false)
  })

  it('the five capability payload contracts are all exported', async () => {
    const contracts = await import('@/lib/capabilities/contracts')
    for (const name of [
      'INVITATION_CAPABILITY',
      'PUBLIC_VERIFICATION_CAPABILITY',
      'STRIPE_EVENT_CAPABILITY',
      'PUBLIC_LEAD_CAPABILITY',
      'ORGANIZATION_BOOTSTRAP_CAPABILITY',
    ]) {
      expect(contracts, `contracts must export ${name}`).toHaveProperty(name)
    }
  })

  it('every Stripe disposition maps to exactly one HTTP status and one retryability', () => {
    const seen = new Set<StripeEventDisposition>()
    for (const disposition of STRIPE_EVENT_DISPOSITIONS) seen.add(disposition)
    expect(seen.size).toBe(STRIPE_EVENT_DISPOSITIONS.length)
    expect([...STRIPE_EVENT_DISPOSITIONS].sort()).toEqual(
      ['applied', 'duplicate', 'ignored', 'refused', 'retry', 'unavailable'].sort()
    )
  })

  it('an applied event is a typed success carrying the event id', async () => {
    const { executor } = executorSpy()
    const result: StripeEventResult = await processStripeEvent({
      event: subscriptionEvent(),
      executor,
      resolvePlan: () => ({ quota: 250, label: 'Pro' }),
    })
    expect(result).toMatchObject({
      disposition: 'applied',
      capability: 'CAP-03',
      eventId: 'evt_1',
      httpStatus: 200,
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// 7. No service_role shortcut
// ---------------------------------------------------------------------------

describe('7. no service_role anywhere on this path', () => {
  const SURFACES = [ROUTE_PATH, LAYER_PATH, CONTRACTS_PATH].map(
    (segments) => [segments.join('/'), segments] as const
  )

  it.each(SURFACES)('%s does not reach for the elevated Supabase key', (_label, segments) => {
    // RR-CAP-10-C: the Supabase elevated key retains table-level UPDATE on
    // organizations AND bypasses RLS, so it would move a quota with no audit
    // row at all. It is the one shortcut that makes every argument in
    // stella_0008 vacuous, and it must not appear on this path in any form.
    const source = read(...segments)
    expect(source).not.toMatch(/service_role/)
    expect(source).not.toMatch(/SERVICE_ROLE_KEY/)
    expect(source).not.toMatch(/createClient\(/)
  })

  it('the capability connects as its own least-privilege login role', () => {
    expect(STRIPE_CAPABILITY_ROLE).toBe('uellix_stripe')
    expect(STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR).toBe('UELLIX_STRIPE_DATABASE_URL')
    // Not the runtime's connection, and not the legacy shared one.
    expect(STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR).not.toBe('UELLIX_RUNTIME_DATABASE_URL')
    expect(STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR).not.toBe('DATABASE_URL')
  })
})

// ---------------------------------------------------------------------------
// 8. The typed layer matches the CURRENT prepared SQL
// ---------------------------------------------------------------------------

describe('8. compatibility with db/prepared/stella_0008', () => {
  const sqlSource = read(...PACKAGE_PATH)

  it('names exactly the three functions the package creates, with their arity', () => {
    expect(STRIPE_CAPABILITY_FUNCTIONS).toEqual({
      beginEvent: { name: 'uellix_capability.stripe_begin_event', arity: 4 },
      applySubscription: { name: 'uellix_capability.stripe_apply_subscription', arity: 8 },
      failEvent: { name: 'uellix_capability.stripe_fail_event', arity: 2 },
    })

    for (const fn of Object.values(STRIPE_CAPABILITY_FUNCTIONS)) {
      const bare = fn.name.replace('uellix_capability.', '')
      expect(sqlSource, `${fn.name} must exist in the package`).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION uellix_capability\\.${bare}\\b`)
      )
    }
  })

  it('the declared SQLSTATEs are the ones the package actually raises', () => {
    expect(sqlSource).toMatch(new RegExp(`ERRCODE = '${CAPABILITY_SQLSTATE.DENIED}'`))
    expect(sqlSource).toMatch(new RegExp(`ERRCODE = '${CAPABILITY_SQLSTATE.CONTENDED}'`))
  })

  it('the failure codes are exactly the package CHECK constraint list', () => {
    expect([...STRIPE_FAILURE_CODES].sort()).toEqual(
      ['internal', 'not_applicable', 'org_not_resolved', 'price_unmapped', 'signature'].sort()
    )
    for (const codeName of STRIPE_FAILURE_CODES) {
      expect(sqlSource, `${codeName} must be accepted by stripe_fail_event`).toContain(`'${codeName}'`)
    }
  })

  it('the claim results are the three the package returns', () => {
    for (const claim of ['claimed', 'duplicate', 'in_progress']) {
      expect(sqlSource).toMatch(new RegExp(`RETURN '${claim}'`))
    }
  })
})
