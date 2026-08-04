// db/capabilities/stripe-capability-executor.ts
//
// THE CONNECTION SIDE OF CAP-03. It binds `lib/capabilities/stripe-webhook.ts`
// to the three prepared functions over a connection that authenticates as
// `uellix_stripe` — and to NOTHING else.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SECOND CLIENT AND NOT THE APPLICATION ONE
// ---------------------------------------------------------------------------
// The shared client in db/client.ts authenticates as `uellix_app`, and
// `uellix_app` holds no EXECUTE on the three `stripe_*` functions. That is not
// an oversight to work around: it is what stops any application endpoint from
// moving a quota, and CAP-03 §2 calls it the second trust boundary. Reaching
// the capability therefore requires a DIFFERENT login role over a DIFFERENT
// credential, which is the whole reason `stella_0008` creates one.
//
// `uellix_stripe` holds EXECUTE on three functions and no privilege of any
// kind on any relation in `public`, in all four DML modes — proven by the
// package's own postconditions, not asserted here. So a leaked credential can
// move a quota and cannot read a customer list.
//
// ---------------------------------------------------------------------------
// IT RETURNS `null` RATHER THAN THROWING WHEN NOTHING IS PROVISIONED
// ---------------------------------------------------------------------------
// Today that is the normal state: `stella_0008` is prepared and applied
// nowhere, and `UELLIX_STRIPE_DATABASE_URL` is set nowhere. "The capability is
// not provisioned" is an operational fact the caller must be able to report as
// itself, and an exception would make it indistinguishable from a database
// that is down. The caller turns the `null` into a typed `unavailable`
// outcome.
//
// A WRONG credential is a different matter and DOES throw: a URL that declares
// some other role would connect with privileges this capability never asked
// for, and failing closed at the guard is the point.
//
// This module reads no environment at import time and opens no socket at
// import time. The client is built on first use and memoised.

import { parseDeclaredRole } from '../safety/resolve-capability-database-url'
import { createDatabaseClient, type DatabaseClient } from '../client'
import type { EnvironmentSource } from '../safety/database-target'
import type {
  StripeApplySubscriptionInput,
  StripeBeginEventInput,
  StripeCapabilityExecutor,
} from '@/lib/capabilities/stripe-webhook'
import {
  STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR,
  STRIPE_CAPABILITY_ROLE,
} from '@/lib/capabilities/stripe-webhook'
import { STRIPE_CLAIM_RESULTS, type StripeClaimResult, type StripeFailureCode } from '@/lib/capabilities/contracts'

export class StripeCapabilityCredentialError extends Error {
  readonly name = 'StripeCapabilityCredentialError'
}

let cachedClient: DatabaseClient | null = null

/**
 * Build the guarded client for this capability, or `null` when no credential
 * is provisioned.
 *
 * The connection string is never interpolated into any message here, not even
 * redacted — a connection string that reaches a log is a leaked credential
 * however carefully the host was masked. Only the DECLARED ROLE, which is not
 * a secret, is ever named.
 */
function resolveStripeCapabilityClient(env: EnvironmentSource = process.env): DatabaseClient | null {
  if (cachedClient !== null) return cachedClient

  const raw = env[STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR]
  if (typeof raw !== 'string' || raw.trim() === '') return null

  const url = raw.trim()
  const declaredRole = parseDeclaredRole(url)

  if (declaredRole === null) {
    throw new StripeCapabilityCredentialError(
      `${STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR} carries no login role in its userinfo, so the ` +
        `connecting identity would be whatever the server defaults to rather than ` +
        `"${STRIPE_CAPABILITY_ROLE}".`
    )
  }

  if (declaredRole !== STRIPE_CAPABILITY_ROLE) {
    throw new StripeCapabilityCredentialError(
      `${STRIPE_CAPABILITY_DATABASE_URL_ENV_VAR} declares role "${declaredRole}" but this capability ` +
        `requires "${STRIPE_CAPABILITY_ROLE}". Any other role either lacks EXECUTE on the three ` +
        'capability functions or holds privileges this path must never carry.'
    )
  }

  // `app_runtime`, because that is what this is: the product serving a request.
  // It is the only capability permitting a managed remote without a
  // destructive token, and the guard still refuses an unknown or malformed
  // target before a socket is opened. The ROLE separation is enforced above and
  // by the server, not by picking a different guard policy.
  cachedClient = createDatabaseClient({
    connectionString: url,
    capability: 'app_runtime',
    env,
    operation: 'stripe_webhook_capability',
  })

  return cachedClient
}

function assertClaimResult(value: unknown): StripeClaimResult {
  if (typeof value === 'string' && (STRIPE_CLAIM_RESULTS as readonly string[]).includes(value)) {
    return value as StripeClaimResult
  }
  // A claim the state machine does not name is not a state to guess at: the
  // handler's next decision is whether Stripe should retry, and guessing it
  // wrong is either a lost billing event or an infinite retry loop.
  throw new Error(`stripe_begin_event returned an unrecognised claim result`)
}

/**
 * The executor, or `null` when the capability is not provisioned.
 *
 * Every argument is bound as a parameter and cast explicitly, matching the
 * signatures in `db/prepared/stella_0008_stripe_webhook_identity.sql`. Nothing
 * is interpolated — the functions run with `search_path = ''` and every name
 * inside them is qualified, so the SQL side is closed too.
 */
export function resolveStripeCapabilityExecutor(
  env: EnvironmentSource = process.env
): StripeCapabilityExecutor | null {
  const client = resolveStripeCapabilityClient(env)
  if (client === null) return null

  const { sql } = client

  return {
    async beginEvent(input: StripeBeginEventInput): Promise<StripeClaimResult> {
      const rows = await sql`
        SELECT uellix_capability.stripe_begin_event(
                 ${input.eventId}::text,
                 ${input.eventType}::text,
                 ${input.stripeCustomerId}::text,
                 ${input.stripeSubscriptionId}::text) AS claim`
      return assertClaimResult(rows[0]?.claim)
    },

    async applySubscription(input: StripeApplySubscriptionInput): Promise<void> {
      await sql`
        SELECT uellix_capability.stripe_apply_subscription(
                 ${input.eventId}::text,
                 ${input.matchKind}::text,
                 ${input.matchValue}::text,
                 ${input.stripeCustomerId}::text,
                 ${input.stripeSubscriptionId}::text,
                 ${input.stripePriceId}::text,
                 ${input.quota}::integer,
                 ${input.planLabel}::text)`
    },

    async failEvent(eventId: string, code: StripeFailureCode): Promise<void> {
      await sql`
        SELECT uellix_capability.stripe_fail_event(${eventId}::text, ${code}::text)`
    },
  }
}

/** Test seam: drop the memoised client so a suite can vary the environment. */
export function resetStripeCapabilityClientForTesting(): void {
  cachedClient = null
}
