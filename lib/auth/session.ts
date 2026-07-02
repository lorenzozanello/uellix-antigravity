/**
 * lib/auth/session.ts
 * Server-side authentication and authorisation helpers.
 *
 * These functions are designed for use in Server Components, Server Actions,
 * and Route Handlers.  They read from the Supabase session and query the
 * database via Drizzle to enforce permissions.
 *
 * IMPORTANT: Never trust client-sent data for permission decisions.
 * Always use these helpers to verify the user's identity and role.
 */

import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { db } from '@/db/client'
import { users, organizations, organizationMembers } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import type { Role } from './roles'
import { isValidRole } from './roles'
import { hasRole } from './permissions'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string
  email: string
  fullName: string | null
  avatarUrl: string | null
  isSuperAdmin: boolean
}

export interface Membership {
  id: string
  organizationId: string
  userId: string
  role: Role
  status: string
}

export interface Organization {
  id: string
  name: string
  slug: string
  legalName: string | null
  country: string | null
  sector: string | null
  status: string
}

export interface OrganizationContext {
  user: AuthUser
  membership: Membership
  organization: Organization
}

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

/**
 * Returns the currently authenticated user from the database, or `null` if
 * the session is invalid or the user has no profile in `users`.
 *
 * This function does NOT redirect — use `requireAuth()` when you need
 * a hard guard.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const supabase = await createClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) return null

  const dbUser = await db
    .select()
    .from(users)
    .where(eq(users.id, authUser.id))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!dbUser) return null

  return {
    id: dbUser.id,
    email: dbUser.email,
    fullName: dbUser.fullName,
    avatarUrl: dbUser.avatarUrl,
    isSuperAdmin: dbUser.isSuperAdmin,
  }
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
 */
export async function getCurrentMembership(
  userId: string
): Promise<Membership | null> {
  const row = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, 'active')
      )
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!row) return null

  const role = isValidRole(row.role) ? row.role : null
  if (!role) return null

  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role,
    status: row.status,
  }
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
export async function requireRole(
  userId: string,
  minimumRole: Role
): Promise<Membership> {
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
 */
export const requireOrganizationAccess = cache(async (): Promise<OrganizationContext> => {
  const user = await requireAuth()

  // SuperAdmin may not have a membership — redirect to admin
  const membership = await getCurrentMembership(user.id)
  if (!membership) {
    if (user.isSuperAdmin) {
      redirect('/admin')
    }
    redirect('/app/onboarding')
  }

  const org = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, membership.organizationId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!org) redirect('/app/onboarding')

  return {
    user,
    membership,
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      legalName: org.legalName,
      country: org.country,
      sector: org.sector,
      status: org.status,
    },
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
export const getCurrentOrganizationContext = cache(async (): Promise<OrganizationContext | null> => {
  const user = await getCurrentUser()
  if (!user) return null

  const membership = await getCurrentMembership(user.id)
  if (!membership) return null

  const org = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, membership.organizationId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!org) return null

  return {
    user,
    membership,
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      legalName: org.legalName,
      country: org.country,
      sector: org.sector,
      status: org.status,
    },
  }
})

// ---------------------------------------------------------------------------
// syncUserProfile
// ---------------------------------------------------------------------------

/**
 * Creates or updates the `users` row to stay in sync with Supabase Auth.
 * Call this after successful login, signup, or OAuth callback.
 *
 * Uses an upsert (INSERT ... ON CONFLICT DO UPDATE) to be idempotent.
 */
export async function syncUserProfile(authUser: {
  id: string
  email?: string
  user_metadata?: { full_name?: string; avatar_url?: string }
}): Promise<void> {
  const email = authUser.email ?? ''
  const fullName = authUser.user_metadata?.full_name ?? null
  const avatarUrl = authUser.user_metadata?.avatar_url ?? null

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
