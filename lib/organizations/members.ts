// lib/organizations/members.ts
import { db } from '@/db/client'
import { organizationMembers, users } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canManageUsers } from '@/lib/auth/permissions'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

/** List active members of the current organization, joined with user profile data. */
export async function listMembersForCurrentOrganization() {
  const ctx = await requireOrganizationAccess()
  return db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      status: organizationMembers.status,
      joinedAt: organizationMembers.joinedAt,
      email: users.email,
      fullName: users.fullName,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organization.id),
        eq(organizationMembers.status, 'active')
      )
    )
}

/** Remove a member from the current organization. Requires organization_admin or above. */
export async function removeMemberFromCurrentOrganization(membershipId: string) {
  const ctx = await requireOrganizationAccess()
  if (!canManageUsers(ctx.membership.role)) {
    throw new Error('Insufficient permissions to remove members')
  }

  const membership = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.id, membershipId))
    .then((rows) => rows[0])
  if (!membership) throw new Error('Membership not found')
  if (membership.organizationId !== ctx.organization.id) throw new Error('Forbidden')
  if (membership.userId === ctx.user.id) throw new Error('You cannot remove yourself')

  const [updated] = await db
    .update(organizationMembers)
    .set({ status: 'removed', updatedAt: new Date() })
    .where(eq(organizationMembers.id, membershipId))
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'organization_member',
    entityId: membershipId,
    action: AUDIT_ACTIONS.MEMBERSHIP_REMOVED,
    beforeJson: membership,
    afterJson: updated,
  })

  return updated
}
