// lib/admin/organizations.ts
// SuperAdmin-only visibility across all organizations.

import { db } from '@/db/client'
import { organizations, organizationMembers } from '@/db/schema'
import { eq, count } from 'drizzle-orm'
import { requireAdminAccess } from '@/lib/auth/session'

/** List every organization on the platform with its active member count. */
export async function listAllOrganizations() {
  await requireAdminAccess()

  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      country: organizations.country,
      sector: organizations.sector,
      status: organizations.status,
      createdAt: organizations.createdAt,
      memberCount: count(organizationMembers.id),
    })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      eq(organizationMembers.organizationId, organizations.id)
    )
    .groupBy(organizations.id)
}

/** Suspend or reactivate an organization platform-wide. Requires super_admin. */
export async function setOrganizationStatus(organizationId: string, status: 'active' | 'suspended') {
  await requireAdminAccess()

  const org = await db.select().from(organizations).where(eq(organizations.id, organizationId)).then((r) => r[0])
  if (!org) throw new Error('Organization not found')

  const [updated] = await db
    .update(organizations)
    .set({ status, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning()

  return updated
}
