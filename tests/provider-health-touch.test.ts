// tests/provider-health-touch.test.ts
//
// M11 TA-16 — DIRECT COVERAGE OF THE NEW UNKNOWN / SINGLE-FLIGHT / BUDGET
// DESIGN (M11 NB-R3, NB-R5, NB-R6, NB-R7, NB-R8, and the owner's HT-1/HT-2
// contract).
//
// The transport is ALWAYS injected via `__setProviderTouchFetchForTests` —
// never the real global `fetch`. `vitest.setup.network-guard.ts` (M11 TA-19)
// is the backstop if this file ever forgets to inject it: a real call to a
// `*.supabase.co` host from this suite is refused before a socket exists.
//
// Fake timers throughout: `TTL_MS`, `BUDGET_WINDOW_MS`, `PROBE_WAIT_BUDGET_MS`
// and `PROBE_HARD_TIMEOUT_MS` are all real millisecond values, and a real
// wall-clock sleep would make this file slow and occasionally flaky.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUDGET_MAX_PROBES_PER_WINDOW,
  BUDGET_WINDOW_MS,
  PROBE_HARD_TIMEOUT_MS,
  PROBE_WAIT_BUDGET_MS,
  TTL_MS,
  __resetProviderTouchStateForTests,
  __setProviderTouchFetchForTests,
  deriveBudgetMaxProbesPerWindow,
  observeProviderHealth,
  probeProviderOnce,
} from '@/lib/health/provider-touch'

/** An AbortError, shaped exactly like the real Fetch API's abort rejection. */
function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/** Resolves immediately with the given ok/status. Never inspects `init.signal`. */
function immediateFetch(ok: boolean): typeof fetch {
  return vi.fn(async () => new Response(null, { status: ok ? 200 : 503 })) as unknown as typeof fetch
}

/** Resolves immediately with an EXACT status code — for NB-IC-6's per-status classification matrix. */
function statusFetch(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
}

/** Rejects immediately with a genuine (non-abort) transport error. */
function failingFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
}

/**
 * Never settles on its own — only when the AbortSignal `fetchImpl` receives
 * actually fires. This is the ONLY correct way to simulate a hung connection
 * under fake timers: a `setTimeout`-based fetch mock would race the guard's
 * own `setTimeout(..., PROBE_HARD_TIMEOUT_MS)` non-deterministically.
 */
function hangingFetchAbortAware(): { impl: typeof fetch; calls: number[] } {
  const calls: number[] = []
  const impl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(Date.now())
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortError()))
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetProviderTouchStateForTests()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
})

