import React from 'react'
import { requireAuth } from '@/lib/auth/session'

/**
 * app/(authenticated)/layout.tsx
 * The AUTHENTICATED boundary — a signed-in user, and nothing more.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GROUP EXISTS
 * ---------------------------------------------------------------------------
 * The application has TWO distinct authorisation boundaries, and until this
 * group existed the codebase only had a place to express the stronger one:
 *
 *   AUTHENTICATED         a valid session. Nothing about organisations.
 *   ORGANIZATION_REQUIRED a session AND an active membership + organisation.
 *
 * `app/app/layout.tsx` expresses the second by calling
 * `requireOrganizationAccess()`, which redirects a member-less user to
 * `/app/onboarding`. That route used to live at `app/app/onboarding/`, i.e.
 * INSIDE the layout that redirects to it, so the only page a member-less user
 * was allowed to reach was gated on the very thing it existed to create:
 *
 *   GET /app/onboarding -> app/app/layout.tsx -> requireOrganizationAccess()
 *                       -> redirect /app/onboarding -> ... (307 forever)
 *
 * MEASURED on the hosted preview as ERR_TOO_MANY_REDIRECTS, with dozens of
 * `GET /app/onboarding 307` and zero 500s — a pure routing cycle, not a
 * database or privilege failure. The redirect target equalled the request
 * pathname, which is the signature of a self-redirect.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROUTE GROUP, AND WHY THIS ONE RATHER THAN A `(workspace)` GROUP
 * ---------------------------------------------------------------------------
 * A route group is stripped from the URL, so `app/(authenticated)/app/
 * onboarding/page.tsx` still serves `/app/onboarding` — no redirect contract,
 * bookmark or test URL changes. What changes is which layouts wrap it: this
 * one, and not `app/app/layout.tsx`.
 *
 * The obvious alternative was to move the WORKSPACE routes into an
 * `app/app/(workspace)/` group and leave onboarding as a plain child of
 * `app/app/`. It was rejected on a security default, not on taste: with the
 * gate inside a group, a route added directly under `app/app/` would inherit
 * NO organisation check, and the mistake would be invisible — a new page
 * reachable by a user with no organisation. Keeping `app/app/layout.tsx` as
 * the gate for everything under it means the default for a new route stays
 * SECURE, and the single deliberate exception is the one carved out here.
 *
 * That invariant is not left to discipline: `tests/auth/route-authorization-
 * boundary.test.ts` enumerates the filesystem and fails if a route escapes the
 * organisation gate without being declared in this group.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LAYOUT DOES AND DOES NOT DO
 * ---------------------------------------------------------------------------
 * It calls `requireAuth()` and renders its children bare. It renders NO
 * workspace chrome — no Sidebar, no TopBar — because both need an
 * organisation to describe, and the pages in this group are the ones that do
 * not have one yet. (The onboarding page already paints its own full-screen
 * shell, which is what it was written for.)
 *
 * It issues NO organisation-scoped query. `requireAuth()` resolves the request
 * principal, which reads `public.users` and the caller's own membership inside
 * an identity context; it never opens an organisation context, so nothing here
 * depends on the row that onboarding exists to create.
 *
 * Unauthenticated requests do not reach it: `lib/supabase/proxy.ts` already
 * redirects any `/app*` path to `/login?redirect=<pathname>` when there is no
 * session. `requireAuth()` is the second, server-side half of that guarantee —
 * the proxy is a convenience, this is the boundary.
 */
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireAuth()

  return <>{children}</>
}
