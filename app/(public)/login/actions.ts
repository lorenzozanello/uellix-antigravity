'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { syncUserProfile, getCurrentMembership } from '@/lib/auth/session'

export async function login(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim()
  const password = formData.get('password') as string | null

  if (!email || !password || password.length < 6) {
    redirect('/login?error=invalid_credentials')
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data.user) {
    redirect('/login?error=auth_failed')
  }

  // Sync user profile (idempotent upsert)
  await syncUserProfile(data.user)

  revalidatePath('/', 'layout')

  // Smart redirect: go to onboarding if no org, otherwise dashboard
  const membership = await getCurrentMembership(data.user.id)
  if (!membership) {
    redirect('/app/onboarding')
  }

  redirect('/app/dashboard')
}

export async function signup(formData: FormData) {
  const email = (formData.get('email') as string | null)?.trim()
  const password = formData.get('password') as string | null

  if (!email || !password || password.length < 6) {
    redirect('/login?error=invalid_credentials')
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({ email, password })

  if (error || !data.user) {
    redirect('/login?error=auth_failed')
  }

  // Sync user profile immediately after signup
  await syncUserProfile(data.user)

  revalidatePath('/', 'layout')

  // New users always go to onboarding
  redirect('/app/onboarding')
}
