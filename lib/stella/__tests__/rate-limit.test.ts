// lib/stella/__tests__/rate-limit.test.ts
// Atomic per-organization limiter contract for memory and distributed runtimes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeStellaRateLimit, resetStellaRateLimitForTests } from '../rate-limit'

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
  stellaState: { canUseStella: false, missingApiKey: false },
}))

const ORG_A = 'org-aaaa-0000-0000-000000000001'
const ORG_B = 'org-bbbb-0000-0000-000000000002'

beforeEach(() => {
  resetStellaRateLimitForTests()
  vi.useRealTimers()
})

afterEach(() => vi.useRealTimers())

describe('consumeStellaRateLimit', () => {
  it('atomically consumes the first token', async () => {
    await expect(consumeStellaRateLimit(ORG_A)).resolves.toMatchObject({
      allowed: true,
      remaining: 2,
      limit: 3,
      reason: 'allowed',
    })
  })

  it('blocks after all tokens are consumed', async () => {
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    await expect(consumeStellaRateLimit(ORG_A)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      reason: 'limit',
    })
  })

  it('never returns negative remaining quota', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await consumeStellaRateLimit(ORG_A)
    }
    expect((await consumeStellaRateLimit(ORG_A)).remaining).toBe(0)
  })

  it('isolates organization counters', async () => {
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    expect((await consumeStellaRateLimit(ORG_A)).allowed).toBe(false)
    await expect(consumeStellaRateLimit(ORG_B)).resolves.toMatchObject({ allowed: true, remaining: 2 })
  })

  it('resets the memory bucket on the next UTC hour', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-26T14:00:00Z'))
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    expect((await consumeStellaRateLimit(ORG_A)).allowed).toBe(false)

    vi.setSystemTime(new Date('2026-06-26T15:00:00Z'))
    await expect(consumeStellaRateLimit(ORG_A)).resolves.toMatchObject({ allowed: true, remaining: 2 })
  })

  it('returns a future reset timestamp', async () => {
    const result = await consumeStellaRateLimit(ORG_A)
    expect(new Date(result.resetAtHourUtc).getTime()).toBeGreaterThan(Date.now())
  })

  it('can reset all buckets for deterministic tests', async () => {
    await consumeStellaRateLimit(ORG_A)
    await consumeStellaRateLimit(ORG_A)
    resetStellaRateLimitForTests()
    expect((await consumeStellaRateLimit(ORG_A)).remaining).toBe(2)
  })
})
