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
      // F0-02: antes esto apuntaba a '/app', que NO es una ruta — la tabla de
      // rutas sólo tiene /app/dashboard, /app/projects, etc. El resultado era
      // que toda organización nueva veía un 404 en inglés justo después de
      // completar su onboarding, pese a que los datos sí se habían guardado.
      router.push('/app/dashboard')
    }
  }, [onboardingCompleted, pathname, router])

  return null
}
