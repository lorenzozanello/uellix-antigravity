import Link from 'next/link';
import {
  getRunList,
  compareCalculationRuns,
} from '@/lib/pipeline/sroi-results';

export const dynamic = 'force-dynamic';

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: { projectId: string };
  searchParams: { runA?: string; runB?: string };
}) {
  const { projectId } = params;
  const runAId = searchParams.runA;
  const runBId = searchParams.runB;

  const runs = await getRunList(projectId);

  let comparison: Awaited<ReturnType<typeof compareCalculationRuns>> | null = null;
  let compareError: string | null = null;

  if (runAId && runBId) {
    if (runAId === runBId) {
      compareError = 'Selecciona dos corridas distintas para comparar.';
    } else {
      try {
        comparison = await compareCalculationRuns(projectId, runAId, runBId);
      } catch (e: unknown) {
        compareError = e instanceof Error ? e.message : 'Error al comparar corridas.';
      }
    }
  }

  const runA = runs.find((r) => r.id === runAId);
  const runB = runs.find((r) => r.id === runBId);

  function deltaColor(val: number) {
    if (val > 0) return 'text-emerald-700';
    if (val < 0) return 'text-red-700';
    return 'text-gray-600';
  }

  function formatDelta(val: number, decimals = 2) {
    const prefix = val > 0 ? '+' : '';
    return `${prefix}${val.toFixed(decimals)}`;
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
        <h1 className="text-2xl font-bold text-gray-900">Comparación de Corridas SROI</h1>
        <p className="text-sm text-gray-500 mt-1">
          Vista de diferencias entre dos corridas históricas. No recalcula SROI ni persiste
          resultados.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        <p>
          <strong>Nota metodológica:</strong> Esta vista es informativa. Las corridas son
          inmutables. No se realiza conversión de moneda (FX). Si las corridas tienen distintas
          monedas, la comparación numérica puede no ser directamente comparable.
        </p>
      </div>

      {/* Run selector */}
      <section className="bg-white border rounded-lg shadow-sm p-4 space-y-4">
        <h2 className="text-lg font-semibold">Seleccionar Corridas</h2>
        {runs.length < 2 ? (
          <p className="text-sm text-gray-500 italic">
            Se necesitan al menos 2 corridas SROI registradas para comparar.
          </p>
        ) : (
          <form method="GET" className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block text-sm font-medium text-gray-700">
              Corrida A (referencia)
              <select
                name="runA"
                defaultValue={runAId ?? ''}
                className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500"
              >
                <option value="">— Seleccionar —</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} — {r.status} — {r.sroiRatio ? `${parseFloat(r.sroiRatio).toFixed(2)}:1` : '—'}{' '}
                    ({new Date(r.createdAt).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Corrida B (comparada)
              <select
                name="runB"
                defaultValue={runBId ?? ''}
                className="mt-1 block w-full rounded border-gray-300 text-sm shadow-sm focus:border-teal-500"
              >
                <option value="">— Seleccionar —</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} — {r.status} — {r.sroiRatio ? `${parseFloat(r.sroiRatio).toFixed(2)}:1` : '—'}{' '}
                    ({new Date(r.createdAt).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </label>
            <div className="md:col-span-2">
              <button
                type="submit"
                className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded text-sm font-medium transition-colors"
              >
                Comparar
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Error state */}
      {compareError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <strong>Error:</strong> {compareError}
        </div>
      )}

      {/* Currency mismatch warning */}
      {comparison?.warning?.currencyMismatch && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm text-orange-800">
          <strong>⚠ Advertencia de moneda:</strong> {comparison.warning.message}. Las
          diferencias numéricas no son directamente comparables sin conversión FX (no
          disponible en esta vista).
        </div>
      )}

      {/* Comparison table */}
      {comparison && runA && runB && (
        <section className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b">
            <h2 className="text-lg font-semibold">Resultados de Comparación</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Diferencias calculadas como A − B. Solo orientativo, requiere revisión humana.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-600 uppercase">
                <tr>
                  <th className="px-4 py-3">Métrica</th>
                  <th className="px-4 py-3 text-right">
                    Corrida A (v{runA.version})
                  </th>
                  <th className="px-4 py-3 text-right">
                    Corrida B (v{runB.version})
                  </th>
                  <th className="px-4 py-3 text-right">Diferencia A − B</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {[
                  {
                    label: 'Ratio SROI',
                    valA: runA.sroiRatio ? parseFloat(runA.sroiRatio) : 0,
                    valB: runB.sroiRatio ? parseFloat(runB.sroiRatio) : 0,
                    delta: comparison.sroiRatio,
                    suffix: ':1',
                  },
                  {
                    label: 'Valor Social Neto',
                    valA: runA.totalInvestment ? parseFloat(runA.totalInvestment) : 0,
                    valB: runB.totalInvestment ? parseFloat(runB.totalInvestment) : 0,
                    delta: comparison.netSocialValue,
                    suffix: ` ${comparison.currency ?? ''}`,
                  },
                  {
                    label: 'Valor Social Bruto',
                    valA: 0,
                    valB: 0,
                    delta: comparison.grossSocialValue,
                    suffix: ` ${comparison.currency ?? ''}`,
                  },
                  {
                    label: 'Inversión Total',
                    valA: runA.totalInvestment ? parseFloat(runA.totalInvestment) : 0,
                    valB: runB.totalInvestment ? parseFloat(runB.totalInvestment) : 0,
                    delta: comparison.totalInvestment,
                    suffix: ` ${comparison.currency ?? ''}`,
                  },
                  {
                    label: 'Ítems de línea',
                    valA: 0,
                    valB: 0,
                    delta: comparison.lineItemCount,
                    suffix: '',
                  },
                ].map(({ label, valA, valB, delta, suffix }) => (
                  <tr key={label} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800">{label}</td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {valA.toLocaleString()}
                      {suffix}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {valB.toLocaleString()}
                      {suffix}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${deltaColor(delta)}`}>
                      {formatDelta(delta)}
                      {suffix}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-4 border-t bg-gray-50">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-gray-500 block text-xs">Estado Corrida A</span>
                <span className="font-medium">{runA.status}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-xs">Calculado A</span>
                <span className="font-medium">{new Date(runA.createdAt).toLocaleDateString()}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-xs">Estado Corrida B</span>
                <span className="font-medium">{runB.status}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-xs">Calculado B</span>
                <span className="font-medium">{new Date(runB.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Empty state - no selection yet */}
      {!runAId && !runBId && runs.length >= 2 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center text-gray-500">
          <p className="text-sm">Selecciona dos corridas arriba para ver la comparación.</p>
        </div>
      )}

      {/* Run list for reference */}
      {runs.length > 0 && (
        <section className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b">
            <h2 className="text-base font-semibold text-gray-800">
              Corridas disponibles ({runs.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-2">Versión</th>
                  <th className="px-4 py-2">Estado</th>
                  <th className="px-4 py-2 text-right">Ratio SROI</th>
                  <th className="px-4 py-2">Creada</th>
                  <th className="px-4 py-2">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium">v{r.version}</td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-teal-700">
                      {r.sroiRatio ? `${parseFloat(r.sroiRatio).toFixed(2)}:1` : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/app/projects/${projectId}/pipeline/calculation/runs/${r.id}`}
                        className="text-teal-700 hover:underline text-xs"
                      >
                        Ver detalle
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