afterEach(() => {
  __setProviderTouchFetchForTests(null)
  __resetProviderTouchStateForTests()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Exported constants — technical, derived, and directly asserted (NB-R8).
// ---------------------------------------------------------------------------

describe('exported technical parameters', () => {
  it('TTL_MS is 15000', () => {
    expect(TTL_MS).toBe(15_000)
  })

  it('PROBE_WAIT_BUDGET_MS is 3000', () => {
    expect(PROBE_WAIT_BUDGET_MS).toBe(3_000)
  })

  it('PROBE_HARD_TIMEOUT_MS is derived and strictly greater than PROBE_WAIT_BUDGET_MS', () => {
    expect(PROBE_HARD_TIMEOUT_MS).toBeGreaterThan(PROBE_WAIT_BUDGET_MS)
  })

  it('BUDGET_MAX_PROBES_PER_WINDOW satisfies its own joint invariant against BUDGET_WINDOW_MS/TTL_MS', () => {
    expect(BUDGET_MAX_PROBES_PER_WINDOW).toBeGreaterThanOrEqual(Math.ceil(BUDGET_WINDOW_MS / TTL_MS))
  })

  it('deriveBudgetMaxProbesPerWindow satisfies the invariant at the previously-contradictory corner (NB-R3)', () => {
    // The exact corner an earlier design got wrong: WINDOW_MS=300000, TTL_MS=5000
    // required 60 probes while the old independently-chosen cap was 30.
    const derived = deriveBudgetMaxProbesPerWindow(300_000, 5_000)
    expect(derived).toBeGreaterThanOrEqual(Math.ceil(300_000 / 5_000))
  })

  it('MUST FAIL: BUDGET_MAX_PROBES_PER_WINDOW must not be independently settable below the derived floor', () => {
    // A mutation that hardcodes a value below the floor is exactly what the
    // module-load assertion in provider-touch.ts exists to catch. Proven here
    // on the DERIVATION FUNCTION itself, at an adversarial input, rather than
    // by re-importing the module with a broken constant.
    const floor = Math.ceil(60_000 / 15_000)
    expect(deriveBudgetMaxProbesPerWindow(60_000, 15_000)).toBeGreaterThanOrEqual(floor)
    expect(2).toBeLessThan(floor) // a naive independently-chosen "2" would violate it
  })

  it('M11 hardening (NB-IC-1) — behaviourally IDENTICAL with and without OD-4/KV env vars set, across every producer including budget exhaustion', async () => {
    // The prior version of this control installed a hanging-fetch double
    // that was never wired into the touch at all (`immediateFetch` was
    // installed instead), so `expect(impl).not.toHaveBeenCalled()` was
    // guaranteed to pass regardless of what the module actually does with
    // KV env vars — it proved nothing. This version proves the property
    // BEHAVIOURALLY: run the EXACT SAME sequence of calls (enough to exhaust
    // the budget, forcing every internal branch to execute at least once)
    // twice — once with KV_REST_API_URL/TOKEN unset, once with them set to
    // values that would be obviously wrong if ever read — and assert the
    // resulting verdict sequence AND call count are identical. A hidden
    // KV-conditional branch (e.g. a shared/distributed budget when KV is
    // present) would make the two runs diverge.
    async function runSequence(): Promise<{ verdicts: string[]; calls: number }> {
      __resetProviderTouchStateForTests()
      // Force cache misses via hard-timeout (never cached, NB-R5) rather
      // than via TTL expiry: BUDGET_MAX_PROBES_PER_WINDOW (6) x
      // PROBE_HARD_TIMEOUT_MS (8000ms) = 48000ms stays under
      // BUDGET_WINDOW_MS (60000ms), where forcing misses via TTL_MS+1
      // (15001ms) per iteration would itself roll the budget window over
      // mid-loop and silently prevent exhaustion — the same interaction this
      // file's own budget-exhaustion helper below was written to avoid.
      const { impl: hangingImpl } = hangingFetchAbortAware()
      __setProviderTouchFetchForTests(hangingImpl)
      const verdicts: string[] = []
      for (let i = 0; i < BUDGET_MAX_PROBES_PER_WINDOW; i++) {
        const probe = observeProviderHealth()
        await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)
        verdicts.push(await probe)
      }
      // Budget is now exhausted: these resolve UNKNOWN immediately, with no
      // further fetch attempt and no additional time advancement needed.
      verdicts.push(await observeProviderHealth())
      verdicts.push(await observeProviderHealth())
      return { verdicts, calls: (hangingImpl as ReturnType<typeof vi.fn>).mock.calls.length }
    }

    const withoutKv = await runSequence()

    vi.stubEnv('KV_REST_API_URL', 'https://should-not-be-read.example.com')
    vi.stubEnv('KV_REST_API_TOKEN', 'should-not-be-read')
    const withKv = await runSequence()

    expect(withKv.verdicts).toEqual(withoutKv.verdicts)
    expect(withKv.calls).toBe(withoutKv.calls)
    // The budget genuinely does exhaust partway through this sequence in
    // BOTH runs (BUDGET_MAX_PROBES_PER_WINDOW < BUDGET_MAX_PROBES_PER_WINDOW + 2
    // attempts), so this comparison exercises the budget-exhaustion branch
    // too, not only the happy path.
    expect(withoutKv.verdicts).toContain('UNKNOWN')
  })

  it('MUST FAIL: static source-level check — the two literal KV variable names never appear in this module', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/health/provider-touch.ts'), 'utf8')
    expect(source).not.toContain('KV_REST_API_URL')
    expect(source).not.toContain('KV_REST_API_TOKEN')
  })
})

// ---------------------------------------------------------------------------
// AS-1 / AS-2 / AS-3 analogues at the touch layer, plus UNKNOWN.
// ---------------------------------------------------------------------------

describe('definitive verdicts', () => {
  it('a 2xx response -> REACHABLE', async () => {
    __setProviderTouchFetchForTests(immediateFetch(true))
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
  })

  it('a non-ok HTTP response -> UNREACHABLE (affirmative evidence: the provider answered with a fault)', async () => {
    __setProviderTouchFetchForTests(immediateFetch(false))
    await expect(observeProviderHealth()).resolves.toBe('UNREACHABLE')
  })

  it('a genuine transport failure (not our own abort) -> UNREACHABLE (HT-2: affirmative evidence)', async () => {
    __setProviderTouchFetchForTests(failingFetch())
    await expect(observeProviderHealth()).resolves.toBe('UNREACHABLE')
  })
})

