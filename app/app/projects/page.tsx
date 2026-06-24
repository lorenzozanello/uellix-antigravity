import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { listProjectsForCurrentOrganization } from '@/lib/projects/service';
import Link from 'next/link';

export default async function ProjectsPage() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return <p>Unauthenticated. Please log in.</p>;

  const projects = await listProjectsForCurrentOrganization();

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Proyectos</h1>
        {canCreate && (
          <Link href="/app/projects/new" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400">
            Nuevo proyecto
          </Link>
        )}
      </div>
      {projects.length === 0 ? (
        <p className="text-slate-400">No hay proyectos registrados.</p>
      ) : (
        <table className="min-w-full divide-y divide-slate-800 bg-slate-900/10">
          <thead className="bg-slate-900/50">
            <tr>
              <th className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">Nombre</th>
              <th className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">Estado</th>
              <th className="px-6 py-3.5 text-left text-sm font-semibold text-slate-200">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {projects.map((project) => (
              <tr key={project.id}>
                <td className="px-6 py-4 text-sm font-medium text-white">{project.name}</td>
                <td className="px-6 py-4 text-sm text-slate-400">{project.status}</td>
                <td className="px-6 py-4 text-sm">
                  <Link href={`/app/projects/${project.id}`} className="text-teal-300 underline">Ver</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
