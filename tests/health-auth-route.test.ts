// tests/health-auth-route.test.ts
//
// M11 TA-13 — EXTENDS the original two-case file. Both original cases are
// RETAINED in spirit (PII protection on the authenticated path; PII
// protection on the degraded path) with their fixtures corrected to real SDK
// shapes — the original fixtures ('private-user-id', a bare `new Error(...)`)
// predate M11 and do not match what @supabase/supabase-js actually returns,
// which is exactly the gap M11 TA-01's discriminator exists to close.
//
// The touch (`lib/health/provider-touch.ts`) is injected via
// `__setProviderTouchFetchForTests`, never the real transport — the mock on
// `@/lib/supabase/server` below covers `getVerifiedAuthIdentityResult`'s own
// egress; `vitest.setup.network-guard.ts` (M11 TA-19) is the backstop for
// either mock being missed.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import {
  PROBE_WAIT_BUDGET_MS,
  __resetProviderTouchStateForTests,
  __setProviderTouchFetchForTests,
} from '@/lib/health/provider-touch'

const getUser = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser },
  }),
}))

import { GET, buildAnonymousHealthResponse } from '@/app/api/health/auth/route'

const REAL_UUID = '11111111-1111-4111-8111-111111111111'

/** A fetch stub for the touch, so a NO_SESSION anonymous call resolves deterministically. */
function touchFetch(ok: boolean): typeof fetch {
  return vi.fn(async () => new Response(null, { status: ok ? 200 : 503 })) as unknown as typeof fetch
}

/** Abort-aware: never settles on its own, only when the probe's own AbortController fires. */
function hangingTouchFetch(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  getUser.mockReset()
  __resetProviderTouchStateForTests()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
})

afterEach(() => {
  __setProviderTouchFetchForTests(null)
  __resetProviderTouchStateForTests()
  vi.unstubAllEnvs()
})

describe('GET /api/health/auth', () => {
  it('reports connectivity without exposing user information (authenticated)', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: REAL_UUID, email_confirmed_at: '2026-01-01T00:00:00Z' } },
      error: null,
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', authenticated: true })
    expect(JSON.stringify(body)).not.toContain(REAL_UUID)
    expect(body).not.toHaveProperty('error')
  })

  it('AS-1 NO_SESSION, provider REACHABLE: 200, unauthenticated body, upstream REACHABLE', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    __setProviderTouchFetchForTests(touchFetch(true))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', authenticated: false, upstream: 'REACHABLE' })
  })

  it('AS-1 NO_SESSION, provider UNREACHABLE: 503, degraded body (the genuinely failable cell)', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    __setProviderTouchFetchForTests(touchFetch(false))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ status: 'degraded', authenticated: false, upstream: 'UNREACHABLE' })
  })

  it('AS-2 SESSION_REJECTED (AuthApiError): 200, unauthenticated body, upstream REACHABLE — never 503', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('sensitive upstream detail', 401, 'session_expired'),
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', authenticated: false, upstream: 'REACHABLE' })
    expect(JSON.stringify(body)).not.toContain('sensitive upstream detail')
  })

  it('AS-3 (AuthRetryableFetchError via a rejected session): 503, degraded body — the failable cell', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('sensitive upstream detail', 0),
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ status: 'degraded', authenticated: false, upstream: 'UNREACHABLE' })
    expect(JSON.stringify(body)).not.toContain('sensitive upstream detail')
  })

  it('does not expose an upstream authentication error (degraded path, real SDK shape)', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('sensitive upstream detail', 503),
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      status: 'degraded',
      authenticated: false,
      message: 'Authentication service unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('sensitive upstream detail')
  })

  it('the pure body-builder maps UNKNOWN to 200/unknown (unit-level check on the helper alone)', () => {
    const { body, status } = buildAnonymousHealthResponse('UNKNOWN')
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'unknown', authenticated: false, upstream: 'UNKNOWN' })
  })

  it('M11 NB-IC-2 — END-TO-END: GET() itself, with the touch genuinely unable to observe (wait-budget exceeded), answers 200/unknown — NEVER 503', async () => {
    // NOT the pure helper in isolation: this exercises the REAL wiring —
    // GET() -> getVerifiedAuthIdentityResult() (NO_SESSION) ->
    // observeProviderHealth() -> a hanging fetch whose wait budget is
    // exceeded before it ever settles. A mutation inside GET() that maps
    // UNKNOWN to 503 (or to buildAnonymousHealthResponse('UNREACHABLE'))
    // MUST turn this test red; a change to only the pure helper, or to
    // buildAnonymousHealthResponse's own UNKNOWN branch elsewhere, is NOT
    // sufficient to make it pass — the route's own dispatch has to get it
    // right too.
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    __setProviderTouchFetchForTests(hangingTouchFetch())

    vi.useFakeTimers()
    try {
      const responsePromise = GET()
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BUDGET_MS)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(response.status).not.toBe(503)
      expect(body).toMatchObject({ status: 'unknown', authenticated: false, upstream: 'UNKNOWN' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('MUST FAIL: AS-2 can never produce 503', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('rejected', 401, 'session_expired'),
    })
    const response = await GET()
    expect(response.status).not.toBe(503)
    expect(response.status).toBe(200)
  })

  it('MUST FAIL: UNKNOWN must never be mapped to 503 merely because an observation was unavailable', () => {
    const { status } = buildAnonymousHealthResponse('UNKNOWN')
    expect(status).not.toBe(503)
    expect(status).toBe(200)
  })

  it('MUST FAIL: an anonymous request against an unreachable provider must differ observably from one against a reachable provider', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })

    __setProviderTouchFetchForTests(touchFetch(true))
    const healthy = await (await GET()).json()

    __resetProviderTouchStateForTests()
    __setProviderTouchFetchForTests(touchFetch(false))
    const unhealthy = await (await GET()).json()

    expect(healthy).not.toEqual(unhealthy)
    expect(healthy.upstream).toBe('REACHABLE')
    expect(unhealthy.upstream).toBe('UNREACHABLE')
  })

  it('M11 NB-IC-7/8 — AUTH_UNAVAILABLE (createClient throws — a LOCAL config failure, not affirmative evidence the provider is unreachable): 200, unknown body, NEVER 503', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockRejectedValueOnce(new Error('coherence failure, never echoed'))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.status).not.toBe(503)
    expect(body).toMatchObject({ status: 'unknown', authenticated: false, upstream: 'UNKNOWN' })
    expect(JSON.stringify(body)).not.toContain('coherence failure')
  })

  it('MALFORMED_SUBJECT: treated as REACHABLE (GoTrue answered, even if the subject is malformed)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'not-a-uuid' } }, error: null })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', authenticated: false, upstream: 'REACHABLE' })
  })

  it('MUST FAIL: no health response body may contain a user id, email, token or upstream error text', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: REAL_UUID, email: 'person@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } },
      error: null,
    })
    const authed = JSON.stringify(await (await GET()).json())
    expect(authed).not.toContain(REAL_UUID)
    expect(authed).not.toContain('person@example.com')

    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('a secret upstream detail XYZ', 0),
    })
    const degraded = JSON.stringify(await (await GET()).json())
    expect(degraded).not.toContain('a secret upstream detail XYZ')
  })
})
