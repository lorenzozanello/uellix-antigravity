// lib/health/provider-touch.ts
//
// M11 TA-03/04/05 — A DEDICATED, SESSIONLESS PROBE OF THE AUTH PROVIDER'S
// OWN REACHABILITY.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS AND NOT A REUSE OF lib/auth/identity.ts
// ---------------------------------------------------------------------------
// For an ANONYMOUS caller, `supabase.auth.getUser()` makes ZERO outbound
// calls: @supabase/auth-js's own `_getUser` returns `AuthSessionMissingError`
// the instant it finds no `access_token`, before any fetch. That is correct
// for a SESSION question ("is this caller logged in") and wrong for a HEALTH
// question ("is GoTrue itself reachable") — an anonymous caller can never
// observe the second through the first. This module makes an INDEPENDENT,
// unauthenticated request instead: `GET {authUrl}/auth/v1/health`, GoTrue's
// own dedicated liveness endpoint, with only the `apikey` header the
// project's API gateway requires to route the request at all. No session, no
// cookie, no tenant data, no database connection.
//
// It trusts that Supabase project coherence has ALREADY been proven before
// this code runs: `proxy.ts` calls `assertSupabaseProjectCoherence()` first,
// ahead of every other matched request (S-5/PLATFORM_PRE_HANDLER_FAILURE_RULE
// in the M11 Track A DAG authority) — a request that reaches this module has
// already passed that gate, or the process never got here. Re-asserting
// coherence here would additionally require a resolvable
// UELLIX_RUNTIME_DATABASE_URL (`assertSupabaseProjectCoherence` proves
// Postgres too), coupling a PUBLIC LIVENESS SURFACE to a database dependency
// it has no reason to carry. So this module reads
// `process.env.NEXT_PUBLIC_SUPABASE_URL` directly, the same "inlined form"
// `lib/supabase/project-coherence.ts` itself reads and explains (Next.js
// inlines `NEXT_PUBLIC_*` as a build-time constant only when the access is a
// static member expression) — never a second, unchecked re-derivation of a
// DIFFERENT value.
//
// ---------------------------------------------------------------------------
// THE OWNER'S HT-1 / HT-2 CONTRACT — AFFIRMATIVE EVIDENCE, OR NOTHING
// ---------------------------------------------------------------------------
// A bare timeout is NOT proof the provider is down — GoTrue may simply be
// slow. Per the owner's ratified HT-1/HT-2 decision:
//
//   HT-1: PROBE_HARD_TIMEOUT_MS expiring WITHOUT affirmative unreachability
//         evidence classifies UNKNOWN (200, non-healthy body, runner
//         INCONCLUSIVE — never PASS, never health FAIL, never 503).
//   HT-2: UNREACHABLE (AS-3, 503, health FAIL) is reserved for AFFIRMATIVE
//         evidence — a genuine transport failure, a DNS failure, connection
//         refused, or an actual non-ok HTTP response FROM the provider.
//
// Implemented by distinguishing OUR OWN AbortController firing (`AbortError`
// — no evidence, just our own ceiling) from every other fetch rejection (a
// real transport fault — affirmative evidence) — see `probeProviderOnce`.
//
// ---------------------------------------------------------------------------
// SINGLE-FLIGHT OWNERSHIP (M11 NB-R6) — THE PROBE OUTLIVES ANY ONE CALLER
// ---------------------------------------------------------------------------
// The underlying fetch's AbortController is owned by THIS MODULE, tied to
// NOTHING but `PROBE_HARD_TIMEOUT_MS`. It is never wired to any individual
// caller's own lifecycle or AbortSignal, so one caller disconnecting can
// never strand or corrupt the probe for concurrent waiters. A WAITER's own
// `PROBE_WAIT_BUDGET_MS` timeout only makes THAT WAITER stop waiting
// (resolve UNKNOWN); it never calls `controller.abort()`. The shared probe
// keeps running, and if it later resolves definitively, it still populates
// the cache for the NEXT caller — the wait-timed-out caller's own miss is not
// wasted.
//
// ---------------------------------------------------------------------------
// CACHE-WRITE SEMANTICS (M11 NB-R5) — UNKNOWN IS NEVER CACHED
// ---------------------------------------------------------------------------
// The cache stores facts ABOUT THE PROVIDER (REACHABLE / UNREACHABLE, each
// worth `TTL_MS` of staleness). UNKNOWN is a fact about THIS REQUEST's
// inability to observe — budget exhaustion, a wait-timeout, or our own hard
// ceiling — and has no basis to outlive the request that produced it.
// Caching it would let a stale non-observation silently survive the very
// budget-window reset that is supposed to guarantee recovery. So `UNKNOWN`
// is the one verdict this module NEVER writes to `cacheEntry`.
//
// ---------------------------------------------------------------------------
// THE JOINT BUDGET/TTL INVARIANT (M11 NB-R3/NB-R8) — DERIVED, NOT GUESSED
// ---------------------------------------------------------------------------
// An earlier draft fixed `BUDGET_WINDOW_MS`, `TTL_MS` and
// `BUDGET_MAX_PROBES_PER_WINDOW` as three INDEPENDENTLY chosen numbers with
// separately "reasonable" admissible ranges. Their own worst-case corner
// (`WINDOW_MS=300000`, `TTL_MS=5000`) required
// `ceil(300000/5000) = 60` probes per window, while the independently-chosen
// cap was 30 — a genuine, machine-verified contradiction. Three independent
// degrees of freedom whose product must satisfy one invariant will always
// have this failure mode somewhere in their range. The fix removes the
// degree of freedom instead of widening the cap: `BUDGET_MAX_PROBES_PER_WINDOW`
// and `PROBE_HARD_TIMEOUT_MS` are DERIVED from the other constants, with a
// fixed positive headroom/margin, so the invariant holds BY CONSTRUCTION for
// any tuning of the base constants — and a defensive assertion at module load
// still catches a mutation that reintroduces two independent literals.

