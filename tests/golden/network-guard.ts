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
  return guarded as typeof fetch
}

let nodeGuardInstalled = false

/** Install the runner-process guard. Idempotent: re-importing must not double-wrap. */
export function installNodeEgressGuard(allowed: ReadonlySet<string>): void {
  if (nodeGuardInstalled) return
  nodeGuardInstalled = true
  globalThis.fetch = guardedFetch(globalThis.fetch, allowed)
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
