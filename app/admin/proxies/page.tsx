import { listGlobalProxySources, listGlobalFinancialProxies } from '@/lib/admin/proxies'
import {
  createGlobalProxySourceAction,
  createGlobalFinancialProxyAction,
  updateGlobalProxyReviewStatusAction,
} from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: 'Completa todos los campos requeridos con valores válidos.',
  not_global: 'Ese proxy pertenece a una organización — no se puede gestionar aquí.',
  missing_fields: 'No se puede aprobar: faltan valor, moneda, unidad o año de referencia.',
  invalid_status: 'Estado inválido.',
  not_found: 'Proxy no encontrado.',
  unknown_error: 'Ocurrió un error. Intenta de nuevo.',
}

const REVIEW_STATUS_LABEL: Record<string, string> = {
  suggested: 'Sugerido',
  pending_review: 'En revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  archived: 'Archivado',
}

export default async function AdminProxiesPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const searchParams = await props.searchParams
  const [sources, proxies] = await Promise.all([listGlobalProxySources(), listGlobalFinancialProxies()])

  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? ERROR_MESSAGES.unknown_error : null

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Proxies Globales</h1>
        <p className="text-slate-400 mt-2">
          Proxies financieros de sistema, disponibles para todas las organizaciones tras aprobación.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-red-900/40 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </div>
      )}
      {searchParams?.success && (
        <div className="rounded-md border border-green-900/40 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          Cambios guardados correctamente.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Nueva fuente oficial</h3>
          <form action={createGlobalProxySourceAction} className="space-y-3">
            <input
              name="name"
              type="text"
              required
              placeholder="Nombre (ej. PNUD)"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
            />
            <input
              name="url"
              type="url"
              placeholder="URL de referencia (opcional)"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
            />
            <button
              type="submit"
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
            >
              Crear fuente
            </button>
          </form>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Nuevo proxy global</h3>
          {sources.length === 0 ? (
            <p className="text-sm text-slate-500">Crea al menos una fuente antes de agregar un proxy.</p>
          ) : (
            <form action={createGlobalFinancialProxyAction} className="space-y-3">
              <select
                name="sourceId"
                required
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              <input
                name="name"
                type="text"
                required
                placeholder="Nombre del proxy"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  name="value"
                  type="text"
                  required
                  placeholder="Valor"
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
                <input
                  name="currency"
                  type="text"
                  required
                  placeholder="Moneda (USD)"
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
                <input
                  name="unit"
                  type="text"
                  required
                  placeholder="Unidad"
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
                <input
                  name="referenceYear"
                  type="number"
                  required
                  placeholder="Año"
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
              </div>
              <button
                type="submit"
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                Crear proxy
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Nombre</th>
              <th className="text-left px-4 py-3 font-medium">Valor</th>
              <th className="text-left px-4 py-3 font-medium">Año</th>
              <th className="text-left px-4 py-3 font-medium">Estado</th>
              <th className="text-right px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {proxies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Aún no hay proxies globales.
                </td>
              </tr>
            ) : (
              proxies.map((proxy) => (
                <tr key={proxy.id}>
                  <td className="px-4 py-3 text-white">{proxy.name}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {proxy.value} {proxy.currency}/{proxy.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{proxy.referenceYear ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {REVIEW_STATUS_LABEL[proxy.reviewStatus] ?? proxy.reviewStatus}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    {proxy.reviewStatus !== 'approved' && (
                      <form action={updateGlobalProxyReviewStatusAction} className="inline">
                        <input type="hidden" name="proxyId" value={proxy.id} />
                        <input type="hidden" name="status" value="approved" />
                        <button type="submit" className="text-xs font-medium text-green-400 hover:underline">
                          Aprobar
                        </button>
                      </form>
                    )}
                    {proxy.reviewStatus !== 'rejected' && (
                      <form action={updateGlobalProxyReviewStatusAction} className="inline">
                        <input type="hidden" name="proxyId" value={proxy.id} />
                        <input type="hidden" name="status" value="rejected" />
                        <button type="submit" className="text-xs font-medium text-red-400 hover:underline">
                          Rechazar
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
