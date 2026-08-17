// vitest.setup.network-guard.ts
//
// HZ-01 — UNDER VITEST, REACHING REAL GEMINI IS IMPOSSIBLE.
//
// ===========================================================================
// THE INCIDENT
// ===========================================================================
// While building the G1-B provider-invocation observability, a test that ran
// two `StellaGeminiAdapter` calls under `Promise.all` produced real HTTPS
// traffic to `generativelanguage.googleapis.com`. Measured on a minimal probe
// containing no code of ours beyond the adapter itself:
//
//     two adapters, SEQUENTIAL   ->  vi.mock('@google/genai') applies
//     two adapters, CONCURRENT   ->  the mock is BYPASSED, the real SDK loads
//
// Two concurrent `await import('@google/genai')` calls defeat Vitest's module
// mock. Warming the module registry with a sequential call first does not help.
//
// The escaped calls carried an INVALID canary key, Google answered
// `400 API_KEY_INVALID`, and nothing was generated, consumed or billed. They
// were harmless for exactly one reason — the key was wrong — and that reason is
// not a control.
//
// ===========================================================================
// WHY THIS FILE EXISTS RATHER THAN A RULE
// ===========================================================================
// Before it, the suite's safety rested on three separate things going right:
//
//     1. `vi.mock('@google/genai')` intercepting  — it does not, under concurrency
//     2. `GEMINI_API_KEY` being absent            — on the dev machine it is present
//     3. the operator prefixing `env -u GEMINI_API_KEY`
//
// Three habits are not a property. Any one of them failing put a billable call
// carrying the request body one `Promise.all` away. This guard removes all
// three from the argument: whatever the mock does, whatever the environment
// holds, egress to the provider is refused before a socket exists.
//
// ===========================================================================
// WHY IT LIVES IN THE HARNESS AND NOT IN lib/stella
// ===========================================================================
// The defect belongs to the test harness, and a `NODE_ENV === 'test'` branch
// inside `StellaGeminiAdapter` would be worse in three ways: it would put test
// logic on the model boundary, it would only protect the code that remembered
// to call it, and it would protect nothing when the mock is bypassed and the
// REAL SDK issues the request — which is precisely the case that happened.
//
// This intercepts the transport instead, so it holds for any caller: our
// adapter, the real SDK, a transitive dependency, or a future rewrite.
//
// ===========================================================================
// THE TRANSPORT, TRACED IN THE INSTALLED SOURCE
// ===========================================================================
// `@google/genai@2.10.0`, `dist/node/index.mjs`, read (never called):
//
//     apiCall(url, requestInit) {
//       ... return fetch(url, requestInit);          // line ~13595
//       ... const response = await fetch(url, requestInit);   // line ~13599
//     }
//     const DEFAULT_FETCHER = (input, init) => fetch(input, init);  // line ~18812
//
// Every request site is the UNQUALIFIED GLOBAL `fetch`. There is no
// `https.request`, no `http.request`, and no direct undici Dispatcher use — the
// single `undici` reference (line ~13436) only READS
// `Symbol.for('undici.globalDispatcher.1')` to adjust a timeout. So replacing
// `globalThis.fetch` intercepts every model call the SDK can make.
//
// `node:https` / `node:http` are wrapped ANYWAY, for the same hostnames. Not
// because 2.10.0 needs it, but because "the SDK currently uses fetch" is a fact
// about a version, and the guard should survive the upgrade that changes it.
//
// ===========================================================================
// NO OPT-OUT. DELIBERATELY.
// ===========================================================================
// There is no `ALLOW_REAL_GEMINI_TESTS`, and there must not be. No Vitest case
// today needs a real provider, and an escape hatch would be set once, in CI, by
// someone debugging, and never unset. Live evaluation has its own governed
// harness — `pnpm tsx tests/eval/stella-contextual-real/run.ts`
// (docs/ops/gates/G1_PACKAGE.md) — which does not run under Vitest, loads no
// setup file, and keeps its own acknowledgements. That split is asserted in
// tests/no-real-gemini-network-guard.test.ts.

/** The error a blocked attempt raises. `name` is the greppable contract. */
export class TestRealGeminiNetworkBlockedError extends Error {
  constructor(hostname: string, method: string) {
    // THE MESSAGE IS THE WHOLE PAYLOAD, so it is built from exactly two values.
    // No URL, no path, no query, no headers, no body: a Gemini URL can carry
    // `?key=`, the headers carry `x-goog-api-key` and `authorization`, and the
    // body is the prompt. An error object travels to reporters, CI logs and
    // Sentry, so what it may hold is decided here rather than downstream.
    super(
      `TEST_REAL_GEMINI_NETWORK_BLOCKED: a Vitest process attempted ${method} to ${hostname}. ` +
        'Tests must never reach the real provider. Mock @google/genai, or use the governed ' +
        'tsx harness (docs/ops/gates/G1_PACKAGE.md) which runs outside Vitest.'
    )
    this.name = 'TEST_REAL_GEMINI_NETWORK_BLOCKED'
  }
}

/**
 * The hostnames refused.
 *
 * Derived from the installed SDK source, and narrow ON PURPOSE — the suite
 * legitimately talks to localhost (Supabase, Postgres) and must keep doing so,
 * so this is not a blanket ban on networking.
 *
 * `www.googleapis.com` appears in the SDK too and is deliberately NOT here: it
 * is the OAuth/discovery host of the Vertex path, not a model-call endpoint,
 * and blocking it would widen the guard past the thing it is guarding.
 */
