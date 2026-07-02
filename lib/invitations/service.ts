// lib/invitations/service.ts
//
// Invitation lifecycle: create (org_admin+), list, revoke, accept.
//
// Email delivery is intentionally NOT wired up here — ANTIGRAVITY.md forbids
// introducing external services without approval, and no provider has been
// chosen yet. `createInvitation` returns the raw (unhashed) token so the
// caller can build an accept URL and hand it off manually until a provider
// is approved. Only the SHA-256 hash of the token is ever persisted.

import { db } from '@/db/client'
import { invitations, organizationMembers } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import crypto from 'crypto'
import { z } from 'zod'
import {
  requireOrganizationAccess,
  getCurrentUser,
  getCurrentMembership,
} from '@/lib/auth/session'
import { canInviteUsers } from '@/lib/auth/permissions'
import { isValidRole, ROLES, type Role } from '@/lib/auth/roles'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

const INVITATION_TTL_DAYS = 7

const InviteInputSchema = z.object({
  email: z.string().email(),
  role: z.string().refine(isValidRole, { message: 'Invalid role' }),
})

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

/** Create a pending invitation. Requires organization_admin or above. */
export async function createInvitation(input: unknown) {
  const ctx = await requireOrganizationAccess()
  if (!canInviteUsers(ctx.membership.role)) {
    throw new Error('Insufficient permissions to invite users')
  }

  const data = InviteInputSchema.parse(input)
  if (data.role === ROLES.SUPER_ADMIN) {
    throw new Error('Cannot invite a user as super_admin')
  }
  const normalizedEmail = data.email.trim().toLowerCase()

  const existingPending = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, ctx.organization.id),
        eq(invitations.email, normalizedEmail),
        eq(invitations.status, 'pending')
      )
    )
  if (existingPending.length > 0) {
    throw new Error('An active invitation already exists for this email')
  }

  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const [invitation] = await db
    .insert(invitations)
    .values({
      organizationId: ctx.organization.id,
      email: normalizedEmail,
      role: data.role,
      status: 'pending',
      tokenHash,
      invitedBy: ctx.user.id,
      expiresAt,
    })
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'invitation',
    entityId: invitation.id,
    action: AUDIT_ACTIONS.INVITATION_SENT,
    afterJson: { email: normalizedEmail, role: data.role, expiresAt: expiresAt.toISOString() },
  })

  return { invitation, rawToken }
}

/** List all invitations for the current organization (any active member may view). */
export async function listInvitationsForCurrentOrganization() {
  const ctx = await requireOrganizationAccess()
  return db.select().from(invitations).where(eq(invitations.organizationId, ctx.organization.id))
}

/** Revoke a pending invitation. Requires organization_admin or above. */
export async function revokeInvitation(invitationId: string) {
  const ctx = await requireOrganizationAccess()
  if (!canInviteUsers(ctx.membership.role)) {
    throw new Error('Insufficient permissions to revoke invitations')
  }

  const invitation = await db
    .select()
    .from(invitations)
    .where(eq(invitations.id, invitationId))
    .then((rows) => rows[0])
  if (!invitation) throw new Error('Invitation not found')
  if (invitation.organizationId !== ctx.organization.id) throw new Error('Forbidden')
  if (invitation.status !== 'pending') throw new Error('Only pending invitations can be revoked')

  const [updated] = await db
    .update(invitations)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(invitations.id, invitationId))
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'invitation',
    entityId: invitationId,
    action: AUDIT_ACTIONS.INVITATION_REVOKED,
    beforeJson: invitation,
    afterJson: updated,
  })

  return updated
}

/**
 * Accept a pending invitation using the raw token from the accept link.
 * The caller must already be authenticated via Supabase (but must NOT yet
 * have an active membership anywhere — the schema enforces one active
 * membership per user).
 */
export async function acceptInvitation(rawToken: string) {
  const user = await getCurrentUser()
  if (!user) throw new Error('Unauthenticated')

  const tokenHash = hashToken(rawToken)
  const invitation = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, tokenHash))
    .then((rows) => rows[0])
  if (!invitation) throw new Error('Invalid invitation')

  if (invitation.status !== 'pending') {
    throw new Error('Invitation is no longer valid')
  }
  if (invitation.expiresAt < new Date()) {
    await db
      .update(invitations)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(invitations.id, invitation.id))
    throw new Error('Invitation has expired')
  }
  if (invitation.email !== user.email.trim().toLowerCase()) {
    throw new Error('This invitation was issued to a different email address')
  }

  const existingMembership = await getCurrentMembership(user.id)
  if (existingMembership) {
    throw new Error('You already belong to an organization')
  }

  const role: Role = isValidRole(invitation.role) ? invitation.role : ROLES.VIEWER

  const [membership] = await db
    .insert(organizationMembers)
    .values({
      organizationId: invitation.organizationId,
      userId: user.id,
      role,
      status: 'active',
      invitedBy: invitation.invitedBy,
      joinedAt: new Date(),
    })
    .returning()

  const [updatedInvitation] = await db
    .update(invitations)
    .set({ status: 'accepted', acceptedAt: new Date(), updatedAt: new Date() })
    .where(eq(invitations.id, invitation.id))
    .returning()

  await logAuditAction({
    organizationId: invitation.organizationId,
    actorUserId: user.id,
    entityType: 'invitation',
    entityId: invitation.id,
    action: AUDIT_ACTIONS.INVITATION_ACCEPTED,
    afterJson: { userId: user.id, role },
  })
  await logAuditAction({
    organizationId: invitation.organizationId,
    actorUserId: user.id,
    entityType: 'organization_member',
    entityId: membership.id,
    action: AUDIT_ACTIONS.MEMBERSHIP_CREATED,
    afterJson: { userId: user.id, role },
  })

  return { membership, invitation: updatedInvitation }
}
