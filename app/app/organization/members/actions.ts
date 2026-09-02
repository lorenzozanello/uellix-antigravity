'use server'

import { redirect } from 'next/navigation'
import { AuthContextError } from '@/lib/auth/database-context'
import { rethrowNextControlFlow } from '@/lib/errors/next-control-flow'
import { revalidatePath } from 'next/cache'
import { createInvitation, revokeInvitation } from '@/lib/invitations/service'
import { removeMemberFromCurrentOrganization } from '@/lib/organizations/members'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'

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

  await requireOrganizationAccess()

  try {
    // The email is sent AFTER the transaction commits: a token in an inbox
    // whose hash was rolled back is a live link that resolves to nothing.
    const { sendEmail } = await withOrganizationDatabaseContext(() =>
      createInvitation({ email, role })
    )
    await sendEmail()
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${MEMBERS_PATH}?error=not_authorized`)
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${MEMBERS_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(MEMBERS_PATH)
  redirect(`${MEMBERS_PATH}?success=invited`)
}

export async function revokeInvitationAction(formData: FormData) {
  const invitationId = formData.get('invitationId') as string | null
  if (!invitationId) redirect(`${MEMBERS_PATH}?error=invalid_input`)

  await requireOrganizationAccess()

  try {
    await withOrganizationDatabaseContext(() => revokeInvitation(invitationId))
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${MEMBERS_PATH}?error=not_authorized`)
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${MEMBERS_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(MEMBERS_PATH)
  redirect(`${MEMBERS_PATH}?success=revoked`)
}

export async function removeMemberAction(formData: FormData) {
  const membershipId = formData.get('membershipId') as string | null
  if (!membershipId) redirect(`${MEMBERS_PATH}?error=invalid_input`)

  await requireOrganizationAccess()

  try {
    await withOrganizationDatabaseContext(() =>
      removeMemberFromCurrentOrganization(membershipId)
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${MEMBERS_PATH}?error=not_authorized`)
    const message = err instanceof Error ? err.message : 'unknown_error'
    redirect(`${MEMBERS_PATH}?error=${errorToSlug(message)}`)
  }

  revalidatePath(MEMBERS_PATH)
  redirect(`${MEMBERS_PATH}?success=removed`)
}
