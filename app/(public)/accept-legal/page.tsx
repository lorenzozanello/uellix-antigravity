import { redirect } from 'next/navigation'
import { loadRequestPrincipal } from '@/lib/auth/session'
import { VERIFY_EMAIL_PATH } from '@/lib/auth/email-verification'
import { loadRequiredInstrumentsPendingAcceptance } from '@/lib/auth/legal-acceptance'
import { withAccountAcceptanceDischargeContext } from '@/lib/auth/database-context'
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
  // second one (S-AO-PREDICATE-CARDINALITY). B-1 REPAIR: this MUST NOT use
  // withAuthenticatedDatabaseContext — that helper's requirePrincipal
  // re-asserts L0 (assertPrincipalGates), which throws for the EXACT subject
  // this page exists to serve, self-locking the discharge surface. B0 is
  // still required (already asserted at :42, and again inside the discharge
  // context itself); L0 is deliberately not re-asserted here.
  const pending = await withAccountAcceptanceDischargeContext((ctx) =>
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
    <Shell wide>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Aceptación de términos requerida</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Antes de continuar, es necesario aceptar los siguientes documentos. El texto mostrado
            a continuación es exactamente el contenido cuya huella digital quedará registrada con
            tu aceptación.
          </p>

          {error === 'nothing_to_accept' && (
            <p className="text-sm text-destructive" role="alert">
              No se recibió ningún documento para aceptar. Inténtalo de nuevo.
            </p>
          )}

          <form action={acceptRequiredLegalInstruments} className="space-y-6">
            {safeNext && <input type="hidden" name="next" value={safeNext} />}
            <div className="space-y-4">
              {pending.map((item) => (
                <section key={item.instrumentVersionId} className="space-y-2 rounded-md border border-border p-3">
                  <input type="hidden" name="instrumentVersionId" value={item.instrumentVersionId} />
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h2 className="text-sm font-semibold">
                      {LEGAL_INSTRUMENT_LABELS[item.instrumentKey] ?? item.instrumentKey}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      versión {item.version} · {item.locale}
                    </span>
                  </div>
                  {/* The exact bytes lib/auth/legal-acceptance.ts re-verified
                      against content_digest — never invented text, and never
                      a route name that merely happens to correspond. */}
                  <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-sm">
                    {item.content}
                  </div>
                  <p className="break-all text-xs text-muted-foreground">{item.contentDigest}</p>
                </section>
              ))}
            </div>
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
// The actual content rendered above comes from item.content, resolved by
// lib/auth/legal-acceptance.ts loadRequiredInstrumentsPendingAcceptance and
// re-verified there against content_digest before this page ever sees it.
const LEGAL_INSTRUMENT_LABELS: Record<string, string> = {
  terms_of_service: 'Términos de Servicio',
  privacy_policy: 'Política de Privacidad',
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-background">
      <div className={wide ? 'w-full max-w-2xl space-y-6' : 'w-full max-w-md space-y-6'}>{children}</div>
    </div>
  )
}
