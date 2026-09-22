// tests/stella-preconditions-route.test.ts
//
// M11 TA-14 — EP-3's AUTH BRANCH AND OD-3's INTENTIONAL-OFF STATUS SPLIT.
//
// Per M11 NB-R1's re-derived consumer set, this route ALREADY calls
// `getVerifiedAuthIdentityResult` (`@/lib/auth/identity`) today, independent
// of the M11 touch ever landing. Following the SAME established, already-safe
// pattern `tests/runtime-identity-observability.test.ts` uses for EP-2
// (`vi.mock('@/lib/auth/identity', ...)`, mocking ABOVE the GoTrue
// chokepoint rather than below it — this file is not testing the
// discriminator itself, so it need not exercise the real supabase.auth code
// path at all. `vitest.setup.network-guard.ts` (M11 TA-19) is the backstop
// if this mock is ever missed.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStellaConfig = {
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-3.6-flash',
  isEnabled: true,
  maxOutputTokens: 4096,
  requestTimeoutMs: 30_000,
}

vi.mock('@/lib/stella/config', () => ({
  STELLA_DEFAULT_GEMINI_MODEL: 'gemini-3.6-flash',
  get stellaConfig() {
    return mockStellaConfig
  },
  get stellaState() {
    return {
      canUseStella: mockStellaConfig.isEnabled && mockStellaConfig.geminiApiKey.trim().length > 0,
    }
  },
}))

const mockRateLimitAttestation = vi.hoisted(() => vi.fn())
vi.mock('@/lib/stella/rate-limit', () => ({
  stellaRateLimitAttestation: mockRateLimitAttestation,
}))

const mockGetVerifiedAuthIdentityResult = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/identity', () => ({
  getVerifiedAuthIdentityResult: mockGetVerifiedAuthIdentityResult,
}))

import { GET } from '@/app/api/health/stella-preconditions/route'

function satisfiedRateLimit() {
  return { environment: 'test', backend: 'memory', distributedRequired: false, satisfied: true, presentVariables: [] }
}
function unsatisfiedRateLimit() {
  return { environment: 'staging', backend: 'unconfigured', distributedRequired: true, satisfied: false, presentVariables: [] }
}

beforeEach(() => {
  mockStellaConfig.geminiApiKey = 'test-key'
  mockStellaConfig.isEnabled = true
  mockRateLimitAttestation.mockReturnValue(satisfiedRateLimit())
  mockGetVerifiedAuthIdentityResult.mockReset()
})

describe('GET /api/health/stella-preconditions', () => {
  it('anonymous caller (M11 TA-02 non-regression): 401, unchanged', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({ identity: null, failure: 'NO_SESSION', upstreamObservation: null })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('AUTH_UNAVAILABLE: 503, Unavailable — unchanged', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({ identity: null, failure: 'AUTH_UNAVAILABLE', upstreamObservation: null })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({ error: 'Unavailable' })
  })

  it('verified session, stellaEnabled true, precondition satisfied: 200, ready true', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({
      identity: { userId: '1', emailVerified: true },
      failure: null,
      upstreamObservation: null,
    })
    mockStellaConfig.isEnabled = true
    mockRateLimitAttestation.mockReturnValue(satisfiedRateLimit())

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ready).toBe(true)
    expect(body.master.stellaEnabled).toBe(true)
  })

  it('M11 TA-07 — verified session, stellaEnabled true, precondition UNMET: 503 (as today)', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({
      identity: { userId: '1', emailVerified: true },
      failure: null,
      upstreamObservation: null,
    })
    mockStellaConfig.isEnabled = true
    mockRateLimitAttestation.mockReturnValue(unsatisfiedRateLimit())

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.ready).toBe(false)
    expect(body.master.stellaEnabled).toBe(true)
  })

  it('M11 TA-07 — verified session, stellaEnabled FALSE (intentional off), precondition satisfied: 200 (healthy-and-disabled)', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({
      identity: { userId: '1', emailVerified: true },
      failure: null,
      upstreamObservation: null,
    })
    mockStellaConfig.isEnabled = false
    mockStellaConfig.geminiApiKey = ''
    mockRateLimitAttestation.mockReturnValue(satisfiedRateLimit())

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.master.stellaEnabled).toBe(false)
  })

  it('M11 TA-07 PRECEDENCE — stellaEnabled FALSE AND precondition unmet: 200, intentional-off DOMINATES', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({
      identity: { userId: '1', emailVerified: true },
      failure: null,
      upstreamObservation: null,
    })
    mockStellaConfig.isEnabled = false
    mockStellaConfig.geminiApiKey = ''
    mockRateLimitAttestation.mockReturnValue(unsatisfiedRateLimit())

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.master.stellaEnabled).toBe(false)
    expect(body.ready).toBe(false) // the body still honestly reports not-ready
  })

  it('MUST FAIL: a 200 status with ready:false must never be treated as a ready deployment — the body field is the one to branch on', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({
      identity: { userId: '1', emailVerified: true },
      failure: null,
      upstreamObservation: null,
    })
    mockStellaConfig.isEnabled = false
    mockStellaConfig.geminiApiKey = ''
    mockRateLimitAttestation.mockReturnValue(unsatisfiedRateLimit())

    const response = await GET()
    const body = await response.json()

    // The specific hazard the status split introduces: this reachable
    // combination MUST NOT collapse `ready` to true just because status is 200.
    expect(response.status).toBe(200)
    expect(body.ready).toBe(false)
  })

  it('does not leak a secret value, ever — only presence/name booleans', async () => {
    mockGetVerifiedAuthIdentityResult.mockResolvedValue({
      identity: { userId: '1', emailVerified: true },
      failure: null,
      upstreamObservation: null,
    })
    mockStellaConfig.geminiApiKey = 'AIzaSuperSecretRealKeyValue'

    const response = await GET()
    const body = await response.json()

    expect(JSON.stringify(body)).not.toContain('AIzaSuperSecretRealKeyValue')
    expect(body.master.geminiApiKeyPresent).toBe(true)
  })
})
