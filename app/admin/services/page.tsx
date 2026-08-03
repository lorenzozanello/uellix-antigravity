import { listOrganizationsWithStellaUsage } from '@/lib/admin/stella-services'
import { runWithAdminAccess } from '@/lib/auth/session'
import { updateOrganizationStellaServiceAction } from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  not_authorized: 'No tenés permiso para esta operación, o tu sesión ya no es válida.',
  invalid_input: 'Datos inválidos. La cuota debe ser un número entero mayor o igual a 0, o vacía para ilimitado.',
  update_failed: 'No se pudo actualizar el servicio de esta organización.',
}

// es-LA (Latin American Spanish) formatting — BCP-47 tag es-419.
const tokensFormat = new Intl.NumberFormat('es-419')
const costFormat = new Intl.NumberFormat('es-419', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

export default async function AdminServicesPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const searchParams = await props.searchParams
  const orgs = await runWithAdminAccess(() => listOrganizationsWithStellaUsage())

  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error.' : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Servicios Stella</h1>
        <p className="text-slate-400 mt-2">
          No hay pasarela de pago en la plataforma. Asigná manualmente el plan y la cuota mensual
          de Stella de cada organización — todas arrancan en cuota 0 (bloqueadas) hasta que las
          habilites acá.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-red-900/40 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </div>
      )}
      {searchParams?.success === 'updated' && (
        <div className="rounded-md border border-green-900/40 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          Servicio actualizado correctamente.
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Organización</th>
              <th className="text-left px-4 py-3 font-medium">Plan</th>
              <th className="text-left px-4 py-3 font-medium">Cuota mensual</th>
              <th className="text-left px-4 py-3 font-medium">Uso este mes</th>
              <th className="text-left px-4 py-3 font-medium">Tokens este mes</th>
              <th className="text-left px-4 py-3 font-medium">Costo estimado (USD)</th>
              <th className="text-right px-4 py-3 font-medium">Actualizar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {orgs.map((org) => (
              <tr key={org.id}>
                <td className="px-4 py-3 text-white">{org.name}</td>
                <td className="px-4 py-3 text-slate-400">{org.stellaPlanLabel ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">
                  {org.stellaMonthlyQuota === null ? 'Ilimitado' : org.stellaMonthlyQuota}
                </td>
                <td className="px-4 py-3 text-slate-400">{org.usedThisMonth}</td>
                <td className="px-4 py-3 text-slate-400">{tokensFormat.format(org.tokensThisMonth)}</td>
                <td className="px-4 py-3 text-slate-400">
                  {org.tokensThisMonth > 0 ? `≈ ${costFormat.format(org.estimatedCostUsd)}` : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <form action={updateOrganizationStellaServiceAction} className="flex items-center justify-end gap-2">
                    <input type="hidden" name="organizationId" value={org.id} />
                    <input
                      type="text"
                      name="planLabel"
                      defaultValue={org.stellaPlanLabel ?? ''}
                      placeholder="Plan"
                      className="w-24 rounded-md bg-slate-950 border border-slate-800 text-xs text-white px-2 py-1"
                    />
                    <input
                      type="number"
                      name="monthlyQuota"
                      min={0}
                      defaultValue={org.stellaMonthlyQuota ?? ''}
                      placeholder="Ilimitado"
                      className="w-24 rounded-md bg-slate-950 border border-slate-800 text-xs text-white px-2 py-1"
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-red-600 hover:bg-red-500 transition-colors text-xs font-medium text-white px-3 py-1.5"
                    >
                      Guardar
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        El costo es una <strong className="text-slate-400">estimación</strong> basada en una
        heurística mixta input/output sobre el total de tokens (solo se registra el total por
        interacción). Supuestos y precios en <code>lib/stella/cost-model.ts</code>; la
        calibración contra la facturación real de Gemini es el gate G9.
      </p>
    </div>
  )
}
