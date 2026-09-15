// tests/golden/meta/node-egress-guard.guard.ts
//
// THE NODE EGRESS GUARD IS IN FRONT OF THIS PROCESS — PROVEN, NOT DECLARED.
//
// ===========================================================================
// WHAT WENT WRONG IN R1
// ===========================================================================
// R1 shipped `installNodeEgressGuard` with ZERO call sites. The function
// existed, was documented at length, and guarded nothing. Independent review
// found it by grepping for callers — which is the right way to audit a control,
// and a bar this file now has to clear permanently.
//
// The lesson is narrow and worth stating: a control's existence and a control's
// INSTALLATION are different facts, and only the second one protects anything.
// Every assertion below is about the second.
//
// ===========================================================================
// WHY THE PROCESS IDENTITY IS THE CENTRE OF THIS FILE
// ===========================================================================
// The tempting repair — a `globalSetup` that installs the guard once — would
// have been wrong in a way that still looks green. Playwright runs `globalSetup`
// in the RUNNER process and test files in WORKER processes: different OS
// processes, different module registries, different `globalThis`. A guard
// installed in the runner wraps the runner's `fetch` and leaves the worker's —
// the one Golden test code actually calls — untouched.
//
// So the guard is installed by a worker-scoped auto fixture in
// `tests/golden/harness.ts`, and the decisive assertion here is that the pid
// which installed the guard is the pid ASKING. Anything less is a claim about
// where the code "should" have run.
//
// ===========================================================================
// NO LIVE REQUEST IS EMITTED BY ANY PROOF BELOW
// ===========================================================================
// Two independent reasons, because one would be a habit rather than a property:
//
//   1. the forbidden host is under `.invalid`, reserved by RFC 2606 and
//      guaranteed never to resolve. Even with the guard removed — the mutation
//      case — nothing can leave the machine;
//   2. the delegation proofs use a SPY as the transport, never the real one, so
//      "reached the transport boundary" is observed as a spy call rather than
//      as a socket.

import { expect, test } from '../harness'
import {
  GoldenEgressBlockedError,
  allowedHostnames,
  fetchIsGuarded,
  guardedFetch,
  isHostAllowed,
  nodeEgressGuardState,
} from '../network-guard'
import { resolveGoldenTarget } from '../target'

/** Never resolves. See RFC 2606. */
const FORBIDDEN_URL = 'https://blocked.golden-pilot.invalid/v1/models:generateContent'
const LOOPBACK_URL = 'http://127.0.0.1:3100/verify/some-locator'

/** A transport stand-in that records calls and never opens a socket. */
function makeTransportSpy(): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = ((input: RequestInfo | URL) => {
    calls.push(String(input))
    return Promise.resolve(new Response('spy', { status: 200 }))
  }) as unknown as typeof fetch
  return { fn, calls }
}

test.describe('Golden Node egress guard', () => {
  // -------------------------------------------------------------------
  // PROOF 1 — the transport boundary is real and reachable when unguarded
  // -------------------------------------------------------------------
  test('PROOF 1 — unguarded, a forbidden request reaches the transport boundary', async () => {
    const spy = makeTransportSpy()

    // No guard between the caller and the transport: the call arrives. This
    // establishes that the spy IS the boundary, so PROOF 2's silence is
    // meaningful rather than an artefact of a spy that never records anything.
    await spy.fn(FORBIDDEN_URL)

    expect(spy.calls, 'the unguarded transport did not receive the request').toEqual([FORBIDDEN_URL])
  })

  // -------------------------------------------------------------------
  // PROOF 2 — guarded, the same request is refused BEFORE the transport
  // -------------------------------------------------------------------
  test('PROOF 2 — guarded, a forbidden request is refused synchronously and never reaches transport', () => {
    const spy = makeTransportSpy()
    const guarded = guardedFetch(spy.fn, allowedHostnames('http://127.0.0.1:3100'))

    // SYNCHRONOUS throw, asserted as a throw and not as a rejection. A rejected
    // promise would be swallowed by any `.catch()` the caller already has,
    // turning a hard stop into a retry against a host that will never answer.
    expect(() => guarded(FORBIDDEN_URL)).toThrow(GoldenEgressBlockedError)

    // The half that matters: refused BEFORE a socket could exist. A guard that
    // threw after delegating would satisfy the line above and leak the request.
    expect(spy.calls, 'the transport was reached despite the refusal').toEqual([])
  })

  // -------------------------------------------------------------------
  // PROOF 3 — allowed local traffic still passes through
  // -------------------------------------------------------------------
  test('PROOF 3 — guarded, allowed loopback traffic is delegated to the transport', async () => {
    const spy = makeTransportSpy()
    const guarded = guardedFetch(spy.fn, allowedHostnames('http://127.0.0.1:3100'))

    const response = await guarded(LOOPBACK_URL)

    expect(response.status).toBe(200)
    expect(spy.calls, 'allowed traffic was blocked, which would break a served tier').toEqual([
      LOOPBACK_URL,
    ])
  })

  // -------------------------------------------------------------------
  // PROOF 4 — THE PERMANENT CONTROL: the guard is active in THIS process
  // -------------------------------------------------------------------
  // Remove the auto fixture from harness.ts and this test goes RED. That is the
  // whole point: it is not possible to delete the installation and keep a green
  // battery, which is exactly what R1 permitted.
  test('PROOF 4 — the guard is installed in THIS worker process', () => {
    const state = nodeEgressGuardState()

    expect(state.installed, 'installNodeEgressGuard was never called in this process').toBe(true)
    expect(
      state.installedInPid,
      'the guard was installed in a DIFFERENT process than the one running this test; a ' +
        'globalSetup-style installation protects the runner and leaves the worker bare',
    ).toBe(process.pid)
    expect(
      state.fetchIsGuardedNow,
      'globalThis.fetch is not the guarded function; something replaced it after installation',
    ).toBe(true)
    expect(state.activeInThisProcess).toBe(true)
  })

  test('PROOF 4b — globalThis.fetch itself refuses a forbidden host synchronously', () => {
    // Behavioural, not structural. PROOF 4 reads a brand; this calls the thing.
    // A brand could in principle be stamped on a function that does not guard,
    // so the two assertions fail for different reasons and neither substitutes
    // for the other.
    expect(fetchIsGuarded(globalThis.fetch)).toBe(true)
    expect(() => globalThis.fetch(FORBIDDEN_URL)).toThrow(GoldenEgressBlockedError)
  })

  // -------------------------------------------------------------------
  // PROOF 5 — the allowlist cannot silently admit a provider host
  // -------------------------------------------------------------------
  test('PROOF 5 — no model-provider host is reachable under any declared target', () => {
    const providerHosts = [
      'generativelanguage.googleapis.com',
      'aiplatform.googleapis.com',
      'vertexai.googleapis.com',
      'api.openai.com',
    ]

    // Checked against the tier this run actually declared, not a hypothetical
    // one, so a target that widened the allowlist would fail here.
    const allowed = allowedHostnames(resolveGoldenTarget().baseURL)
    for (const host of providerHosts) {
      expect(isHostAllowed(host, allowed), `${host} is reachable from the Golden harness`).toBe(false)
    }
  })
})
