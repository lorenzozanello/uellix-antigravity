// lib/stella/__tests__/rate-limit-backend.test.ts
//
// G1-B PRECONDITIONS — P1: A PER-INSTANCE LIMIT IS NOT A LIMIT ON SERVERLESS.
//
// ---------------------------------------------------------------------------
// THE FINDING
// ---------------------------------------------------------------------------
// `consumeStellaRateLimit` builds an Upstash limiter when `KV_REST_API_URL` and
// `KV_REST_API_TOKEN` are present, and otherwise falls back to a `Map` in the
// process. On Vercel that Map is per lambda instance: N concurrent instances
// give an organization N × the configured hourly budget, and the number is not
// knowable from inside. The fallback announced itself with one `console.warn`
// and then behaved exactly like a working limiter — `allowed: true`,
// `reason: 'allowed'`, a plausible `remaining` — so nothing downstream, and no
// certification, could tell the two apart.
//
// For local development that fallback is correct and wanted. For a Preview or
// Production deployment it is a limiter that reports a guarantee it does not
// have, which is worse than no limiter at all.
//
// ---------------------------------------------------------------------------
// THE POLICY
// ---------------------------------------------------------------------------
//   development / test / ci   in-memory fallback, warned once. Unchanged.
//   staging (Preview) /       the distributed backend is REQUIRED. Without it
//   production                the limiter refuses: `allowed: false`,
//                             `reason: 'unavailable'`.
//
// The refusal is not new machinery. `issueGovernedStellaTicket` already maps a
// `null`/unavailable limiter result to `RATE_LIMIT_UNAVAILABLE`, and issuance
// happens BEFORE any reservation, so the governed path fails CLOSED: no ticket,
// no quota unit, no provider call. Stella stops rather than pretending.
//
// ---------------------------------------------------------------------------
// AND IT MUST BE ATTESTABLE, NOT INFERRED
// ---------------------------------------------------------------------------
// `stellaRateLimitAttestation()` answers "which backend is this deployment
// actually using, and is that acceptable here?" without reading, returning or
// logging any credential — presence of a variable, never its value. That is the
// G1-B precondition an operator can check against Preview before spending a
// real provider call.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config', () => ({
  stellaConfig: {
    geminiApiKey: '',
    geminiModel: 'gemini-3.6-flash',
    isEnabled: false,
    isAdvisorEnabled: false,
    requestTimeoutMs: 15000,
    rateLimitPerHour: 3,
  },
  stellaState: { canUseStella: false, missingApiKey: false },
}))

const ORG = 'org-rate-limit-backend'

async function load() {
  const mod = await import('../rate-limit')
  mod.resetStellaRateLimitForTests()
  return mod
}

/** Clear every variable this module reads, so a case declares its own world. */
function clearEnvironment() {
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UELLIX_APP_ENV', 'VERCEL_ENV', 'CI']) {
    vi.stubEnv(key, '')
  }
  vi.stubEnv('NODE_ENV', 'development')
}

describe('stellaRateLimitAttestation', () => {
  beforeEach(() => {
    vi.resetModules()
    clearEnvironment()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reports the in-memory backend as ACCEPTABLE in development', async () => {
    const { stellaRateLimitAttestation } = await load()
    expect(stellaRateLimitAttestation()).toMatchObject({
      environment: 'development',
      backend: 'memory',
      distributedRequired: false,
      satisfied: true,
    })
  })

  it('reports the missing backend as UNSATISFIED in a Preview deployment', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    const { stellaRateLimitAttestation } = await load()
    expect(stellaRateLimitAttestation()).toMatchObject({
      environment: 'staging',
      backend: 'unconfigured',
      distributedRequired: true,
      satisfied: false,
    })
  })

  it('reports the missing backend as UNSATISFIED in production', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'production')
    const { stellaRateLimitAttestation } = await load()
    expect(stellaRateLimitAttestation()).toMatchObject({
      distributedRequired: true,
      satisfied: false,
    })
  })

  it('reports the distributed backend when BOTH variables are present', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    vi.stubEnv('KV_REST_API_URL', 'https://example.upstash.io')
    vi.stubEnv('KV_REST_API_TOKEN', 'token-value-never-read-back')
    const { stellaRateLimitAttestation } = await load()
    expect(stellaRateLimitAttestation()).toMatchObject({
      backend: 'distributed',
      distributedRequired: true,
      satisfied: true,
    })
  })

  it('treats HALF a configuration as no configuration', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    vi.stubEnv('KV_REST_API_URL', 'https://example.upstash.io')
    const { stellaRateLimitAttestation } = await load()
    expect(stellaRateLimitAttestation()).toMatchObject({ backend: 'unconfigured', satisfied: false })
  })

  it('treats a whitespace-only value as absent', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    vi.stubEnv('KV_REST_API_URL', '   ')
    vi.stubEnv('KV_REST_API_TOKEN', '   ')
    const { stellaRateLimitAttestation } = await load()
    expect(stellaRateLimitAttestation()).toMatchObject({ backend: 'unconfigured', satisfied: false })
  })

  it('never returns a credential value — only which names are present', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    vi.stubEnv('KV_REST_API_URL', 'https://secret-instance.upstash.io')
    vi.stubEnv('KV_REST_API_TOKEN', 'AZ-super-secret-token')
    const { stellaRateLimitAttestation } = await load()
    const serialized = JSON.stringify(stellaRateLimitAttestation())
    expect(serialized).not.toContain('secret-instance')
    expect(serialized).not.toContain('AZ-super-secret-token')
  })
})

describe('consumeStellaRateLimit fails CLOSED where the fallback would be a fiction', () => {
  beforeEach(() => {
    vi.resetModules()
    clearEnvironment()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses in a Preview deployment with no distributed backend', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'staging')
    const { consumeStellaRateLimit } = await load()
    await expect(consumeStellaRateLimit(ORG)).resolves.toMatchObject({
      allowed: false,
      reason: 'unavailable',
    })
  })

  it('refuses every time, not just the first — the refusal is not a counter', async () => {
    vi.stubEnv('UELLIX_APP_ENV', 'production')
    const { consumeStellaRateLimit } = await load()
    for (let i = 0; i < 5; i++) {
      await expect(consumeStellaRateLimit(ORG)).resolves.toMatchObject({ allowed: false, reason: 'unavailable' })
    }
  })

  it('still allows the in-memory fallback in development', async () => {
    const { consumeStellaRateLimit } = await load()
    await expect(consumeStellaRateLimit(ORG)).resolves.toMatchObject({
      allowed: true,
      reason: 'allowed',
      remaining: 2,
    })
  })

  it('still enforces the per-hour budget in development', async () => {
    const { consumeStellaRateLimit } = await load()
    await consumeStellaRateLimit(ORG)
    await consumeStellaRateLimit(ORG)
    await consumeStellaRateLimit(ORG)
    await expect(consumeStellaRateLimit(ORG)).resolves.toMatchObject({ allowed: false, reason: 'limit' })
  })

  it('resolves the environment at CALL time, not at import time', async () => {
    // A module-scope read would capture the environment of whichever module
    // happened to import this one first. It also made the limiter untestable
    // and made the health surface report a stale answer.
    const mod = await load()
    await expect(mod.consumeStellaRateLimit(ORG)).resolves.toMatchObject({ allowed: true })
    vi.stubEnv('UELLIX_APP_ENV', 'production')
    await expect(mod.consumeStellaRateLimit(ORG)).resolves.toMatchObject({
      allowed: false,
      reason: 'unavailable',
    })
  })
})
