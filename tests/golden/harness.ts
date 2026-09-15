// tests/golden/harness.ts
//
// THE GOLDEN `test` — EVERY GOLDEN FILE IMPORTS FROM HERE, NOT FROM PLAYWRIGHT.
//
// ===========================================================================
// THE DEFECT THIS CLOSES
// ===========================================================================
// R1 defined `installNodeEgressGuard` and never called it. The guard existed,
// was documented, was unit-testable as a pure function — and was not in front
// of anything. A declared control with no call site is worse than no control,
// because it answers the question "is egress guarded?" with a file.
//
// ===========================================================================
// WHY A WORKER FIXTURE AND NOT globalSetup
// ===========================================================================
// The obvious repair is a `globalSetup` that installs the guard once. It would
// be wrong, and wrong in a way that still looks green.
//
// Playwright runs `globalSetup` in the RUNNER process and test files in WORKER
// processes. They are different operating-system processes with different
// module registries and different `globalThis`. A guard installed in the runner
// wraps the runner's `fetch`; the worker's `fetch` — the one every line of
// Golden test code would actually call — stays untouched.
//
// So the guard is installed by a WORKER-SCOPED, AUTO fixture. `scope: 'worker'`
// runs it once per worker process, and `auto: true` means no test has to
// remember to request it: a fixture that must be opted into is a control that
// is absent exactly where someone forgot.
//
// `tests/golden/meta/node-egress-guard.guard.ts` asserts that the pid that
// installed the guard is the pid asking the question. That is the empirical
// process-identity proof, rather than a claim that the fixture "should" run in
// the right place.
//
// ===========================================================================
// WHY THIS FILE IS THE ONLY IMPORT PATH
// ===========================================================================
// Importing `test` straight from `@playwright/test` anywhere under
// `tests/golden/` would produce a test that runs OUTSIDE the auto fixture, and
// therefore outside the guard. That is not a style rule: it is the failure mode
// this file exists to remove, so the meta guard scans for it and fails on it.

import { test as playwrightTest, expect } from '@playwright/test'
import { allowedHostnames, installNodeEgressGuard } from './network-guard'
import { resolveGoldenTarget } from './target'

/**
 * Worker-scoped fixtures. The value is `void` because nothing consumes it —
 * its entire purpose is the side effect, performed once per worker before any
 * test in that worker runs.
 */
interface GoldenWorkerFixtures {
  goldenNodeEgressGuard: void
}

// The test-scoped parameter is `object` and not `Record<string, never>`: the
// latter makes Playwright infer the fixture VALUE as `never`, so a worker
// fixture that legitimately produces `void` stops type-checking.
export const test = playwrightTest.extend<object, GoldenWorkerFixtures>({
  goldenNodeEgressGuard: [
    async ({}, use) => {
      // The allowlist is derived from the DECLARED target, so a run against a
      // Preview deployment permits that origin and nothing else. With no target
      // declared the allowlist is loopback only, which is the tightest it can
      // be and still let a local harness function.
      installNodeEgressGuard(allowedHostnames(resolveGoldenTarget().baseURL))
      await use()
    },
    { scope: 'worker', auto: true },
  ],
})

export { expect }