const TOUCH_HEALTH_PATH = '/auth/v1/health'

export type ProviderTouchVerdict = 'REACHABLE' | 'UNREACHABLE' | 'UNKNOWN'

/** Short cache TTL for a definitive (REACHABLE/UNREACHABLE) verdict. */
export const TTL_MS = 15_000

/** The touch's own request budget window — independent of OD-4/KV. */
export const BUDGET_WINDOW_MS = 60_000

/** Margin above the derived floor, chosen for headroom, not tightness. */
const BUDGET_HEADROOM = 2

/**
 * The minimum probe budget a window must admit so a provider that recovers
 * is always re-observable within one window, even in the worst case where
 * every prior probe in the window failed and was never cached.
 */
export function deriveBudgetMaxProbesPerWindow(windowMs: number, ttlMs: number): number {
  return Math.ceil(windowMs / ttlMs) + BUDGET_HEADROOM
}

/** DERIVED — see the module header. Never set this independently. */
export const BUDGET_MAX_PROBES_PER_WINDOW = deriveBudgetMaxProbesPerWindow(BUDGET_WINDOW_MS, TTL_MS)

/** How long ONE WAITER tolerates an already in-flight probe before UNKNOWN. */
export const PROBE_WAIT_BUDGET_MS = 3_000

/** Margin the probe's own hard ceiling sits above any waiter's patience. */
const PROBE_HARD_TIMEOUT_MARGIN_MS = 5_000

/**
 * DERIVED — see the module header. The probe's own transport-level ceiling,
 * always strictly greater than `PROBE_WAIT_BUDGET_MS` by construction.
 */
export const PROBE_HARD_TIMEOUT_MS = PROBE_WAIT_BUDGET_MS + PROBE_HARD_TIMEOUT_MARGIN_MS

