'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { checkAndRecordRateLimit } from '@/lib/security/rate-limit'

const RESET_RATE_LIMIT = { maxAttempts: 3, windowMs: 15 * 60 * 1000 }

export async function requestPasswordReset(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim().toLowerCase()

  if (!email) {
    redirect('/forgot-password?error=invalid_email')
  }

  // Rate limit before hitting Supabase, but always fall through to the same
  // success redirect either way (see below) — this endpoint must not leak
  // whether the email is registered OR whether it's being rate limited,
  // since both would help an attacker enumerate accounts or time attacks.
  const { allowed } = checkAndRecordRateLimit(`reset:${email}`, RESET_RATE_LIMIT)

  if (allowed) {
    const supabase = await createClient()
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

    // Deliberately ignore the result — Supabase Auth returns success here
    // regardless of whether the email is registered, to avoid leaking which
    // addresses have accounts. Always show the same confirmation message.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/auth/callback?next=/reset-password`,
    })
  }

  redirect('/forgot-password?success=1')
}
