/* eslint-disable @typescript-eslint/no-explicit-any */
// tests/auth/route-authorization-boundary.test.ts
//
// The redirect graph, and the topology that makes it terminate.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------
// `requireOrganizationAccess()` sends a member-less user to `/app/onboarding`.
// That route used to live at `app/app/onboarding/`, i.e. INSIDE the layout that
// issues the redirect, so the destination re-entered the gate and redirected to
// itself. MEASURED on the hosted preview as ERR_TOO_MANY_REDIRECTS: dozens of
// `GET /app/onboarding 307` and ZERO 500s — a routing cycle, not a privilege
// failure.
//
// A redirect whose Location equals the request pathname is the signature, and
// `assertNoSelfRedirect` below makes it a first-class assertion rather than
// something a reader has to notice.
//
// ---------------------------------------------------------------------------
// WHY HALF OF THIS SUITE READS THE FILESYSTEM
// ---------------------------------------------------------------------------
// In the App Router, WHICH LAYOUTS WRAP A PAGE is a property of where the file
// sits, not of anything the page can assert about itself. A behavioural test
// that called the page directly would have passed happily on the broken tree,
// because the page was never the problem — its ancestor was. So the topology is
// asserted as topology, and the behaviour of each boundary is asserted
// separately underneath it.
//
// The invariant is deliberately EXACT-MATCH rather than "onboarding is outside
// the gate": the security default in this codebase is that everything under
// `app/app/` requires an organisation, and the only way that default erodes is
// by a second route quietly joining the carve-out.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

// ---------------------------------------------------------------------------
// Mocks — declared before the modules under test are imported
// ---------------------------------------------------------------------------

const mockRedirect = vi.fn((p: string) => {
  throw new Error(`REDIRECT:${p}`)
})
vi.mock('next/navigation', () => ({
  redirect: (p: string) => mockRedirect(p),
}))

const mockLoadRequestPrincipal = vi.fn()
// TENANCY-S3-SELECTOR-REACHABILITY (Packet A): the enumerator
// requireOrganizationAccess() now calls for R2. Reset to a rejection by
// default (never a silent []) so a test that forgets to arm it fails loudly
// instead of quietly behaving like the zero-candidate case.
const mockListSelectableMemberships = vi.fn()
vi.mock('@/lib/auth/database-context', () => ({
  loadRequestPrincipal: () => mockLoadRequestPrincipal(),
  listSelectableMemberships: () => mockListSelectableMemberships(),
  withOptionalDatabaseIdentityContext: (cb: any) => cb(null),
  withOrganizationDatabaseContext: (cb: any) => cb(),
  withSuperAdminDatabaseContext: (cb: any) => cb(),
}))

// R3 clears the carrier through this module. Mocked here (rather than left
// real) because this suite never opens next/headers' cookie jar — the
// mechanism itself is proven against a real cookie store in
// tests/auth/session.test.ts and tests/tenancy/s2-selected-org-carrier.test.ts.
const mockClearSelectedOrganization = vi.fn(async () => undefined)
vi.mock('@/lib/auth/selected-organization', () => ({
  clearSelectedOrganization: () => mockClearSelectedOrganization(),
}))

// The onboarding page imports its server action, which reaches `@/db/client`.
// It is left unmocked because it needs no mock: that client is a lazy Proxy
// (db/client.ts) which resolves a connection only on property access, and this
// suite never triggers one — the page is called for its redirect decision, not
// rendered against data.

// Workspace chrome: this suite is about authorization, not rendering.
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/components/layout/TopBar', () => ({ TopBar: () => null }))
vi.mock('@/components/auth/OnboardingCheck', () => ({ OnboardingCheck: () => null }))

// MEASURED, so that a future reader is not surprised by the failure MODE: if
// the onboarding route is ever moved back under the gated layout, this file
// does not fail an assertion — it fails to COLLECT, with
//
//   Failed to resolve import "@/app/(authenticated)/app/onboarding/page" …
//   Does the file exist?
//
// which names the moved file outright. Vite's import analysis is static, so a
// dynamic `await import()` of a literal path behaves identically; deferring it
// buys nothing and was tried. The suite reports "no tests" alongside that
// error, and the error — not the count — is the diagnosis.
import AuthenticatedLayout from '@/app/(authenticated)/layout'
import OnboardingPage from '@/app/(authenticated)/app/onboarding/page'
import PrivateLayout from '@/app/app/layout'

