'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createSignupAllowlistEntry, removeSignupAllowlistEntry } from '@/lib/admin/signup-allowlist'

const ACCESS_PATH = '/admin/access'

export async function createSignupAllowlistEntryAction(formData: FormData) {
  const type = formData.get('type') as string | null
  const pattern = (formData.get('pattern') as string | null)?.trim()
  const notes = (formData.get('notes') as string | null)?.trim() || undefined

  if ((type !== 'email' && type !== 'domain') || !pattern) {
    redirect(`${ACCESS_PATH}?error=invalid_input`)
  }

  try {
    await createSignupAllowlistEntry({ type, pattern, notes })
  } catch {
    redirect(`${ACCESS_PATH}?error=invalid_input`)
  }

  revalidatePath(ACCESS_PATH)
  redirect(`${ACCESS_PATH}?success=entry_created`)
}

export async function removeSignupAllowlistEntryAction(formData: FormData) {
  const id = formData.get('id') as string | null
  if (!id) redirect(`${ACCESS_PATH}?error=invalid_input`)

  try {
    await removeSignupAllowlistEntry(id)
  } catch {
    redirect(`${ACCESS_PATH}?error=not_found`)
  }

  revalidatePath(ACCESS_PATH)
  redirect(`${ACCESS_PATH}?success=entry_removed`)
}
