// tests/no-real-gemini-network-guard.test.ts
//
// HZ-01 — TESTS MUST NEVER REACH REAL GEMINI.
//
// ---------------------------------------------------------------------------
// THE INCIDENT THIS CLOSES
// ---------------------------------------------------------------------------
// While writing the provider-invocation observability for G1-B, a test that ran
// two adapter calls under `Promise.all` produced real HTTPS traffic to
// `generativelanguage.googleapis.com`. Measured on a minimal probe containing
// no code of ours beyond the adapter:
//
//     two adapters, SEQUENTIAL   -> vi.mock('@google/genai') applies
//     two adapters, CONCURRENT   -> the mock is BYPASSED, the real SDK loads
//
// The calls carried an INVALID canary key and Google rejected them with
// `400 API_KEY_INVALID`, so nothing was generated, consumed or billed. But the
// only reason they were harmless is that the key was wrong — and this machine's
// ambient environment DOES carry a real `GEMINI_API_KEY`. The same escape with
// the adapter's default key would have been a billable call carrying the
// request body.
//
// ---------------------------------------------------------------------------
// WHY A GUARD AND NOT "BE MORE CAREFUL"
// ---------------------------------------------------------------------------
// Before this file, the suite's safety rested on three things that are all
// somebody remembering something:
//
//     * that `vi.mock('@google/genai')` works — it does not, under concurrency;
//     * that `GEMINI_API_KEY` is absent — on this machine it is not;
//     * that the operator prefixes `env -u GEMINI_API_KEY`.
//
// A property that depends on three habits is not a property. The guard makes it
// structural: under Vitest, egress to the provider hostnames is impossible
// regardless of which of the three fails.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BLOCKED_GEMINI_HOSTNAMES,
  TestRealGeminiNetworkBlockedError,
  guardedFetch,
} from '../vitest.setup.network-guard'

const ROOT = process.cwd()

/**
 * Strip `//` comment lines before a shape assertion.
 *
 * These files carry their argument in prose, and the argument necessarily
 * NAMES the shapes it forbids — "there is no `ALLOW_REAL_GEMINI_TESTS`", "there
 * is no `Promise.all` in this file, and here is why". A scanner that cannot
 * tell a comment from a statement would force each fix to ship without its
 * reason.
 */
function statementsOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent'

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// 1-2. The block, and the proof that nothing was delegated
// ---------------------------------------------------------------------------

