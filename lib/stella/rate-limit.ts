// lib/stella/rate-limit.ts
// Phase 4: Redis-backed Rate Limiter with In-Memory fallback.
//
// ---------------------------------------------------------------------------
// G1-B PRECONDITIONS — A PER-INSTANCE LIMIT IS NOT A LIMIT ON SERVERLESS
// ---------------------------------------------------------------------------
// This module used to do one thing when `KV_REST_API_URL`/`KV_REST_API_TOKEN`
// were absent: warn once, then serve a `Map` held in the process. On Vercel
// that Map is per LAMBDA INSTANCE, so N warm instances give one organization
// N × `rateLimitPerHour`, and N is not knowable from inside the process. The
// fallback then behaved exactly like a working limiter — `allowed: true`,
// `reason: 'allowed'`, a plausible `remaining` — so no caller, and no
// certification, could distinguish "rate limited" from "counted locally".
//
// For local development that fallback is correct and wanted. For a Preview or
// Production deployment it reports a guarantee it does not have.
//
// THE POLICY, by environment (resolved by db/safety/database-access.ts, which
// is already the repository's one answer to "which environment is this?"):
//
//   development / test / ci    in-memory fallback, warned once. Unchanged.
//   staging (Preview) /        the distributed backend is REQUIRED. Without it
//   production                 this function returns `reason: 'unavailable'`
//                              and `allowed: false`.
//
// FAILING CLOSED COSTS NOTHING EXTRA HERE, and that is why it is the right
// disposition rather than an aggressive one: the only caller is
// `issueGovernedStellaTicket`, which already maps this result to
// `RATE_LIMIT_UNAVAILABLE` — and issuance happens BEFORE any reservation, so no
// ticket is minted, no quota unit is held and no provider call is made. Stella
// stops instead of pretending.
//
// ---------------------------------------------------------------------------
// AND IT IS ATTESTABLE — AS A CONFIGURATION PRECONDITION, NOT AS HEALTH
// ---------------------------------------------------------------------------
// `stellaRateLimitAttestation()` answers exactly one question: "does this
// deployment DECLARE a distributed backend, and does this environment require
// one?" It reads PRESENCE of the two variables, never their values, and it is
// what /api/health/stella-preconditions serves.
//
// WHAT IT DOES NOT AND CANNOT SAY: that Upstash is reachable, that the token is
// valid, or that the limiter is "healthy"/"usable". A URL and a token that are
// present but wrong produce `satisfied: true` here and then fail on the FIRST
// real call. That is a limitation of a readiness attestation, and it is NOT a
// security hole: the failure lands in the `catch` below, which returns
// `reason: 'unavailable'` — so the runtime still fails CLOSED, before any
// ticket is minted and before the provider is reached. The difference between
// "not configured" and "configured but unusable" is a difference in the
// operator's diagnosis, never in what the caller is allowed to do.
//
// A liveness probe is deliberately NOT added here: it would turn a pure,
// synchronous configuration read into a network call on a health path, and it
// would still only prove reachability at the instant it ran.

import { stellaConfig } from './config'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { resolveEnvironmentDecision, type DeploymentEnvironment } from '@/db/safety/database-access'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  resetAtHourUtc: string
  reason: 'allowed' | 'limit' | 'unavailable'
}

/**
 * A CONFIGURATION-PRESENCE PRECONDITION for the distributed limiter.
 *
 * NOT a health check and not a liveness probe. `satisfied: true` means "this
 * deployment declares the backend this environment requires" — it does NOT mean
 * the backend answers, that the credential is valid, or that a `limit()` call
 * would succeed. Present-but-invalid credentials satisfy this and fail on first
 * use, where `consumeStellaRateLimit` returns `reason: 'unavailable'` and the
 * governed path refuses before minting a ticket.
 *
 * `backend` is what the process WOULD use; `distributedRequired` is what the
 * environment DEMANDS; `satisfied` is the conjunction. Reporting all three
 * rather than one boolean is deliberate — "not satisfied" in development and
 * "not satisfied" in Preview are the same word for two different situations,
 * and an operator reading a health payload needs to tell them apart.
 */
export interface StellaRateLimitAttestation {
  readonly environment: DeploymentEnvironment
  readonly backend: 'distributed' | 'memory' | 'unconfigured'
  readonly distributedRequired: boolean
  readonly satisfied: boolean
  /**
   * The variable NAMES this deployment supplies, never their values. A health
   * payload that echoed a token would be a credential leak with a status code.
   */
  readonly presentVariables: readonly string[]
}

/** The environments where a per-instance counter is not a limit. */
const DISTRIBUTED_REQUIRED_ENVIRONMENTS: ReadonlySet<DeploymentEnvironment> = new Set([
  'staging',
  'production',
])

const KV_URL_VAR = 'KV_REST_API_URL'
const KV_TOKEN_VAR = 'KV_REST_API_TOKEN'

/**
 * `.trim()`, for the same reason `stellaConfig` trims the Gemini key: a value
 * that is only whitespace — a mis-pasted secret, a trailing newline in a
 * dashboard field — is an ABSENT value, and treating it as present produces a
 * limiter that constructs successfully and fails on every call.
 */
