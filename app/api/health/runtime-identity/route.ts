// app/api/health/runtime-identity/route.ts
//
// STELLA_STAGING_B — the runtime identity, as an OBSERVATION.
//
// Everything that proved this property before was inferential. The bootstrap
// gate refuses to serve on a wrong role, so a deployment that answers at all
// has passed it once; the hosted smoke showed an authenticated user with no
// membership getting `Unauthorized` from an organisation-scoped route, which is
// what an RLS boundary looks like from outside. Both are strong. Neither can be
// asked to show the answer, and "the deployment did not fail" is not the same
// statement as "current_user is uellix_app and it does not hold BYPASSRLS".
//
// This route asks the question and shows the answer. The evidence comes from a
// query on `getDefaultDatabaseClient().sql` — the very pool db/client.ts builds
// to serve requests, inside this deployment's own process. A probe run from a
// separate connection, or from a laptop, certifies whoever opened it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT PART OF /api/health/auth
// ---------------------------------------------------------------------------
// That route answers ANONYMOUS callers with 200 and `authenticated: false`, and
// staging's SMK-02 verified exactly that contract. Adding database-role
// evidence to it would mean either exposing it to anonymous callers or changing
// a contract that is already certified. They are also two different questions:
// "can we reach Auth" and "who is this PostgreSQL session".
//
// ---------------------------------------------------------------------------
// WHY A VERIFIED SESSION AND NOT SUPER-ADMIN
// ---------------------------------------------------------------------------
// Super-admin is read from `public.users` under RLS — through the very property
// this route exists to measure. A deployment whose database identity is wrong
// is a deployment where `loadRequestPrincipal()` finds no readable profile and
// answers 403, so the strictest-looking gate is the one that removes the
// diagnostic exactly when it is needed. The minimum correct boundary is the one
// that survives the failure it observes: a session GoTrue has verified,
// resolved by the same `lib/auth/identity.ts` every protected entry point uses.
// No second auth system, no organisation requirement, no profile requirement.

import { NextResponse } from 'next/server'
import { getDefaultDatabaseClient } from '@/db/client'
import {
  observeRuntimeIdentityReport,
  toRuntimeIdentityPayload,
  unobservableRuntimeIdentityPayload,
} from '@/db/runtime-identity-report'
import { getVerifiedAuthIdentityResult } from '@/lib/auth/identity'

export async function GET() {
  const { identity, failure } = await getVerifiedAuthIdentityResult()

  if (!identity) {
    // 503 for an Auth outage, 401 for everything else. Telling a caller they
    // are unauthenticated when GoTrue is simply down is how an outage turns
    // into a logout storm — the distinction lib/auth/identity.ts preserves for
    // this reason. Neither branch says which of the two it was beyond the
    // status code, and neither echoes a cookie, a token or a subject.
    return NextResponse.json(
      { error: failure === 'AUTH_UNAVAILABLE' ? 'Unavailable' : 'Unauthorized' },
      { status: failure === 'AUTH_UNAVAILABLE' ? 503 : 401 }
    )
  }

  try {
    const payload = toRuntimeIdentityPayload(
      await observeRuntimeIdentityReport(getDefaultDatabaseClient().sql)
    )
    // 503 rather than 200-with-a-flag when the identity is wrong: this is a
    // health surface, and a deployment whose runtime role can bypass RLS is not
    // healthy. Matches /api/health/auth's `degraded` convention.
    return NextResponse.json(payload, { status: payload.verified ? 200 : 503 })
  } catch {
    // NOTHING from the error is read. postgres-js builds connection failures
    // out of the host and port and attaches `address`, and a PostgreSQL error
    // carries a SQLSTATE and often the statement — so the caught value is
    // discarded entirely rather than inspected, redacted or logged. The result
    // is one stable code, and it is never healthy.
    return NextResponse.json(unobservableRuntimeIdentityPayload(), { status: 503 })
  }
}
