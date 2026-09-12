/**
 * lib/auth/session.ts
 * Server-side authentication and authorisation helpers.
 *
 * These functions are designed for use in Server Components, Server Actions,
 * and Route Handlers.  They read from the Supabase session and, through
 * lib/auth/database-context.ts, from the database inside an identity context.
 *
 * IMPORTANT: Never trust client-sent data for permission decisions.
 * Always use these helpers to verify the user's identity and role.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED AT THE RUNTIME CUTOVER
 * ---------------------------------------------------------------------------
 * These helpers used to be the place the database was first touched:
 * `getCurrentUser()` selected from `public.users`, `getCurrentMembership()`
 * selected from `organization_members`, and each one did so on a claimless
 * connection. As `postgres` that worked, because RLS did not apply. As
 * `uellix_app` it returns zero rows, and login stops working.
 *
 * They are now READERS of a principal resolved once per request by
 * lib/auth/database-context.ts, which does the same reads inside a short
 * identity context. Their signatures, return types and redirect behaviour are
 * unchanged — the 115 service functions that call them did not have to move.
 *
 * The rule that follows from that: these helpers tell you WHO the caller is;
 * they do not open a context for the work that comes after. An entry point
 * that queries must run inside one of the `runWith*` wrappers below, or inside
 * `withOrganizationDatabaseContext` / `withSuperAdminDatabaseContext` directly.
 */

import { cache } from 'react'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { withDatabaseIdentityContext } from '@/db/identity-context'
import { getVerifiedAuthIdentity } from './identity'
import {
  loadRequestPrincipal,
  listSelectableMemberships,
  withOptionalDatabaseIdentityContext,
  withOrganizationDatabaseContext,
  withSuperAdminDatabaseContext,
  type AuthUser,
  type Membership,
  type Organization,
  type OrganizationContext,
  type RequestPrincipal,
  type SelectableMembership,
} from './database-context'
import { clearSelectedOrganization } from './selected-organization'
import { VERIFY_EMAIL_PATH } from './email-verification'
import { ACCEPT_LEGAL_PATH } from './legal-acceptance'
import type { Role } from './roles'
import { hasRole } from './permissions'

/** Same shape check as db/identity-context.ts: the value becomes a JSON claim. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
//
// Defined in lib/auth/database-context.ts and re-exported here so the ~40
// modules that import them from this path keep working.

export type { AuthUser, Membership, Organization, OrganizationContext, RequestPrincipal, SelectableMembership }

// PACKET B — routing translations (login, signup, the auth callback, the
// onboarding action) need the RAW principal to read `.emailVerified` without
// going through a redirecting helper. Re-exported here for the same reason
// `listSelectableMemberships` is: the actual implementation lives in
// lib/auth/database-context.ts, and this stays the reader surface pages and
// actions import from.
export { loadRequestPrincipal }

// ---------------------------------------------------------------------------
// listSelectableMemberships
// ---------------------------------------------------------------------------
//
// S3 — SELECTOR_DECIRCULARISATION: hosted (as a thin re-export) here rather
// than duplicated, because the actual query already lives in
// lib/auth/database-context.ts, which is where organizationMembers and
// organizations are already imported. Session.ts stays the reader surface
// pages import from, matching every other helper in this file, without this
// module gaining a new schema/db import of its own — the smaller of the two
// compliant dependency surfaces measured for this choice (see
// docs/ops/tenancy/MULTI_ORG_S3_IMPLEMENTATION_EVIDENCE_v1.0.0.json
// ENUMERATOR_HOST).
//
// Both `@/lib/auth/session` and `@/lib/auth/database-context` are
// CONTEXT_MODULES the entry-point scanner skips by import specifier
// (tests/database-runtime-entrypoints.test.ts CONTEXT_MODULES) — re-exporting
// here moves neither the AST inventory nor the runtime-entrypoint pins.
export { listSelectableMemberships }

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

/**
 * Returns the currently authenticated user from the database, or `null` if
 * the session is invalid or the user has no profile in `users`.
 *
 * This function does NOT redirect — use `requireAuth()` when you need
 * a hard guard.
 *
 * It no longer issues its own query: the read happens inside an identity
 * context in `loadRequestPrincipal()`. That is the whole fix for the login
 * cycle — see the header of lib/auth/identity.ts.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  return (await loadRequestPrincipal())?.user ?? null
}

// ---------------------------------------------------------------------------
// getCurrentMembership
// ---------------------------------------------------------------------------

/**
 * Returns the user's active organisation membership, or `null` if
 * the user has no active membership.
 *
 * In the MVP a user belongs to at most one organisation, so we simply
 * return the first active membership found.
 *
 * `userId` is still a parameter for source compatibility, and it is CHECKED
 * rather than used: the membership returned is always the session's own. A
 * caller asking about someone else gets `null`, which is what RLS would have
 * produced anyway — just without the round trip.
 */
