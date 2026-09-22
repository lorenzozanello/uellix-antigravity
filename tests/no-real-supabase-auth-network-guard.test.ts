// tests/no-real-supabase-auth-network-guard.test.ts
//
// M11 TA-19 — THE SUPABASE AUTH HOST EXTENSION OF THE NETWORK GUARD, PROVEN
// DIRECTLY. Mirrors `tests/no-real-gemini-network-guard.test.ts`'s own
// structure and rigor for the sibling guard added in
// `vitest.setup.network-guard.ts` — see that file's own M11 TA-19 header
// block for why a suffix match (not an exact `Set`) is the right mechanism
// here, and why it deliberately reads no environment variable.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCKED_SUPABASE_AUTH_HOST_SUFFIXES,
  TestRealSupabaseAuthNetworkBlockedError,
  guardedFetch,
} from '../vitest.setup.network-guard'

const ROOT = process.cwd()
const SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co/auth/v1/health'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the guard blocks any Supabase project host', () => {
  it('the INSTALLED global fetch refuses a *.supabase.co host', () => {
    expect(() => globalThis.fetch(SUPABASE_URL)).toThrow(TestRealSupabaseAuthNetworkBlockedError)
    expect(() => globalThis.fetch(SUPABASE_URL)).toThrow(/TEST_REAL_SUPABASE_AUTH_NETWORK_BLOCKED/)
  })

  it('NEVER delegates to the underlying transport', () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded(SUPABASE_URL)).toThrow(TestRealSupabaseAuthNetworkBlockedError)
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks a Request object and a URL object, not just a string', () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded(new URL(SUPABASE_URL))).toThrow(TestRealSupabaseAuthNetworkBlockedError)
    expect(() => guarded(new Request(SUPABASE_URL, { method: 'GET' }))).toThrow(
      TestRealSupabaseAuthNetworkBlockedError
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks ANY project ref under the suffix — a per-project host, not a fixed one', () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    for (const ref of ['zzyyxxwwvvuuttss', 'a', 'my-staging-ref-123']) {
      const host = `${ref}.supabase.co`
      expect(() => guarded(`https://${host}/auth/v1/health`), host).toThrow(
        TestRealSupabaseAuthNetworkBlockedError
      )
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('BLOCKED_SUPABASE_AUTH_HOST_SUFFIXES contains the domain suffix', () => {
    expect(BLOCKED_SUPABASE_AUTH_HOST_SUFFIXES).toContain('.supabase.co')
  })
})

describe('the guard is scoped, not a blanket ban on networking', () => {
  it('delegates a localhost URL to the real transport (never matches the suffix)', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'))
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    await guarded('http://127.0.0.1:54321/auth/v1/health', { method: 'GET' })

    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('delegates an unrelated host', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'))
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    await guarded('https://api.example.com/v1/thing')

    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not block a host that merely CONTAINS "supabase.co" without being a suffix', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'))
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    await guarded('https://supabase.co.evil-lookalike.example.com/x')

    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('the refusal leaks nothing', () => {
  it('names the host and the method, and NOTHING from the request', () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)
    const url = `${SUPABASE_URL}?apikey=SECRET-ANON-KEY-CANARY`

    let thrown: unknown
    try {
      guarded(url, { method: 'GET', headers: { apikey: 'SECRET-ANON-KEY-CANARY' } })
    } catch (error) {
      thrown = error
    }

    const serialized = `${(thrown as Error).name} ${(thrown as Error).message} ${(thrown as Error).stack ?? ''}`
    expect(serialized).toContain('TEST_REAL_SUPABASE_AUTH_NETWORK_BLOCKED')
    expect(serialized).toContain('.supabase.co')
    expect(serialized).toContain('GET')
    expect(serialized).not.toContain('SECRET-ANON-KEY-CANARY')
    expect(serialized).not.toContain('apikey=')
  })
})

describe('no environment-variable opt-out, and no env read at all (M11 TA-19 deliberate simplification)', () => {
  it('still blocks with NEXT_PUBLIC_SUPABASE_URL pointed at a DIFFERENT project than the blocked one', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://some-other-project-ref.supabase.co')
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded(SUPABASE_URL)).toThrow(TestRealSupabaseAuthNetworkBlockedError)
    expect(transport).not.toHaveBeenCalled()
  })

  it('the guard file reads no environment variable — preserved from the original Gemini guard property', () => {
    const source = readFileSync(path.join(ROOT, 'vitest.setup.network-guard.ts'), 'utf8')
    expect(source).not.toMatch(/process\.env/)
  })

  it('has no ALLOW/SKIP escape hatch for the Supabase guard either', () => {
    const source = readFileSync(path.join(ROOT, 'vitest.setup.network-guard.ts'), 'utf8')
    expect(source).not.toMatch(/ALLOW_REAL_SUPABASE/i)
    expect(source).not.toMatch(/SKIP_SUPABASE/i)
  })
})

describe('HZ-01-shaped regression: concurrent attempts are both blocked', () => {
  it('two simultaneous attempts to a Supabase host are both refused', async () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    const results = await Promise.allSettled([
      (async () => guarded(SUPABASE_URL))(),
      (async () => guarded(SUPABASE_URL))(),
    ])

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(TestRealSupabaseAuthNetworkBlockedError)
    }
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('the Gemini guard and the Supabase guard coexist without interference', () => {
  it('a Gemini host is still refused by the ORIGINAL error type, not the Supabase one', async () => {
    const { TestRealGeminiNetworkBlockedError } = await import('../vitest.setup.network-guard')
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded('https://generativelanguage.googleapis.com/v1/x')).toThrow(
      TestRealGeminiNetworkBlockedError
    )
  })
})
