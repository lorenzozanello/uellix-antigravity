// lib/marketing/demo-request-rate-limit.ts
// Per-IP in-memory hourly limiter for the public demo request form.
// Same lazy-expiry pattern as lib/stella/rate-limit.ts — not Redis-backed,
// resets on server restart. This is a public, unauthenticated endpoint, so
// a coarse per-IP cap is a cheap first line of defense against spam.

const LIMIT_PER_HOUR = 5

interface HourBucket {
  count: number
  hourKey: string
}

function currentHourKey(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`
}

const store = new Map<string, HourBucket>()

export function checkDemoRequestRateLimit(ip: string): boolean {
  const hourKey = currentHourKey()
  const bucket = store.get(ip)
  const count = bucket && bucket.hourKey === hourKey ? bucket.count : 0
  return count < LIMIT_PER_HOUR
}

export function recordDemoRequest(ip: string): void {
  const hourKey = currentHourKey()
  const bucket = store.get(ip)
  if (bucket && bucket.hourKey === hourKey) {
    bucket.count++
  } else {
    store.set(ip, { count: 1, hourKey })
  }
}

export function resetDemoRequestRateLimitForTests(): void {
  store.clear()
}
