'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function updatePassword(formData: FormData) {
  const password = formData.get('password') as string | null
  const confirmPassword = formData.get('confirmPassword') as string | null

  if (!password || password.length < 6) {
    redirect('/reset-password?error=invalid_password')
  }
  if (password !== confirmPassword) {
    redirect('/reset-password?error=password_mismatch')
  }

  const supabase = await createClient()

  // Requires an active recovery session — the user only reaches this page
  // after exchanging a valid recovery code via /auth/callback.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect('/forgot-password?error=session_expired')
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    redirect('/reset-password?error=update_failed')
  }

  redirect('/login?success=password_updated')
}
