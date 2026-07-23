// lib/stella/rate-limit.ts
// Phase 4: Redis-backed Rate Limiter with In-Memory fallback.

import { stellaConfig } from './config'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  resetAtHourUtc: string
  reason: 'allowed' | 'limit' | 'unavailable'
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

let ratelimit: Ratelimit | null = null

if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  })
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(stellaConfig.rateLimitPerHour, '1 h'),
    analytics: true,
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Consume exactly one hourly Stella token for an organization. */
export async function consumeStellaRateLimit(organizationId: string): Promise<RateLimitResult> {
  if (ratelimit) {
    const limit = stellaConfig.rateLimitPerHour
    try {
      const result = await ratelimit.limit(`stella_org_${organizationId}`)
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

  return memoryConsume(organizationId)
}

export function resetStellaRateLimitForTests(): void {
  store.clear()
}
