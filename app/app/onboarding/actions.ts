'use server'

import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { organizations, organizationMembers } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { syncUserProfile, getCurrentMembership } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { logAuditAction } from '@/lib/audit/logger'
import { ROLES } from '@/lib/auth/roles'

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

  // Check slug uniqueness
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1)

  if (existing.length > 0) {
    redirect('/app/onboarding?error=slug_taken')
  }

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

  redirect('/app/dashboard')
}
