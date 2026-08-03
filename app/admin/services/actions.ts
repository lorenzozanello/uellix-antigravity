'use server'

import { redirect } from 'next/navigation'
import { AuthContextError } from '@/lib/auth/database-context'
import { rethrowNextControlFlow } from '@/lib/errors/next-control-flow'
import { revalidatePath } from 'next/cache'
import { updateOrganizationStellaService } from '@/lib/admin/stella-services'
import { requireAdminAccess } from '@/lib/auth/session'
import { withSuperAdminDatabaseContext } from '@/lib/auth/database-context'

const SERVICES_PATH = '/admin/services'

export async function updateOrganizationStellaServiceAction(formData: FormData) {
  const organizationId = formData.get('organizationId') as string | null
  const planLabel = (formData.get('planLabel') as string | null)?.trim() || undefined
  const monthlyQuotaRaw = (formData.get('monthlyQuota') as string | null)?.trim()

  if (!organizationId) {
    redirect(`${SERVICES_PATH}?error=invalid_input`)
  }

  const monthlyQuota = monthlyQuotaRaw === '' || monthlyQuotaRaw === undefined
    ? null
    : Number(monthlyQuotaRaw)

  if (monthlyQuota !== null && (Number.isNaN(monthlyQuota) || monthlyQuota < 0)) {
    redirect(`${SERVICES_PATH}?error=invalid_input`)
  }

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      updateOrganizationStellaService(organizationId, { planLabel, monthlyQuota })
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${SERVICES_PATH}?error=not_authorized`)
    redirect(`${SERVICES_PATH}?error=update_failed`)
  }

  revalidatePath(SERVICES_PATH)
  redirect(`${SERVICES_PATH}?success=updated`)
}