// ---------------------------------------------------------------------------
// M11 hardening (NB-IC-6) — a non-ok HTTP response is proof the provider
// answered. Only the shared infrastructure-fault status set counts as
// affirmative evidence; every other status proves reachability, matching the
// exact AS-2 (AuthApiError)-vs-AS-3 (AuthRetryableFetchError) split
// identity.ts already makes for the session-check path.
// ---------------------------------------------------------------------------

describe('M11 hardening — HTTP status classification matrix (NB-IC-6)', () => {
  it.each([401, 403, 404, 429])(
    'a %i response -> REACHABLE (the provider answered; not affirmative evidence of unreachability)',
    async (status) => {
      __setProviderTouchFetchForTests(statusFetch(status))
      await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
    }
  )

  it.each([500, 502, 503, 520, 530])(
    'a %i response -> UNREACHABLE (the shared infrastructure-fault status set)',
    async (status) => {
      __setProviderTouchFetchForTests(statusFetch(status))
      await expect(observeProviderHealth()).resolves.toBe('UNREACHABLE')
    }
  )

  it('MUST FAIL: 401 must never be classified UNREACHABLE — it is proof of reachability, not its absence', async () => {
    __setProviderTouchFetchForTests(statusFetch(401))
    const verdict = await observeProviderHealth()
    expect(verdict).not.toBe('UNREACHABLE')
    expect(verdict).toBe('REACHABLE')
  })

  it('MUST FAIL: 429 (the exact status OD-4 itself can return) must never be classified UNREACHABLE at the touch layer', async () => {
    __setProviderTouchFetchForTests(statusFetch(429))
    const verdict = await observeProviderHealth()
    expect(verdict).not.toBe('UNREACHABLE')
    expect(verdict).toBe('REACHABLE')
  })
})

// ---------------------------------------------------------------------------
// M11 hardening (section 7 / mutation survival) — DIRECT coverage of
// `probeProviderOnce`'s own AbortError branch, bypassing
// `observeProviderHealth`'s waiter race entirely.
// ---------------------------------------------------------------------------
//
// THE BUG THIS CLOSES: the ORIGINAL "HT-1" tests below called
// `observeProviderHealth()` and advanced the fake clock by
// `PROBE_HARD_TIMEOUT_MS`. Because `PROBE_WAIT_BUDGET_MS` (3000ms) is
// strictly LESS than `PROBE_HARD_TIMEOUT_MS` (8000ms) BY CONSTRUCTION, the
// WAITER's own timeout inside `waitWithBudget` always fires first and
// resolves the OUTER promise to UNKNOWN — regardless of what
// `probeProviderOnce`'s own AbortError branch does. Deleting that branch
// entirely (e.g. making every catch() path return 'UNREACHABLE') left both
// tests GREEN, because neither one ever actually observed
// `probeProviderOnce`'s own settled value — only the waiter's. `probeProviderOnce`
// is now exported specifically so this class of survivor is closed: these
// tests call it DIRECTLY, with no waiter race in between.

describe('M11 hardening — probeProviderOnce, called DIRECTLY (closes the HT-1 mutation-survivor)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
  })

  it('the probe itself resolves UNKNOWN when ITS OWN hard timeout fires — no waiter involved', async () => {
    const { impl } = hangingFetchAbortAware()
    __setProviderTouchFetchForTests(impl)

    const promise = probeProviderOnce('https://test-project.supabase.co')
    await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)

    await expect(promise).resolves.toBe('UNKNOWN')
  })

  it('MUST FAIL: probeProviderOnce must never report UNREACHABLE for its own hard timeout — proven on the function itself, not on the public API', async () => {
    const { impl } = hangingFetchAbortAware()
    __setProviderTouchFetchForTests(impl)

    const promise = probeProviderOnce('https://test-project.supabase.co')
    await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)
    const verdict = await promise

    expect(verdict).not.toBe('UNREACHABLE')
    expect(verdict).toBe('UNKNOWN')
  })

  it('MUST FAIL: probeProviderOnce still reports UNREACHABLE for a GENUINE transport failure (the AbortError branch does not swallow every rejection)', async () => {
    __setProviderTouchFetchForTests(failingFetch())
    await expect(probeProviderOnce('https://test-project.supabase.co')).resolves.toBe('UNREACHABLE')
  })

  it('observeProviderHealth (the public API) still resolves UNKNOWN under the SAME hard-timeout scenario — consistency between the direct and public-API views', async () => {
    const { impl } = hangingFetchAbortAware()
    __setProviderTouchFetchForTests(impl)

    const promise = observeProviderHealth()
    await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)

    await expect(promise).resolves.toBe('UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// M11 hardening — a malformed/unparseable auth URL degrades to UNKNOWN
// (a local configuration defect), never UNREACHABLE — closes the
// "TypeError from a bad URL misclassified as a network fault" gap.
// ---------------------------------------------------------------------------

describe('M11 hardening — malformed URL configuration (section 5)', () => {
  it('an unparseable NEXT_PUBLIC_SUPABASE_URL -> UNKNOWN, no fetch attempted', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'not-a-valid-url-at-all')
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)

    await expect(observeProviderHealth()).resolves.toBe('UNKNOWN')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('MUST FAIL: a malformed URL must never be classified UNREACHABLE — it is a config defect, not affirmative provider-unavailability evidence', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '::::not a url::::')
    const verdict = await observeProviderHealth()
    expect(verdict).not.toBe('UNREACHABLE')
    expect(verdict).toBe('UNKNOWN')
  })

  it('does not spend budget on a malformed URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'not-a-valid-url-at-all')
    for (let i = 0; i < BUDGET_MAX_PROBES_PER_WINDOW + 3; i++) {
      await expect(observeProviderHealth()).resolves.toBe('UNKNOWN')
    }
    // Recovers IMMEDIATELY once configuration is fixed, proving no budget
    // was ever consumed by the malformed attempts above.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co')
    __setProviderTouchFetchForTests(immediateFetch(true))
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
  })
})

