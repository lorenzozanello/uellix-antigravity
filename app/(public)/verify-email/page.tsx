import { redirect } from 'next/navigation'
import { loadRequestPrincipal } from '@/lib/auth/session'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

/**
 * app/(public)/verify-email/page.tsx
 *
 * PACKET B — B2_MINIMUM_SAFE_DESTINATION, amended by RAT-EV-01
 * (docs/ops/tenancy/TENANCY_EMAIL_VERIFICATION_PACKET_B_NO_SESSION_AUTHORITY_
 * AMENDMENT_v1.0.0.json). The one place every completeness point
 * (requireAuth, requireOrganizationAccess) and every routing translation
 * (login, signup, the auth callback, the onboarding action) sends an
 * authenticated subject whose email the provider has not confirmed.
 *
 * Served from app/(public)/, deliberately outside every route group that
 * calls requireAuth() or requireOrganizationAccess(), and outside the
 * proxy's isProtected predicate (lib/supabase/proxy.ts, `/app*` and
 * `/admin*` only). Calling either of those helpers here would redirect an
 * unverified subject straight back to this page — the same
 * ERR_TOO_MANY_REDIRECTS shape app/(authenticated)/layout.tsx exists to
 * avoid for the pre-organization case, reproduced for the pre-verification
 * one. It reads the principal directly instead.
 *
 * FOUR STATES (ROUTING_TERMINATION), branched on ONE input — whether a
 * principal resolves server-side, and if so, whether it is verified. NO
 * OTHER INPUT may select the branch (AM-B-A4, AM-B-G3): `next` is read only
 * to choose the destination of an ALREADY-DECIDED verified exit, never to
 * decide which representation renders.
 *
 *   A. no principal, direct anonymous visit         -> generic RENDER
 *   B. no principal, post-signup (no session)        -> generic RENDER (same as A — AM-B-N2, forced equivalence)
 *   C. principal, email NOT confirmed                 -> subject-aware RENDER (own address only, no tenancy)
 *   D. principal, email confirmed                     -> redirect onward (Packet A, no auto-selection)
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next: nextParam } = await searchParams
  const principal = await loadRequestPrincipal()

  // States A and B (RAT-EV-01, NO_SESSION_STATE). No session resolves for
  // either a genuinely anonymous visitor or a post-signup subject whose
  // provider returned no session (Gate A on) — the two are FORCED to be
  // indistinguishable (AM-B-N2), so both render the exact same generic,
  // PII-free representation. `nextParam` is deliberately never read on this
  // branch: there is no session to resume with, and AM-B-A2 forbids
  // consulting request-supplied values for anything on this path.
  if (!principal) {
    return <GenericVerificationPending />
  }

  // State D — verified. Exit to the governed application flow. A carried
  // `next` (from the callback's B0 refusal, or a login/signup redirect
  // target) is honoured HERE, once verification is confirmed — never
  // earlier — and only through the existing isSafeRedirectPath validation.
  // No new redirect-target vocabulary (X-B-10). The default destination is
  // /app/dashboard, which requireOrganizationAccess (C4, unmodified) will
  // itself resolve per Packet A R1-R4 for a member-less subject — this
  // page introduces no tenancy-selection logic of its own (AM-B-D1,
  // NO_AUTO_SELECTION).
  if (principal.emailVerified) {
    const safeNext = isSafeRedirectPath(nextParam ?? null) ? (nextParam as string) : null
    redirect(safeNext ?? '/app/dashboard')
  }

  // State C — authenticated, unverified. May show this subject's OWN
  // address (AM-B-C1: the principal already knows it, so this discloses
  // nothing to a third party), but no tenancy (AM-B-C2).
  return <SubjectAwareVerificationPending email={principal.user.email} />
}

/**
 * States A and B. Conveys exactly two things: verification is required, and
 * a person who recently signed up should check email. No email address, no
 * account identifier, no tenancy, no resend affordance (AM-B-N3, AM-B-G2).
 */
function GenericVerificationPending() {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Verificación de correo requerida</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Es necesario verificar tu correo electrónico antes de continuar.
          </p>
          <p className="text-sm text-muted-foreground">
            Si has creado una cuenta hace poco, revisa tu bandeja de entrada y sigue el enlace de
            verificación que te enviamos.
          </p>
        </CardContent>
      </Card>
    </Shell>
  )
}

/** State C. Subject-aware, but tenancy-independent (AM-B-C2). */
function SubjectAwareVerificationPending({ email }: { email: string }) {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Verifica tu correo electrónico</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Hemos enviado un enlace de confirmación a <strong>{email}</strong>. Ábrelo para
            continuar.
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
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md space-y-6">{children}</div>
    </div>
  )
}
