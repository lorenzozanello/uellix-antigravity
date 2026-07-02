'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function requestPasswordReset(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim()

  if (!email) {
    redirect('/forgot-password?error=invalid_email')
  }

  const supabase = await createClient()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  // Deliberately ignore the result — Supabase Auth returns success here
  // regardless of whether the email is registered, to avoid leaking which
  // addresses have accounts. Always show the same confirmation message.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appUrl}/auth/callback?next=/reset-password`,
  })

  redirect('/forgot-password?success=1')
}
