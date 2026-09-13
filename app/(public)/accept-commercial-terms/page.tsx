import { loadRequestPrincipal } from '@/lib/auth/session'
import { withOrganizationAcceptanceDischargeContext } from '@/lib/auth/database-context'
import { loadRequiredOrganizationInstrumentsPendingAcceptance } from '@/lib/auth/organization-commercial-acceptance'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { acceptRequiredOrganizationInstrument } from './actions'

/**
 * app/(public)/accept-commercial-terms/page.tsx
 *
 * L1 (HPO-ODS-W2-29) — the ORGANIZATION_COMMERCIAL_ACCEPTANCE destination:
 * where the four enforcement surfaces send an organisation administrator
 * whose organisation is not current on every required ORGANIZATION-class
 * instrument.
 *
 * Served from app/(public)/, deliberately OUTSIDE every route group that
 * calls requireAuth() or requireOrganizationAccess() — the same reason
 * /verify-email and /accept-legal sit there. A destination inside a gated
 * group would redirect the subject who fails L1 straight back to itself.
 *
 * IT DOES NOT CALL ANY OF THE FOUR ENFORCEMENT SURFACES. Every one of them
 * enforces L1, so reaching for `withOrganizationDatabaseContext` here — the
 * obvious primitive, since it is the one that produces an organisation scope
 * — would reproduce CL-1's BLOCKING B-1 self-lock one gate later (mutation
 * MUT-L1-enforce-L1-on-the-discharge-boundary). The bounded
 * `withOrganizationAcceptanceDischargeContext` omits L1 and ONLY L1: it still
 * requires authentication, B0, L0, a resolved organisation scope and an
 * EXACT organization_admin role.
 *
 * NOTHING IS DISCLOSED TO AN INELIGIBLE VIEWER. An ordinary member is
 * refused by the discharge boundary before any instrument is resolved, so
 * this page never renders an instrument key, a version, any text, any
 * administrator identity, any other organisation or any commercial state to
 * them (N-AO-35, X-L1-05). Only an organization_admin receives the completion
 * call-to-action (AO1_C4, P-AO-16) — there is no affordance here for anyone
 * else, and NO notification of any kind is sent to anyone (N-AO-34).
 */
export default async function AcceptCommercialTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const principal = await loadRequestPrincipal()

  // Authentication only. B0, L0, scope and role are all re-asserted inside
  // the discharge context below; this is the cheap pre-check that avoids
  // opening one for a request with no session at all.
  if (!principal) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Acceso no disponible</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Inicia sesión para continuar.
            </p>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  // THE SAME RESOLVER THE ACTION RE-DERIVES AT SUBMISSION TIME. There is
  // exactly one L1 pending-set derivation and both halves of the discharge
  // surface use it — the page to render, the action to validate.
  const pending = await withOrganizationAcceptanceDischargeContext((ctx) =>
    loadRequiredOrganizationInstrumentsPendingAcceptance(ctx.organization.id)
  )

  // THE SURFACE MUST NOT TRAP AN ADMIN WHO HAS ALREADY DISCHARGED L1
  // (DISCHARGE_BOUNDARY.THE_DISCHARGE_SURFACE_MUST_NOT_TRAP_A_PASSING_ADMIN,
  // control TOPO-discharge-surface-not-a-dead-end). An empty pending set is
  // reached two ways and BOTH terminate here rather than re-entering the
  // chain: the organisation is already current on everything required, or a
  // required key has no presentable currently-applicable version — the
  // EMPTY/PARTIAL registry and the UNPRESENTABLE-version cases, which FAIL
  // CLOSED with NO FALLBACK to an older edition (P-AO-15, N-AO-37,
  // PRESENT-unpresentable-fails-closed).
  //
  // They are deliberately rendered as the SAME terminal state and are NOT
  // distinguished to the viewer: telling an administrator which of the two
  // applies would disclose registry shape they have no need of, and the
  // affordance is identical either way — there is nothing here to accept.
  if (pending.length === 0) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">No hay nada pendiente de aceptar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Esta organización no tiene documentos comerciales pendientes en este momento.
            </p>
            <a
              href="/app/dashboard"
              className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
            >
              Volver
            </a>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell wide>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Aceptación comercial de la organización</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Como administrador de la organización, es necesario aceptar el siguiente documento en
            nombre de la organización. El texto mostrado a continuación es exactamente el contenido
            cuya huella digital quedará registrada con la aceptación.
          </p>

          {error === 'nothing_to_accept' && (
            <p className="text-sm text-destructive" role="alert">
              No se pudo registrar la aceptación. Inténtalo de nuevo.
            </p>
          )}

          {pending.map((item) => (
            <form
              key={item.instrumentVersionId}
              action={acceptRequiredOrganizationInstrument}
              className="space-y-4"
            >
              {/* THE ONLY AUTHORITATIVE SELECTOR THE CLIENT MAY SUPPLY
                  (SUBMISSION_BINDING.WHAT_THE_CLIENT_MAY_SUPPLY). The
                  organisation, the accepting subject, the role, the
                  instrument key, the content digest and the timestamp are ALL
                  server-derived; none of them appears as a form field, so
                  none of them can be forged, and a role field submitted
                  anyway is ignored rather than validated. */}
              <input type="hidden" name="instrumentVersionId" value={item.instrumentVersionId} />
              <section className="space-y-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 className="text-sm font-semibold">
                    {ORGANIZATION_INSTRUMENT_LABELS[item.instrumentKey] ?? item.instrumentKey}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    versión {item.version} · {item.locale}
                  </span>
                </div>
                {/* The exact bytes the resolver re-verified against
                    content_digest — never invented text. */}
                <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-sm">
                  {item.content}
                </div>
                <p className="break-all text-xs text-muted-foreground">{item.contentDigest}</p>
              </section>
              <Button type="submit" className="w-full">
                Aceptar en nombre de la organización
              </Button>
            </form>
          ))}
        </CardContent>
      </Card>
    </Shell>
  )
}

// Display labels only — no instrument text is authored or stored here
// (EMPTY_AND_PARTIAL_REGISTRY.NO_INSTRUMENT_LEGAL_CONTENT_IS_AUTHORIZED_HERE).
// The content rendered above comes from item.content, resolved from the live
// registry and re-verified against content_digest before this page sees it.
const ORGANIZATION_INSTRUMENT_LABELS: Record<string, string> = {
  commercial_terms: 'Condiciones Comerciales',
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-background">
      <div className={wide ? 'w-full max-w-2xl space-y-6' : 'w-full max-w-md space-y-6'}>{children}</div>
    </div>
  )
}
