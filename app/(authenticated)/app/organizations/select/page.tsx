// app/(authenticated)/app/organizations/select/page.tsx
//
// The pre-organization selector (S2).
//
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.1.json
// S2_ROUTE_TOPOLOGY_DECISION: this route is DELIBERATELY placed OUTSIDE
// app/app/** — requiring an organization principal in order to reach the
// organization selector is circular, the same cycle app/(authenticated)/
// layout.tsx's own header describes for onboarding. It is reached via
// app/(authenticated)/layout.tsx, which calls only `requireAuth()` — no
// organization is required to render this page.
//
// This page renders NO SELECTION. It reads the caller's own membership
// (an EXISTING source, lib/auth/session.ts) and presents an EXPLICIT act —
// a form submit to `selectOrganizationAction` — as the only way the carrier
// is ever written. See SESSION_SCOPE.no_selection_behavior: even in the
// single-membership case, presenting the organization is not the same as
// selecting it, and the distinction here is the same one the authority
// requires be observable — the carrier does not exist until the button is
// pressed.

import { requireAuth, getCurrentOrganizationContext } from '@/lib/auth/session'
import { getSelectedOrganizationId } from '@/lib/auth/selected-organization'
import { selectOrganizationAction } from './actions'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/states/ErrorState'

const ERROR_MESSAGES: Record<string, string> = {
  missing_organization: 'No se especificó ninguna organización.',
  not_a_member: 'No perteneces a esa organización, o tu membresía ya no está activa.',
}

const ERROR_ID = 'organization-selection-error'

export default async function SelectOrganizationPage(props: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireAuth()

  const context = await getCurrentOrganizationContext()
  const currentlySelectedOrganizationId = await getSelectedOrganizationId()

  const searchParams = await props.searchParams
  const errorKey = searchParams?.error
  const errorMessage = errorKey ? ERROR_MESSAGES[errorKey] ?? 'Ocurrió un error. Intenta de nuevo.' : null

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Selecciona una organización
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Elige la organización en la que quieres trabajar durante esta sesión.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Tu organización</CardTitle>
          </CardHeader>
          <CardContent>
            {errorMessage && (
              <ErrorState
                id={ERROR_ID}
                title="No se pudo seleccionar la organización"
                message={errorMessage}
                className="mb-5"
              />
            )}

            {!context ? (
              <p className="text-sm text-muted-foreground">
                Todavía no perteneces a ninguna organización activa.
              </p>
            ) : (
              <form action={selectOrganizationAction} className="space-y-4">
                <input type="hidden" name="organizationId" value={context.organization.id} />
                <div className="rounded-md border border-border px-4 py-3">
                  <p className="text-sm font-medium text-foreground">{context.organization.name}</p>
                  {context.organization.id === currentlySelectedOrganizationId && (
                    <p className="mt-1 text-xs text-muted-foreground">Actualmente seleccionada</p>
                  )}
                </div>
                <Button type="submit" id="btn-select-organization" className="w-full">
                  Seleccionar organización
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
