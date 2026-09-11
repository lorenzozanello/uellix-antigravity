import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership, listSelectableMemberships, loadRequestPrincipal } from '@/lib/auth/session'
import { VERIFY_EMAIL_PATH } from '@/lib/auth/email-verification'
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

      // PACKET B — B0, evaluated BEFORE `next` (IM audit BLOCKING-1 / N-BNS-6:
      // a caller-supplied safe target must NEVER outrank the gate — this
      // callback serves recovery-return, OAuth-return, magic link and
      // confirmation-link uniformly, with no mechanism field consulted). A
      // safe `next` is CARRIED FORWARD across the refusal — never honoured
      // early — so the journey resumes once the subject is verified
      // (B4.invitation_target_preservation, N-BNS-6). Carrying forward is
      // not the same act as honouring early: the target is still validated
      // here by the EXISTING isSafeRedirectPath, and no new redirect-target
      // vocabulary is introduced (X-B-10).
      const principal = await loadRequestPrincipal()
      if (principal && !principal.emailVerified) {
        const destination = next
          ? `${VERIFY_EMAIL_PATH}?next=${encodeURIComponent(next)}`
          : VERIFY_EMAIL_PATH
        return NextResponse.redirect(new URL(destination, request.url))
      }

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