export const BLOCKED_GEMINI_HOSTNAMES: ReadonlySet<string> = new Set([
  // The Gemini Developer API — the one `StellaGeminiAdapter` uses.
  'generativelanguage.googleapis.com',
  // The Vertex AI model endpoints. Unused today; blocked so that a future
  // switch to Vertex cannot silently reopen this hole.
  'aiplatform.googleapis.com',
  'vertexai.googleapis.com',
])

/** Refuse, or return. Never both, never neither. */
function assertNotProviderHost(hostname: string | undefined, method: string): void {
  if (!hostname) return
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_GEMINI_HOSTNAMES.has(normalized)) {
    throw new TestRealGeminiNetworkBlockedError(normalized, method.toUpperCase())
  }
}

/**
 * Read the hostname out of whatever `fetch` accepts, WITHOUT touching the body.
 *
 * A `Request` is not consumed and not cloned: only `.url` and `.method` are
 * read, both of which are safe accessors.
 */
function describeFetchTarget(
  input: RequestInfo | URL,
  init?: RequestInit
): { hostname: string | undefined; method: string } {
  let rawUrl: string | undefined
  let method = init?.method
  if (typeof input === 'string') rawUrl = input
  else if (input instanceof URL) rawUrl = input.href
  else if (input && typeof (input as Request).url === 'string') {
    rawUrl = (input as Request).url
    method = method ?? (input as Request).method
  }
  if (rawUrl === undefined) return { hostname: undefined, method: method ?? 'GET' }
  try {
    return { hostname: new URL(rawUrl).hostname, method: method ?? 'GET' }
  } catch {
    // Unparseable target: not a provider URL, so not this guard's business.
    return { hostname: undefined, method: method ?? 'GET' }
  }
}

/**
 * Wrap a fetch implementation so provider hosts are refused BEFORE delegation.
 *
 * THROWS SYNCHRONOUSLY rather than returning a rejected promise. A rejected
 * promise would be swallowed by any `.catch()` a caller already has — and the
 * SDK has one — turning a hard stop into a retry against a host that will never
 * answer. A synchronous throw is unmistakable and cannot be mistaken for a
 * network failure.
 *
 * Exported separately from the installation so a test can prove the property
 * that matters: given a spy as the transport, a blocked call must leave the spy
 * UNCALLED. That is what "before any socket exists" means, stated as an
 * assertion rather than as a claim about ordering.
 */
export function guardedFetch(originalFetch: typeof fetch): typeof fetch {
  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { hostname, method } = describeFetchTarget(input, init)
    assertNotProviderHost(hostname, method)
    return originalFetch(input as RequestInfo, init)
  }
  return guarded as typeof fetch
}

/** Pull a hostname out of the several shapes `http.request` accepts. */
function describeNodeRequestTarget(args: unknown[]): { hostname?: string; method: string } {
  let hostname: string | undefined
  let method = 'GET'
  for (const arg of args.slice(0, 2)) {
    if (typeof arg === 'string') {
      try {
        hostname = hostname ?? new URL(arg).hostname
      } catch {
        /* not a URL */
      }
    } else if (arg instanceof URL) {
      hostname = hostname ?? arg.hostname
    } else if (arg && typeof arg === 'object') {
      const options = arg as { hostname?: unknown; host?: unknown; method?: unknown }
      if (typeof options.hostname === 'string') hostname = hostname ?? options.hostname
      else if (typeof options.host === 'string') hostname = hostname ?? options.host.split(':')[0]
      if (typeof options.method === 'string') method = options.method
    }
  }
  return { hostname, method }
}

/** Installed once per worker. Re-importing the module must not double-wrap. */
let installed = false

/**
 * AWAITED at module scope, not fire-and-forget.
 *
 * An earlier draft wrapped `node:http`/`node:https` inside `void import(...).then(...)`,
 * which installs on a later microtask — so a test module that issued a request
 * in the first tick would have raced the guard it was supposed to be under.
 * Vitest setup files are ESM and support top-level await, so the whole
 * installation completes before any test module is imported.
 *
 * The `fetch` wrap is synchronous and comes FIRST regardless: it is the
 * primitive the SDK actually uses, so it must never depend on a resolution.
 */
export async function installGeminiNetworkGuard(): Promise<void> {
  if (installed) return
  installed = true

  globalThis.fetch = guardedFetch(globalThis.fetch)

  // Defense in depth for a transport 2.10.0 does not use. Wrapped rather than
  // replaced: everything that is not a provider hostname is delegated
  // unchanged, so the suite's localhost traffic is untouched.
  for (const moduleName of ['node:https', 'node:http'] as const) {
    const mod = await import(moduleName)
    const target = (mod.default ?? mod) as unknown as Record<string, unknown>
    for (const fn of ['request', 'get'] as const) {
      const original = target[fn]
      if (typeof original !== 'function') continue
      target[fn] = function guardedNodeRequest(this: unknown, ...args: unknown[]) {
        const { hostname, method } = describeNodeRequestTarget(args)
        assertNotProviderHost(hostname, method)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }
    }
  }
}

await installGeminiNetworkGuard()