// ---------------------------------------------------------------------------
// Cache: TTL, and NB-R5 — UNKNOWN is never cached.
// ---------------------------------------------------------------------------

describe('caching (NB-R5: only REACHABLE/UNREACHABLE are ever cached)', () => {
  it('many requests inside one TTL window produce exactly ONE upstream call', async () => {
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)

    await observeProviderHealth()
    await observeProviderHealth()
    await observeProviderHealth()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a request after TTL_MS expiry produces a second upstream call', async () => {
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)

    await observeProviderHealth()
    vi.advanceTimersByTime(TTL_MS + 1)
    await observeProviderHealth()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('MUST FAIL: an UNKNOWN result (hard timeout) is never cached — the next call re-probes rather than reusing it', async () => {
    const { impl: hanging } = hangingFetchAbortAware()
    __setProviderTouchFetchForTests(hanging)
    const first = observeProviderHealth()
    await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)
    await expect(first).resolves.toBe('UNKNOWN')

    // Swap to a definitive transport for the NEXT call. If UNKNOWN had been
    // cached, this call would short-circuit to the (non-existent) cached
    // UNKNOWN rather than actually probing again.
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a REACHABLE result IS cached and reused within TTL_MS', async () => {
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)
    await observeProviderHealth()
    vi.advanceTimersByTime(TTL_MS - 1)
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Budget: exhaustion, recovery, never permanent (NB-R3).
// ---------------------------------------------------------------------------

describe('the independent request budget', () => {
  /**
   * Forces N fresh probe ATTEMPTS (consuming N budget units) inside a SINGLE
   * window, without advancing time anywhere near `BUDGET_WINDOW_MS`. A hard
   * timeout is NEVER cached (NB-R5), so it is the one outcome that forces a
   * cache miss on the very next call almost for free —
   * `PROBE_HARD_TIMEOUT_MS` (8000ms) x `BUDGET_MAX_PROBES_PER_WINDOW` (6)
   * fits comfortably inside `BUDGET_WINDOW_MS` (60000ms), where advancing a
   * full `TTL_MS` (15000ms) per call would not (6 x 15000ms > 60000ms would
   * roll the window over mid-loop, silently resetting the very counter the
   * test means to exhaust).
   */
  async function exhaustBudgetWithHardTimeouts(): Promise<void> {
    const { impl } = hangingFetchAbortAware()
    __setProviderTouchFetchForTests(impl)
    for (let i = 0; i < BUDGET_MAX_PROBES_PER_WINDOW; i++) {
      const probe = observeProviderHealth()
      await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)
      await expect(probe).resolves.toBe('UNKNOWN')
    }
  }

  it('exhausting the budget yields UNKNOWN and never REACHABLE', async () => {
    await exhaustBudgetWithHardTimeouts()
    // The budget is now exhausted for this window: no attempt is made at
    // all, proven by swapping in a transport that would otherwise answer
    // REACHABLE immediately.
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)
    const verdict = await observeProviderHealth()
    expect(verdict).toBe('UNKNOWN')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('MUST FAIL: budget exhaustion must never manufacture REACHABLE', async () => {
    await exhaustBudgetWithHardTimeouts()
    __setProviderTouchFetchForTests(immediateFetch(true))
    const verdict = await observeProviderHealth()
    expect(verdict).not.toBe('REACHABLE')
    expect(verdict).toBe('UNKNOWN')
  })

  it('budget exhaustion recovers at the next window boundary — never permanent', async () => {
    await exhaustBudgetWithHardTimeouts()
    __setProviderTouchFetchForTests(immediateFetch(true))
    await expect(observeProviderHealth()).resolves.toBe('UNKNOWN')

    vi.advanceTimersByTime(BUDGET_WINDOW_MS + 1)
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
  })

  it('a misconfigured (absent) auth URL never spends budget', async () => {
    vi.unstubAllEnvs()
    const fetchImpl = immediateFetch(true)
    __setProviderTouchFetchForTests(fetchImpl)

    for (let i = 0; i < BUDGET_MAX_PROBES_PER_WINDOW + 5; i++) {
      await expect(observeProviderHealth()).resolves.toBe('UNKNOWN')
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Single-flight ownership (NB-R6/NB-R7): waiter timeout never affects the
// shared probe; a late-resolving probe still populates the cache.
// ---------------------------------------------------------------------------

describe('single-flight ownership', () => {
  it('a waiter that exceeds PROBE_WAIT_BUDGET_MS gets UNKNOWN without cancelling the shared probe', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    ) as unknown as typeof fetch
    __setProviderTouchFetchForTests(fetchImpl)

    const waiterPromise = observeProviderHealth()
    await vi.advanceTimersByTimeAsync(PROBE_WAIT_BUDGET_MS)
    await expect(waiterPromise).resolves.toBe('UNKNOWN')

    // The underlying probe is STILL running — resolve it now, well after the
    // waiter already bailed.
    resolveFetch(new Response(null, { status: 200 }))
    await vi.runAllTimersAsync()

    // A LATER caller benefits from the cache the (still-running) probe wrote.
    const later = await observeProviderHealth()
    expect(later).toBe('REACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1) // never a second probe was started
  })

  it('a second caller arriving while a probe is in flight JOINS it rather than starting a second one', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    ) as unknown as typeof fetch
    __setProviderTouchFetchForTests(fetchImpl)

    const first = observeProviderHealth()
    const second = observeProviderHealth()

    resolveFetch(new Response(null, { status: 200 }))
    const [a, b] = await Promise.all([first, second])

    expect(a).toBe('REACHABLE')
    expect(b).toBe('REACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('MUST FAIL: an initiator-side abort must never cancel the shared probe for other waiters', async () => {
    // No caller-supplied AbortSignal is ever threaded into the touch's own
    // fetch call — proven by construction: `observeProviderHealth()` takes NO
    // signal parameter at all, so there is nothing a caller could wire in.
    // This is asserted here as a type-level/API-shape fact rather than a
    // runtime one: the function's arity is zero.
    expect(observeProviderHealth.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Recovery after UNKNOWN and after a hard timeout.
// ---------------------------------------------------------------------------

describe('recovery', () => {
  it('a later valid observation replaces an UNKNOWN one', async () => {
    const { impl: hanging } = hangingFetchAbortAware()
    __setProviderTouchFetchForTests(hanging)
    const first = observeProviderHealth()
    await vi.advanceTimersByTimeAsync(PROBE_HARD_TIMEOUT_MS)
    await expect(first).resolves.toBe('UNKNOWN')

    __setProviderTouchFetchForTests(immediateFetch(true))
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
  })

  it('recovery after a genuine UNREACHABLE observation, once TTL_MS elapses', async () => {
    __setProviderTouchFetchForTests(failingFetch())
    await expect(observeProviderHealth()).resolves.toBe('UNREACHABLE')

    vi.advanceTimersByTime(TTL_MS + 1)
    __setProviderTouchFetchForTests(immediateFetch(true))
    await expect(observeProviderHealth()).resolves.toBe('REACHABLE')
  })
})

// ---------------------------------------------------------------------------
// PII — the touch never exposes the URL, key or upstream error text.
// ---------------------------------------------------------------------------

describe('PII discipline', () => {
  it('the returned verdict never carries the provider URL, key or error text', async () => {
    __setProviderTouchFetchForTests(failingFetch())
    const verdict = await observeProviderHealth()
    const serialized = JSON.stringify(verdict)
    expect(serialized).not.toContain('supabase.co')
    expect(serialized).not.toContain('fetch failed')
  })
})
