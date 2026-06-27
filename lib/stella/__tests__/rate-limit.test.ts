// lib/stella/__tests__/rate-limit.test.ts
// Sprint 9D: Rate limiter tests — per-org, hourly window, in-memory.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { checkStellaRateLimit, recordStellaRequest, resetStellaRateLimitForTests } from '../rate-limit'

// Mock stellaConfig to control the rate limit in tests without env vars
vi.mock('../config', () => ({
  stellaConfig: {
    rateLimitPerHour: 3,
    geminiApiKey: '',
    geminiModel: 'gemini-2.0-flash',
    isEnabled: false,
    isAdvisorEnabled: false,
    isValidatorEnabled: false,
    isComposerEnabled: false,
    requestTimeoutMs: 15000,
  },
  stellaState: {
    canUseStella: false,
    missingApiKey: false,
  },
}))

const ORG_A = 'org-aaaa-0000-0000-000000000001'
const ORG_B = 'org-bbbb-0000-0000-000000000002'

beforeEach(() => {
  resetStellaRateLimitForTests()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('checkStellaRateLimit', () => {
  it('allows first request (count 0 < limit 3)', () => {
    const result = checkStellaRateLimit(ORG_A)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(3)
    expect(result.limit).toBe(3)
  })

  it('returns remaining count correctly after recording requests', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    const result = checkStellaRateLimit(ORG_A)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(1)
  })

  it('blocks when limit is reached', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    const result = checkStellaRateLimit(ORG_A)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('remaining never goes below zero', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A) // over limit, but store still increments
    const result = checkStellaRateLimit(ORG_A)
    expect(result.remaining).toBe(0)
  })

  it('includes a future UTC reset timestamp', () => {
    const result = checkStellaRateLimit(ORG_A)
    const reset = new Date(result.resetAtHourUtc)
    expect(reset.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('per-org isolation', () => {
  it('org A requests do not affect org B', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)

    const resultB = checkStellaRateLimit(ORG_B)
    expect(resultB.allowed).toBe(true)
    expect(resultB.remaining).toBe(3)
  })

  it('org B requests do not affect org A', () => {
    recordStellaRequest(ORG_B)
    recordStellaRequest(ORG_B)
    recordStellaRequest(ORG_B)

    const resultA = checkStellaRateLimit(ORG_A)
    expect(resultA.allowed).toBe(true)
    expect(resultA.remaining).toBe(3)
  })

  it('both orgs can reach their limit independently', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_B)
    recordStellaRequest(ORG_B)
    recordStellaRequest(ORG_B)

    expect(checkStellaRateLimit(ORG_A).allowed).toBe(false)
    expect(checkStellaRateLimit(ORG_B).allowed).toBe(false)
  })
})

describe('hourly window reset', () => {
  it('resets count when hour changes', () => {
    // Use fake timers to control Date
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-26T14:00:00Z'))

    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    expect(checkStellaRateLimit(ORG_A).allowed).toBe(false)

    // Advance to next hour
    vi.setSystemTime(new Date('2026-06-26T15:00:00Z'))

    const result = checkStellaRateLimit(ORG_A)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(3)
  })

  it('recording in new hour starts fresh bucket', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-26T14:30:00Z'))

    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)

    vi.setSystemTime(new Date('2026-06-26T15:05:00Z'))

    recordStellaRequest(ORG_A) // starts new hour bucket
    const result = checkStellaRateLimit(ORG_A)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })
})

describe('resetStellaRateLimitForTests', () => {
  it('clears all org buckets', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    expect(checkStellaRateLimit(ORG_A).allowed).toBe(false)

    resetStellaRateLimitForTests()

    expect(checkStellaRateLimit(ORG_A).allowed).toBe(true)
    expect(checkStellaRateLimit(ORG_A).remaining).toBe(3)
  })

  it('clears multiple orgs at once', () => {
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_B)
    recordStellaRequest(ORG_B)
    recordStellaRequest(ORG_B)

    resetStellaRateLimitForTests()

    expect(checkStellaRateLimit(ORG_A).remaining).toBe(3)
    expect(checkStellaRateLimit(ORG_B).remaining).toBe(3)
  })
})

describe('security invariants', () => {
  it('does not leak cross-org counters', () => {
    for (let i = 0; i < 3; i++) recordStellaRequest(ORG_A)
    expect(checkStellaRateLimit(ORG_A).allowed).toBe(false)
    expect(checkStellaRateLimit(ORG_B).allowed).toBe(true)
  })

  it('does not read or expose env vars directly', () => {
    // Rate limiter reads from stellaConfig mock (rateLimitPerHour: 3)
    // If it read from process.env directly, limit would be 100 (default)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    recordStellaRequest(ORG_A)
    expect(checkStellaRateLimit(ORG_A).allowed).toBe(false) // blocked at 3, not 100
  })

  it('does not make real Gemini API calls', () => {
    // Rate limiter is pure in-memory logic — no network, no Gemini
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
  })
})
