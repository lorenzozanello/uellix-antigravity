import { redirect } from 'next/navigation'
import { loadRequestPrincipal } from '@/lib/auth/session'
import { VERIFY_EMAIL_PATH } from '@/lib/auth/email-verification'
import { loadRequiredInstrumentsPendingAcceptance } from '@/lib/auth/legal-acceptance'
import { withAuthenticatedDatabaseContext } from '@/lib/auth/database-context'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { acceptRequiredLegalInstruments } from './actions'

/**
 * app/(public)/accept-legal/page.tsx
 *
 * CL-1 (HPO-ODS-W2-28) — CL1-S3/CL1-S4/CL1-S5. The account-class L0
 * acceptance destination: where K3 (requireAuth) and K4
 * (requireOrganizationAccess) send a verified subject who is not current on
 * every required ACCOUNT-class instrument.
 *
 * Served from app/(public)/, deliberately outside every route group that
 * calls requireAuth() or requireOrganizationAccess() — the same reason
 * app/(public)/verify-email/page.tsx sits there (B0_PRESERVATION /
 * ENFORCEMENT_TOPOLOGY.L0_ATTACHMENT.explicitly_not_gated_by_L0). Calling
 * either helper here would redirect a subject who fails L0 straight back to
 * this page.
 *
 * B0 BEFORE L0 (B0_PRESERVATION.REQUIRED): an unverified subject is refused
 * by B0 at VERIFY_EMAIL_PATH, never shown this page — re-checked directly
 * here, defensively, exactly as verify-email re-checks its own precondition
 * rather than assuming K3/K4 always ran first.
 */
export default async function AcceptLegalPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next: nextParam, error } = await searchParams
  const principal = await loadRequestPrincipal()

  if (!principal) redirect('/login')

  // B0 precedes L0 (B0_PRESERVATION.REQUIRED — "REMAIN AFTER B0").
  if (!principal.emailVerified) redirect(VERIFY_EMAIL_PATH)

  const safeNext = isSafeRedirectPath(nextParam ?? null) ? (nextParam as string) : null

  // Already current — nothing to discharge. Exit to the governed application
  // flow, exactly as verify-email exits once B0 is satisfied.
  if (principal.accountAcceptanceCurrent) {
    redirect(safeNext ?? '/app/dashboard')
  }

  // CL1-S3 resolver, read within a context so RLS scopes it to this subject —
  // the SAME predicate accountAcceptanceCurrent was derived from, never a
  // second one (S-AO-PREDICATE-CARDINALITY).
  const pending = await withAuthenticatedDatabaseContext((ctx) =>
    loadRequiredInstrumentsPendingAcceptance(ctx.user.id)
  )

  // EMPTY_INSTRUMENT_REGISTRY / PARTIAL_REGISTRY (FAIL_CLOSED.FC_7,
  // N-AO-37): a required key has no currently applicable published version.
  // The gate has already refused (accountAcceptanceCurrent is false); there
  // is nothing this page can let the subject accept, so it says so rather
  // than rendering a partial, misleading form.
  if (pending.length === 0) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Acceso temporalmente no disponible</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Los documentos legales necesarios para continuar aún no están publicados. Vuelve a
              intentarlo más tarde.
            </p>
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="outline" className="w-full">
                Cerrar sesión
              </Button>
            </form>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Aceptación de términos requerida</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Antes de continuar, es necesario aceptar los siguientes documentos.
          </p>

          {error === 'nothing_to_accept' && (
            <p className="text-sm text-destructive" role="alert">
              No se recibió ningún documento para aceptar. Inténtalo de nuevo.
            </p>
          )}

          <form action={acceptRequiredLegalInstruments} className="space-y-4">
            {safeNext && <input type="hidden" name="next" value={safeNext} />}
            <ul className="space-y-2">
              {pending.map((item) => (
                <li key={item.instrumentVersionId} className="text-sm">
                  <input type="hidden" name="instrumentVersionId" value={item.instrumentVersionId} />
                  {/* UX_REACHABILITY_FOLLOWUP: these public pages are static
                      presentation, not yet wired to render FROM the T2 record
                      (INSTRUMENT_MODEL.INSTRUMENT_OF_RECORD_VERSUS_PRESENTATION
                      .what_the_presentation_surfaces_must_do_instead) — that
                      wiring is a future allocation this unit does not make. */}
                  <a
                    href={LEGAL_INSTRUMENT_PRESENTATION_PATHS[item.instrumentKey] ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-4"
                  >
                    {LEGAL_INSTRUMENT_LABELS[item.instrumentKey] ?? item.instrumentKey}
                  </a>
                </li>
              ))}
            </ul>
            <Button type="submit" className="w-full">
              Aceptar y continuar
            </Button>
          </form>

          <form action="/auth/signout" method="post">
            <Button type="submit" variant="outline" className="w-full">
              Cerrar sesión
            </Button>
          </form>
        </CardContent>
      </Card>
    </Shell>
  )
}

// Display labels only — no instrument text is authored or stored here
// (EMPTY_INSTRUMENT_REGISTRY.NO_INSTRUMENT_LEGAL_CONTENT_IS_AUTHORIZED_HERE).
const LEGAL_INSTRUMENT_LABELS: Record<string, string> = {
  terms_of_service: 'Términos de Servicio',
  privacy_policy: 'Política de Privacidad',
}

const LEGAL_INSTRUMENT_PRESENTATION_PATHS: Record<string, string> = {
  terms_of_service: '/terminos',
  privacy_policy: '/privacidad',
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md space-y-6">{children}</div>
    </div>
  )
}