// ---------------------------------------------------------------------------
// Principal fixtures
// ---------------------------------------------------------------------------

const USER = { id: '00000000-0000-4000-8000-00000000f001', email: 'f1@example.test', isSuperAdmin: false }
const SUPER = { ...USER, isSuperAdmin: true }
const ORG = { id: '00000000-0000-4000-8000-0000000000aa', name: 'Org', onboardingCompleted: true }
const MEMBERSHIP = { id: 'm1', role: 'organization_admin', organizationId: ORG.id, userId: USER.id }

// One SelectableMembership per candidate organization — the enumerator's
// shape (lib/auth/database-context.ts SelectableMembership), never a
// principal.
const CANDIDATE_A = {
  membership: { id: 'sm-a', role: 'organization_admin', organizationId: 'org-a', userId: USER.id, status: 'active' },
  organization: { id: 'org-a', name: 'Org A', onboardingCompleted: true },
}
const CANDIDATE_B = {
  membership: { id: 'sm-b', role: 'analyst', organizationId: 'org-b', userId: USER.id, status: 'active' },
  organization: { id: 'org-b', name: 'Org B', onboardingCompleted: true },
}

const anonymous = () => mockLoadRequestPrincipal.mockResolvedValue(null)

// TENANCY-S3-SELECTOR-REACHABILITY (Packet A) — E1 forced edit. The single
// memberless() fixture used to set NO organizationRefusalCode and stub NO
// enumerator, so it could not distinguish genuine memberless/founding from
// member-with-no-carrier: the direct fixture-level image of the production
// defect. Split into two fixtures that differ ONLY in the enumerator's
// answer, both carrying the SAME refusal code (R2's precondition).

// PACKET B — S-IA-PRINCIPAL-FIXTURES-EXPLICITLY-VERIFIED: every fixture in
// this suite is a Packet A scenario re-driven under Packet B, so each one is
// pinned EXPLICITLY as a VERIFIED principal. `emailVerified` is REQUIRED on
// RequestPrincipal precisely so this cannot be left implicit — an omitted
// field here would silently measure every one of these fixtures as
// unverified and redirect them all to /verify-email instead of exercising
// Packet A's own routing at all.

/** RETURN SITE 1, zero candidates — genuine founding (R2.branch_zero). */
const noCarrierNoCandidates = (user = USER) => {
  mockLoadRequestPrincipal.mockResolvedValue({
    user,
    membership: null,
    organization: null,
    organizationRefusalCode: 'TENANCY_NO_ORGANIZATION_SELECTED',
    emailVerified: true,
    accountAcceptanceCurrent: true,
  })
  mockListSelectableMemberships.mockResolvedValue([])
}

/** RETURN SITE 1, one-or-more candidates — member without a carrier (R2.branch_one_or_more). */
const noCarrierWithCandidates = (user = USER, candidates: unknown[] = [CANDIDATE_A]) => {
  mockLoadRequestPrincipal.mockResolvedValue({
    user,
    membership: null,
    organization: null,
    organizationRefusalCode: 'TENANCY_NO_ORGANIZATION_SELECTED',
    emailVerified: true,
    accountAcceptanceCurrent: true,
  })
  mockListSelectableMemberships.mockResolvedValue(candidates)
}

/** RETURN SITE 2 — stale/non-member carrier (R3's precondition). */
const staleCarrier = (user = USER) =>
  mockLoadRequestPrincipal.mockResolvedValue({
    user,
    membership: null,
    organization: null,
    organizationRefusalCode: 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER',
    emailVerified: true,
    accountAcceptanceCurrent: true,
  })

/** RETURN SITE 3 — membership DEMONSTRABLY EXISTS; only the organisation row is unreadable (R4's precondition). */
const memberWithUnreadableOrganization = () =>
  mockLoadRequestPrincipal.mockResolvedValue({
    user: USER,
    membership: MEMBERSHIP,
    organization: null,
    organizationRefusalCode: 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER',
    emailVerified: true,
    accountAcceptanceCurrent: true,
  })

