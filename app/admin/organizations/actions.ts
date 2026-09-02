'use server'

import { redirect } from 'next/navigation'
import { AuthContextError } from '@/lib/auth/database-context'
import { rethrowNextControlFlow } from '@/lib/errors/next-control-flow'
import { revalidatePath } from 'next/cache'
import { setOrganizationStatus } from '@/lib/admin/organizations'
import { requireAdminAccess } from '@/lib/auth/session'
import { withSuperAdminDatabaseContext } from '@/lib/auth/database-context'

const ORGS_PATH = '/admin/organizations'

export async function setOrganizationStatusAction(formData: FormData) {
  const organizationId = formData.get('organizationId') as string | null
  const status = formData.get('status') as string | null

  if (!organizationId || (status !== 'active' && status !== 'suspended')) {
    redirect(`${ORGS_PATH}?error=invalid_input`)
  }

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      setOrganizationStatus(organizationId, status as 'active' | 'suspended')
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${ORGS_PATH}?error=not_authorized`)
    redirect(`${ORGS_PATH}?error=update_failed`)
  }

  revalidatePath(ORGS_PATH)
  redirect(`${ORGS_PATH}?success=updated`)
}
