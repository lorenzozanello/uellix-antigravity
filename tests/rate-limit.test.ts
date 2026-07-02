import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkAndRecordRateLimit, resetRateLimitForTests } from '@/lib/security/rate-limit'

beforeEach(() => {
  resetRateLimitForTests()
  vi.useRealTimers()
})

describe('checkAndRecordRateLimit', () => {
  it('allows attempts up to the limit', () => {
    const opts = { maxAttempts: 3, windowMs: 60_000 }
    expect(checkAndRecordRateLimit('user@a.com', opts).allowed).toBe(true)
    expect(checkAndRecordRateLimit('user@a.com', opts).allowed).toBe(true)
    expect(checkAndRecordRateLimit('user@a.com', opts).allowed).toBe(true)
  })

  it('blocks the attempt after the limit is reached', () => {
    const opts = { maxAttempts: 2, windowMs: 60_000 }
    checkAndRecordRateLimit('user@b.com', opts)
    checkAndRecordRateLimit('user@b.com', opts)
    const result = checkAndRecordRateLimit('user@b.com', opts)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('tracks separate keys independently', () => {
    const opts = { maxAttempts: 1, windowMs: 60_000 }
    checkAndRecordRateLimit('user-x@a.com', opts)
    const other = checkAndRecordRateLimit('user-y@a.com', opts)
    expect(other.allowed).toBe(true)
  })

  it('resets after the window elapses', () => {
    vi.useFakeTimers()
    const opts = { maxAttempts: 1, windowMs: 1000 }
    expect(checkAndRecordRateLimit('user@c.com', opts).allowed).toBe(true)
    expect(checkAndRecordRateLimit('user@c.com', opts).allowed).toBe(false)

    vi.advanceTimersByTime(1001)

    expect(checkAndRecordRateLimit('user@c.com', opts).allowed).toBe(true)
  })
})
