import { listRecentAuditLogs } from '@/lib/admin/logs'

export default async function AdminLogsPage() {
  const logs = await listRecentAuditLogs(200)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Logs Globales</h1>
        <p className="text-slate-400 mt-2">
          Últimos {logs.length} eventos de auditoría en toda la plataforma.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/50 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Fecha</th>
              <th className="text-left px-4 py-3 font-medium">Organización</th>
              <th className="text-left px-4 py-3 font-medium">Actor</th>
              <th className="text-left px-4 py-3 font-medium">Acción</th>
              <th className="text-left px-4 py-3 font-medium">Entidad</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Sin eventos registrados todavía.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString('es-MX')}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{log.organizationName ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-400">{log.actorEmail ?? 'sistema'}</td>
                  <td className="px-4 py-3 text-white font-mono text-xs">{log.action}</td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-xs">
                    {log.entityType}:{log.entityId.slice(0, 8)}
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
