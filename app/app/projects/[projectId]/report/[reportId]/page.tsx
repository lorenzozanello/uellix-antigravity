import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getReportDraft } from '@/lib/pipeline/sroi-results';
import { updateReportSectionAction } from '../updateReportSection.action';
import { lockReportDraftAction } from '../lockReportDraft.action';

export const dynamic = 'force-dynamic';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800',
  under_review: 'bg-blue-100 text-blue-800',
  locked: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-gray-100 text-gray-600',
};

export default async function ReportDetailPage({
  params,
}: {
  params: { projectId: string; reportId: string };
}) {
  const { projectId, reportId } = params;

  let report: Awaited<ReturnType<typeof getReportDraft>>;
  try {
    report = await getReportDraft(projectId, reportId);
  } catch {
    notFound();
  }

  const isLocked = report.status === 'locked';

  async function handleUpdateSection(formData: FormData) {
    'use server';
    const sectionId = formData.get('sectionId') as string;
    await updateReportSectionAction(projectId, reportId, sectionId, {
      title: formData.get('title') as string,
      content: (formData.get('content') as string) || undefined,
    });
    revalidatePath(`/app/projects/${projectId}/report/${reportId}`);
  }

  async function handleLock() {
    'use server';
    await lockReportDraftAction(projectId, reportId);
    revalidatePath(`/app/projects/${projectId}/report/${reportId}`);
  }

  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm text-gray-500 mb-1">
            <Link
              href={`/app/projects/${projectId}/report`}
              className="hover:text-teal-700 underline"
            >
              ← Volver a Reportes
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{report.title}</h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                STATUS_COLORS[report.status] ?? 'bg-gray-100 text-gray-600'
              }`}
            >
              {report.status}
            </span>
            <span className="text-xs text-gray-500">
              Corrida:{' '}
              <Link
                href={`/app/projects/${projectId}/pipeline/calculation/runs/${report.calculationRunId}`}
                className="text-teal-700 hover:underline font-mono"
              >
                {report.calculationRunId.slice(0, 8)}…
              </Link>
            </span>
          </div>
        </div>

        {!isLocked && (
          <form action={handleLock}>
            <button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
            >
              Bloquear reporte
            </button>
          </form>
        )}
      </div>

      {/* Locked banner */}
      {isLocked && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-800 space-y-1">
          <p className="font-semibold">
            Este reporte está bloqueado y conserva una versión audit-ready para revisión.
          </p>
          <p className="text-xs text-emerald-700">
            No equivale a certificación automática. Requiere revisión humana para su validación
            final.
          </p>
          {report.lockedAt && (
            <p className="text-xs text-emerald-600">
              Bloqueado el {new Date(report.lockedAt).toLocaleString()}.
            </p>
          )}
        </div>
      )}

      {/* Summary */}
      {report.summary && (
        <section className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-600 mb-2">Resumen</h2>
          <p className="text-sm text-gray-800">{report.summary}</p>
        </section>
      )}

      {/* Sections */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Secciones
          {report.sections.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({report.sections.length})
            </span>
          )}
        </h2>

        {report.sections.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No hay secciones registradas.</p>
        ) : (
          <div className="space-y-4">
            {report.sections.map((section) => (
              <div key={section.id} className="bg-white border rounded-lg shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-400 bg-white border rounded px-1.5 py-0.5">
                    {section.sectionType}
                  </span>
                  <span className="text-sm font-semibold text-gray-800">{section.title}</span>
                </div>

                {isLocked ? (
                  <div className="p-4">
                    {section.content ? (
                      <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                        {section.content}
                      </p>
                    ) : (
                      <p className="text-sm text-gray-400 italic">Sin contenido registrado.</p>
                    )}
                  </div>
                ) : (
                  <form action={handleUpdateSection} className="p-4 space-y-3">
                    <input type="hidden" name="sectionId" value={section.id} />
                    <label className="block text-sm font-medium text-gray-700">
                      Título de sección
                      <input
                        name="title"
                        type="text"
                        required
                        defaultValue={section.title}
                        className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                      />
                    </label>
                    <label className="block text-sm font-medium text-gray-700">
                      Contenido
                      <textarea
                        name="content"
                        rows={4}
                        defaultValue={section.content ?? ''}
                        placeholder="Documentación metodológica de esta sección..."
                        className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                      />
                    </label>
                    <button
                      type="submit"
                      className="bg-teal-600 hover:bg-teal-700 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors"
                    >
                      Guardar sección
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Metadata footer */}
      <section className="bg-gray-50 border rounded-lg p-4 text-xs text-gray-500 grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <span className="block text-gray-400 mb-0.5">Creado el</span>
          <span>{new Date(report.createdAt).toLocaleString()}</span>
        </div>
        <div>
          <span className="block text-gray-400 mb-0.5">Última actualización</span>
          <span>{new Date(report.updatedAt).toLocaleString()}</span>
        </div>
        {isLocked && report.lockedAt && (
          <div>
            <span className="block text-gray-400 mb-0.5">Bloqueado el</span>
            <span>{new Date(report.lockedAt).toLocaleString()}</span>
          </div>
        )}
      </section>
    </div>
  );
}
