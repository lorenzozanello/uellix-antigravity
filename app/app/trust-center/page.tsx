import React from 'react';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { listEvidenceForOrganizationWithProject } from '@/lib/pipeline/evidence';
import Link from 'next/link';

export default async function TrustCenterPage({
  searchParams,
}: {
  searchParams: { status?: string; type?: string; projectId?: string };
}) {
  const { organization } = await requireOrganizationAccess();

  // Fetch all projects for the filter dropdown
  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organization.id));

  // Fetch all evidence items for the organization
  const evidences = await listEvidenceForOrganizationWithProject();

  const statusFilter = searchParams.status || '';
  const typeFilter = searchParams.type || '';
  const projectFilter = searchParams.projectId || '';

  const filteredEvidences = evidences.filter((ev) => {
    if (statusFilter && ev.status !== statusFilter) return false;
    if (typeFilter && ev.type !== typeFilter) return false;
    if (projectFilter && ev.projectId !== projectFilter) return false;
    return true;
  });

  return (
    <section className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">Trust Center</h1>
        <p className="mt-2 text-sm text-gray-600">
          Espacio audit‑ready para la verificación y trazabilidad de los proyectos de la organización.
          Cada evidencia asociada cuenta con un hash SHA‑256 único y requiere revisión humana para su validación final.
        </p>
      </div>

      {/* Filters Form */}
      <form method="GET" action="/app/trust-center" className="flex flex-wrap gap-4 items-end mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div>
          <label htmlFor="projectId" className="block text-xs font-semibold text-gray-500 mb-1">Proyecto</label>
          <select
            id="projectId"
            name="projectId"
            defaultValue={projectFilter}
            className="block w-48 rounded border-gray-300 text-sm focus:border-teal-500 focus:ring-teal-500"
          >
            <option value="">Todos los proyectos</option>
            {orgProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="status" className="block text-xs font-semibold text-gray-500 mb-1">Estado de revisión</label>
          <select
            id="status"
            name="status"
            defaultValue={statusFilter}
            className="block w-40 rounded border-gray-300 text-sm focus:border-teal-500 focus:ring-teal-500"
          >
            <option value="">Todos los estados</option>
            <option value="draft">Borrador</option>
            <option value="under_review">En revisión humana</option>
            <option value="approved">Aprobado</option>
            <option value="rejected">Rechazado</option>
            <option value="archived">Archivado</option>
          </select>
        </div>

        <div>
          <label htmlFor="type" className="block text-xs font-semibold text-gray-500 mb-1">Tipo de evidencia</label>
          <select
            id="type"
            name="type"
            defaultValue={typeFilter}
            className="block w-40 rounded border-gray-300 text-sm focus:border-teal-500 focus:ring-teal-500"
          >
            <option value="">Todos los tipos</option>
            <option value="file">Archivo</option>
            <option value="url">Enlace URL</option>
            <option value="text">Texto / Declaración</option>
          </select>
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            className="bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
          >
            Filtrar
          </button>
          <Link
            href="/app/trust-center"
            className="bg-gray-200 hover:bg-gray-300 text-gray-700 px-4 py-2 rounded text-sm font-medium transition-colors text-center"
          >
            Limpiar
          </Link>
        </div>
      </form>

      {/* Evidences Table */}
      {filteredEvidences.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-gray-300 rounded-lg">
          <p className="text-gray-500 text-sm">No se encontraron evidencias asociadas trazables con los filtros seleccionados.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm text-left">
            <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3">Proyecto</th>
                <th className="px-6 py-3">Título de evidencia</th>
                <th className="px-6 py-3">Tipo</th>
                <th className="px-6 py-3">Hash SHA‑256</th>
                <th className="px-6 py-3">Estado</th>
                <th className="px-6 py-3">Fecha de registro</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200 text-gray-700">
              {filteredEvidences.map((ev) => (
                <tr key={ev.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900">{ev.projectName}</td>
                  <td className="px-6 py-4">{ev.title}</td>
                  <td className="px-6 py-4 uppercase font-mono text-xs">{ev.type}</td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-500" title={ev.contentHash || ''}>
                    {ev.contentHash ? `${ev.contentHash.slice(0, 12)}…` : '—'}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      ev.status === 'approved' ? 'bg-green-100 text-green-800' :
                      ev.status === 'rejected' ? 'bg-red-100 text-red-800' :
                      ev.status === 'under_review' ? 'bg-yellow-100 text-yellow-800' :
                      ev.status === 'archived' ? 'bg-gray-100 text-gray-800' : 'bg-blue-100 text-blue-800'
                    }`}>
                      {ev.status === 'under_review' ? 'En revisión humana' : ev.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(ev.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
