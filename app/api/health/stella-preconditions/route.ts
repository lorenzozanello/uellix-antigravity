// app/api/health/stella-preconditions/route.ts
//
// G1-B PRECONDITIONS — THE DEPLOYMENT ANSWERS FOR ITSELF.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// G1-B spends REAL provider calls against a Preview deployment. Every one of
// them is wasted if the deployment is not configured the way the certification
// assumes — and until this route, "is Preview using the branch's environment?"
// could only be answered by inference: the deploy log, the Vercel dashboard, or
// a call that failed in a way somebody interpreted.
//
// The most expensive version of that inference is the rate limiter. Without
// `KV_REST_API_URL`/`KV_REST_API_TOKEN` it used to fall back to a per-instance
// `Map` and then behave EXACTLY like a working limiter, so a Preview with no KV
// and a Preview with KV were indistinguishable from outside. It now fails
// closed (lib/stella/rate-limit.ts) — and this route is where an operator sees
// WHICH of the two they have, before spending anything.
//
// SCOPE OF THE CLAIM. Everything here is a CONFIGURATION PRECONDITION, read
// from this process's own environment. It is not a health check of anything
// external: no network call, no database query. In particular it does not
// establish that Upstash answers or that the KV token is valid — see the
// `ready` field below for why that is a diagnosis limitation and not a hole.
//
// ---------------------------------------------------------------------------
// WHAT IT WILL NEVER RETURN
// ---------------------------------------------------------------------------
// No secret VALUE, ever — not truncated, not fingerprinted, not hashed. Only:
//   * booleans for "is this key present and non-blank",
//   * variable NAMES that are present,
//   * feature flags, which are public product state,
//   * the model target, which is already in the repository.
//
// A health payload that echoed even part of a credential would be a leak with a
// 200 next to it. `stellaRateLimitAttestation()` is written to the same rule and
// is unit-tested against it.
//
// ---------------------------------------------------------------------------
// WHY IT TOUCHES NO DATABASE
// ---------------------------------------------------------------------------
// Deliberate, and not an omission. The DATABASE preconditions of G1-B — the
// `audit_logs` INSERT policy (prepared stella_hosted_0008) and the removal of
// the `model_used` column default (prepared stella_0020) — are asserted by
// those packages' own postconditions at APPLY time, against the catalog, by the
// identity that applied them. Re-deriving them here would mean a second, weaker
// answer to a question that already has an authoritative one, and would put a
// tenant-data-capable client behind a health route for no gain.
// `/api/health/runtime-identity` remains the route that observes the connection.
//
// ---------------------------------------------------------------------------
// WHY A VERIFIED SESSION AND NOT ANONYMOUS
// ---------------------------------------------------------------------------
// Same boundary as `/api/health/runtime-identity`, for the same reason: this is
// deployment configuration, not public status. It requires no organisation and
// no profile, so it still answers during exactly the misconfiguration it exists
// to diagnose.

import { NextResponse } from 'next/server'
import { getVerifiedAuthIdentityResult } from '@/lib/auth/identity'
import { stellaConfig, stellaState, STELLA_DEFAULT_GEMINI_MODEL } from '@/lib/stella/config'
import { stellaRateLimitAttestation } from '@/lib/stella/rate-limit'
import { STELLA_CAPABILITIES, stellaCapabilityBlocker } from '@/lib/stella/capability-readiness'

export async function GET() {
  const { identity, failure } = await getVerifiedAuthIdentityResult()

  if (!identity) {
    return NextResponse.json(
      { error: failure === 'AUTH_UNAVAILABLE' ? 'Unavailable' : 'Unauthorized' },
      { status: failure === 'AUTH_UNAVAILABLE' ? 503 : 401 }
    )
  }

  const rateLimit = stellaRateLimitAttestation()

  const capabilities = Object.fromEntries(
    STELLA_CAPABILITIES.map((capability) => [capability, stellaCapabilityBlocker(capability)])
  )

  const payload = {
    schema: 'uellix.stella.preconditions/1',
    environment: rateLimit.environment,
    master: {
      stellaEnabled: stellaConfig.isEnabled,
      // PRESENCE, not the value, and trimmed — see stellaState.canUseStella.
      geminiApiKeyPresent: stellaConfig.geminiApiKey.trim().length > 0,
      canUseStella: stellaState.canUseStella,
    },
    model: {
      // Both, because they can differ: an operator who set GEMINI_MODEL in the
      // deployment must be able to SEE that the deployment is not on the
      // repository's target rather than discover it from a 404.
      requested: stellaConfig.geminiModel,
      repositoryTarget: STELLA_DEFAULT_GEMINI_MODEL,
      matchesRepositoryTarget: stellaConfig.geminiModel === STELLA_DEFAULT_GEMINI_MODEL,
      maxOutputTokens: stellaConfig.maxOutputTokens,
      requestTimeoutMs: stellaConfig.requestTimeoutMs,
    },
    // `null` means ready; a string names the single reason it is not.
    capabilities,
    rateLimit,
    // The one field a caller should branch on. A deployment that does not even
    // DECLARE a distributed limiter is not ready to be given a real provider
    // budget.
    //
    // `ready: true` IS A PRECONDITION, NOT A HEALTH VERDICT. Specifically it
    // does NOT assert that Upstash is reachable or that the KV credential is
    // valid — this route makes no network call and no database query, by
    // design. A deployment with present-but-invalid KV variables reports
    // `ready: true` here and then refuses on the first real call, where
    // `consumeStellaRateLimit` returns `reason: 'unavailable'` and the governed
    // path fails CLOSED before minting a ticket. That is a limitation of
    // readiness attestation, not a hole: nothing is ever allowed through on the
    // strength of this field alone.
    ready: stellaState.canUseStella && rateLimit.satisfied,
  }

  // 503 rather than 200-with-a-flag when a precondition is unmet, matching the
  // `degraded` convention of the two sibling health routes. A G1-B preflight
  // that only reads status codes must still get the right answer.
  return NextResponse.json(payload, { status: payload.ready ? 200 : 503 })
}