// Fail-closed at module load (M11 NB-R3/NB-R8 mutation coverage): these must
// be mathematically unreachable for DERIVED constants. If either fires, the
// derivation above was bypassed by a later edit — surfaced immediately at
// import time, not discovered by a corner-case request in production.
if (BUDGET_MAX_PROBES_PER_WINDOW < Math.ceil(BUDGET_WINDOW_MS / TTL_MS)) {
  throw new Error(
    'lib/health/provider-touch: BUDGET_MAX_PROBES_PER_WINDOW violates its own derivation invariant ' +
      '(must be >= ceil(BUDGET_WINDOW_MS / TTL_MS)). This constant is derived, not independently set — ' +
      'if this fires, the derivation was bypassed.'
  )
}
if (PROBE_HARD_TIMEOUT_MS <= PROBE_WAIT_BUDGET_MS) {
  throw new Error(
    'lib/health/provider-touch: PROBE_HARD_TIMEOUT_MS must exceed PROBE_WAIT_BUDGET_MS. This constant ' +
      'is derived, not independently set — if this fires, the derivation was bypassed.'
  )
}

interface CacheEntry {
  readonly verdict: 'REACHABLE' | 'UNREACHABLE'
  readonly observedAtMs: number
}

interface SharedProbe {
  readonly promise: Promise<ProviderTouchVerdict>
}

let cacheEntry: CacheEntry | null = null
let inFlight: SharedProbe | null = null
let budgetWindowStartMs = 0
let budgetConsumed = 0
let fetchImpl: typeof fetch = fetch

/**
 * Read `NEXT_PUBLIC_SUPABASE_URL` as a static member expression — the same
 * inlining-sensitive access form `lib/supabase/project-coherence.ts` uses and
 * explains. Returns `null` (never throws, never attempts a fetch) for
 * absent/blank/UNPARSEABLE: a malformed URL is a LOCAL CONFIGURATION defect,
 * not affirmative evidence the PROVIDER is unreachable (HT-2) — `fetch()`
 * itself would throw a `TypeError` for it (undici constructs the URL before
 * any socket exists), which the catch block in `probeProviderOnce` would
 * otherwise be unable to tell apart from a genuine transport failure. A
 * public liveness surface degrades to UNKNOWN on misconfiguration of any
 * kind rather than crashing OR reporting a health fact about a provider it
 * never actually contacted.
 */
function resolveTouchAuthUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  try {
    new URL(trimmed)
  } catch {
    return null
  }
  return trimmed
}

function resetBudgetWindowIfElapsed(nowMs: number): void {
  if (budgetWindowStartMs === 0 || nowMs - budgetWindowStartMs >= BUDGET_WINDOW_MS) {
    budgetWindowStartMs = nowMs
    budgetConsumed = 0
  }
}

/**
 * The exact status set @supabase/auth-js's own `NETWORK_ERROR_CODES` treats
 * as an infrastructure fault — throwing `AuthRetryableFetchError` rather than
 * the ordinary `AuthApiError` — read directly from the installed SDK source
 * (`node_modules/.../lib/fetch.js`). The touch mirrors this EXACT set rather
 * than inventing a second, independent status taxonomy: a non-ok response
 * outside this set (401, 403, 404, 429, ...) is still PROOF the provider
 * answered — the same "AS-2 proves reachability" logic `classifyUpstreamAuthError`
 * already applies to `AuthApiError` — and must never be reported as
 * affirmative evidence of unreachability (HT-2).
 */
const UPSTREAM_INFRASTRUCTURE_FAULT_STATUSES: ReadonlySet<number> = new Set([
  500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530,
])

/**
 * ONE raw network attempt against the health endpoint, with no cache, no
 * budget and no single-flight coalescing — the directly testable unit the
 * HT-1/HT-2 AbortError-vs-genuine-failure distinction lives in. Exported so a
 * mutation deleting that distinction can be caught DIRECTLY, without racing
 * against `observeProviderHealth`'s own `PROBE_WAIT_BUDGET_MS` waiter timeout
 * (which — being strictly shorter than `PROBE_HARD_TIMEOUT_MS` by
 * construction — would otherwise resolve the outer call first and mask a
 * mutation to this function's own AbortError branch). Never throws.
 */
