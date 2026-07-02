// lib/security/rate-limit.ts
// Generic in-memory fixed-window rate limiter for auth-adjacent endpoints
// (login, password reset) that have no rate limiting today, unlike Stella
// (lib/stella/rate-limit.ts) which already has a per-org hourly limiter.
// Same trade-off as that module: not Redis-backed, resets on server
// restart / doesn't share state across serverless instances — acceptable
// for the MVP as a defense-in-depth layer, not the sole protection
// (Supabase Auth also rate-limits at its own layer).

interface Window {
  count: number
  windowStartMs: number
}

const store = new Map<string, Window>()

export interface RateLimitOptions {
  /** Maximum attempts allowed within the window. */
  maxAttempts: number
  /** Window length in milliseconds. */
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

/** Checks and records an attempt for `key` in one call. */
export function checkAndRecordRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  const existing = store.get(key)

  if (!existing || now - existing.windowStartMs >= options.windowMs) {
    store.set(key, { count: 1, windowStartMs: now })
    return { allowed: true, remaining: options.maxAttempts - 1 }
  }

  if (existing.count >= options.maxAttempts) {
    return { allowed: false, remaining: 0 }
  }

  existing.count++
  return { allowed: true, remaining: options.maxAttempts - existing.count }
}

export function resetRateLimitForTests(): void {
  store.clear()
}