function presentEnv(name: string): string | null {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

// ---------------------------------------------------------------------------
// In-Memory Fallback Implementation
// ---------------------------------------------------------------------------
interface HourBucket {
  count: number
  hourKey: string
}

function currentHourKey(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`
}

function nextHourReset(): string {
  const now = new Date()
  const reset = new Date(now)
  reset.setUTCMinutes(0, 0, 0)
  reset.setUTCHours(reset.getUTCHours() + 1)
  return reset.toISOString()
}

const store = new Map<string, HourBucket>()

// WS3c U3 (RK-24): once-per-process flag — the in-memory fallback must
// announce itself the first time it is actually used, because per-instance
// limits are much weaker than the distributed limiter on serverless.
let memoryFallbackWarned = false

function warnMemoryFallbackOnce(): void {
  if (memoryFallbackWarned) return
  memoryFallbackWarned = true
  console.warn(
    '[stella-rate-limit] KV not configured — falling back to per-instance in-memory limiter (limits are per-instance on serverless)'
  )
}

function memoryConsume(organizationId: string): RateLimitResult {
  const limit = stellaConfig.rateLimitPerHour
  const hourKey = currentHourKey()
  const bucket = store.get(organizationId)
  const count = bucket && bucket.hourKey === hourKey ? bucket.count : 0
  const allowed = count < limit
  const nextCount = allowed ? count + 1 : count

  if (allowed) {
    store.set(organizationId, { count: nextCount, hourKey })
  }

  return {
    allowed,
    remaining: Math.max(0, limit - nextCount),
    limit,
    resetAtHourUtc: nextHourReset(),
    reason: allowed ? 'allowed' : 'limit',
  }
}

// ---------------------------------------------------------------------------
// Redis (Upstash/Vercel KV) Implementation
// ---------------------------------------------------------------------------
//
// PER CALL, not module-scope, and not cached.
//
// The previous `if (process.env...) { ratelimit = ... }` ran at IMPORT time, so
// it captured whichever environment happened to be loaded first: the choice was
// untestable, a health surface would report a stale answer, and the decision was
// taken before any caller existed.
//
// It is not memoised either, for the reason `getGeminiAdapter` gives for the
// same decision (lib/stella/adapter/gemini-client.ts): a cached client in a warm
// serverless instance pins a stale credential across a rotation until the next
// cold start. The Upstash client is fetch-based and holds no socket, so
// constructing one per call costs an object -- and it means this module keeps no
// copy of a token anywhere.

function getDistributedLimiter(): Ratelimit | null {
  const url = presentEnv(KV_URL_VAR)
  const token = presentEnv(KV_TOKEN_VAR)
  // BOTH, or neither. Half a configuration is not a configuration: a URL with
  // no token constructs a client that authenticates on every call and fails on
  // every call, which would surface as `unavailable` - the right answer for the
  // wrong reason, and one an operator cannot act on.
  if (url === null || token === null) return null

  return new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(stellaConfig.rateLimitPerHour, '1 h'),
    analytics: true,
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Which limiter this deployment DECLARES, and whether the environment accepts
 * that declaration.
 *
 * Reads no secret value and returns none — only which variable NAMES are
 * present. Safe to serve from a health endpoint. Synchronous and network-free:
 * it asserts CONFIGURATION PRESENCE, never reachability — see the module header.
 */
export function stellaRateLimitAttestation(): StellaRateLimitAttestation {
  const { environment } = resolveEnvironmentDecision()
  const distributedRequired = DISTRIBUTED_REQUIRED_ENVIRONMENTS.has(environment)
  const presentVariables = [KV_URL_VAR, KV_TOKEN_VAR].filter((name) => presentEnv(name) !== null)
  const configured = presentVariables.length === 2
  const backend: StellaRateLimitAttestation['backend'] = configured
    ? 'distributed'
    : distributedRequired
      ? 'unconfigured'
      : 'memory'
  return {
    environment,
    backend,
    distributedRequired,
    satisfied: configured || !distributedRequired,
    presentVariables,
  }
}

/** Consume exactly one hourly Stella token for an organization. */
export async function consumeStellaRateLimit(organizationId: string): Promise<RateLimitResult> {
  const limit = stellaConfig.rateLimitPerHour
  const limiter = getDistributedLimiter()

  if (limiter) {
    try {
      const result = await limiter.limit(`stella_org_${organizationId}`)
      return {
        allowed: result.success,
        remaining: result.remaining,
        limit: result.limit,
        resetAtHourUtc: new Date(result.reset).toISOString(),
        reason: result.success ? 'allowed' : 'limit',
      }
    } catch {
      console.error('[stella-rate-limit] Distributed limiter unavailable')
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAtHourUtc: nextHourReset(),
        reason: 'unavailable',
      }
    }
  }

  // No distributed backend. Whether that is acceptable is a property of the
  // ENVIRONMENT, not of this call.
  const attestation = stellaRateLimitAttestation()
  if (attestation.distributedRequired) {
    // The same shape a distributed OUTAGE produces, and deliberately so: from
    // the caller's side "the limiter is not answering" and "the limiter was
    // never configured" have the same correct disposition — refuse before a
    // ticket exists. The two are told apart by `stellaRateLimitAttestation()`,
    // which is what a health surface and a G1-B preflight read.
    console.error(
      `[stella-rate-limit] no distributed limiter configured in "${attestation.environment}" — refusing. ` +
        `Set ${KV_URL_VAR} and ${KV_TOKEN_VAR} for this deployment.`
    )
    return {
      allowed: false,
      remaining: 0,
      limit,
      resetAtHourUtc: nextHourReset(),
      reason: 'unavailable',
    }
  }

  // Development, test and CI — per-instance in-memory fallback (RK-24: warn once).
  warnMemoryFallbackOnce()
  return memoryConsume(organizationId)
}

export function resetStellaRateLimitForTests(): void {
  store.clear()
  memoryFallbackWarned = false
}
