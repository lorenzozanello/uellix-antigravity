import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOrganizationAccess } from '@/lib/auth/session';
import {
  getCalculationRunDetail,
  listSroiRunReviews,
} from '@/lib/pipeline/sroi-results';
import { createSroiRunReviewAction } from '../createSroiRunReview.action';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

const REVIEW_ROLES = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer'];

export default async function RunDetailPage({
  params,
}: {
  params: { projectId: string; runId: string };
}) {
  const { projectId, runId } = params;

  let detail: Awaited<ReturnType<typeof getCalculationRunDetail>>;
  try {
    detail = await getCalculationRunDetail(projectId, runId);
  } catch {
    notFound();
  }

  const ctx = await requireOrganizationAccess();
  const canReview = ctx && REVIEW_ROLES.includes(ctx.membership.role);

  const reviews = await listSroiRunReviews(projectId, runId);

  const { run, lineItems, snapshotJson } = detail;

  async function handleCreateReview(formData: FormData) {
    'use server';
    await createSroiRunReviewAction(projectId, runId, {
      status: formData.get('status') as string,
      readinessScore: formData.get('readinessScore')
        ? Number(formData.get('readinessScore'))
        : undefined,
      overallNotes: (formData.get('overallNotes') as string) || undefined,
    });
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  const statusColors: Record<string, string> = {
    calculated: 'bg-emerald-100 text-emerald-800',
    pending: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link
              href={`/app/projects/${projectId}/pipeline/calculation`}
              className="hover:text-teal-700 underline"
            >
              ← Volver al Cálculo SROI
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">
            Corrida SROI — v{run.version}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            ID: <code className="font-mono text-xs bg-gray-100 px-1 rounded">{run.id}</code>
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/app/projects/${projectId}/pipeline/calculation/compare?runA=${runId}`}
            className="text-sm bg-white border border-gray-300 hover:border-teal-500 text-gray-700 px-4 py-2 rounded font-medium transition-colors"
          >
            Comparar con otra corrida
          </Link>
          <Link
            href={`/app/projects/${projectId}/report`}
            className="text-sm bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded font-medium transition-colors"
          >
            Ver Reportes
          </Link>
        </div>
      </div>

      {/* Immutability banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800 space-y-1">
        <p className="font-semibold">📌 Esta es una corrida histórica e inmutable.</p>
        <p>
          El resultado corresponde a un <strong>ratio SROI preliminar</strong> y{' '}
          <strong>requiere revisión humana</strong> para su validación final. No constituye
          certificación automática ni auditoría independiente. Constituye una{' '}
          <strong>audit-ready foundation</strong> para el proceso de revisión metodológica.
        </p>
      </div>

      {/* KPI Summary */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Ratio SROI Preliminar',
            value: run.sroiRatio ? `${parseFloat(run.sroiRatio).toFixed(2)}:1` : '—',
            highlight: true,
          },
          {
            label: 'Valor Social Neto',
            value: run.netSocialValue
              ? `${parseFloat(run.netSocialValue).toLocaleString()} ${run.currency}`
              : '—',
          },
          {
            label: 'Valor Social Bruto',
            value: run.grossSocialValue
              ? `${parseFloat(run.grossSocialValue).toLocaleString()} ${run.currency}`
              : '—',
          },
          {
            label: 'Inversión Total',
            value: run.totalInvestment
              ? `${parseFloat(run.totalInvestment).toLocaleString()} ${run.currency}`
              : '—',
          },
        ].map(({ label, value, highlight }) => (
          <div key={label} className="bg-white border rounded-lg p-4 shadow-sm">
            <span className="block text-xs text-gray-500 mb-1">{label}</span>
            <span
              className={`text-xl font-bold ${highlight ? 'text-teal-700' : 'text-gray-800'}`}
            >
              {value}
            </span>
          </div>
        ))}
      </section>

      {/* Metadata */}
      <section className="bg-white border rounded-lg p-4 shadow-sm grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <span className="text-gray-500 block">Versión</span>
          <span className="font-medium">v{run.version}</span>
        </div>
        <div>
          <span className="text-gray-500 block">Estado</span>
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
              statusColors[run.status ?? ''] ?? 'bg-gray-100 text-gray-700'
            }`}
          >
            {run.status}
          </span>
        </div>
        <div>
          <span className="text-gray-500 block">Calculado el</span>
          <span className="font-medium">
            {run.calculatedAt ? new Date(run.calculatedAt).toLocaleString() : '—'}
          </span>
        </div>
        <div>
          <span className="text-gray-500 block">Moneda</span>
          <span className="font-medium">{run.currency ?? '—'}</span>
        </div>
      </section>

      {/* Line items */}
      <section className="bg-white border rounded-lg shadow-sm overflow-hidden">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold">Líneas de Cálculo</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Detalle inmutable de los ítems que componen esta corrida.
          </p>
        </div>
        {lineItems.length === 0 ? (
          <p className="p-4 text-sm text-gray-500 italic">
            No hay líneas de cálculo registradas.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-600 uppercase">
                <tr>
                  <th className="px-4 py-3">Asignación</th>
                  <th className="px-4 py-3 text-right">Cantidad</th>
                  <th className="px-4 py-3 text-right">Valor Proxy</th>
                  <th className="px-4 py-3 text-right">Bruto</th>
                  <th className="px-4 py-3 text-right">Ajustado</th>
                  <th className="px-4 py-3 text-right">Filtros</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lineItems.map((li) => (
                  <tr key={li.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {li.assignmentId}
                    </td>
                    <td className="px-4 py-3 text-right">{li.quantity}</td>
                    <td className="px-4 py-3 text-right">
                      {parseFloat(li.proxyValue ?? '0').toLocaleString()} {li.currency}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {parseFloat(li.grossValue ?? '0').toLocaleString()} {li.currency}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-teal-700">
                      {parseFloat(li.adjustedValue ?? '0').toLocaleString()} {li.currency}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-gray-500">
                      DW:{li.deadweightPct}% AT:{li.attributionPct}% DP:{li.displacementPct}%
                      DO:{li.dropoffPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Snapshot JSON */}
      {snapshotJson && (
        <section className="bg-white border rounded-lg shadow-sm">
          <div className="p-4 border-b">
            <h2 className="text-lg font-semibold">Snapshot de Inputs</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Fotografía inmutable de los inputs al momento del cálculo.
            </p>
          </div>
          <pre className="p-4 text-xs bg-gray-50 overflow-x-auto rounded-b-lg text-gray-700 leading-relaxed">
            {JSON.stringify(snapshotJson, null, 2)}
          </pre>
        </section>
      )}

      {/* Reviews */}
      <section className="bg-white border rounded-lg shadow-sm">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Revisiones Metodológicas</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Solo los revisores autorizados pueden crear o modificar revisiones.
            </p>
          </div>
        </div>

        {reviews.length === 0 ? (
          <p className="p-4 text-sm text-gray-500 italic">
            No hay revisiones registradas para esta corrida.
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {reviews.map((review) => (
              <div key={review.id} className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      review.status === 'approved'
                        ? 'bg-emerald-100 text-emerald-800'
                        : review.status === 'flagged'
                        ? 'bg-red-100 text-red-800'
                        : review.status === 'reviewed'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {review.status}
                  </span>
                  {review.readinessScore !== null && review.readinessScore !== undefined && (
                    <span className="text-xs text-gray-500">
                      Score: {review.readinessScore}/100
                    </span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">
                    {new Date(review.createdAt).toLocaleString()}
                  </span>
                </div>
                {review.overallNotes && (
                  <p className="text-sm text-gray-700">{review.overallNotes}</p>
                )}
                {review.items && review.items.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {review.items.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 text-xs text-gray-600"
                      >
                        <span className="font-mono bg-gray-100 px-1 rounded">
                          {item.itemKey}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            item.status === 'pass'
                              ? 'bg-emerald-100 text-emerald-700'
                              : item.status === 'fail'
                              ? 'bg-red-100 text-red-700'
                              : item.status === 'warning'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {item.status}
                        </span>
                        <span className="text-gray-500">{item.severity}</span>
                        {item.notes && <span className="text-gray-400">— {item.notes}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* New review form — only for authorized roles */}
        {canReview ? (
          <div className="p-4 border-t bg-gray-50">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Nueva Revisión Metodológica
            </h3>
            <form action={handleCreateReview} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block text-sm font-medium text-gray-700">
                  Estado
                  <select
                    name="status"
                    className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                  >
                    <option value="draft">Draft</option>
                    <option value="reviewed">Reviewed</option>
                    <option value="approved">Approved</option>
                    <option value="flagged">Flagged</option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-gray-700">
                  Score de Preparación (0–100)
                  <input
                    name="readinessScore"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="ej. 80"
                    className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                  />
                </label>
              </div>
              <label className="block text-sm font-medium text-gray-700">
                Notas generales
                <textarea
                  name="overallNotes"
                  rows={3}
                  placeholder="Observaciones metodológicas..."
                  className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500 focus:ring-teal-200"
                />
              </label>
              <button
                type="submit"
                className="bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
              >
                Registrar Revisión
              </button>
            </form>
          </div>
        ) : (
          <div className="p-4 border-t bg-gray-50">
            <p className="text-sm text-gray-500 italic">
              Solo los revisores y gestores autorizados pueden crear revisiones. Contacte a un
              impact manager o reviewer.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
