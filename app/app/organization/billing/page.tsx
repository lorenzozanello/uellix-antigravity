import { runWithOrganizationAccess } from '@/lib/auth/session'
import { ROLES } from '@/lib/auth/roles'
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { createStripePortalSession } from './actions'
import { getStellaQuotaDisplay } from './quota-display'
import { db } from '@/db/client'
import { stellaInteractions } from '@/db/schema'
import { and, eq, gte, count } from 'drizzle-orm'
import { startOfCurrentUtcMonth } from '@/lib/stella/quota'
import { CheckCircle2, CreditCard, Zap } from 'lucide-react'

export default async function BillingPage() {
  const { organization, membership, usedThisMonth } = await runWithOrganizationAccess(
    async ({ organization, membership }) => ({
      organization,
      membership,
      // Usage from the same source the admin rollup uses: count of
      // stella_interactions for this org in the current UTC calendar month.
      usedThisMonth: await db
        .select({ value: count() })
        .from(stellaInteractions)
        .where(
          and(
            eq(stellaInteractions.organizationId, organization.id),
            gte(stellaInteractions.createdAt, startOfCurrentUtcMonth())
          )
        )
        .then((rows) => rows[0]?.value ?? 0),
    })
  )

  const isAdmin = membership.role === ROLES.SUPER_ADMIN || membership.role === ROLES.ORGANIZATION_ADMIN

  // Real quota semantics — same as the enforcement path (lib/stella/quota.ts)
  // and the admin panel (/admin/services). No invented fallback.
  const quotaDisplay = getStellaQuotaDisplay(organization.stellaMonthlyQuota)
  const planLabel = organization.stellaPlanLabel ?? 'Sin plan'

  const usageLine =
    quotaDisplay.state === 'assigned'
      ? `${usedThisMonth} / ${organization.stellaMonthlyQuota}`
      : quotaDisplay.state === 'unlimited'
        ? `${usedThisMonth} (sin límite)`
        : `${usedThisMonth}`

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Suscripción y Facturación</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan comercial y límites de uso de Stella AI para {organization.name}.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-uellix-orange" />
              Plan actual: {planLabel}
            </CardTitle>
            <CardDescription>{quotaDisplay.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-slate-50 border rounded-lg p-4">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-slate-500">Cuota mensual de Stella</dt>
                  <dd className="font-semibold text-slate-900">{quotaDisplay.quotaLabel}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Uso este mes</dt>
                  <dd className="font-semibold text-slate-900">{usageLine}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-slate-500">
                El uso se cuenta por consulta a Stella y se reinicia el primer día de cada mes
                calendario (UTC) — el mismo conteo que aplica el sistema al autorizar cada consulta.
              </p>
            </div>

            <div className="bg-slate-50 border rounded-lg p-4">
              <h3 className="font-semibold text-sm text-slate-900 mb-2">Incluido en la plataforma:</h3>
              <ul className="space-y-2 text-sm text-slate-600">
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Acceso al Banco Global de Proxies</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Exportación de Reportes Audit-Ready (PDF)</li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  {quotaDisplay.state === 'unassigned'
                    ? 'Stella AI (requiere plan asignado por Uellix)'
                    : `Stella AI (${quotaDisplay.quotaLabel.toLowerCase()})`}
                </li>
              </ul>
            </div>
          </CardContent>
          <CardFooter className="bg-slate-50 border-t px-6 py-4">
            {isAdmin ? (
              <div className="w-full space-y-2">
                <p className="text-xs text-slate-500">
                  Los planes y cuotas de Stella se gestionan directamente con el equipo de Uellix —
                  no hay pasarela de pago de autoservicio. Escribinos a{' '}
                  <a href="mailto:hola@uellix.com" className="underline underline-offset-2">hola@uellix.com</a>{' '}
                  para cambiar de plan. El portal de facturación solo muestra comprobantes si tu
                  organización ya tiene facturación configurada por Uellix.
                </p>
                <form action={createStripePortalSession}>
                  <Button
                    type="submit"
                    variant="default"
                    className="w-full sm:w-auto"
                    disabled={!organization.stripeCustomerId}
                  >
                    <CreditCard className="mr-2 h-4 w-4" />
                    Portal de facturación
                  </Button>
                </form>
                {!organization.stripeCustomerId && (
                  <p className="text-xs text-slate-500">
                    Tu organización todavía no tiene facturación configurada, por eso el portal está deshabilitado.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">Solo los administradores de la organización pueden gestionar la facturación.</p>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
