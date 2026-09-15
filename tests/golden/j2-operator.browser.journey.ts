// tests/golden/j2-operator.browser.journey.ts
//
// J2 — operator journey, browser leg.
//
// ===========================================================================
// THE ONE CONTROL THAT IS GENUINELY EXECUTABLE WITHOUT PROVISIONING
// ===========================================================================
// J2's eight frozen steps all require an operator principal, which requires a
// provisioned account this lane does not create. Its NEGATIVE control does
// not: "a non-operator principal must be refused on every operator surface".
// An anonymous caller is a non-operator principal, and it needs no fixture.
//
// So the refusal is asserted across every operator surface the frozen path
// names, derived from that path rather than from a hand-written list — the
// same reason the contract suite derives its steps.
//
// ===========================================================================
// THE HALF OF THE INTENT THAT CANNOT BE SATISFIED YET
// ===========================================================================
// The frozen intent has a second clause: the control "must prove the platform
// principal is distinguishable from a tenant role value rather than assuming
// it". An anonymous caller cannot prove that. Proving it needs two provisioned
// principals — one holding the `is_super_admin` flag, one holding the tenant
// role `super_admin` — and a demonstration that only the first reaches the
// operator surface.
//
// That half is therefore NOT claimed here. It is asserted as still-blocked, so
// that when the ambiguity is resolved in `db/schema.ts` the assertion fails and
// forces this control to be completed rather than left half-built behind a
// green tick.

import { expect, test } from '@playwright/test'
import { installBrowserEgressGuard, allowedHostnames } from './network-guard'
import { probePlatformPrincipalAmbiguity } from './posture'
import { resolveGoldenTarget } from './target'

const target = resolveGoldenTarget()

/**
 * The operator surfaces, as routes.
 *
 * Mapped from the frozen J2 path to the routes that implement it. The mapping
 * is written out because the authority names surfaces in prose and the
 * application names them as paths; there is no derivation that bridges those
 * two without inventing one. What is NOT written out is which surfaces exist —
 * that stays the authority's decision, and a surface added to the frozen path
 * without an entry here fails the contract suite, not this file.
 */
const OPERATOR_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['signup-allowlist', '/admin/access'],
  ['organisations', '/admin/organizations'],
  ['audit-logs', '/admin/logs'],
  ['statistics', '/admin'],
  ['proxies', '/admin/proxies'],
  ['assistant-services', '/admin/services'],
  ['deletion-approval', '/admin/project-deletions'],
]

test.describe('J2 — operator journey (browser)', () => {
  test.beforeEach(async ({ context }) => {
    await installBrowserEgressGuard(context, allowedHostnames(target.baseURL))
  })

  for (const [stepId, route] of OPERATOR_ROUTES) {
    test(`J2 negative control — anonymous principal refused on ${stepId} (${route})`, async ({ page }) => {
      await page.goto(route)

      // The refusal is a redirect away from the operator surface, so the
      // assertion is on where the browser ENDED UP, not on a status code: a
      // server-side redirect resolves before the response is observed.
      expect(
        new URL(page.url()).pathname,
        `an anonymous caller stayed on the operator surface ${route}`,
      ).not.toBe(route)

      // And positively: none of the admin chrome rendered. A redirect that
      // landed somewhere unexpected but still showed operator content would
      // satisfy a path check alone.
      await expect(page.getByRole('link', { name: 'Uellix Admin' })).toHaveCount(0)
    })
  }

  test('J2 — the platform/tenant principal distinction is not yet provable', () => {
    const reading = probePlatformPrincipalAmbiguity()
    expect(
      reading.blockerStillPresent,
      'the platform principal no longer shares the super_admin literal with a tenant role, so ' +
        "J2's negative control must now prove the distinction with two provisioned principals " +
        'rather than recording it as unprovable',
    ).toBe(true)
  })
})
