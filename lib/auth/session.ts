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
  withOptionalDatabaseIdentityContext,
  withOrganizationDatabaseContext,
  withSuperAdminDatabaseContext,
  type AuthUser,
  type Membership,
  type Organization,
  type OrganizationContext,
} from './database-context'
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

export type { AuthUser, Membership, Organization, OrganizationContext }

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
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
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
 * - No organisation → redirects to `/app/onboarding`
 *
 * Returns the full `OrganizationContext`.
 *
 * NOTE: this returns the context; it does NOT leave a database context open.
 * An entry point that goes on to query must be wrapped in
 * `runWithOrganizationAccess()`.
 */
export const requireOrganizationAccess = cache(async (): Promise<OrganizationContext> => {
  const principal = await loadRequestPrincipal()
  if (!principal) redirect('/login')

  if (!principal.membership || !principal.organization) {
    // SuperAdmin may not have a membership — redirect to admin
    if (principal.user.isSuperAdmin) redirect('/admin')
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
    if (!principal || !principal.membership || !principal.organization) return null

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
