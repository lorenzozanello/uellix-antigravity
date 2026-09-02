'use server'

import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { organizations, organizationMembers } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { syncUserProfile, getCurrentMembership } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { logAuditAction } from '@/lib/audit/logger'
import { ROLES } from '@/lib/auth/roles'
import { isEmailAllowlisted } from '@/lib/admin/signup-allowlist'
import { withAuthenticatedDatabaseContext } from '@/lib/auth/database-context'

/**
 * BLOCKED BY DESIGN AFTER THE RUNTIME CUTOVER — see
 * docs/ops/DATABASE_RUNTIME_CUTOVER.md, "Bootstrap operations".
 *
 * Self-serve organisation creation writes two rows that RLS refuses to a
 * non-super-admin, and refuses on purpose:
 *
 *   * `orgs_insert_super_admin`  — WITH CHECK (current_user_is_super_admin())
 *   * `members_insert_admin`     — WITH CHECK (already an admin of that org)
 *
 * `members_insert_admin` even carries a comment saying onboarding "uses the
 * Drizzle service client which bypasses RLS entirely" and that a self-insert
 * exception was deliberately NOT added, because it "would allow any user to
 * join any org". That client no longer exists.
 *
 * So this action now runs inside a proper identity context and fails closed
 * with a row-level-security violation for an ordinary user, instead of quietly
 * writing through a bypass. Making it work again requires either a narrowly
 * scoped policy or a separate technical bootstrap identity — a privilege
 * decision, deliberately NOT taken in this unit.
 *
 * A super-admin creating an organisation still succeeds: both policies admit
 * `current_user_is_super_admin()`.
 */
export async function createFirstOrganization(formData: FormData) {
  const supabase = await createClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) redirect('/login')

  // Sync user profile first (idempotent)
  await syncUserProfile(authUser)

  // Enforce: user must not already have an org
  const existingMembership = await getCurrentMembership(authUser.id)
  if (existingMembership) {
    redirect('/app/dashboard')
  }

  // Self-serve org creation is gated: only allowlisted emails/domains may
  // create a brand-new organization. Invited users never reach this action
  // (acceptInvitation joins an existing org via a separate code path).
  //
  // `signup_allowlist` is readable only by a super admin
  // (`signup_allowlist_select_super_admin`). Under the cutover an ordinary
  // user therefore reads zero rows and lands here — the same fail-closed wall
  // documented on this action, reached one step earlier.
  const allowlisted =
    !!authUser.email &&
    (await withAuthenticatedDatabaseContext(() => isEmailAllowlisted(authUser.email!)))
  if (!allowlisted) {
    redirect('/app/onboarding?error=not_allowlisted')
  }

  // Validate inputs
  const name = (formData.get('name') as string | null)?.trim()
  const slug = (formData.get('slug') as string | null)?.trim().toLowerCase()
  const legalName = (formData.get('legalName') as string | null)?.trim() || null
  const country = (formData.get('country') as string | null)?.trim().toUpperCase().slice(0, 2) || null
  const sector = (formData.get('sector') as string | null)?.trim() || null

  if (!name || name.length < 2) {
    redirect('/app/onboarding?error=invalid_name')
  }

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    redirect('/app/onboarding?error=invalid_slug')
  }

  // Everything that touches the database happens in ONE transaction, and the
  // redirects happen OUTSIDE it: `redirect()` throws, so a redirect inside the
  // callback would roll back the organisation it just created.
  const outcome = await withAuthenticatedDatabaseContext(async () => {
    // Check slug uniqueness
    const existing = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1)

    if (existing.length > 0) return { status: 'slug_taken' as const }

    // Create organization
    const [org] = await db
      .insert(organizations)
      .values({
        name,
        slug,
        legalName,
        country,
        sector,
        status: 'active',
      })
      .returning()

    // Create membership as organization_admin
    const [membership] = await db
      .insert(organizationMembers)
      .values({
        organizationId: org.id,
        userId: authUser.id,
        role: ROLES.ORGANIZATION_ADMIN,
        status: 'active',
        joinedAt: new Date(),
      })
      .returning()

    // Audit log
    await logAuditAction({
      organizationId: org.id,
      actorUserId: authUser.id,
      entityType: 'organization',
      entityId: org.id,
      action: 'organization.created',
      afterJson: { name, slug, sector, country },
    })

    await logAuditAction({
      organizationId: org.id,
      actorUserId: authUser.id,
      entityType: 'organization_member',
      entityId: membership.id,
      action: 'membership.created',
      afterJson: { userId: authUser.id, role: ROLES.ORGANIZATION_ADMIN },
    })

    return { status: 'created' as const }
  })

  if (outcome.status === 'slug_taken') {
    redirect('/app/onboarding?error=slug_taken')
  }

  redirect('/app/dashboard')
}
