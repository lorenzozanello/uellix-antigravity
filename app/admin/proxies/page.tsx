import { listGlobalProxySources, listGlobalFinancialProxies, listPendingReviewProxies } from '@/lib/admin/proxies'
import {
  createGlobalProxySourceAction,
  createGlobalFinancialProxyAction,
  updateGlobalProxyReviewStatusAction,
  setGlobalProxyManualFxRateAction,
  promoteProxyToGlobalAction,
} from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: 'Completa todos los campos requeridos con valores válidos.',
  not_global: 'Ese proxy pertenece a una organización — no se puede gestionar aquí.',
  missing_fields: 'No se puede aprobar: faltan valor, moneda, unidad o año de referencia.',
  invalid_status: 'Estado inválido.',
  not_found: 'Proxy no encontrado.',
  fx_not_needed: 'Los proxies en USD no necesitan una tasa de conversión.',
  invalid_rate: 'La tasa debe ser un número mayor a 0.',
  fx_rate_missing: 'No se puede aprobar: falta la conversión a USD para este proxy.',
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
  const [sources, proxies, pendingProxies] = await Promise.all([
    listGlobalProxySources(), 
    listGlobalFinancialProxies(),
    listPendingReviewProxies()
  ])

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
            <form action={createGlobalFinancialProxyAction} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Fuente oficial</label>
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
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Nombre del proxy</label>
                <input
                  name="name"
                  type="text"
                  required
                  placeholder="Ej: Salario mínimo, 1 hectárea de bosque"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
              </div>
              <div className="border-t border-slate-700 pt-4">
                <h4 className="text-xs font-semibold text-slate-300 mb-3">Valor y moneda</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Valor</label>
                    <input
                      name="value"
                      type="text"
                      required
                      placeholder="100"
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Moneda</label>
                    <input
                      name="currency"
                      type="text"
                      required
                      placeholder="USD, COP, EUR, GBP…"
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Unidad</label>
                    <input
                      name="unit"
                      type="text"
                      required
                      placeholder="mes, hectárea…"
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Año de referencia</label>
                    <input
                      name="referenceYear"
                      type="number"
                      required
                      placeholder="2024"
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                    />
                  </div>
                </div>
              </div>
              <div className="text-xs text-slate-400 bg-slate-950/50 rounded px-3 py-2 border border-slate-800">
                <strong>Nota:</strong> Si la moneda es USD se usará directamente. Si es COP se auto-convertirá al aprobar usando la TRM oficial del 31 de diciembre del año de referencia. Otras monedas requieren entrada manual de la tasa después de crear el proxy.
              </div>
              <button
                type="submit"
                className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                Crear proxy
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto mt-8 mb-8">
        <div className="px-4 py-4 border-b border-slate-800">
          <h3 className="text-lg font-semibold text-white">Sugerencias de la Comunidad</h3>
          <p className="text-sm text-slate-400">
            Proxies sugeridos por organizaciones que están pendientes de revisión para el Banco Global.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Nombre</th>
              <th className="text-left px-4 py-3 font-medium">Valor</th>
              <th className="text-left px-4 py-3 font-medium">Año</th>
              <th className="text-right px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {pendingProxies.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                  No hay proxies pendientes de revisión.
                </td>
              </tr>
            ) : (
              pendingProxies.map((proxy) => (
                <tr key={proxy.id}>
                  <td className="px-4 py-3 text-white">{proxy.name}</td>
                  <td className="px-4 py-3 text-slate-400">
                    <div className="text-sm">{proxy.value}</div>
                    <div className="text-xs text-slate-500">{proxy.currency}/{proxy.unit}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{proxy.referenceYear ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <form action={promoteProxyToGlobalAction} className="inline">
                      <input type="hidden" name="proxyId" value={proxy.id} />
                      <button
                        type="submit"
                        className="text-xs font-medium text-green-400 hover:underline transition"
                      >
                        Aprobar y Clonar a Global
                      </button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Nombre</th>
              <th className="text-left px-4 py-3 font-medium">Valor</th>
              <th className="text-left px-4 py-3 font-medium">USD</th>
              <th className="text-left px-4 py-3 font-medium">Año</th>
              <th className="text-left px-4 py-3 font-medium">Estado</th>
              <th className="text-right px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {proxies.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Aún no hay proxies globales.
                </td>
              </tr>
            ) : (
              proxies.map((proxy) => {
                const needsManualFx = Boolean(proxy.currency && proxy.currency !== 'USD' && proxy.currency !== 'COP' && !proxy.valueUsd)
                return (
                  <tr key={proxy.id}>
                    <td className="px-4 py-3 text-white">{proxy.name}</td>
                    <td className="px-4 py-3 text-slate-400">
                      <div className="text-sm">{proxy.value}</div>
                      <div className="text-xs text-slate-500">{proxy.currency}/{proxy.unit}</div>
                    </td>
                    <td className="px-4 py-3">
                      {proxy.currency === 'USD' ? (
                        <div className="text-sm text-slate-500">
                          <div className="text-slate-400">{proxy.value} USD</div>
                          <div className="text-xs text-slate-600">(directo)</div>
                        </div>
                      ) : proxy.valueUsd ? (
                        <div className="text-sm">
                          <div className="text-green-400 font-medium">{proxy.valueUsd} USD</div>
                          <div className="text-xs text-green-600">✓ Convertido</div>
                        </div>
                      ) : proxy.currency === 'COP' ? (
                        <div className="text-sm text-slate-400">
                          <div>Auto (TRM)</div>
                          <div className="text-xs text-slate-600">al aprobar</div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-xs text-amber-600 font-medium">Requiere tasa manual</div>
                          <form action={setGlobalProxyManualFxRateAction} className="flex flex-col gap-2">
                            <input type="hidden" name="proxyId" value={proxy.id} />
                            <input
                              name="rateToUsd"
                              type="text"
                              required
                              placeholder={`Tasa ${proxy.currency}→USD`}
                              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white placeholder:text-slate-500"
                            />
                            <input
                              name="source"
                              type="text"
                              required
                              placeholder="Fuente (ej: ECB)"
                              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white placeholder:text-slate-500"
                            />
                            <button type="submit" className="text-xs font-medium text-amber-400 hover:text-amber-300 transition">
                              Fijar tasa
                            </button>
                          </form>
                        </div>
                      )}
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
                          <button
                            type="submit"
                            disabled={needsManualFx}
                            className="text-xs font-medium text-green-400 hover:underline disabled:text-slate-600 disabled:no-underline disabled:cursor-not-allowed transition"
                            title={needsManualFx ? 'Fija primero la tasa a USD' : undefined}
                          >
                            Aprobar
                          </button>
                        </form>
                      )}
                      {proxy.reviewStatus !== 'rejected' && (
                        <form action={updateGlobalProxyReviewStatusAction} className="inline">
                          <input type="hidden" name="proxyId" value={proxy.id} />
                          <input type="hidden" name="status" value="rejected" />
                          <button type="submit" className="text-xs font-medium text-red-400 hover:underline transition">
                            Rechazar
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