const member = () =>
  mockLoadRequestPrincipal.mockResolvedValue({
    user: USER,
    membership: MEMBERSHIP,
    organization: ORG,
    organizationRefusalCode: null,
    emailVerified: true,
    accountAcceptanceCurrent: true,
  })

/** Run a route entry point and report the redirect it issued, or null. */
async function locationOf(entry: () => Promise<unknown>): Promise<string | null> {
  try {
    await entry()
    return null
  } catch (error) {
    const message = (error as Error).message
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length)
    throw error
  }
}

/** The assertion the outage would have failed. */
function assertNoSelfRedirect(pathname: string, location: string | null) {
  expect(
    location,
    `${pathname} redirected to itself — this is the ERR_TOO_MANY_REDIRECTS signature`
  ).not.toBe(pathname)
}

beforeEach(() => {
  mockRedirect.mockClear()
  mockLoadRequestPrincipal.mockReset()
  mockListSelectableMemberships.mockReset()
  mockClearSelectedOrganization.mockClear()
})

// ---------------------------------------------------------------------------
// A. TOPOLOGY — which layouts wrap which routes
// ---------------------------------------------------------------------------

describe('route topology: AUTHENTICATED is separated from ORGANIZATION_REQUIRED', () => {
  it('serves /app/onboarding from OUTSIDE the organisation-gated directory', () => {
    expect(existsSync(path.join(ROOT, 'app/(authenticated)/app/onboarding/page.tsx'))).toBe(true)
    // The old location. Its return would reinstate the cycle verbatim.
    expect(
      existsSync(path.join(ROOT, 'app/app/onboarding/page.tsx')),
      'onboarding is back inside the organisation-gated layout'
    ).toBe(false)
  })

  it('the /app layout gates on the organisation, and the (authenticated) layout does not', () => {
    const gated = read('app/app/layout.tsx')
    const authOnly = read('app/(authenticated)/layout.tsx')

    expect(gated).toMatch(/await requireOrganizationAccess\(\)/)

    // The load-bearing half: the onboarding ancestor must NOT call the gate
    // that redirects to onboarding. Comments are stripped so the explanation
    // in that file's header — which names the function — cannot satisfy this.
    const authOnlyCode = authOnly.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(authOnlyCode).toMatch(/await requireAuth\(\)/)
    expect(authOnlyCode).not.toMatch(/requireOrganizationAccess/)
  })

  // S2 (docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.1.json
  // S2_ROUTE_TOPOLOGY_DECISION) adds a second pre-organization route,
  // app/(authenticated)/app/organizations/select/page.tsx. A ONE-LEVEL
  // directory-name sweep reports its top-level name as `organizations`, which
  // is indistinguishable from a top-level carve-out of the WHOLE
  // `organizations/**` subtree — silently authorizing `organizations/create`,
  // `organizations/[id]` or any future sibling that has never been
  // adjudicated as pre-organization. The sweep below is a RECURSIVE
  // route-path enumeration keyed on route-SERVING files, so the carve-out is
  // exactly as wide as the routes that actually exist.
  const ROUTE_SERVING_FILE_NAMES = ['page.tsx', 'page.ts', 'route.ts', 'route.tsx']

  /**
   * Every route-serving path (relative to `app/<group>/app/`, joined with
   * `/`) reachable beneath `dir`. A directory contributes a path only if it
   * (or a descendant) directly contains one of ROUTE_SERVING_FILE_NAMES —
   * this is what makes a nested route like `organizations/select` collapse
   * to that one string instead of the top-level `organizations`.
   */
  function collectRouteServingPaths(dir: string, prefix: string[] = []): string[] {
    const found: string[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return found
    }

    const servesRouteHere = entries.some(
      (e) => e.isFile() && ROUTE_SERVING_FILE_NAMES.includes(e.name)
    )
    if (servesRouteHere && prefix.length > 0) {
      found.push(prefix.join('/'))
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        found.push(...collectRouteServingPaths(path.join(dir, entry.name), [...prefix, entry.name]))
      }
    }

    return found
  }

  it('carves out EXACTLY the declared pre-organization routes — every other /app/* page stays gated', () => {
    // Route groups are stripped from the URL, so any `app/(group)/app/**` also
    // serves `/app/*` while escaping app/app/layout.tsx. Enumerate every
    // route-serving path they contribute and require the set to be exactly
    // the declared exception.
    const groups = readdirSync(path.join(ROOT, 'app'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('(') && e.name.endsWith(')'))
      .map((e) => e.name)

    const ungated: string[] = []
    for (const group of groups) {
      const groupAppDir = path.join(ROOT, 'app', group, 'app')
      if (!existsSync(groupAppDir)) continue
      ungated.push(...collectRouteServingPaths(groupAppDir))
    }

    expect([...new Set(ungated)].sort()).toEqual(['onboarding', 'organizations/select'])
  })

  // -------------------------------------------------------------------------
  // T-B-2 (Packet B) — the verification destination is pinned outside every
  // completeness point and outside C3.
  // -------------------------------------------------------------------------
  //
  // Mechanically identical in spirit to the circular-gate control just below:
  // if /verify-email is ever served from inside a group that calls
  // requireAuth() or requireOrganizationAccess(), either one would redirect
  // an unverified subject straight back to it, reproducing the exact
  // ERR_TOO_MANY_REDIRECTS shape recorded at app/(authenticated)/layout.tsx
  // :8-30 for the pre-organization case. This does not edit the carve-out
  // assertion above — doing so would itself be a STOP signal
  // (S-IA-ROUTE-CARVEOUT-UNCHANGED), because /verify-email is served from
  // app/(public)/, not from either organisation-gated route group.

  it('T-B-2: app/(public)/verify-email/page.tsx exists', () => {
    expect(existsSync(path.join(ROOT, 'app/(public)/verify-email/page.tsx'))).toBe(true)
  })

  it('T-B-2: the verification destination is NOT served from either organisation-gated route group', () => {
    expect(
      existsSync(path.join(ROOT, 'app/(authenticated)/app/verify-email')),
      'the verification destination is back inside the C3-only authenticated group'
    ).toBe(false)
    expect(
      existsSync(path.join(ROOT, 'app/app/verify-email')),
      'the verification destination is back inside the C4-gated workspace'
    ).toBe(false)
  })

  it('does NOT authorize the organization-gated location for the selector — the circular gate', () => {
    // Mechanically identical to the onboarding old-location control above:
    // if the selector is ever served from inside app/app/, the layout that
    // gates on an organization would gate the very page that selects one.
    expect(
      existsSync(path.join(ROOT, 'app/app/organizations/select/page.tsx')),
      'the organization selector is back inside the organisation-gated layout — the circular gate'
    ).toBe(false)
  })

  it('SINGULAR app/app/organization/ stays organization-gated; PLURAL organizations/select is the only ungated member of its subtree', () => {
    // The two names differ by one character and sit one directory apart. A
    // grep, a rename or a hurried review could conflate them — either
    // ungating the workspace or re-gating the selector into the cycle.
    expect(
      existsSync(path.join(ROOT, 'app/app/organization')),
      'the singular organization workspace must remain inside app/app/'
    ).toBe(true)
    expect(
      existsSync(path.join(ROOT, 'app/(authenticated)/app/organizations/select/page.tsx')),
      'the plural pre-organization selector must exist at its declared location'
    ).toBe(true)
  })

  it('STRICTNESS PROOF: the recursive enumeration is strictly stronger than the one-level sweep it replaces', () => {
    // Reproduces the OLD one-level sweep inline (rather than re-importing a
    // deleted implementation) so both controls can be driven over the same
    // fixture trees and compared row by row.
    function oldOneLevelSweep(root: string): string[] {
      const grps = readdirSync(path.join(root, 'app'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('(') && e.name.endsWith(')'))
        .map((e) => e.name)
      const out: string[] = []
      for (const g of grps) {
        const groupAppDir = path.join(root, 'app', g, 'app')
        if (!existsSync(groupAppDir)) continue
        for (const entry of readdirSync(groupAppDir, { withFileTypes: true })) {
          if (entry.isDirectory()) out.push(entry.name)
        }
      }
      return out.sort()
    }

    function newRecursiveSweep(root: string): string[] {
      const grps = readdirSync(path.join(root, 'app'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('(') && e.name.endsWith(')'))
        .map((e) => e.name)
      const out: string[] = []
      for (const g of grps) {
        const groupAppDir = path.join(root, 'app', g, 'app')
        if (!existsSync(groupAppDir)) continue
        out.push(...collectRouteServingPaths(groupAppDir))
      }
      return [...new Set(out)].sort()
    }

    // Row 1: CURRENT TREE — identical verdict, proving no currently-failing
    // control is being repaired and no regression is introduced today.
    expect(newRecursiveSweep(ROOT)).toEqual(['onboarding', 'organizations/select'])
    expect(oldOneLevelSweep(ROOT)).not.toEqual(['onboarding']) // already invalidated by S2 landing — see next row
    expect(oldOneLevelSweep(ROOT)).toEqual(['onboarding', 'organizations'])

    // Rows 2-4: mutation fixtures built on a real disposable directory tree,
    // never asserted from reasoning alone.
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'route-topology-fixture-'))
    try {
      const mk = (...segments: string[]) => {
        const p = path.join(fixtureRoot, ...segments)
        fs.mkdirSync(p, { recursive: true })
        return p
      }
      const touch = (dir: string, name: string) => fs.writeFileSync(path.join(dir, name), '')

      // Baseline fixture: reproduces today's authorized carve-out.
      touch(mk('app', '(authenticated)', 'app', 'onboarding'), 'page.tsx')
      touch(mk('app', '(authenticated)', 'app', 'organizations', 'select'), 'page.tsx')

      // Row: WITH S2 — both controls agree the baseline fixture is exactly
      // the declared carve-out.
      expect(newRecursiveSweep(fixtureRoot)).toEqual(['onboarding', 'organizations/select'])

      // Row: MUTATION organizations/create/page.tsx — THE LOAD-BEARING ROW.
      // The widening the old sweep would have silently authorized.
      touch(mk('app', '(authenticated)', 'app', 'organizations', 'create'), 'page.tsx')
      expect(oldOneLevelSweep(fixtureRoot)).toEqual(['onboarding', 'organizations']) // unchanged — blind to the new route
      expect(newRecursiveSweep(fixtureRoot)).not.toEqual(['onboarding', 'organizations/select'])
      expect(newRecursiveSweep(fixtureRoot)).toContain('organizations/create')

      // Row: MUTATION organizations/[id]/page.tsx — dynamic segments caught
      // identically; the rule is path-shaped, not name-shaped.
      touch(mk('app', '(authenticated)', 'app', 'organizations', '[id]'), 'page.tsx')
      expect(newRecursiveSweep(fixtureRoot)).toContain('organizations/[id]')

      // Row: MUTATION onboarding/step2/page.tsx — closes a PRE-EXISTING
      // blind spot in the OLD control, unrelated to S2: it reports only the
      // top-level name `onboarding` and cannot see a nested ungated route at
      // all, while the new control does.
      touch(mk('app', '(authenticated)', 'app', 'onboarding', 'step2'), 'page.tsx')
      expect(oldOneLevelSweep(fixtureRoot)).toEqual(['onboarding', 'organizations']) // still blind
      expect(newRecursiveSweep(fixtureRoot)).toContain('onboarding/step2')
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('the workspace routes are still inside the gated directory', () => {
    const gatedRoutes = readdirSync(path.join(ROOT, 'app/app'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()

    // Named explicitly: a route silently leaving app/app/ would leave the gate.
    for (const route of ['dashboard', 'organization', 'portfolios', 'projects', 'trust-center']) {
      expect(gatedRoutes, `/app/${route} left the organisation gate`).toContain(route)
    }
    expect(existsSync(path.join(ROOT, 'app/app/layout.tsx'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B. THE REDIRECT GRAPH
// ---------------------------------------------------------------------------

describe('redirect graph: /app/onboarding', () => {
  it('1. unauthenticated -> /login', async () => {
    anonymous()
    const location = await locationOf(() => AuthenticatedLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/login')
  })

  it('2. authenticated, membership=null, ZERO candidates -> RENDERS, and never redirects to itself', async () => {
    noCarrierNoCandidates()

    const layoutLocation = await locationOf(
      () => AuthenticatedLayout({ children: null }) as Promise<unknown>
    )
    expect(layoutLocation, 'the authenticated layout redirected a member-less user').toBeNull()

    const pageLocation = await locationOf(
      () => OnboardingPage({ searchParams: Promise.resolve({}) }) as Promise<unknown>
    )
    expect(pageLocation, 'the onboarding page redirected a member-less user with zero candidates').toBeNull()

    assertNoSelfRedirect('/app/onboarding', layoutLocation)
    assertNoSelfRedirect('/app/onboarding', pageLocation)
  })

  it('P-A1-2 (onboarding page entry point): membership=null, ONE candidate -> /app/organizations/select, never the creation form', async () => {
    noCarrierWithCandidates()
    const pageLocation = await locationOf(
      () => OnboardingPage({ searchParams: Promise.resolve({}) }) as Promise<unknown>
    )
    expect(pageLocation).toBe('/app/organizations/select')
  })

  it('3. authenticated, membership exists -> /app/dashboard', async () => {
    member()
    const location = await locationOf(
      () => OnboardingPage({ searchParams: Promise.resolve({}) }) as Promise<unknown>
    )
    expect(location).toBe('/app/dashboard')
  })
})

describe('redirect graph: organisation-gated workspace routes', () => {
  it('4. authenticated, membership=null, ZERO candidates -> /app/onboarding', async () => {
    noCarrierNoCandidates()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/onboarding')
    // …and the destination is NOT this layout, which is the whole repair.
    assertNoSelfRedirect('/app/dashboard', location)
  })

  it('P-A1-2: authenticated, membership=null, exactly ONE candidate -> /app/organizations/select — the load-bearing positive control (NO_AUTO_SELECTION, no shortcut)', async () => {
    noCarrierWithCandidates(USER, [CANDIDATE_A])
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/organizations/select')
    assertNoSelfRedirect('/app/dashboard', location)
  })

  it('P-A1-3: authenticated, membership=null, TWO candidates -> /app/organizations/select — held separately from P-A1-2 so a collapsed single-candidate branch is visible', async () => {
    noCarrierWithCandidates(USER, [CANDIDATE_A, CANDIDATE_B])
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/organizations/select')
  })

  it('6. authenticated, membership exists -> allowed', async () => {
    member()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBeNull()
  })

  it.each([
    ['zero candidates', () => noCarrierNoCandidates(SUPER)],
    ['one-or-more candidates', () => noCarrierWithCandidates(SUPER, [CANDIDATE_A])],
  ])(
    'P-A1-4 / 7. super admin without a membership -> /admin, contract preserved, insensitive to the enumerator (%s)',
    async (_label, setup) => {
      setup()
      const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
      expect(location).toBe('/admin')
    }
  )

  it('N-A1-4: RETURN SITE 3 (membership exists, organisation row unreadable) -> /app/onboarding, unchanged — NOT swept into the stale-carrier branch', async () => {
    memberWithUnreadableOrganization()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/onboarding')
    expect(mockClearSelectedOrganization, 'a valid member\'s carrier must never be cleared').not.toHaveBeenCalled()
    expect(mockListSelectableMemberships, 'R4 is excluded before the enumerator is ever consulted').not.toHaveBeenCalled()
  })

  it('N-A1-2 / R3: stale/non-member carrier -> selector, carrier cleared, enumerator never consulted (no substitution is possible if no candidate is even read)', async () => {
    staleCarrier()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/organizations/select')
    expect(mockClearSelectedOrganization).toHaveBeenCalledTimes(1)
    expect(mockListSelectableMemberships).not.toHaveBeenCalled()
  })

  it('unauthenticated -> /login, ahead of any organisation question', async () => {
    anonymous()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/login')
  })
})

// ---------------------------------------------------------------------------
// E. N-A1-1 — NO CARRIER WRITE DURING ROUTING (R2)
// ---------------------------------------------------------------------------
//
// The single most important negative control in the manifest: it is the
// only one that can tell a compliant selector redirect apart from an
// auto-selection that happens to redirect to the selector afterwards
// (NO_AUTO_SELECTION; ROUTING_CONTRACT.NO_CARRIER_WRITE_DURING_ROUTING).

describe('N-A1-1: no carrier write during routing', () => {
  it('lib/auth/session.ts contains no path capable of WRITING (selecting) the carrier — only clearSelectedOrganization is imported, never setSelectedOrganization', () => {
    const source = read('lib/auth/session.ts')
    expect(source).not.toMatch(/\bsetSelectedOrganization\b/)
  })

  it.each([
    ['zero candidates', () => noCarrierNoCandidates()],
    ['one candidate', () => noCarrierWithCandidates(USER, [CANDIDATE_A])],
    ['two candidates', () => noCarrierWithCandidates(USER, [CANDIDATE_A, CANDIDATE_B])],
  ])('%s: R2 never calls the carrier-clearing mechanism either — it only enumerates, it never touches the carrier', async (_label, setup) => {
    setup()
    await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(mockClearSelectedOrganization).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// F. N-A1-3 — ENUMERATOR FAILURE FAILS CLOSED
// ---------------------------------------------------------------------------

describe('N-A1-3: enumerator failure fails closed, never a membership fallback', () => {
  it('a rejected enumerator propagates as a failure — never a redirect to onboarding, dashboard, or the selector', async () => {
    mockLoadRequestPrincipal.mockResolvedValue({
      user: USER,
      membership: null,
      organization: null,
      organizationRefusalCode: 'TENANCY_NO_ORGANIZATION_SELECTED',
      emailVerified: true,
      accountAcceptanceCurrent: true,
    })
    mockListSelectableMemberships.mockRejectedValue(new Error('enumerator unavailable'))

    await expect(PrivateLayout({ children: null }) as Promise<unknown>).rejects.toThrow('enumerator unavailable')
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// G. N-A1-5 — NO NEW AUDIT EVENT FOR AN ABSENT CARRIER
// ---------------------------------------------------------------------------

describe('N-A1-5: no new audit event for an absent carrier', () => {
  it('none of the repaired routing files import any audit emitter', () => {
    for (const file of [
      'lib/auth/session.ts',
      'app/(public)/login/actions.ts',
      'app/auth/callback/route.ts',
      'app/(authenticated)/app/onboarding/page.tsx',
    ]) {
      const source = read(file)
      expect(
        source,
        `${file} must not emit any audit event from routing`
      ).not.toMatch(/emitOrganizationSelectionRefused|emitMembershipRevalidationRefused|logAuditAction/)
    }
  })
})

// ---------------------------------------------------------------------------
// H. T-A1-1 — TERMINATION: THE SELECTOR GRAPH HAS NO REDIRECT LOOP
// ---------------------------------------------------------------------------

describe('T-A1-1: the selector graph has no redirect loop', () => {
  it('the selector page never calls requireOrganizationAccess and issues no redirect at all — it cannot re-enter the organisation gate or cycle back to itself', () => {
    const selectorPage = read('app/(authenticated)/app/organizations/select/page.tsx')
    expect(selectorPage).not.toMatch(/requireOrganizationAccess/)
    expect(selectorPage).not.toMatch(/redirect\(/)
  })

  it('neither /app/onboarding nor /app/organizations/select acquires an outbound redirect to itself, for any candidate count', () => {
    const onboardingPage = read('app/(authenticated)/app/onboarding/page.tsx')
    expect(onboardingPage).not.toMatch(/redirect\('\/app\/onboarding'\)/)
  })

  it('one-or-more candidates: the workspace gate -> selector walk terminates in one hop (the selector is TERMINAL, proven structurally above)', async () => {
    noCarrierWithCandidates()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/organizations/select')
  })

  it('stale-carrier walk: the workspace gate clears the carrier and reaches the selector in one hop, and never re-enters R3 (the clear happens BEFORE the redirect)', async () => {
    staleCarrier()
    const location = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(location).toBe('/app/organizations/select')
    expect(mockClearSelectedOrganization).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// C. TERMINATION
// ---------------------------------------------------------------------------

describe('8. the authenticated redirect graph reaches a terminal state', () => {
  it('member-less: /app/dashboard -> /app/onboarding -> RENDER, in two hops', async () => {
    noCarrierNoCandidates()

    const hops: string[] = []
    let current: string | null = '/app/dashboard'
    hops.push(current)

    // Hop 1: the workspace gate.
    current = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(current).toBe('/app/onboarding')
    hops.push(current!)

    // Hop 2: the destination renders instead of redirecting — the cycle's end.
    const terminal = await locationOf(
      () => OnboardingPage({ searchParams: Promise.resolve({}) }) as Promise<unknown>
    )
    expect(terminal, 'the graph did not terminate').toBeNull()

    expect(new Set(hops).size, 'a pathname repeated — the graph cycles').toBe(hops.length)
  })

  it('member: /app/onboarding -> /app/dashboard -> RENDER, in two hops', async () => {
    member()

    const first = await locationOf(
      () => OnboardingPage({ searchParams: Promise.resolve({}) }) as Promise<unknown>
    )
    expect(first).toBe('/app/dashboard')

    const terminal = await locationOf(() => PrivateLayout({ children: null }) as Promise<unknown>)
    expect(terminal, 'the graph did not terminate').toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D. THE FLOWS THAT MUST NOT REGRESS
// ---------------------------------------------------------------------------

describe('invitation and signup redirect contracts are untouched', () => {
  it('login and signup still prefer a validated redirect over the onboarding default', () => {
    const actions = read('app/(public)/login/actions.ts')
    // The invited-user guarantee: an explicit safe target wins, so an invitee
    // is not sent to onboarding to create a second organisation.
    expect(actions).toMatch(/isSafeRedirectPath\(redirectParam\)/)
    expect(actions).toMatch(/if \(redirectTo\) \{\s*redirect\(redirectTo\)/)
    expect(actions).toMatch(/redirect\('\/app\/onboarding'\)/)
  })

  it('the auth callback keeps the same precedence', () => {
    const callback = read('app/auth/callback/route.ts')
    expect(callback).toMatch(/isSafeRedirectPath\(nextParam\)/)
    expect(callback).toMatch(/\/app\/onboarding/)
    expect(callback).toMatch(/\/app\/dashboard/)
  })

  it('the onboarding URL contract is unchanged everywhere it is referenced', () => {
    // The route group is stripped from the URL, so no caller had to move.
    for (const file of [
      'app/(public)/login/actions.ts',
      'app/auth/callback/route.ts',
      'lib/auth/session.ts',
      'app/(authenticated)/app/onboarding/actions.ts',
    ]) {
      expect(read(file), `${file} lost the /app/onboarding contract`).toContain('/app/onboarding')
    }
  })

  it('self-serve organisation creation is still allowlist-gated and unwidened', () => {
    const actions = read('app/(authenticated)/app/onboarding/actions.ts')
    expect(actions).toMatch(/isEmailAllowlisted/)
    expect(actions).toMatch(/not_allowlisted/)
    expect(actions).toMatch(/withAuthenticatedDatabaseContext/)
    // It must not have gained an organisation-scoped context or a bypass.
    expect(actions).not.toMatch(/withSuperAdminDatabaseContext|runWithOrganizationAccess/)
  })
})

// ---------------------------------------------------------------------------
// I. P-A1-1/2/3 AT THE LOGIN ACTION AND THE AUTH CALLBACK
// ---------------------------------------------------------------------------
//
// Neither file is executed in this suite (see the existing source-text style
// above — both entry points reach @/lib/supabase/server and
// @/lib/security/rate-limit, which this file does not mock). The behavioural
// proof of the same defect and its repair is driven fully against the
// workspace gate and the onboarding page above, and independently again
// against the real requireOrganizationAccess in tests/auth/session.test.ts.
// This block proves the STRUCTURAL half: both files now enumerate before
// deciding, rather than routing on the conflated boolean alone.

describe('P-A1-1/2/3 at the login action and the auth callback: enumerate before deciding', () => {
  it('login: the smart redirect enumerates candidates and no longer routes on the conflated boolean alone', () => {
    const actions = read('app/(public)/login/actions.ts')
    expect(actions).toMatch(/listSelectableMemberships/)
    expect(actions).toMatch(/candidates\.length === 0/)
    expect(actions).toMatch(/redirect\('\/app\/organizations\/select'\)/)
  })

  it('auth callback: the smart redirect enumerates candidates and no longer routes on the conflated boolean alone', () => {
    const callback = read('app/auth/callback/route.ts')
    expect(callback).toMatch(/listSelectableMemberships/)
    expect(callback).toMatch(/candidates\.length === 0/)
    expect(callback).toMatch(/\/app\/organizations\/select/)
  })
})
