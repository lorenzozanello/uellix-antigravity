'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership, listSelectableMemberships, loadRequestPrincipal } from '@/lib/auth/session'
import { VERIFY_EMAIL_PATH } from '@/lib/auth/email-verification'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'
import { checkAndRecordRateLimit } from '@/lib/security/rate-limit'

const LOGIN_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 }
const SIGNUP_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 }

function loginErrorRedirect(slug: string, redirectTo: string | null): never {
  const suffix = redirectTo ? `&redirect=${encodeURIComponent(redirectTo)}` : ''
  redirect(`/login?error=${slug}${suffix}`)
}

export async function login(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim().toLowerCase()
  const password = formData.get('password') as string | null
  const redirectParam = formData.get('redirect') as string | null
  const redirectTo = isSafeRedirectPath(redirectParam) ? redirectParam : null

  if (!email || !password || password.length < 6) {
    loginErrorRedirect('invalid_credentials', redirectTo)
  }

  if (!checkAndRecordRateLimit(`login:${email}`, LOGIN_RATE_LIMIT).allowed) {
    loginErrorRedirect('rate_limited', redirectTo)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data.user) {
    loginErrorRedirect('auth_failed', redirectTo)
  }

  // Sync user profile (idempotent upsert)
  await syncUserProfile(data.user)

  revalidatePath('/', 'layout')

  // PACKET B — B0. Evaluated BEFORE honouring redirectTo (the same class of
  // defect IM's audit found at the auth callback: a caller-supplied safe
  // target must never outrank the gate) and before listSelectableMemberships
  // could ever be called for an unverified subject (S-IA-NO-ENUMERATION-ON-
  // REFUSAL — listSelectableMemberships transits requirePrincipal, C6, which
  // refuses an unverified principal). redirectTo is CARRIED FORWARD across
  // the refusal, not honoured early, so the invite (or other) journey
  // resumes once verification completes.
  const principal = await loadRequestPrincipal()
  if (principal && !principal.emailVerified) {
    const destination = redirectTo
      ? `${VERIFY_EMAIL_PATH}?next=${encodeURIComponent(redirectTo)}`
      : VERIFY_EMAIL_PATH
    redirect(destination)
  }

  // An explicit, validated redirect target (e.g. an invitation accept link)
  // takes priority over the smart org-membership redirect below — a user
  // accepting an invite doesn't have a membership yet, so the default
  // "no membership -> onboarding" branch would otherwise strand them.
  if (redirectTo) {
    redirect(redirectTo)
  }

  // Smart redirect: go to onboarding if no org, otherwise dashboard.
  //
  // TENANCY-S3-SELECTOR-REACHABILITY (Packet A): a null membership here is
  // TRUE both for a genuinely memberless subject AND for a returning member
  // who simply has no selected-organization carrier for this session
  // (SESSION_SCOPE: "A new session starts with no selection" — the ORDINARY
  // case at login, not an edge case). Enumerate before deciding: zero
  // candidates is genuine founding; one or more — including exactly one,
  // NO_AUTO_SELECTION — routes to the selector. See the full ROUTING_CONTRACT
  // at lib/auth/session.ts requireOrganizationAccess().
  const membership = await getCurrentMembership(data.user.id)
  if (!membership) {
    const candidates = await listSelectableMemberships()
    if (candidates.length === 0) {
      redirect('/app/onboarding')
    }
    redirect('/app/organizations/select')
  }

  redirect('/app/dashboard')
}

export async function signup(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim().toLowerCase()
  const password = formData.get('password') as string | null
  const redirectParam = formData.get('redirect') as string | null
  const redirectTo = isSafeRedirectPath(redirectParam) ? redirectParam : null

  if (!email || !password || password.length < 6) {
    loginErrorRedirect('invalid_credentials', redirectTo)
  }

  if (!checkAndRecordRateLimit(`signup:${email}`, SIGNUP_RATE_LIMIT).allowed) {
    loginErrorRedirect('rate_limited', redirectTo)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({ email, password })

  if (error || !data.user) {
    loginErrorRedirect('auth_failed', redirectTo)
  }

  // Sync user profile immediately after signup
  await syncUserProfile(data.user)

  revalidatePath('/', 'layout')

  // PACKET B — Gate A (provider confirmation) may be enabled with no
  // auto-created session: signUp then returns a user but a null session, and
  // there is no cookie for loadRequestPrincipal to read a principal from.
  // The pending-verification destination applies unconditionally here —
  // there is nothing else this subject could do yet, invite link or not.
  if (!data.session) {
    redirect(VERIFY_EMAIL_PATH)
  }

  // PACKET B — B0, same rationale as login(): evaluated BEFORE honouring
  // redirectTo. A session exists past the !data.session check above, so a
  // principal is resolvable here; redirectTo is carried forward across the
  // refusal rather than honoured early.
  const principal = await loadRequestPrincipal()
  if (principal && !principal.emailVerified) {
    const destination = redirectTo
      ? `${VERIFY_EMAIL_PATH}?next=${encodeURIComponent(redirectTo)}`
      : VERIFY_EMAIL_PATH
    redirect(destination)
  }

  // Same rationale as login(): an invited user accepting via a fresh
  // signup should land on the accept link, not go through onboarding
  // and create a brand-new organization.
  if (redirectTo) {
    redirect(redirectTo)
  }

  // New users with no pending invite always go to onboarding
  redirect('/app/onboarding')
}
