import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership } from '@/lib/auth/session'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')

  if (code) {
    const supabase = await createClient()
    const { data } = await supabase.auth.exchangeCodeForSession(code)

    if (data.user) {
      // Sync user profile (idempotent)
      await syncUserProfile(data.user)

      // Smart redirect based on org membership
      const membership = await getCurrentMembership(data.user.id)
      if (!membership) {
        return NextResponse.redirect(new URL('/app/onboarding', request.url))
      }
    }
  }

  return NextResponse.redirect(new URL('/app/dashboard', request.url))
}