export async function probeProviderOnce(authUrl: string): Promise<ProviderTouchVerdict> {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  const controller = new AbortController()
  const hardTimeout = setTimeout(() => controller.abort(), PROBE_HARD_TIMEOUT_MS)

  try {
    const response = await fetchImpl(`${authUrl}${TOUCH_HEALTH_PATH}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { apikey: anonKey },
    })
    if (response.ok) return 'REACHABLE'
    // NB-IC-6: a non-ok response is still proof the provider answered. Only
    // the shared infrastructure-fault status set counts as affirmative
    // evidence of an upstream health fault.
    return UPSTREAM_INFRASTRUCTURE_FAULT_STATUSES.has(response.status) ? 'UNREACHABLE' : 'REACHABLE'
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // HT-1: our own ceiling fired. No affirmative evidence either way.
      return 'UNKNOWN'
    }
    // HT-2: the fetch itself failed for a reason that was NOT us aborting it
    // — DNS, connection refused, TLS, or any other genuine transport fault.
    // (A malformed URL never reaches here: `resolveTouchAuthUrl` refuses to
    // hand one to this function at all.) That IS affirmative evidence.
    return 'UNREACHABLE'
  } finally {
    clearTimeout(hardTimeout)
  }
}

function startSharedProbe(authUrl: string): SharedProbe {
  const promise = probeProviderOnce(authUrl).then((verdict) => {
    // NB-R5: only a definitive observation is worth caching.
    if (verdict !== 'UNKNOWN') {
      cacheEntry = { verdict, observedAtMs: Date.now() }
    }
    return verdict
  })
  return { promise }
}

/**
 * Race a shared probe against ONE WAITER's own patience. The probe itself is
 * untouched by this race — see the module header on ownership.
 */
function waitWithBudget(
  probePromise: Promise<ProviderTouchVerdict>,
  waitBudgetMs: number
): Promise<ProviderTouchVerdict> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('UNKNOWN')
    }, waitBudgetMs)
    probePromise.then((verdict) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(verdict)
    })
  })
}

/**
 * The public entry point. Sessionless, cached, budgeted, single-flighted.
 * Never throws — every path resolves to a `ProviderTouchVerdict`.
 */
export async function observeProviderHealth(): Promise<ProviderTouchVerdict> {
  const nowMs = Date.now()

  if (cacheEntry && nowMs - cacheEntry.observedAtMs < TTL_MS) {
    return cacheEntry.verdict
  }

  if (inFlight) {
    return waitWithBudget(inFlight.promise, PROBE_WAIT_BUDGET_MS)
  }

  const authUrl = resolveTouchAuthUrl()
  if (authUrl === null) {
    // No fetch is attempted, so no budget is spent on a configuration
    // problem that a retry cannot fix.
    return 'UNKNOWN'
  }

  resetBudgetWindowIfElapsed(nowMs)
  if (budgetConsumed >= BUDGET_MAX_PROBES_PER_WINDOW) {
    // BUDGET_EXHAUSTED — never cached (NB-R5); FIXED_WINDOW_RESET guarantees
    // this is never permanent.
    return 'UNKNOWN'
  }
  budgetConsumed += 1

  const probe = startSharedProbe(authUrl)
  inFlight = probe
  // Release the single-flight slot once the probe settles, regardless of
  // whether any waiter is still racing against it (NB-R6 ownership).
  void probe.promise.finally(() => {
    if (inFlight === probe) inFlight = null
  })

  return waitWithBudget(probe.promise, PROBE_WAIT_BUDGET_MS)
}

// ---------------------------------------------------------------------------
// Test-only hooks. Never called by production code paths.
// ---------------------------------------------------------------------------

/** Swap the transport. `null` restores the real global `fetch`. */
export function __setProviderTouchFetchForTests(impl: typeof fetch | null): void {
  fetchImpl = impl ?? fetch
}

/** Clear cache, in-flight probe and budget window between tests. */
export function __resetProviderTouchStateForTests(): void {
  cacheEntry = null
  inFlight = null
  budgetWindowStartMs = 0
  budgetConsumed = 0
}
