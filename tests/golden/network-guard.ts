// tests/golden/network-guard.ts
//
// EGRESS BOUNDARY FOR THE GOLDEN JOURNEY RUNNER.
//
// ===========================================================================
// WHY A SECOND GUARD EXISTS WHEN THE REPOSITORY ALREADY HAS ONE
// ===========================================================================
// `vitest.setup.network-guard.ts` closes a real incident: two concurrent
// `await import('@google/genai')` calls defeat Vitest's module mock and the
// real SDK reaches `generativelanguage.googleapis.com`. That guard is
// installed through `setupFiles`, which is a VITEST mechanism.
//
// Playwright loads no Vitest setup file. So every protection that file
// provides is absent in this runner by construction — not weakened, absent.
// A Golden Journey that exercised "the governed assistant" leg under
// Playwright would sit outside the only control the repository has against
// billable provider traffic from a test process.
//
// ===========================================================================
// THE TWO LAYERS, AND WHY ONE WOULD NOT BE ENOUGH
// ===========================================================================
// There are two completely separate places a Golden run can emit traffic, and
// a guard on either one is silent about the other:
//
//   NODE LAYER     the runner process itself — fixtures, helpers, anything
//                  that calls `fetch` while deciding what to assert.
//
//   BROWSER LAYER  the page under test. This traffic never passes through
//                  Node's `fetch` at all; it originates inside the browser
//                  process. Wrapping `globalThis.fetch` in the runner does
//                  NOTHING to it.
//
// The browser layer is the one that matters for a journey, and it is the one a
// Node-only guard would miss entirely. It is enforced with Playwright routing
// rather than by trusting the application not to call out.
//
// ===========================================================================
// ALLOWLIST, NOT DENYLIST
// ===========================================================================
// The Vitest guard is a narrow denylist of provider hostnames, correctly so:
// it protects a suite that legitimately talks to localhost Supabase and
// Postgres, and a blanket ban would break it.
//
// This guard inverts that, because a Golden run has a single legitimate
// destination — its declared target — and everything else is either a provider
// call, a production API, or a third party. Enumerating what may be reached is
// a property; enumerating what may not be reached is a list that is one new
// vendor out of date. The frozen authority's requirement is that Stella uses a
// deterministic test boundary and that no production API is called, and an
// allowlist is the only shape that states that as a property.

import type { BrowserContext } from '@playwright/test'

/** Raised when the runner process attempts egress outside the allowlist. */
export class GoldenEgressBlockedError extends Error {
  constructor(hostname: string, method: string) {
    // The message carries a hostname and a method and nothing else. A URL can
    // carry `?key=`, headers carry bearer tokens, and a body can carry a
    // prompt; an error travels to reporters, CI logs and Sentry, so what it is
    // allowed to hold is decided here rather than wherever it is printed.
    super(
      `GOLDEN_EGRESS_BLOCKED: the Golden Journey runner attempted ${method} to ${hostname}. ` +
        'Only the declared target origin and loopback are reachable from this harness.',
    )
    this.name = 'GOLDEN_EGRESS_BLOCKED'
  }
}

/** Loopback names the harness may always reach, so a local target needs no special case. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/**
 * Hostnames allowed for a given target.
 *
 * Takes the base URL rather than reading the environment so the meta guard can
 * drive every branch without mutating the process.
 */
export function allowedHostnames(baseURL: string | undefined): ReadonlySet<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTS)
  if (baseURL !== undefined && baseURL.length > 0) {
    try {
      allowed.add(new URL(baseURL).hostname.toLowerCase())
    } catch {
      // An unparseable base URL contributes no host. `target.ts` already
      // refuses that case; contributing a bogus entry here would be a second,
      // quieter way for a malformed target to widen the boundary.
    }
  }
  return allowed
}

/** Normalise an IPv6 literal's brackets so `[::1]` and `::1` compare equal. */
export function normaliseHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

export function isHostAllowed(hostname: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(normaliseHostname(hostname))
}

/**
 * Wrap a fetch implementation so disallowed hosts are refused BEFORE delegation.
 *
 * Throws synchronously rather than returning a rejected promise, for the same
 * reason the Vitest guard does: a rejected promise is swallowed by any
 * `.catch()` the caller already has, turning a hard stop into a retry loop
 * against a host that will never answer.
 *
 * Exported separately from installation so a test can assert the property that
 * matters — given a spy as the transport, a blocked call leaves the spy
 * UNCALLED. That is what "before a socket exists" means as an assertion rather
 * than as a claim about ordering.
 */
/**
 * Brand stamped on a guarded fetch.
 *
 * `Symbol.for` rather than a module-local symbol: the guard can be installed
 * from one module instance and inspected from another (Playwright workers load
 * the graph independently), and a module-local symbol would make the same
 * function look unbranded to the inspector. The registry symbol is the same
 * value everywhere in the process, which is the scope the question is asked at.
 *
 * This exists because "the guard was installed" and "the fetch in front of me
 * is the guarded one" are different claims, and R1 shipped the first without
 * the second — a guard with no call site at all. A boolean set by the installer
 * could still be true while `globalThis.fetch` had been replaced by something
 * else afterwards; the brand is read off the function that would actually run.
 */
