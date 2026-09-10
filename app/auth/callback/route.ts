import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership, listSelectableMemberships } from '@/lib/auth/session'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const nextParam = requestUrl.searchParams.get('next')
  const next = isSafeRedirectPath(nextParam) ? nextParam : null

  if (code) {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data?.user) {
      // Sync user profile (idempotent)
      await syncUserProfile(data.user)

      if (next) {
        return NextResponse.redirect(new URL(next, request.url))
      }

      // Smart redirect based on org membership.
      //
      // TENANCY-S3-SELECTOR-REACHABILITY (Packet A): structurally identical
      // to the login action's conflation — see its comment for the full
      // rationale. Enumerate before deciding rather than treating a null
      // membership as "no organization at all".
      const membership = await getCurrentMembership(data.user.id)
      if (!membership) {
        const candidates = await listSelectableMemberships()
        if (candidates.length === 0) {
          return NextResponse.redirect(new URL('/app/onboarding', request.url))
        }
        return NextResponse.redirect(new URL('/app/organizations/select', request.url))
      }

      return NextResponse.redirect(new URL('/app/dashboard', request.url))
    }
  }

  return NextResponse.redirect(new URL('/login', request.url))
}
