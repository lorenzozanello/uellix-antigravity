import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLES } from '@/lib/auth/roles'
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { createStripePortalSession } from './actions'
import { CheckCircle2, CreditCard, Zap } from 'lucide-react'

export default async function BillingPage() {
  const ctx = await requireOrganizationAccess()
  const { organization, membership } = ctx

  const isAdmin = membership.role === ROLES.SUPER_ADMIN || membership.role === ROLES.ORGANIZATION_ADMIN
  const planLabel = organization.stellaPlanLabel || 'Free'
  const quota = organization.stellaMonthlyQuota || 10

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Suscripción y Facturación</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gestiona el plan comercial y los límites de uso de Stella AI para {organization.name}.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-uellix-orange" />
              Plan Actual: {planLabel}
            </CardTitle>
            <CardDescription>
              Tienes acceso a {quota} consultas mensuales de inteligencia de impacto.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-slate-50 border rounded-lg p-4">
              <h3 className="font-semibold text-sm text-slate-900 mb-2">Características incluidas:</h3>
              <ul className="space-y-2 text-sm text-slate-600">
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Acceso al Banco Global de Proxies</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Exportación de Reportes Audit-Ready (PDF)</li>
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> API de Stella AI ({quota} req/mes)</li>
              </ul>
            </div>
          </CardContent>
          <CardFooter className="bg-slate-50 border-t px-6 py-4">
            {isAdmin ? (
              <form action={createStripePortalSession} className="w-full">
                <Button type="submit" variant="default" className="w-full sm:w-auto" disabled={!organization.stripeCustomerId}>
                  <CreditCard className="mr-2 h-4 w-4" />
                  {organization.stripeCustomerId ? 'Administrar Facturación en Stripe' : 'Contactar a Ventas para Actualizar'}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-slate-500">Solo los administradores de la organización pueden gestionar la facturación.</p>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