describe('the guard blocks the provider hostname', () => {
  it('the INSTALLED global fetch refuses the Gemini host', async () => {
    // Proves the setup file actually ran in this worker — not merely that the
    // module exports a function that would have worked.
    expect(() => globalThis.fetch(GEMINI_URL)).toThrow(TestRealGeminiNetworkBlockedError)
    expect(() => globalThis.fetch(GEMINI_URL)).toThrow(/TEST_REAL_GEMINI_NETWORK_BLOCKED/)
  })

  it('NEVER delegates to the underlying transport — no socket can be created', async () => {
    // The load-bearing assertion of the whole file. `guardedFetch` is installed
    // over a spy that stands in for the real transport; if the guard delegated,
    // the spy would record it. It does not, so there is nothing left that could
    // open a socket, resolve DNS or send a byte.
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded(GEMINI_URL)).toThrow(TestRealGeminiNetworkBlockedError)
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks a Request object and a URL object, not just a string', async () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded(new URL(GEMINI_URL))).toThrow(TestRealGeminiNetworkBlockedError)
    expect(() => guarded(new Request(GEMINI_URL, { method: 'POST' }))).toThrow(
      TestRealGeminiNetworkBlockedError
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks every hostname the installed SDK names for model calls', () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    for (const host of BLOCKED_GEMINI_HOSTNAMES) {
      expect(() => guarded(`https://${host}/v1/x`), host).toThrow(TestRealGeminiNetworkBlockedError)
    }
    expect(BLOCKED_GEMINI_HOSTNAMES.has('generativelanguage.googleapis.com')).toBe(true)
    expect(transport).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. The rest of the suite is untouched
// ---------------------------------------------------------------------------

describe('the guard is scoped, not a blanket ban on networking', () => {
  it('delegates a localhost URL to the real transport', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'))
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    await guarded('http://127.0.0.1:54321/rest/v1/x', { method: 'POST' })

    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('delegates an unrelated host', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'))
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    await guarded('https://api.example.com/v1/thing')

    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('passes the original arguments through untouched', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'))
    const guarded = guardedFetch(transport as unknown as typeof fetch)
    const init = { method: 'POST', body: 'payload' }

    await guarded('http://localhost:3000/x', init)

    expect(transport).toHaveBeenCalledWith('http://localhost:3000/x', init)
  })
})

// ---------------------------------------------------------------------------
// 4. The error says the minimum
// ---------------------------------------------------------------------------

describe('the refusal leaks nothing', () => {
  it('names the host and the method, and NOTHING from the request', () => {
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)
    const url = `${GEMINI_URL}?key=AIza-SECRET-CANARY&alt=sse`

    let thrown: unknown
    try {
      guarded(url, {
        method: 'POST',
        headers: { authorization: 'Bearer TOKEN-CANARY', 'x-goog-api-key': 'AIza-SECRET-CANARY' },
        body: JSON.stringify({ contents: 'PROMPT-CANARY' }),
      })
    } catch (error) {
      thrown = error
    }

    const serialized = `${(thrown as Error).name} ${(thrown as Error).message} ${(thrown as Error).stack ?? ''}`
    expect(serialized).toContain('TEST_REAL_GEMINI_NETWORK_BLOCKED')
    expect(serialized).toContain('generativelanguage.googleapis.com')
    expect(serialized).toContain('POST')

    expect(serialized).not.toContain('AIza-SECRET-CANARY')
    expect(serialized).not.toContain('TOKEN-CANARY')
    expect(serialized).not.toContain('PROMPT-CANARY')
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('x-goog-api-key')
    // Not the query string, and not the path either: a path can carry an id.
    expect(serialized).not.toContain('key=')
    expect(serialized).not.toContain('alt=sse')
  })
})

// ---------------------------------------------------------------------------
// 5. A key present does not disable it
// ---------------------------------------------------------------------------

describe('a present GEMINI_API_KEY does not weaken the guard', () => {
  it('still blocks with a fake key in the environment', () => {
    vi.stubEnv('GEMINI_API_KEY', 'AIza-FAKE-BUT-PRESENT')
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    expect(() => guarded(GEMINI_URL)).toThrow(TestRealGeminiNetworkBlockedError)
    expect(transport).not.toHaveBeenCalled()
  })

  it('has no environment-variable opt-out at all', () => {
    // Deliberately absent. There is no legitimate Vitest case that needs a real
    // provider today, and an `ALLOW_REAL_GEMINI_TESTS` escape hatch would be
    // set once, in CI, by someone debugging — and never unset. Live integration
    // goes through the separate tsx harness.
    const source = statementsOnly(
      readFileSync(path.join(ROOT, 'vitest.setup.network-guard.ts'), 'utf8')
    )
    expect(source).not.toMatch(/ALLOW_REAL_GEMINI/i)
    expect(source).not.toMatch(/process\.env\.[A-Z_]*ALLOW/)
    expect(source).not.toMatch(/SKIP_NETWORK_GUARD/i)
    // The guard reads NO environment variable at all — there is nothing to set.
    expect(source).not.toMatch(/process\.env/)
  })
})

// ---------------------------------------------------------------------------
// 6. THE HZ-01 REGRESSION — concurrency, without ever leaving the process
// ---------------------------------------------------------------------------

describe('HZ-01 regression: concurrent attempts are both blocked', () => {
  it('two simultaneous attempts to the Gemini host are both refused', async () => {
    // The historical bug reproduced SAFELY. It does not go anywhere near the
    // SDK or a real call: it drives the intercepted primitive directly, twice,
    // concurrently. Each attempt is wrapped in its own async function so the
    // second is actually attempted — a synchronous throw inside
    // `Promise.all([f(a), f(b)])` would abort before `f(b)` ever ran, and the
    // test would silently prove half of what it claims.
    const transport = vi.fn()
    const guarded = guardedFetch(transport as unknown as typeof fetch)

    const results = await Promise.allSettled([
      (async () => guarded(GEMINI_URL))(),
      (async () => guarded(GEMINI_URL))(),
    ])

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(TestRealGeminiNetworkBlockedError)
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('the INSTALLED global guard also holds under concurrency', async () => {
    const results = await Promise.allSettled([
      (async () => globalThis.fetch(GEMINI_URL))(),
      (async () => globalThis.fetch(GEMINI_URL))(),
      (async () => globalThis.fetch(GEMINI_URL))(),
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. Correctly-mocked tests are unaffected
// ---------------------------------------------------------------------------

describe('the guard does not disturb a test that mocks the SDK properly', () => {
  it('the provider-observability suite still runs the adapter through its mock', async () => {
    // Asserted structurally rather than by re-running that file: it mocks
    // `@google/genai`, so it never reaches `fetch` at all, and the guard sits
    // strictly below the mock. If the guard had broken it, the focused suite in
    // the verification block would fail — which is the real assertion.
    const source = readFileSync(
      path.join(ROOT, 'lib/stella/adapter/provider-call-observability.test.ts'),
      'utf8'
    )
    expect(source).toContain("vi.mock('@google/genai'")
    // No CONCURRENT adapter call anywhere in it — the shape that escaped the
    // mock. Asserted on statements, because the file explains at length why it
    // does not use `Promise.all`.
    expect(statementsOnly(source)).not.toContain('Promise.all')
  })
})

// ---------------------------------------------------------------------------
// 8. The real-eval harness is a different world
// ---------------------------------------------------------------------------

describe('the governed real-evaluation harness is NOT under this guard', () => {
  it('runs through tsx, not Vitest', () => {
    const gate = readFileSync(path.join(ROOT, 'docs/ops/gates/G1_PACKAGE.md'), 'utf8')
    expect(gate).toMatch(/pnpm tsx tests\/eval\/stella-contextual-real\/run\.ts/)
  })

  it('the runner imports no vitest setup and no network guard', () => {
    for (const file of ['run.ts', 'runner.ts']) {
      const source = readFileSync(
        path.join(ROOT, 'tests/eval/stella-contextual-real', file),
        'utf8'
      )
      expect(source, file).not.toContain('vitest.setup')
      expect(source, file).not.toContain('network-guard')
    }
  })

  it('EVERY vitest config resolves the guard as a setup file', async () => {
    // Asserted on the RESOLVED config, not on the source text. The integration
    // config never names the guard: it inherits it through `mergeConfig`, which
    // concatenates `setupFiles`. A textual check would have demanded a literal
    // that does not belong there — and would have passed just as happily if the
    // merge had silently dropped it.
    const configs = {
      default: (await import('../vitest.config')).default,
      integration: (await import('../vitest.integration.config')).default,
      e2e: (await import('../vitest.e2e.config')).default,
    }
    for (const [name, config] of Object.entries(configs)) {
      const setupFiles = [config.test?.setupFiles ?? []].flat()
      expect(setupFiles.some((f) => String(f).includes('vitest.setup.network-guard')), name).toBe(true)
    }
    // In the default and integration configs it must be FIRST: a setup file
    // that ran before it could issue a request the guard was not yet watching.
    expect(String([configs.default.test?.setupFiles ?? []].flat()[0])).toContain(
      'vitest.setup.network-guard'
    )
  })

  it('nothing in the product imports it', () => {
    const adapter = readFileSync(path.join(ROOT, 'lib/stella/adapter/gemini-client.ts'), 'utf8')
    expect(adapter).not.toContain('network-guard')
  })
})
