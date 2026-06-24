import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLE_LABELS } from '@/lib/auth/roles'

export default async function DashboardPage() {
  const { user, organization, membership } = await requireOrganizationAccess()
  const roleLabel = ROLE_LABELS[membership.role] ?? membership.role

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm">
        <h2 className="text-lg font-semibold mb-4 text-white">Bienvenido de vuelta</h2>
        <p className="text-slate-400 mb-1">
          Sesión activa como: <strong className="text-white">{user.email}</strong>
        </p>
        <p className="text-slate-400 mb-1">
          Organización: <strong className="text-teal-400">{organization.name}</strong>
        </p>
        <p className="text-slate-400">
          Rol: <strong className="text-teal-400">{roleLabel}</strong>
        </p>
      </div>
    </div>
  )
}
