'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { updateOrganizationStellaService } from '@/lib/admin/stella-services'

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

  try {
    await updateOrganizationStellaService(organizationId, { planLabel, monthlyQuota })
  } catch {
    redirect(`${SERVICES_PATH}?error=update_failed`)
  }

  revalidatePath(SERVICES_PATH)
  redirect(`${SERVICES_PATH}?success=updated`)
}
