'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership } from '@/lib/auth/session'
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

  // An explicit, validated redirect target (e.g. an invitation accept link)
  // takes priority over the smart org-membership redirect below — a user
  // accepting an invite doesn't have a membership yet, so the default
  // "no membership -> onboarding" branch would otherwise strand them.
  if (redirectTo) {
    redirect(redirectTo)
  }

  // Smart redirect: go to onboarding if no org, otherwise dashboard
  const membership = await getCurrentMembership(data.user.id)
  if (!membership) {
    redirect('/app/onboarding')
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

  // Same rationale as login(): an invited user accepting via a fresh
  // signup should land on the accept link, not go through onboarding
  // and create a brand-new organization.
  if (redirectTo) {
    redirect(redirectTo)
  }

  // New users with no pending invite always go to onboarding
  redirect('/app/onboarding')
}
