// app/api/health/auth/route.ts
//
// M11 TA-06 — A PUBLIC LIVENESS SURFACE WITH A REAL UPSTREAM TOUCH (OD-1
// OPTION A2), GENUINELY FAILABLE FOR AN ANONYMOUS CALLER.
//
// ---------------------------------------------------------------------------
// THE FOUR-ROW CONTRACT
// ---------------------------------------------------------------------------
//   AS-1 NO_SESSION            -> 200, {status:'ok', upstream:'REACHABLE'}
//   AS-2 SESSION_REJECTED,
//        provider REACHABLE    -> 200, {status:'ok', upstream:'REACHABLE'}
//        (503 PROHIBITED for AS-2, unconditionally — it PROVES the provider
//         answered; treating a rejected session as unhealthy would be the
//         same category error in the opposite direction)
//   AS-3 provider UNREACHABLE  -> 503, {status:'degraded', upstream:'UNREACHABLE'}
//        (the one state that IS a health fact — this is the cell that makes
//        the anonymous caller's observation genuinely failable)
//   UNKNOWN (no affirmative
//        evidence either way)  -> 200, {status:'unknown', upstream:'UNKNOWN'}
//        (owner's HT-1/HT-2 decision: NEVER 503 merely because an
//        observation was unavailable; runner disposition is INCONCLUSIVE,
//        never PASS, never health FAIL — enforced by the runner, not here)
//
// AS-4 (a platform client-construction failure) is not one of the four rows
// above: in production it is caught by `proxy.ts` before this handler ever
// runs. Reaching this handler with `failure === 'AUTH_UNAVAILABLE'` is the
// direct-invocation path every unit test in this suite exercises (Vitest
// calls `GET()` directly, bypassing middleware).
//
// M11 HARDENING (NB-IC-7/8): AUTH_UNAVAILABLE is answered UNKNOWN, not
// UNREACHABLE/503. A client-construction throw (a coherence-check failure,
// or any other unexpected exception `identity.ts` catches) is evidence OUR
// OWN configuration is broken — it proves nothing about whether the PROVIDER
// itself is reachable, which is exactly the distinction HT-2 draws: 503 is
// reserved for AFFIRMATIVE evidence of provider/upstream unavailability, and
// a local config throw is not that. Mapping it to UNREACHABLE would be the
// same category error B-1 already named for AS-2/AS-3, in a third guise.
//
// ---------------------------------------------------------------------------
// WHERE THE UPSTREAM SIGNAL COMES FROM
// ---------------------------------------------------------------------------
// AS-1 (NO_SESSION) makes zero outbound calls — `lib/auth/identity.ts` has no
// reachability signal to offer, so the dedicated touch
// (`lib/health/provider-touch.ts`) is asked instead.
//
// AS-2/AuthUnknownError (SESSION_REJECTED) already made a REAL round trip as
// a side effect of checking the session — its own `upstreamObservation` is
// reused directly rather than spending a second probe on the same fact.
//
// MALFORMED_SUBJECT is treated as REACHABLE without consulting either: GoTrue
// answered with a (malformed) user object, which is itself positive evidence
// the provider is up. Never seen in practice per the ratified taxonomy.
//
// ---------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------
// Unchanged from the route's original rule: no user identifier, email,
// provider name, token, cookie or upstream error text, ever, in any branch.

import { NextResponse } from 'next/server'
import { getVerifiedAuthIdentityResult } from '@/lib/auth/identity'
import { observeProviderHealth, type ProviderTouchVerdict } from '@/lib/health/provider-touch'

/** The authenticated-caller body. No `upstream` field — unchanged from the route's original shape. */
interface AuthenticatedHealthyBody {
  readonly status: 'ok'
  readonly authenticated: true
  readonly timestamp: string
}

/** Pure, exported and directly unit-testable — the whole anonymous-caller matrix in one place. */
export function buildAnonymousHealthResponse(upstream: ProviderTouchVerdict): {
  body: Record<string, unknown>
  status: number
} {
  const timestamp = new Date().toISOString()

  if (upstream === 'UNREACHABLE') {
    return {
      body: {
        status: 'degraded',
        authenticated: false,
        upstream: 'UNREACHABLE',
        message: 'Authentication service unavailable',
        timestamp,
      },
      status: 503,
    }
  }

  if (upstream === 'UNKNOWN') {
    return {
      body: {
        status: 'unknown',
        authenticated: false,
        upstream: 'UNKNOWN',
        message: 'Provider reachability not observed this request',
        timestamp,
      },
      status: 200,
    }
  }

  // REACHABLE — AS-1 or AS-2. 503 is PROHIBITED here, unconditionally.
  return {
    body: { status: 'ok', authenticated: false, upstream: 'REACHABLE', timestamp },
    status: 200,
  }
}

export async function GET() {
  try {
    const { identity, failure, upstreamObservation } = await getVerifiedAuthIdentityResult()

    if (identity) {
      return NextResponse.json(
        {
          status: 'ok',
          authenticated: true,
          timestamp: new Date().toISOString(),
        } satisfies AuthenticatedHealthyBody,
        { status: 200 }
      )
    }

    if (failure === 'AUTH_UNAVAILABLE') {
      const { body, status } = buildAnonymousHealthResponse('UNKNOWN')
      return NextResponse.json(body, { status })
    }

    let upstream: ProviderTouchVerdict
    if (failure === 'SESSION_REJECTED' && upstreamObservation !== null) {
      upstream = upstreamObservation
    } else if (failure === 'MALFORMED_SUBJECT') {
      upstream = 'REACHABLE'
    } else {
      // NO_SESSION, or any other shape identity.ts did not classify.
      upstream = await observeProviderHealth()
    }

    const { body, status } = buildAnonymousHealthResponse(upstream)
    return NextResponse.json(body, { status })
  } catch {
    // Preserves the route's original behaviour for a genuinely unexpected
    // throw: a 500, not a fabricated health verdict.
    return NextResponse.json(
      { status: 'error', message: 'Internal health check failure', timestamp: new Date().toISOString() },
      { status: 500 }
    )
  }
}
