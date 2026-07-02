import { listAllOrganizations } from '@/lib/admin/organizations'
import { setOrganizationStatusAction } from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: 'Datos inválidos.',
  update_failed: 'No se pudo actualizar la organización.',
}

export default async function AdminOrganizationsPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const searchParams = await props.searchParams
  const organizations = await listAllOrganizations()

  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error.' : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Organizaciones</h1>
        <p className="text-slate-400 mt-2">
          {organizations.length} organización{organizations.length !== 1 ? 'es' : ''} registrada
          {organizations.length !== 1 ? 's' : ''} en la plataforma.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-red-900/40 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </div>
      )}
      {searchParams?.success === 'updated' && (
        <div className="rounded-md border border-green-900/40 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          Organización actualizada correctamente.
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Nombre</th>
              <th className="text-left px-4 py-3 font-medium">Slug</th>
              <th className="text-left px-4 py-3 font-medium">Sector</th>
              <th className="text-left px-4 py-3 font-medium">País</th>
              <th className="text-left px-4 py-3 font-medium">Miembros</th>
              <th className="text-left px-4 py-3 font-medium">Estado</th>
              <th className="text-right px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {organizations.map((org) => (
              <tr key={org.id}>
                <td className="px-4 py-3 text-white">{org.name}</td>
                <td className="px-4 py-3 text-slate-400">{org.slug}</td>
                <td className="px-4 py-3 text-slate-400">{org.sector ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">{org.country ?? '—'}</td>
                <td className="px-4 py-3 text-slate-400">{org.memberCount}</td>
                <td className="px-4 py-3">
                  <span
                    className={
                      org.status === 'active'
                        ? 'inline-flex items-center rounded-full bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400 ring-1 ring-inset ring-green-500/20'
                        : 'inline-flex items-center rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20'
                    }
                  >
                    {org.status === 'active' ? 'Activa' : org.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <form action={setOrganizationStatusAction}>
                    <input type="hidden" name="organizationId" value={org.id} />
                    <input type="hidden" name="status" value={org.status === 'active' ? 'suspended' : 'active'} />
                    <button
                      type="submit"
                      className="text-xs font-medium text-slate-400 hover:text-white transition-colors"
                    >
                      {org.status === 'active' ? 'Suspender' : 'Reactivar'}
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
