// tests/golden/j3-public-verifier.browser.journey.ts
//
// J3 — public verifier journey, browser leg.
//
// ===========================================================================
// THE DISCRIMINATION PROBLEM THIS FILE EXISTS TO NOT PAPER OVER
// ===========================================================================
// J3's two frozen steps are "resolve a public verification locator as an
// anonymous caller" and "its document rendering". Its frozen negative control
// intent is that "a non-existent or revoked locator must be refused".
//
// At this base those two produce the SAME observable result. `lib/reports/
// public-verify.ts` documents that after the runtime cutover an anonymous
// caller matches no member-scoped SELECT policy, so the query returns zero
// rows and the page calls `notFound()`. A locator that exists and a locator
// that does not both render 404.
//
// So the obvious negative control — "ask for a bogus locator, assert 404" —
// would pass today, would have passed before the cutover, and would keep
// passing if the refusal were removed entirely and replaced by a blanket 404.
// It discriminates nothing. Asserting it and calling J3's negative control
// satisfied would be the vacuous green this harness is built to refuse.
//
// What is asserted instead:
//
//   1. the bogus locator is refused, AND the refusal is NOT the verified
//      report — checked positively, by the absence of the page's own markers,
//      rather than by a status code alone;
//
//   2. the run records that the negative control CANNOT currently be
//      distinguished from the blocked positive, with the reason. That is a
//      weaker claim than "the negative control passed", and it is the true
//      one until an anonymous SELECT policy exists.
//
// The positive leg is not attempted. It needs a locator that resolves, which
// needs the pilot fixture materialised, which this lane does not do.

import { expect, test } from '@playwright/test'
import { PILOT_UNKNOWN_LOCATOR } from './fixtures/pilot-fixture'
import { installBrowserEgressGuard, allowedHostnames } from './network-guard'
import { probeAnonymousReadBlocked } from './posture'
import { resolveGoldenTarget } from './target'

const target = resolveGoldenTarget()

test.describe('J3 — public verifier journey (browser)', () => {
  test.beforeEach(async ({ context }) => {
    // The page under test issues its own requests, and none of them pass
    // through the runner's `fetch`. Without this the journey would be free to
    // reach any third party the application happens to call.
    await installBrowserEgressGuard(context, allowedHostnames(target.baseURL))
  })

  test('J3 negative control — an unknown locator is refused and is not the verified report', async ({
    page,
  }) => {
    const response = await page.goto(`/verify/${PILOT_UNKNOWN_LOCATOR}`)

    // A refusal, not a server error. A 500 would mean the surface fell over
    // rather than refused, and those are different conditions with different
    // remedies — conflating them is how an outage gets recorded as a control.
    expect(response, 'the verify surface returned no response at all').not.toBeNull()
    expect(
      response?.status(),
      'an unknown locator must be refused, not answered and not crashed',
    ).toBe(404)

    // The refusal is checked by what the page does NOT contain. A status code
    // can be right while the body leaks a report; the verified page's own
    // markers are the discriminating signal.
    await expect(page.getByRole('heading', { name: /Reporte Audit-Ready Verificado/i })).toHaveCount(0)
    await expect(page.getByTestId('verify-no-ratio')).toHaveCount(0)
  })

  test('J3 — the negative control is currently indistinguishable from the blocked positive', () => {
    const reading = probeAnonymousReadBlocked()

    // While the anonymous read is fail-closed, a 404 proves only that nothing
    // was returned — it cannot separate "no such locator" from "this locator
    // exists and you may not read it". Recording that is the honest state.
    //
    // When an anonymous SELECT policy lands, this flips and the assertion
    // fails, which is the signal that J3's negative control must be rewritten
    // to discriminate a real locator from a bogus one.
    expect(
      reading.blockerStillPresent,
      'the anonymous read is no longer fail-closed, so J3 can and must now distinguish a ' +
        'resolvable locator from an unknown one instead of recording them as indistinguishable',
    ).toBe(true)
  })
})
