import { ErrorState } from '@/components/states/ErrorState'

const EXPLANATION_ID = 'phase2-onboarding-blocked-explanation'

/**
 * RE-U4-CF-01 (NON_ADMIN_PHASE2_ONBOARDING_TRAP): a non-admin member of an
 * organisation whose onboardingCompleted is false is still routed here by
 * OnboardingCheck (components/auth/OnboardingCheck.tsx redirects on
 * onboardingCompleted alone, not on role), but completeOnboarding
 * (app/actions/onboarding.ts) correctly refuses any caller who is not
 * organization_admin+. Rendering the setup form to that caller produced a
 * dead end: a submit that always server-rejects, with no explanation and no
 * way out. This component is that explanation, plus the same two universally
 * safe exits used by the phase-1 onboarding dead end (RE-U5, U1-F01) — sign
 * out and support — neither of which is an /app/** route OnboardingCheck
 * would redirect back to Phase 2.
 */
export function OrganizationOnboardingBlocked() {
  return (
    <div className="min-h-screen bg-[var(--uellix-paper)] flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <ErrorState
          id={EXPLANATION_ID}
          title="Configuración pendiente de un administrador"
          message="La configuración inicial de esta organización debe completarla una persona con rol de Administrador de Organización. Tu cuenta ya tiene acceso, pero todavía no puede completar este paso. Pide a un administrador de tu organización que finalice la configuración, o contacta al equipo de Uellix si necesitas ayuda."
        />

        <nav aria-label="Salir" className="flex items-center justify-center gap-6 text-sm">
          <a
            href="mailto:hola@uellix.com"
            className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            Contactar soporte
          </a>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              Cerrar sesión
            </button>
          </form>
        </nav>
      </div>
    </div>
  )
}
