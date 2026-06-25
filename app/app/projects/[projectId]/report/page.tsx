import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { listProjectReports, getRunList } from '@/lib/pipeline/sroi-results';
import { createReportDraftFromRunAction } from './createReportDraftFromRun.action';

export const dynamic = 'force-dynamic';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800',
  under_review: 'bg-blue-100 text-blue-800',
  locked: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-gray-100 text-gray-600',
};

export default async function ReportListPage({
  params,
}: {
  params: { projectId: string };
}) {
  const { projectId } = params;

  const [reports, runs] = await Promise.all([
    listProjectReports(projectId),
    getRunList(projectId),
  ]);

  const calculatedRuns = runs.filter((r) => r.status === 'calculated');

  async function handleCreateDraft(formData: FormData) {
    'use server';
    const runId = formData.get('runId') as string;
    const title = formData.get('title') as string;
    const result = await createReportDraftFromRunAction(projectId, runId, { title });
    revalidatePath(`/app/projects/${projectId}/report`);
    redirect(`/app/projects/${projectId}/report/${result.id}`);
  }

  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <div className="text-sm text-gray-500 mb-1">
          <Link
            href={`/app/projects/${projectId}/pipeline/calculation`}
            className="hover:text-teal-700 underline"
          >
            ← Volver al Cálculo SROI
          </Link>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Reportes SROI</h1>
        <p className="text-sm text-gray-500 mt-1">
          Gestión de borradores de reporte vinculados a corridas SROI del proyecto.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        <p>
          <strong>Nota metodológica:</strong> El reporte web está vinculado a una corrida SROI
          inmutable. No equivale a certificación automática. Requiere revisión humana. Constituye
          una <strong>audit-ready foundation</strong> para el proceso de validación metodológica.
        </p>
      </div>

      {/* Create draft form */}
      <section className="bg-white border rounded-lg shadow-sm p-5 space-y-4">
        <h2 className="text-lg font-semibold">Crear Borrador desde Corrida</h2>

        {calculatedRuns.length === 0 ? (
          <div className="text-sm text-gray-500 italic space-y-1">
            <p>No hay corridas calculadas disponibles para generar un reporte.</p>
            <p>
              <Link
                href={`/app/projects/${projectId}/pipeline/calculation`}
                className="text-teal-700 underline hover:text-teal-800"
              >
                Realice primero un cálculo SROI.
              </Link>
            </p>
          </div>
        ) : (
          <form action={handleCreateDraft} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block text-sm font-medium text-gray-700">
                Corrida de referencia
                <select
                  name="runId"
                  required
                  className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                >
                  <option value="">— Seleccionar corrida —</option>
                  {calculatedRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      v{r.version}
                      {r.sroiRatio ? ` — ${parseFloat(r.sroiRatio).toFixed(2)}:1` : ''}
                      {' '}({new Date(r.createdAt).toLocaleDateString()})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Título del reporte
                <input
                  name="title"
                  type="text"
                  required
                  placeholder="ej. Reporte SROI 2024"
                  className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                />
              </label>
            </div>
            <button
              type="submit"
              className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded text-sm font-medium transition-colors"
            >
              Crear Borrador
            </button>
          </form>
        )}
      </section>

      {/* Report list */}
      <section className="bg-white border rounded-lg shadow-sm overflow-hidden">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold">
            Reportes del Proyecto
            {reports.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({reports.length})
              </span>
            )}
          </h2>
        </div>

        {reports.length === 0 ? (
          <div className="p-10 text-center text-gray-500 space-y-1">
            <p className="text-sm">No hay reportes creados para este proyecto.</p>
            <p className="text-xs text-gray-400">
              Use el formulario de arriba para generar el primer borrador.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-600 uppercase">
                <tr>
                  <th className="px-4 py-3">Título</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Creado</th>
                  <th className="px-4 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {reports.map((report) => (
                  <tr key={report.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900 max-w-xs truncate">
                      {report.title}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          STATUS_COLORS[report.status] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {report.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(report.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/app/projects/${projectId}/report/${report.id}`}
                        className="text-teal-700 hover:underline text-xs font-medium"
                      >
                        Ver / Editar
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