export async function getCurrentMembership(userId: string): Promise<Membership | null> {
  const principal = await loadRequestPrincipal()
  if (!principal || principal.user.id !== userId) return null
  return principal.membership
}

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user or redirects to `/login`.
 *
 * Use this as the first call in any protected Server Component or
 * Server Action.
 */
export async function requireAuth(): Promise<AuthUser> {
  const principal = await loadRequestPrincipal()
  if (!principal) redirect('/login')

  // PACKET B — C3. Gates the AUTHENTICATED route group, which is where
  // onboarding (E1/E2) and the organisation selector (E4/E5/E6) live. A gate
  // placed only on requireOrganizationAccess (C4) would leave this group
  // reachable, since app/(authenticated)/layout.tsx calls requireAuth, never
  // requireOrganizationAccess (they are siblings, not a chain).
  if (!principal.emailVerified) redirect(VERIFY_EMAIL_PATH)

  // CL-1 — K3/L0, REMAIN AFTER B0. Gates the AUTHENTICATED route group,
  // exactly as the emailVerified check above gates it for B0 — same
  // reasoning, same placement, one gate later.
  if (!principal.accountAcceptanceCurrent) redirect(ACCEPT_LEGAL_PATH)

  return principal.user
}

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

/**
 * Asserts that the user's role meets the `minimumRole` threshold.
 * Redirects to the app dashboard if the check fails.
 */
export async function requireRole(userId: string, minimumRole: Role): Promise<Membership> {
  const membership = await getCurrentMembership(userId)
  if (!membership || !hasRole(membership.role, minimumRole)) {
    redirect('/app/dashboard')
  }
  return membership
}

// ---------------------------------------------------------------------------
// requireOrganizationAccess
// ---------------------------------------------------------------------------

/**
 * Ensures the user is authenticated AND has an active organisation.
 * - No session → redirects to `/login`
 * - No organisation → redirects to `/app/onboarding` or
 *   `/app/organizations/select`, per the TENANCY-S3-SELECTOR-REACHABILITY
 *   ROUTING_CONTRACT below.
 *
 * Returns the full `OrganizationContext`.
 *
 * NOTE: this returns the context; it does NOT leave a database context open.
 * An entry point that goes on to query must be wrapped in
 * `runWithOrganizationAccess()`.
 *
 * ---------------------------------------------------------------------------
 * TENANCY-S3-SELECTOR-REACHABILITY — ROUTING_CONTRACT (Packet A)
 * ---------------------------------------------------------------------------
 * docs/ops/tenancy/TENANCY_S3_SELECTOR_REACHABILITY_REMEDIATION_v1.0.0.json
 *
 * S3 gave the request principal a two-valued refusal discriminator
 * (`organizationRefusalCode`), but this gate used to ask only the pre-S3
 * boolean question "is membership null" — TRUE at all three return sites of
 * `loadRequestPrincipal`, so a returning member with no selected-organization
 * carrier was routed to organisation CREATION instead of SELECTION. The four
 * rules below are ORDERED and each is a CONJUNCTION of the refusal code AND
 * `membership === null` — never the code alone, which is what would silently
 * mis-handle RETURN SITE 3 (see R4).
 *
 * R1 — SUPER-ADMIN, preserved verbatim, evaluated before any selector
 *      question. A super-admin without a membership never reaches the
 *      selector (SUPERADMIN_BOUNDARY): they reach tenant data through a
 *      different, explicit door.
 *
 * R2 — NO CARRIER AT ALL (RETURN SITE 1: membership === null,
 *      organizationRefusalCode === 'TENANCY_NO_ORGANIZATION_SELECTED').
 *      Enumerate the caller's selectable memberships. Zero candidates is
 *      genuine founding → /app/onboarding. One OR MORE candidates —
 *      INCLUDING exactly one — routes to the selector: NO_AUTO_SELECTION is
 *      BINDING, so the single-candidate case gets no shortcut. No carrier is
 *      ever written here; the selector's own governed action is the sole
 *      writer.
 *
 * R3 — STALE / NON-MEMBER CARRIER (RETURN SITE 2: membership === null,
 *      organizationRefusalCode === 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER').
 *      Clear the stale carrier, THEN redirect to the selector — clearing
 *      BEFORE the redirect so the next request does not re-enter this branch
 *      with the same stale carrier. Never falls back to another membership,
 *      not even when exactly one exists (SECOND_ORG_MEMBERSHIP B4): the
 *      subject chooses, the application does not choose for them.
 *
 * R4 — RETURN SITE 3 (membership !== null, same reused refusal code, but the
 *      membership DEMONSTRABLY EXISTS — only the organisation row could not
 *      be read). This is EXCLUDED from R2 and R3 by the conjunction above,
 *      not absorbed: sweeping it into R3 would clear a genuine member's
 *      valid carrier on a transient organisation-read failure. Its
 *      behaviour is the pre-existing fail-closed fallthrough, unchanged. The
 *      open governed question this state represents
 *      (TENANCY_ORGANIZATION_READABILITY_INVARIANT_SUCCESSOR_REQUIRED) is not
 *      resolved here.
 */
