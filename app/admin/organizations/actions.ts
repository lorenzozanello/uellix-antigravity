'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { setOrganizationStatus } from '@/lib/admin/organizations'

const ORGS_PATH = '/admin/organizations'

export async function setOrganizationStatusAction(formData: FormData) {
  const organizationId = formData.get('organizationId') as string | null
  const status = formData.get('status') as string | null

  if (!organizationId || (status !== 'active' && status !== 'suspended')) {
    redirect(`${ORGS_PATH}?error=invalid_input`)
  }

  try {
    await setOrganizationStatus(organizationId, status as 'active' | 'suspended')
  } catch {
    redirect(`${ORGS_PATH}?error=update_failed`)
  }

  revalidatePath(ORGS_PATH)
  redirect(`${ORGS_PATH}?success=updated`)
}
