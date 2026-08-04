// lib/admin/organizations.ts
// SuperAdmin-only visibility across all organizations.

import { db } from '@/db/client'
import { organizations, organizationMembers } from '@/db/schema'
import { eq, count } from 'drizzle-orm'
import { requireAdminAccess } from '@/lib/auth/session'
import {
  callAdminSetOrganizationStatus,
  OrganizationAdministrationError,
} from './organization-administration'

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

/**
 * Suspend or reactivate an organization platform-wide. Requires super_admin.
 *
 * Goes through `uellix_capability.admin_set_organization_status`, not through
 * the ORM. `status` left the runtime UPDATE grant in `stella_0011` for a
 * specific reason: this function required `requireAdminAccess()` in the
 * application, but it reached the database over the SAME `uellix_app`
 * connection as any organisation admin — so the ACL permitted a suspended
 * organisation's own admin to set itself back to 'active' through the ORM.
 * The check was real and the boundary was not.
 *
 * This also gains an audit row, which the previous implementation never wrote:
 * suspending an organisation used to leave no trace at all. The definer records
 * it in the same transaction as the change.
 *
 * The "organization not found" pre-check is gone: the capability answers every
 * refusal identically, so this endpoint cannot be used to enumerate ids.
 */
export async function setOrganizationStatus(organizationId: string, status: 'active' | 'suspended') {
  await requireAdminAccess()

  await callAdminSetOrganizationStatus(organizationId, status)

  // Read back for the caller. The write is committed and audited already.
  const [updated] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      status: organizations.status,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))

  // The declared return type says a row; without this it could be `undefined`
  // — the write is committed but the read-back is filtered by the ordinary
  // {public} SELECT policy, not by the RESTRICTIVE cap_platform_* one. Same
  // uniform message as any other refusal, so it discloses nothing.
  if (!updated) throw new OrganizationAdministrationError('organization status read-back')

  return updated
}
