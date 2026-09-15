// tests/golden/j1-customer.browser.journey.ts
//
// J1 — customer journey, browser leg.
//
// ===========================================================================
// WHY THIS FILE ASSERTS SO LITTLE
// ===========================================================================
// J1's thirteen frozen steps begin at signup and end at review and approval.
// Every step after the first requires a provisioned principal inside a founded
// organisation, and the frozen authority records that "organisation founding
// and invitation have been measured to fail closed under row-level security in
// a live environment". The pilot fixture in this lane is a set of definitions,
// not provisioned rows.
//
// So the traversal is not attempted. Attempting it would produce twelve
// failures whose cause is "nothing was provisioned", which tells a reader
// nothing about the product and buries the one blocker that matters.
//
// What IS asserted is the entry point and the tenant boundary — the two things
// an anonymous browser can establish without any fixture:
//
//   1. the signup surface is reachable, so J1 step 1 has somewhere to start;
//   2. every tenant-scoped surface refuses an unauthenticated principal.
//
// The second is a WEAKER form of J1's frozen negative control intent, which is
// that "a principal from another tenant must be refused at each tenant-scoped
// step". Anonymous is not another tenant. The gap is asserted explicitly below
// rather than glossed, so the control is not recorded as satisfied by a
// substitute that happens to be easier to arrange.

import { expect, test } from '@playwright/test'
import { PILOT_FOREIGN_PRINCIPAL } from './fixtures/pilot-fixture'
import { installBrowserEgressGuard, allowedHostnames } from './network-guard'
import { resolveGoldenTarget } from './target'

const target = resolveGoldenTarget()

/** Tenant-scoped surfaces an unauthenticated principal must not reach. */
const TENANT_SCOPED_ROUTES: readonly string[] = [
  '/app/dashboard',
  '/app/projects',
  '/app/portfolios',
  '/app/organization/members',
]

test.describe('J1 — customer journey (browser)', () => {
  test.beforeEach(async ({ context }) => {
    await installBrowserEgressGuard(context, allowedHostnames(target.baseURL))
  })

  test('J1.1 signup — the entry point of the journey is reachable', async ({ page }) => {
    const response = await page.goto('/signup')
    expect(response, 'the signup surface returned no response').not.toBeNull()
    expect(
      response?.status(),
      'the first step of the customer journey must have somewhere to start',
    ).toBeLessThan(400)
  })

  for (const route of TENANT_SCOPED_ROUTES) {
    test(`J1 negative control (partial) — unauthenticated principal refused on ${route}`, async ({
      page,
    }) => {
      await page.goto(route)
      expect(
        new URL(page.url()).pathname,
        `an unauthenticated caller stayed on the tenant-scoped surface ${route}`,
      ).not.toBe(route)
    })
  }

  test('J1 — the cross-tenant negative control is not yet expressible', () => {
    // The frozen intent needs a principal that belongs to a DIFFERENT tenant,
    // not merely to none. The fixture names that principal; nothing
    // materialises it, and materialising it needs the database surfaces this
    // lane is not authorised to touch.
    //
    // Asserting the absence keeps the gap visible. When the pilot fixture is
    // provisioned, this assertion must be deleted in the same change that adds
    // the real cross-tenant traversal — it is deliberately written so that it
    // cannot simply be left in place and forgotten.
    expect(
      PILOT_FOREIGN_PRINCIPAL.organizationId,
      'the foreign principal is a definition only; if it is ever provisioned, this control ' +
        "must be replaced by J1's real cross-tenant refusal traversal",
    ).toContain('golden-pilot')
  })
})