export const GOLDEN_EGRESS_GUARD_BRAND = Symbol.for('uellix.golden.node-egress-guard')

/** True when `fn` is a fetch this module guarded. */
export function fetchIsGuarded(fn: unknown = globalThis.fetch): boolean {
  return (
    typeof fn === 'function' &&
    (fn as unknown as Record<symbol, unknown>)[GOLDEN_EGRESS_GUARD_BRAND] === true
  )
}

export function guardedFetch(originalFetch: typeof fetch, allowed: ReadonlySet<string>): typeof fetch {
  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let rawUrl: string | undefined
    let method = init?.method
    if (typeof input === 'string') rawUrl = input
    else if (input instanceof URL) rawUrl = input.href
    else if (input && typeof (input as Request).url === 'string') {
      rawUrl = (input as Request).url
      method = method ?? (input as Request).method
    }
    if (rawUrl !== undefined) {
      try {
        const { hostname } = new URL(rawUrl)
        if (!isHostAllowed(hostname, allowed)) {
          throw new GoldenEgressBlockedError(normaliseHostname(hostname), (method ?? 'GET').toUpperCase())
        }
      } catch (error) {
        if (error instanceof GoldenEgressBlockedError) throw error
        // Unparseable target: not a host this guard can rule on, and not a
        // reason to refuse a call it cannot classify.
      }
    }
    return originalFetch(input as RequestInfo, init)
  }
  Object.defineProperty(guarded, GOLDEN_EGRESS_GUARD_BRAND, {
    value: true,
    enumerable: false,
  })
  return guarded as typeof fetch
}

/**
 * Which process installed the guard, and whether it is still in front.
 *
 * `installedInPid` is the whole point. Playwright runs `globalSetup` in the
 * RUNNER process and test files in WORKER processes, so a guard installed in
 * the runner protects a process that issues none of the test code's requests.
 * Recording the pid lets a test assert that the guard was installed in the very
 * process that is asking — which is the only form of the claim that means
 * anything.
 */
export interface NodeEgressGuardState {
  readonly installed: boolean
  readonly installedInPid: number | null
  /** Read off `globalThis.fetch` NOW, not remembered from installation time. */
  readonly fetchIsGuardedNow: boolean
  readonly activeInThisProcess: boolean
}

let nodeGuardInstalled = false
let nodeGuardPid: number | null = null

/** Install the worker-process guard. Idempotent: re-importing must not double-wrap. */
export function installNodeEgressGuard(allowed: ReadonlySet<string>): void {
  if (nodeGuardInstalled) return
  nodeGuardInstalled = true
  nodeGuardPid = process.pid
  globalThis.fetch = guardedFetch(globalThis.fetch, allowed)
}

export function nodeEgressGuardState(): NodeEgressGuardState {
  const fetchIsGuardedNow = fetchIsGuarded()
  return {
    installed: nodeGuardInstalled,
    installedInPid: nodeGuardPid,
    fetchIsGuardedNow,
    // BOTH halves, deliberately. `installed` alone is a memory of a past call
    // in this module instance; `fetchIsGuardedNow` alone cannot tell this
    // process's installation from one inherited some other way. The conjunction
    // is the claim the reviewer asked to be made provable.
    activeInThisProcess: nodeGuardInstalled && nodeGuardPid === process.pid && fetchIsGuardedNow,
  }
}

/** Test-only: undo the installation so a control can prove its own absence is RED. */
export function uninstallNodeEgressGuardForProof(originalFetch: typeof fetch): void {
  nodeGuardInstalled = false
  nodeGuardPid = null
  globalThis.fetch = originalFetch
}

/**
 * Install the browser-layer guard on one context.
 *
 * `route('**')` intercepts EVERY request the page makes, including subresources
 * and XHR the application issues on its own. Disallowed requests are aborted
 * rather than fulfilled with a stub: a stub would be a development-only
 * workaround inserted into the journey path, which the frozen authority
 * forbids anywhere in a Golden Journey. An abort is what the network genuinely
 * failing looks like, and the journey is entitled to fail on it.
 *
 * Returns the list of blocked URLs' hostnames so a run can report that the
 * boundary was not merely installed but never needed — or was.
 */
export async function installBrowserEgressGuard(
  context: BrowserContext,
  allowed: ReadonlySet<string>,
): Promise<{ readonly blocked: readonly string[] }> {
  const blocked: string[] = []
  await context.route('**', async (route) => {
    const requestUrl = route.request().url()
    let hostname: string
    try {
      hostname = new URL(requestUrl).hostname
    } catch {
      await route.continue()
      return
    }
    if (isHostAllowed(hostname, allowed)) {
      await route.continue()
      return
    }
    blocked.push(normaliseHostname(hostname))
    await route.abort('blockedbyclient')
  })
  return { blocked }
}
