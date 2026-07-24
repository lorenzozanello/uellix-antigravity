import { redirect } from 'next/navigation'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLES, ROLE_LABELS } from '@/lib/auth/roles'
import { listOrganizationAdminsForCurrentOrganization } from '@/lib/organizations/members'
import { OnboardingForm } from './onboarding-form'
import { OnboardingPending } from './onboarding-pending'

// El layout raíz aplica la plantilla "%s | Uellix", así que aquí va sólo el
// nombre de la página; incluir el sufijo produciría "… | Uellix | Uellix".
export const metadata = {
  title: 'Configuración inicial',
}

/**
 * Server Component que decide QUÉ ve cada rol en la ruta de onboarding.
 *
 * F0-02 / F0-03. Tres comportamientos, resueltos en el servidor para que no
 * haya parpadeo de contenido ni bucles de redirección:
 *
 *   1. Onboarding ya completado  → /app/dashboard (nunca a '/app', que no existe).
 *   2. Rol con permiso           → formulario de configuración.
 *   3. Cualquier otro rol        → pantalla de espera en español, con los
 *                                  administradores a quienes contactar y la
 *                                  opción de cerrar sesión.
 *
 * El caso 3 es el que antes dejaba atrapados a analistas, revisores y visores:
 * veían el formulario, lo enviaban y recibían un error en inglés sin salida.
 */
export default async function OnboardingPage() {
  const { organization, membership } = await requireOrganizationAccess()

  if (organization.onboardingCompleted) {
    redirect('/app/dashboard')
  }

  const canCompleteOnboarding =
    membership.role === ROLES.SUPER_ADMIN || membership.role === ROLES.ORGANIZATION_ADMIN

  if (canCompleteOnboarding) {
    return <OnboardingForm />
  }

  const admins = await listOrganizationAdminsForCurrentOrganization()

  return (
    <OnboardingPending
      organizationName={organization.name}
      roleLabel={ROLE_LABELS[membership.role] ?? membership.role}
      admins={admins}
    />
  )
}
