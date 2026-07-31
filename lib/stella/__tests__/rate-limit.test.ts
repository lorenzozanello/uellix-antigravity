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

// ---------------------------------------------------------------------------
// WS3c U3 (RK-24): the in-memory fallback must announce itself — on
// serverless, per-instance limits are much weaker than the distributed
// limiter, and silence hides that misconfiguration.
// Fresh module instances per test (the warn-once flag is module-level).
// ---------------------------------------------------------------------------
describe('in-memory fallback warning (RK-24)', () => {
  const EXPECTED_WARNING =
    '[stella-rate-limit] KV not configured — falling back to per-instance in-memory limiter (limits are per-instance on serverless)'

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  async function freshModule() {
    vi.resetModules()
    return await import('../rate-limit')
  }

  it('warns exactly once per process when KV is not configured and the fallback is used', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await freshModule()

    await mod.consumeStellaRateLimit(ORG_A)
    await mod.consumeStellaRateLimit(ORG_A)
    await mod.consumeStellaRateLimit(ORG_B)

    const fallbackWarnings = warnSpy.mock.calls.filter((c) => c[0] === EXPECTED_WARNING)
    expect(fallbackWarnings).toHaveLength(1)
  })

  it('does not warn at import time — only when the fallback is actually consumed', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    vi.stubEnv('KV_REST_API_TOKEN', '')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await freshModule()

    expect(warnSpy).not.toHaveBeenCalledWith(EXPECTED_WARNING)
  })

  it('does NOT warn when KV IS configured (distributed limiter path)', async () => {
    // Connection-refused endpoint: the distributed limiter is constructed and
    // attempted, fails fast, and resolves as 'unavailable' — never falling
    // back to memory, never emitting the fallback warning.
    vi.stubEnv('KV_REST_API_URL', 'http://127.0.0.1:1')
    vi.stubEnv('KV_REST_API_TOKEN', 'test-token')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod = await freshModule()

    const result = await mod.consumeStellaRateLimit(ORG_A)

    expect(result.reason).toBe('unavailable')
    expect(warnSpy).not.toHaveBeenCalledWith(EXPECTED_WARNING)
    expect(errorSpy).toHaveBeenCalledWith('[stella-rate-limit] Distributed limiter unavailable')
  })
})
