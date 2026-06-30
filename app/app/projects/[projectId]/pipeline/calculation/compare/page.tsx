import Link from 'next/link';
import {
  getRunList,
  compareCalculationRuns,
} from '@/lib/pipeline/sroi-results';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { ArrowLeft, AlertTriangle } from 'lucide-react';

export const dynamic = 'force-dynamic';

const RUN_STATUS_BADGE: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  calculated: { variant: 'success', label: 'Calculated' },
  pending: { variant: 'warning', label: 'Pending' },
  failed: { variant: 'danger', label: 'Failed' },
};

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

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
    return 'text-muted-foreground';
  }

  function formatDelta(val: number, decimals = 2) {
    const prefix = val > 0 ? '+' : '';
    return `${prefix}${val.toFixed(decimals)}`;
  }

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-2">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <Link
            href={`/app/projects/${projectId}/pipeline/calculation`}
            className="hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            Volver al Cálculo SROI
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Comparación de Corridas SROI
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Vista de diferencias entre dos corridas históricas. No recalcula SROI ni persiste
          resultados.
        </p>
      </div>

      {/* Disclaimer */}
      <div
        role="note"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <span className="font-medium text-foreground">Nota metodológica: </span>
        Esta vista es informativa. Las corridas son inmutables. No se realiza conversión de
        moneda (FX). Si las corridas tienen distintas monedas, la comparación numérica puede no
        ser directamente comparable.
      </div>

      {/* Run selector */}
      <Card>
        <CardHeader>
          <CardTitle>Seleccionar Corridas</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length < 2 ? (
            <p className="text-sm text-muted-foreground italic">
              Se necesitan al menos 2 corridas SROI registradas para comparar.
            </p>
          ) : (
            <form method="GET" className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="select-runA" className="block text-xs font-medium text-foreground">
                  Corrida A (referencia)
                </label>
                <select
                  id="select-runA"
                  name="runA"
                  defaultValue={runAId ?? ''}
                  className={INPUT_CLASS}
                >
                  <option value="">— Seleccionar —</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      v{r.version} — {r.status} —{' '}
                      {r.sroiRatio ? `${parseFloat(r.sroiRatio).toFixed(2)}:1` : '—'}{' '}
                      ({new Date(r.createdAt).toLocaleDateString()})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="select-runB" className="block text-xs font-medium text-foreground">
                  Corrida B (comparada)
                </label>
                <select
                  id="select-runB"
                  name="runB"
                  defaultValue={runBId ?? ''}
                  className={INPUT_CLASS}
                >
                  <option value="">— Seleccionar —</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      v{r.version} — {r.status} —{' '}
                      {r.sroiRatio ? `${parseFloat(r.sroiRatio).toFixed(2)}:1` : '—'}{' '}
                      ({new Date(r.createdAt).toLocaleDateString()})
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                >
                  Comparar
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Error state */}
      {compareError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <strong>Error:</strong> {compareError}
        </div>
      )}

      {/* Currency mismatch warning */}
      {comparison?.warning?.currencyMismatch && (
        <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            <strong>Advertencia de moneda:</strong> {comparison.warning.message}. Las diferencias
            numéricas no son directamente comparables sin conversión FX (no disponible en esta
            vista).
          </p>
        </div>
      )}

      {/* Comparison table */}
      {comparison && runA && runB && (
        <Card>
          <CardHeader>
            <CardTitle>Resultados de Comparación</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Diferencias calculadas como A − B. Solo orientativo, requiere revisión humana.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Métrica</TableHead>
                  <TableHead className="text-right">Corrida A (v{runA.version})</TableHead>
                  <TableHead className="text-right">Corrida B (v{runB.version})</TableHead>
                  <TableHead className="text-right">Diferencia A − B</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
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
                  <TableRow key={label}>
                    <TableCell className="font-medium text-foreground">{label}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {valA.toLocaleString()}
                      {suffix}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {valB.toLocaleString()}
                      {suffix}
                    </TableCell>
                    <TableCell className={`text-right font-semibold ${deltaColor(delta)}`}>
                      {formatDelta(delta)}
                      {suffix}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="p-4 border-t border-border bg-muted/30">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground block text-xs">Estado Corrida A</span>
                  <span className="font-medium text-foreground">{runA.status}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">Calculado A</span>
                  <span className="font-medium text-foreground">
                    {new Date(runA.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">Estado Corrida B</span>
                  <span className="font-medium text-foreground">{runB.status}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">Calculado B</span>
                  <span className="font-medium text-foreground">
                    {new Date(runB.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state — no selection yet */}
      {!runAId && !runBId && runs.length >= 2 && (
        <div className="rounded-lg border border-border bg-muted/30 p-8 text-center text-muted-foreground">
          <p className="text-sm">Selecciona dos corridas arriba para ver la comparación.</p>
        </div>
      )}

      {/* Run list for reference */}
      {runs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Corridas disponibles ({runs.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Versión</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Ratio SROI</TableHead>
                  <TableHead>Creada</TableHead>
                  <TableHead>Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => {
                  const statusConfig =
                    RUN_STATUS_BADGE[r.status ?? ''] ?? {
                      variant: 'neutral' as const,
                      label: r.status ?? '—',
                    };
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium text-foreground">v{r.version}</TableCell>
                      <TableCell>
                        <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className="font-semibold text-foreground tabular-nums"
                          style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                        >
                          {r.sroiRatio ? `${parseFloat(r.sroiRatio).toFixed(2)}:1` : '—'}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/app/projects/${projectId}/pipeline/calculation/runs/${r.id}`}
                          className="text-xs font-medium text-[#FF6A00] hover:text-[#FF6A00]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        >
                          Ver detalle
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
