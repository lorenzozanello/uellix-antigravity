// tests/auth-identity-discriminator.test.ts
//
// M11 TA-15 — `classifyUpstreamAuthError` AGAINST REAL SDK ERROR SHAPES.
//
// Every fixture below is a REAL `@supabase/supabase-js` error class
// (re-exported from `@supabase/auth-js`), not a hand-rolled sentinel — the
// exact discipline the ratified AS-1..AS-4 taxonomy specifies
// (`discriminator_available_today: error.name is ...`). The decisive control
// is AS-2 vs AS-3: two inputs that both arrive as a returned error with no
// user must produce DIFFERENT derived states — the conflation this
// discriminator exists to close.
//
// `@/lib/auth/identity.ts` cannot itself be mocked here (it is the module
// under test), so this file's ONLY external-egress exposure is through
// `@/lib/supabase/server`'s `createClient`, which IS mocked (the same layer
// `tests/health-auth-route.test.ts` already mocks) — never a real
// Supabase Auth host, and the network guard (M11 TA-19) is the backstop if
// that mock is ever missed.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js'

const getUser = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser },
  }),
}))

import {
  classifyUpstreamAuthError,
  getVerifiedAuthIdentityResult,
} from '@/lib/auth/identity'

describe('classifyUpstreamAuthError — pure, direct, against real SDK shapes', () => {
  it('AS-1 AuthSessionMissingError -> REACHABLE', () => {
    expect(classifyUpstreamAuthError(new AuthSessionMissingError())).toBe('REACHABLE')
  })

  it('AS-2 AuthApiError -> REACHABLE', () => {
    expect(classifyUpstreamAuthError(new AuthApiError('invalid session', 401, 'session_expired'))).toBe(
      'REACHABLE'
    )
  })

  it('AS-3 AuthRetryableFetchError (transport, status 0) -> UNREACHABLE', () => {
    expect(classifyUpstreamAuthError(new AuthRetryableFetchError('fetch failed', 0))).toBe('UNREACHABLE')
  })

  it('AS-3 AuthRetryableFetchError (provider 5xx) -> UNREACHABLE', () => {
    expect(classifyUpstreamAuthError(new AuthRetryableFetchError('server error', 503))).toBe('UNREACHABLE')
  })

  it('MUST FAIL if AS-2 and AS-3 are ever conflated: two inputs that both arrive as a returned error with no user produce DIFFERENT states', () => {
    const rejected = classifyUpstreamAuthError(new AuthApiError('invalid session', 401, 'session_expired'))
    const unreachable = classifyUpstreamAuthError(new AuthRetryableFetchError('fetch failed', 0))
    expect(rejected).not.toBe(unreachable)
    expect(rejected).toBe('REACHABLE')
    expect(unreachable).toBe('UNREACHABLE')
  })

  it('AuthUnknownError (no affirmative evidence either way) -> UNKNOWN, never UNREACHABLE', () => {
    expect(classifyUpstreamAuthError(new AuthUnknownError('unparseable body', new SyntaxError('bad json')))).toBe(
      'UNKNOWN'
    )
  })

  it('an unrecognised error shape -> UNKNOWN, not guessed as UNREACHABLE', () => {
    expect(classifyUpstreamAuthError(new Error('some other failure'))).toBe('UNKNOWN')
    expect(classifyUpstreamAuthError({ name: 'SomethingElse' })).toBe('UNKNOWN')
    expect(classifyUpstreamAuthError(null)).toBe('UNKNOWN')
    expect(classifyUpstreamAuthError(undefined)).toBe('UNKNOWN')
    expect(classifyUpstreamAuthError('a string, not an error object')).toBe('UNKNOWN')
  })

  it('never echoes the message, token, cookie or subject — only the classification is observable', () => {
    const err = new AuthApiError('contains a secret session token XYZ', 401, 'session_expired')
    const result = classifyUpstreamAuthError(err)
    expect(result).toBe('REACHABLE')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('XYZ')
  })
})

describe('getVerifiedAuthIdentityResult — upstreamObservation wiring, no regression to existing failure/identity fields', () => {
  beforeEach(() => {
    getUser.mockReset()
  })

  it('NO_SESSION: zero outbound evidence, upstreamObservation is null', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    const result = await getVerifiedAuthIdentityResult()
    expect(result.identity).toBeNull()
    expect(result.failure).toBe('NO_SESSION')
    expect(result.upstreamObservation).toBeNull()
  })

  it('SESSION_REJECTED with AuthApiError (AS-2): failure unchanged, upstreamObservation REACHABLE', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('invalid session', 401, 'session_expired'),
    })
    const result = await getVerifiedAuthIdentityResult()
    expect(result.identity).toBeNull()
    expect(result.failure).toBe('SESSION_REJECTED')
    expect(result.upstreamObservation).toBe('REACHABLE')
  })

  it('SESSION_REJECTED with AuthRetryableFetchError (AS-3): failure UNCHANGED (M11 TA-02 non-regression), upstreamObservation UNREACHABLE', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('fetch failed', 0),
    })
    const result = await getVerifiedAuthIdentityResult()
    // TA-02: EP-2/EP-3 read `failure` only, and must keep answering 401 for
    // this state exactly as before — this discriminator adds information, it
    // does not re-route the existing branch.
    expect(result.failure).toBe('SESSION_REJECTED')
    expect(result.upstreamObservation).toBe('UNREACHABLE')
  })

  it('AUTH_UNAVAILABLE (createClient throws): upstreamObservation is null, not guessed', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockRejectedValueOnce(new Error('coherence failure'))
    const result = await getVerifiedAuthIdentityResult()
    expect(result.failure).toBe('AUTH_UNAVAILABLE')
    expect(result.upstreamObservation).toBeNull()
  })

  it('MALFORMED_SUBJECT: upstreamObservation is null at the identity.ts layer (the route classifies it as REACHABLE itself)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'not-a-uuid' } }, error: null })
    const result = await getVerifiedAuthIdentityResult()
    expect(result.failure).toBe('MALFORMED_SUBJECT')
    expect(result.upstreamObservation).toBeNull()
  })

  it('verified identity: upstreamObservation is null, identity/failure unchanged', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: '11111111-1111-4111-8111-111111111111', email_confirmed_at: '2026-01-01T00:00:00Z' } },
      error: null,
    })
    const result = await getVerifiedAuthIdentityResult()
    expect(result.identity).toEqual({ userId: '11111111-1111-4111-8111-111111111111', emailVerified: true })
    expect(result.failure).toBeNull()
    expect(result.upstreamObservation).toBeNull()
  })
})
