'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'

export function OnboardingCheck({ onboardingCompleted }: { onboardingCompleted: boolean }) {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!onboardingCompleted && pathname !== '/app/organization/onboarding') {
      router.push('/app/organization/onboarding')
    } else if (onboardingCompleted && pathname === '/app/organization/onboarding') {
      router.push('/app')
    }
  }, [onboardingCompleted, pathname, router])

  return null
}