export const requireOrganizationAccess = cache(async (): Promise<OrganizationContext> => {
  const principal = await loadRequestPrincipal()
  if (!principal) redirect('/login')

  // ---------------------------------------------------------------------
  // PACKET B — B0 (VERIFICATION_PRECEDES_TENANCY)
  // ---------------------------------------------------------------------
  // Evaluated BEFORE R1 (super-admin) and before any selector question, and
  // BEFORE the enumerator below is ever consulted (S-IA-NO-ENUMERATION-ON-
  // REFUSAL): a privilege bit is not proof of mailbox control, and an
  // unverified subject must not be routed to the selector either. For a
  // verified subject this is a no-op and R1-R4 below run exactly as Packet A
  // left them — B0 is a PREFIX, never a rewrite.
  if (!principal.emailVerified) redirect(VERIFY_EMAIL_PATH)

  // ---------------------------------------------------------------------
  // CL-1 — K4/L0, REMAIN AFTER B0.
  // ---------------------------------------------------------------------
  // Evaluated immediately after B0 and, like B0, BEFORE R1 (super-admin) and
  // before any selector question or enumerator consultation
  // (S-AO-NO-ENUMERATION-ON-REFUSAL): L0 is a PREFIX, not a rewrite, and
  // applies uniformly — a super-admin who has not accepted is refused here
  // exactly like an ordinary subject (PACKET_A_PRESERVATION P-AO-13 re-drives
  // R1 with an ACCEPTANCE-CURRENT super-admin reaching /admin, never an
  // unaccepted one). For an accepted subject this is a no-op and R1-R4 below
  // run exactly as Packet A left them.
  if (!principal.accountAcceptanceCurrent) redirect(ACCEPT_LEGAL_PATH)

  if (!principal.membership || !principal.organization) {
    // R1 — SuperAdmin may not have a membership — redirect to admin, ahead
    // of any selector question and insensitive to the enumerator.
    if (principal.user.isSuperAdmin) redirect('/admin')

    // R2 — no carrier at all: enumerate, then route on candidate count.
    if (principal.membership === null && principal.organizationRefusalCode === 'TENANCY_NO_ORGANIZATION_SELECTED') {
      const candidates = await listSelectableMemberships()
      if (candidates.length === 0) redirect('/app/onboarding')
      redirect('/app/organizations/select')
    }

    // R3 — stale/non-member carrier: clear it, then route to the selector.
    if (
      principal.membership === null &&
      principal.organizationRefusalCode === 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'
    ) {
      await clearSelectedOrganization()
      redirect('/app/organizations/select')
    }

    // R4 — RETURN SITE 3, excluded from R2/R3 above: preserved unchanged.
    redirect('/app/onboarding')
  }

  return {
    user: principal.user,
    membership: principal.membership,
    organization: principal.organization,
  }
})

// ---------------------------------------------------------------------------
// requireAdminAccess
// ---------------------------------------------------------------------------

/**
 * Ensures the user is a super admin.
 * - No session → redirects to `/login`
 * - Not super admin → redirects to `/app/dashboard`
 */
export async function requireAdminAccess(): Promise<AuthUser> {
  const user = await requireAuth()
  if (!user.isSuperAdmin) redirect('/app/dashboard')
  return user
}

// ---------------------------------------------------------------------------
// getCurrentOrganizationContext
// ---------------------------------------------------------------------------

/**
 * Non-redirecting version of `requireOrganizationAccess`.
 * Returns `null` when the context cannot be built (no auth, no org, etc.).
 */
