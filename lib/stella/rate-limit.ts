// lib/stella/rate-limit.ts
// Sprint 9D: Per-org in-memory hourly rate limiter for Stella requests.
// Uses lazy expiry: stale hour buckets are overwritten on the next request,
// no active cleanup needed. Not Redis-backed — resets on server restart (MVP).

import { stellaConfig } from './config'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  resetAtHourUtc: string
}

interface HourBucket {
  count: number
  hourKey: string
}

// UTC hour key, e.g. "2026-5-26-14" (month is 0-indexed, intentional — consistent within process)
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

export function checkStellaRateLimit(organizationId: string): RateLimitResult {
  const limit = stellaConfig.rateLimitPerHour
  const hourKey = currentHourKey()
  const bucket = store.get(organizationId)
  const count = bucket && bucket.hourKey === hourKey ? bucket.count : 0

  return {
    allowed: count < limit,
    remaining: Math.max(0, limit - count),
    limit,
    resetAtHourUtc: nextHourReset(),
  }
}

export function recordStellaRequest(organizationId: string): void {
  const hourKey = currentHourKey()
  const bucket = store.get(organizationId)

  if (bucket && bucket.hourKey === hourKey) {
    bucket.count++
  } else {
    store.set(organizationId, { count: 1, hourKey })
  }
}

export function resetStellaRateLimitForTests(): void {
  store.clear()
}
