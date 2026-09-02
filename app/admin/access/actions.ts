'use server'

import { redirect } from 'next/navigation'
import { AuthContextError } from '@/lib/auth/database-context'
import { rethrowNextControlFlow } from '@/lib/errors/next-control-flow'
import { revalidatePath } from 'next/cache'
import { createSignupAllowlistEntry, removeSignupAllowlistEntry } from '@/lib/admin/signup-allowlist'
import { requireAdminAccess } from '@/lib/auth/session'
import { withSuperAdminDatabaseContext } from '@/lib/auth/database-context'

const ACCESS_PATH = '/admin/access'

export async function createSignupAllowlistEntryAction(formData: FormData) {
  const type = formData.get('type') as string | null
  const pattern = (formData.get('pattern') as string | null)?.trim()
  const notes = (formData.get('notes') as string | null)?.trim() || undefined

  if ((type !== 'email' && type !== 'domain') || !pattern) {
    redirect(`${ACCESS_PATH}?error=invalid_input`)
  }

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() =>
      createSignupAllowlistEntry({ type, pattern, notes })
    )
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${ACCESS_PATH}?error=not_authorized`)
    redirect(`${ACCESS_PATH}?error=invalid_input`)
  }

  revalidatePath(ACCESS_PATH)
  redirect(`${ACCESS_PATH}?success=entry_created`)
}

export async function removeSignupAllowlistEntryAction(formData: FormData) {
  const id = formData.get('id') as string | null
  if (!id) redirect(`${ACCESS_PATH}?error=invalid_input`)

  await requireAdminAccess()

  try {
    await withSuperAdminDatabaseContext(() => removeSignupAllowlistEntry(id))
  } catch (err) {
    // Framework control flow first: redirect() throws, and swallowing it here
    // would render "NEXT_REDIRECT" instead of navigating.
    rethrowNextControlFlow(err)
    // A refusal from the identity layer is an authorisation answer, not an
    // "unknown error" — its internal prose must not reach the query string.
    if (err instanceof AuthContextError) redirect(`${ACCESS_PATH}?error=not_authorized`)
    redirect(`${ACCESS_PATH}?error=not_found`)
  }

  revalidatePath(ACCESS_PATH)
  redirect(`${ACCESS_PATH}?success=entry_removed`)
}
