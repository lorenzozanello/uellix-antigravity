'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createInvitation, revokeInvitation } from '@/lib/invitations/service'
import { removeMemberFromCurrentOrganization } from '@/lib/organizations/members'

const MEMBERS_PATH = '/app/organization/members'

function errorToSlug(message: string): string {
  const known: Record<string, string> = {
    'Insufficient permissions to invite users': 'no_permission',
    'Cannot invite a user as super_admin': 'invalid_role',
    'An active invitation already exists for this email': 'duplicate_pending',
    'Insufficient permissions to revoke invitations': 'no_permission',
    'Insufficient permissions to remove members': 'no_permission',
    'You cannot remove yourself': 'cannot_remove_self',
  }
  return known[message] ?? 'unknown_error'
}

export async function inviteMemberAction(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim()
  const role = formData.get('role') as string | null

  if (!email || !role) {
    redirect(`${MEMBERS_PATH}?error=invalid_input`)
  }

  try {
    await createInvitation({ email, role })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${MEMBERS_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(MEMBERS_PATH)
  redirect(`${MEMBERS_PATH}?success=invited`)
}

export async function revokeInvitationAction(formData: FormData) {
  const invitationId = formData.get('invitationId') as string | null
  if (!invitationId) redirect(`${MEMBERS_PATH}?error=invalid_input`)

  try {
    await revokeInvitation(invitationId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${MEMBERS_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(MEMBERS_PATH)
  redirect(`${MEMBERS_PATH}?success=revoked`)
}

export async function removeMemberAction(formData: FormData) {
  const membershipId = formData.get('membershipId') as string | null
  if (!membershipId) redirect(`${MEMBERS_PATH}?error=invalid_input`)

  try {
    await removeMemberFromCurrentOrganization(membershipId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${MEMBERS_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(MEMBERS_PATH)
  redirect(`${MEMBERS_PATH}?success=removed`)
}
