// lib/auth/identity.ts
//
// THE ONE PLACE A DATABASE IDENTITY IS ALLOWED TO COME FROM.
//
// Before the runtime cutover, "who is this request" was answered by a query:
// `getCurrentUser()` selected from `public.users` and whatever came back was
// the user. That worked only because the connection was `postgres`, which
// bypasses RLS — the query could see the row it was looking for regardless of
// any claim.
//
// After the cutover that same query is the first link of a cycle:
//
//     to read public.users you need claims
//       → to set claims you need a user id
//         → to get a user id you read public.users
//
// The cycle is broken by refusing to let the database answer the question at
// all. The subject comes from Supabase Auth and nowhere else, and this module
// is the only thing that asks.
//
// WHY `getUser()` AND NOT `getSession()`
//
// `getSession()` decodes the session cookie in-process. The cookie is
// attacker-supplied data: anything that can write it can choose the `sub` it
// decodes to, and `sub` is exactly the value that becomes
// `request.jwt.claims` and therefore the value every RLS policy trusts.
// `getUser()` sends the token to GoTrue and gets back a verified subject.
//
// That is a network round trip per request, which is the cost of the property.
// It is memoised per request below rather than avoided.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
//   * It does not read `public.users`. Application attributes — the profile
//     row, `is_super_admin`, the soft-delete tombstone — are loaded INSIDE a
//     context by lib/auth/database-context.ts. Mixing the two is what created
//     the cycle.
//   * It does not accept anything from the caller. There is no parameter that
//     names a user, an organisation or a privilege level.
//   * It does not log the token, the claims, or the subject. A user id is a
//     stable identifier for a real person; error text ends up in logs.

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * The subject of a verified session, and nothing else.
 *
 * Deliberately NOT `AuthUser`: this type carries only what the Auth layer can
 * vouch for on its own. `isSuperAdmin`, the organisation, the profile — none
 * of those are knowable without the database, and pretending otherwise is how
 * a client-supplied privilege claim gets in.
 */
export interface VerifiedAuthIdentity {
  readonly userId: string
}

export type AuthIdentityFailure =
  /** No session cookie, or one GoTrue does not recognise. */
  | 'NO_SESSION'
  /** A session existed but GoTrue rejected it — expired, revoked, wrong project. */
  | 'SESSION_REJECTED'
  /** GoTrue returned a subject that is not a UUID. Never seen; still refused. */
  | 'MALFORMED_SUBJECT'
  /** Auth itself was unreachable. Distinct from "not logged in". */
  | 'AUTH_UNAVAILABLE'

export interface AuthIdentityResult {
  readonly identity: VerifiedAuthIdentity | null
  readonly failure: AuthIdentityFailure | null
}

/**
 * Same shape as db/identity-context.ts uses, and for the same reason: the
 * value is interpolated into a JSON claim document that `auth.uid()` casts
 * with `::uuid`.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the verified subject of the current request.
 *
 * Returns a RESULT rather than throwing, because the four failures are not
 * interchangeable at the call site: "no session" is a 401 or a redirect to
 * login, "auth unavailable" is a 503, and conflating them turns an outage into
 * a logout storm.
 *
 * Memoised with React's `cache` so that a page which touches five services
 * does not make five round trips to GoTrue. `cache` is per-request in the App
 * Router; outside a request scope it degrades to calling through, which is
 * correct — an unmemoised verification is slower, never weaker.
 */
export const getVerifiedAuthIdentityResult = cache(async (): Promise<AuthIdentityResult> => {
  let supabase: Awaited<ReturnType<typeof createClient>>
  try {
    supabase = await createClient()
  } catch {
    // Misconfigured URL/key, or `cookies()` called outside a request scope.
    // Neither means "logged out", so it must not be reported as such.
    return { identity: null, failure: 'AUTH_UNAVAILABLE' }
  }

  let data: Awaited<ReturnType<typeof supabase.auth.getUser>>
  try {
    data = await supabase.auth.getUser()
  } catch {
    return { identity: null, failure: 'AUTH_UNAVAILABLE' }
  }

  const authUser = data.data?.user ?? null

  if (!authUser) {
    // `@supabase/ssr` reports both "no cookie at all" and "cookie rejected"
    // through the same shape. The error object distinguishes them: an absent
    // session produces no error, a rejected one does.
    return { identity: null, failure: data.error ? 'SESSION_REJECTED' : 'NO_SESSION' }
  }

  if (typeof authUser.id !== 'string' || !UUID_PATTERN.test(authUser.id)) {
    // The subject is never echoed — not even a malformed one, which may still
    // be a partially valid identifier.
    return { identity: null, failure: 'MALFORMED_SUBJECT' }
  }

  return { identity: { userId: authUser.id }, failure: null }
})

/**
 * The verified subject, or `null`.
 *
 * The thin form, for call sites that treat every failure the same way.
 * Anything that needs to tell a 401 from a 503 must use
 * `getVerifiedAuthIdentityResult`.
 */
export async function getVerifiedAuthIdentity(): Promise<VerifiedAuthIdentity | null> {
  return (await getVerifiedAuthIdentityResult()).identity
}
