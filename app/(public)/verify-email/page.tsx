import { redirect } from 'next/navigation'
import { loadRequestPrincipal } from '@/lib/auth/session'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

/**
 * app/(public)/verify-email/page.tsx
 *
 * PACKET B — B2_MINIMUM_SAFE_DESTINATION. The one place every completeness
 * point (requireAuth, requireOrganizationAccess) and every routing
 * translation (login, signup, the auth callback, the onboarding action)
 * sends an authenticated subject whose email the provider has not confirmed.
 *
 * Served from app/(public)/, deliberately outside every route group that
 * calls requireAuth() or requireOrganizationAccess(), and outside the
 * proxy's isProtected predicate (lib/supabase/proxy.ts, `/app*` and
 * `/admin*` only). Calling either of those helpers here would redirect an
 * unverified subject straight back to this page — the same
 * ERR_TOO_MANY_REDIRECTS shape app/(authenticated)/layout.tsx exists to
 * avoid for the pre-organization case, reproduced for the pre-verification
 * one. It reads the principal directly instead.
 */
export default async function VerifyEmailPage() {
  const principal = await loadRequestPrincipal()

  if (!principal) {
    redirect('/login')
  }

  if (principal.emailVerified) {
    redirect('/app/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Verifica tu correo electrónico</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Hemos enviado un enlace de confirmación a <strong>{principal.user.email}</strong>. Ábrelo
              para continuar.
            </p>
            <p className="text-sm text-muted-foreground">
              Si no lo encuentras, revisa la carpeta de spam.
            </p>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
              >
                Cerrar sesión
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
