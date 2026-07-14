import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership } from '@/lib/auth/session'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  // Password-recovery emails link here with ?next=/reset-password so the
  // user lands on the "set a new password" form instead of the dashboard.
  const nextParam = requestUrl.searchParams.get('next')
  const next = isSafeRedirectPath(nextParam) ? nextParam : null

  if (code) {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data.user) {
      // Sync user profile (idempotent)
      await syncUserProfile(data.user)

      if (next) {
        return NextResponse.redirect(new URL(next, request.url))
      }

      // Smart redirect based on org membership
      const membership = await getCurrentMembership(data.user.id)
      if (!membership) {
        return NextResponse.redirect(new URL('/app/onboarding', request.url))
      }

      return NextResponse.redirect(new URL('/app/dashboard', request.url))
    }
  }

  return NextResponse.redirect(new URL('/login', request.url))
}
