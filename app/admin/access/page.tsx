import { listSignupAllowlist } from '@/lib/admin/signup-allowlist'
import { createSignupAllowlistEntryAction, removeSignupAllowlistEntryAction } from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: 'Datos inválidos. Revisá el tipo y el patrón ingresado.',
  not_found: 'La entrada no existe o ya fue eliminada.',
}

export default async function AdminAccessPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const searchParams = await props.searchParams
  const entries = await listSignupAllowlist()

  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error.' : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Acceso (Signup)</h1>
        <p className="text-slate-400 mt-2">
          Uellix está en acceso controlado: un usuario sin invitación pendiente solo puede crear una
          organización nueva si su email o dominio está en esta lista. Los usuarios invitados a una
          organización existente no pasan por este control.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-red-900/40 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </div>
      )}
      {searchParams?.success === 'entry_created' && (
        <div className="rounded-md border border-green-900/40 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          Entrada agregada correctamente.
        </div>
      )}
      {searchParams?.success === 'entry_removed' && (
        <div className="rounded-md border border-green-900/40 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          Entrada eliminada correctamente.
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-white mb-4">Agregar entrada</h2>
        <form action={createSignupAllowlistEntryAction} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1" htmlFor="type">Tipo</label>
            <select
              id="type"
              name="type"
              className="w-full rounded-md bg-slate-950 border border-slate-800 text-sm text-white px-3 py-2"
            >
              <option value="email">Email exacto</option>
              <option value="domain">Dominio</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1" htmlFor="pattern">Patrón</label>
            <input
              id="pattern"
              name="pattern"
              type="text"
              required
              placeholder="nombre@empresa.com o empresa.com"
              className="w-full rounded-md bg-slate-950 border border-slate-800 text-sm text-white px-3 py-2 placeholder:text-slate-600"
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-xs font-medium text-slate-400 mb-1" htmlFor="notes">Notas (opcional)</label>
            <input
              id="notes"
              name="notes"
              type="text"
              placeholder="Ej: cliente piloto Q3"
              className="w-full rounded-md bg-slate-950 border border-slate-800 text-sm text-white px-3 py-2 placeholder:text-slate-600"
            />
          </div>
          <button
            type="submit"
            className="rounded-md bg-red-600 hover:bg-red-500 transition-colors text-sm font-medium text-white px-4 py-2"
          >
            Agregar
          </button>
        </form>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Tipo</th>
              <th className="text-left px-4 py-3 font-medium">Patrón</th>
              <th className="text-left px-4 py-3 font-medium">Notas</th>
              <th className="text-left px-4 py-3 font-medium">Agregado</th>
              <th className="text-right px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No hay entradas. Con la lista vacía, nadie puede autocrear una organización nueva.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="px-4 py-3 text-slate-400">{entry.type === 'email' ? 'Email' : 'Dominio'}</td>
                <td className="px-4 py-3 text-white font-mono text-xs">{entry.pattern}</td>
                <td className="px-4 py-3 text-slate-400">{entry.notes ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">{new Date(entry.createdAt).toLocaleDateString('es-MX')}</td>
                <td className="px-4 py-3 text-right">
                  <form action={removeSignupAllowlistEntryAction}>
                    <input type="hidden" name="id" value={entry.id} />
                    <button
                      type="submit"
                      className="text-xs font-medium text-slate-400 hover:text-red-400 transition-colors"
                    >
                      Eliminar
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