export const getCurrentOrganizationContext = cache(
  async (): Promise<OrganizationContext | null> => {
    const principal = await loadRequestPrincipal()
    // PACKET B — C5, extended by CL-1. `null` already means "no context can
    // be built" for a missing session or a missing organisation; an
    // unverified or unaccepted subject folds into the SAME refusal shape,
    // which is why every existing `if (!ctx)` caller (all four Route
    // Handlers included) refuses it for free.
    if (
      !principal ||
      !principal.membership ||
      !principal.organization ||
      !principal.emailVerified ||
      !principal.accountAcceptanceCurrent
    ) {
      return null
    }

    return {
      user: principal.user,
      membership: principal.membership,
      organization: principal.organization,
    }
  }
)

// ---------------------------------------------------------------------------
// Context runners — the redirect-flavoured entry-point wrappers
// ---------------------------------------------------------------------------
//
// The `require*` helpers above answer "who is this". These run work AS them.
//
// The redirect decision is taken BEFORE the transaction opens. `redirect()`
// throws, and a throw inside the callback would roll the transaction back and
// rethrow — correct, but it would also mean every unauthenticated page render
// opened and abandoned a transaction.

/**
 * Redirect-guarded organisation context, for pages, layouts and server actions
 * that query as a member of an organisation.
 */
export async function runWithOrganizationAccess<T>(
  callback: (context: OrganizationContext) => Promise<T>
): Promise<T> {
  await requireOrganizationAccess()
  return withOrganizationDatabaseContext(callback)
}

/**
 * Redirect-guarded super-admin context, for `/admin` pages and admin actions.
 */
export async function runWithAdminAccess<T>(callback: (user: AuthUser) => Promise<T>): Promise<T> {
  await requireAdminAccess()
  return withSuperAdminDatabaseContext(callback)
}

/**
 * Non-redirecting organisation context: the callback receives `null` when
 * there is no session or no organisation, and gets NO claims in that case.
 *
 * The counterpart of `getCurrentOrganizationContext()` for entry points that
 * render an empty or public view instead of redirecting.
 */
export async function runWithOptionalOrganizationAccess<T>(
  callback: (context: OrganizationContext | null) => Promise<T>
): Promise<T> {
  return withOptionalDatabaseIdentityContext(callback)
}

// ---------------------------------------------------------------------------
// syncUserProfile
// ---------------------------------------------------------------------------

/**
 * Creates or updates the `users` row to stay in sync with Supabase Auth.
 * Call this after successful login, signup, or OAuth callback.
 *
 * Uses an upsert (INSERT ... ON CONFLICT DO UPDATE) to be idempotent.
 *
 * THE ONE PLACE THAT CANNOT USE `withAuthenticatedDatabaseContext`.
 *
 * Every other wrapper resolves a principal first, and a principal requires a
 * `public.users` row. On first login that row is precisely what does not exist
 * yet, so this opens the context straight from the verified Auth subject.
 *
 * The insert is permitted by `users_insert_own`, whose `WITH CHECK` is
 * `id = auth.uid()` — the claim this context sets. A row for anyone else is
 * refused by the database, not merely by the code below.
 *
 * WHERE THE SUBJECT COMES FROM HERE.
 *
 * Every call site passes the user object GoTrue itself just returned —
 * `signInWithPassword`, `signUp`, `exchangeCodeForSession`. That is a
 * server-verified subject, exactly as trustworthy as `getUser()`, and it is
 * the only one available on the first request of a brand-new session: the auth
 * cookie has been written but a second, independently constructed server client
 * may not yet read it back within the same request. Requiring `getUser()` here
 * would have made first-login profile creation depend on cookie timing.
 *
 * So the passed subject is used, and cross-checked whenever a readable session
 * also exists. A MISMATCH is refused — that is the case where the argument
 * could be someone else's id.
 */
export async function syncUserProfile(authUser: {
  id: string
  email?: string
  user_metadata?: { full_name?: string; avatar_url?: string }
}): Promise<void> {
  if (!UUID_PATTERN.test(authUser.id)) return

  const identity = await getVerifiedAuthIdentity()
  if (identity && identity.userId !== authUser.id) {
    // Two different verified subjects in one request. Silent refusal rather
    // than a throw: the call sites are login/callback paths whose own error
    // handling already covers "not signed in", and neither id may reach a log.
    return
  }

  const email = authUser.email ?? ''
  const fullName = authUser.user_metadata?.full_name ?? null
  const avatarUrl = authUser.user_metadata?.avatar_url ?? null

  await withDatabaseIdentityContext(
    { userId: authUser.id, organizationId: null, isSuperAdmin: false },
    async () => {
      await db
        .insert(users)
        .values({
          id: authUser.id,
          email,
          fullName,
          avatarUrl,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email,
            fullName,
            avatarUrl,
            updatedAt: new Date(),
          },
        })
    }
  )
}
