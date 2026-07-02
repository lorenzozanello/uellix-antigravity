import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOrganizationAccess } from '@/lib/auth/session';
import {
  getCalculationRunDetail,
  listSroiRunReviews,
} from '@/lib/pipeline/sroi-results';
import { createSroiRunReviewAction } from '../createSroiRunReview.action';
import { revalidatePath } from 'next/cache';
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
import { ArrowLeft } from 'lucide-react';

export const dynamic = 'force-dynamic';

const REVIEW_ROLES = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer'];

const RUN_STATUS_BADGE: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  calculated: { variant: 'success', label: 'Calculado' },
  pending: { variant: 'warning', label: 'Pendiente' },
  error: { variant: 'danger', label: 'Error' },
};

const REVIEW_STATUS_BADGE: Record<string, { variant: 'success' | 'danger' | 'info' | 'neutral'; label: string }> = {
  approved: { variant: 'success', label: 'Aprobado' },
  flagged: { variant: 'danger', label: 'Marcado' },
  reviewed: { variant: 'info', label: 'Revisado' },
  draft: { variant: 'neutral', label: 'Borrador' },
};

const REVIEW_ITEM_BADGE: Record<string, { variant: 'success' | 'danger' | 'warning' | 'neutral'; label: string }> = {
  pass: { variant: 'success', label: 'Correcto' },
  fail: { variant: 'danger', label: 'Fallido' },
  warning: { variant: 'warning', label: 'Advertencia' },
};

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}) {
  const { projectId, runId } = await params;

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

  const runStatusConfig =
    RUN_STATUS_BADGE[run.status ?? ''] ?? { variant: 'neutral' as const, label: run.status ?? '—' };

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
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
            Corrida SROI — v{run.version}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            ID:{' '}
            <code
              className="text-xs text-muted-foreground tabular-nums"
              style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
            >
              {run.id}
            </code>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link
            href={`/app/projects/${projectId}/pipeline/calculation/compare?runA=${runId}`}
            className="inline-flex items-center rounded-md border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Comparar con otra corrida
          </Link>
          <Link
            href={`/app/projects/${projectId}/report`}
            className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Ver Reportes
          </Link>
        </div>
      </div>

      {/* Immutability notice */}
      <div
        role="note"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <span className="font-medium text-foreground">Corrida histórica e inmutable: </span>
        El resultado corresponde a un{' '}
        <strong className="font-medium text-foreground">ratio SROI preliminar</strong> y{' '}
        <strong className="font-medium text-foreground">requiere revisión humana</strong> para
        su validación final. No constituye certificación automática ni auditoría independiente.
        Constituye una{' '}
        <strong className="font-medium text-foreground">base lista para auditoría</strong> para el
        proceso de revisión metodológica.
      </div>

      {/* KPI Summary */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4" aria-label="KPI de la corrida">
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground">Ratio SROI Preliminar</p>
          <p
            className="mt-1 text-2xl font-bold text-foreground tabular-nums"
            style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
          >
            {run.sroiRatio ? `${parseFloat(run.sroiRatio).toFixed(2)}:1` : '—'}
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground">Valor Social Neto</p>
          <p className="mt-1 text-xl font-bold text-foreground">
            {run.netSocialValue
              ? `${parseFloat(run.netSocialValue).toLocaleString()} ${run.currency}`
              : '—'}
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground">Valor Social Bruto</p>
          <p className="mt-1 text-xl font-bold text-foreground">
            {run.grossSocialValue
              ? `${parseFloat(run.grossSocialValue).toLocaleString()} ${run.currency}`
              : '—'}
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium text-muted-foreground">Inversión Total</p>
          <p className="mt-1 text-xl font-bold text-foreground">
            {run.totalInvestment
              ? `${parseFloat(run.totalInvestment).toLocaleString()} ${run.currency}`
              : '—'}
          </p>
        </div>
      </section>

      {/* Metadata */}
      <Card>
        <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground block text-xs">Versión</span>
            <span className="font-medium text-foreground">v{run.version}</span>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs mb-1">Estado</span>
            <Badge variant={runStatusConfig.variant}>{runStatusConfig.label}</Badge>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs">Calculado el</span>
            <span className="font-medium text-foreground">
              {run.calculatedAt ? new Date(run.calculatedAt).toLocaleString() : '—'}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs">Moneda</span>
            <span className="font-medium text-foreground">{run.currency ?? '—'}</span>
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle>Líneas de Cálculo</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Detalle inmutable de los ítems que componen esta corrida.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {lineItems.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground italic">
              No hay líneas de cálculo registradas.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asignación</TableHead>
                  <TableHead className="text-right">Cantidad</TableHead>
                  <TableHead className="text-right">Valor Proxy</TableHead>
                  <TableHead className="text-right">Bruto</TableHead>
                  <TableHead className="text-right">Ajustado</TableHead>
                  <TableHead className="text-right">Filtros</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineItems.map((li) => (
                  <TableRow key={li.id}>
                    <TableCell>
                      <code
                        className="text-xs text-muted-foreground tabular-nums"
                        style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                      >
                        {li.assignmentId}
                      </code>
                    </TableCell>
                    <TableCell className="text-right">{li.quantity}</TableCell>
                    <TableCell className="text-right">
                      {parseFloat(li.proxyValue ?? '0').toLocaleString()} {li.currency}
                    </TableCell>
                    <TableCell className="text-right">
                      {parseFloat(li.grossValue ?? '0').toLocaleString()} {li.currency}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-foreground">
                      {parseFloat(li.adjustedValue ?? '0').toLocaleString()} {li.currency}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      DW:{li.deadweightPct}% AT:{li.attributionPct}% DP:{li.displacementPct}%
                      DO:{li.dropoffPct}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Snapshot JSON */}
      {snapshotJson && (
        <Card>
          <CardHeader>
            <CardTitle>Snapshot de Inputs</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Fotografía inmutable de los inputs al momento del cálculo.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <pre
              className="px-6 py-4 text-xs bg-muted/40 overflow-x-auto rounded-b-lg text-foreground leading-relaxed"
              style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
            >
              {JSON.stringify(snapshotJson, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Reviews */}
      <Card>
        <CardHeader>
          <CardTitle>Revisiones Metodológicas</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Solo los revisores autorizados pueden crear o modificar revisiones.
          </p>
        </CardHeader>

        {reviews.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground italic">
              No hay revisiones registradas para esta corrida.
            </p>
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {reviews.map((review) => {
                const reviewBadge =
                  REVIEW_STATUS_BADGE[review.status ?? ''] ?? {
                    variant: 'neutral' as const,
                    label: review.status ?? '—',
                  };
                return (
                  <div key={review.id} className="px-6 py-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={reviewBadge.variant}>{reviewBadge.label}</Badge>
                      {review.readinessScore !== null && review.readinessScore !== undefined && (
                        <span className="text-xs text-muted-foreground">
                          Score: {review.readinessScore}/100
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground/60 ml-auto">
                        {new Date(review.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {review.overallNotes && (
                      <p className="text-sm text-foreground">{review.overallNotes}</p>
                    )}
                    {review.items && review.items.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {review.items.map((item) => {
                          const itemBadge =
                            REVIEW_ITEM_BADGE[item.status ?? ''] ?? {
                              variant: 'neutral' as const,
                              label: item.status ?? '—',
                            };
                          return (
                            <div
                              key={item.id}
                              className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap"
                            >
                              <code
                                className="tabular-nums bg-muted px-1.5 py-0.5 rounded text-foreground text-[10px]"
                                style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                              >
                                {item.itemKey}
                              </code>
                              <Badge variant={itemBadge.variant}>{itemBadge.label}</Badge>
                              <span className="text-muted-foreground">{item.severity}</span>
                              {item.notes && (
                                <span className="text-muted-foreground/60">— {item.notes}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}

        {/* New review form — only for authorized roles */}
        {canReview ? (
          <div className="p-6 border-t border-border bg-muted/30">
            <h3 className="text-sm font-semibold text-foreground mb-3">
              Nueva Revisión Metodológica
            </h3>
            <form action={handleCreateReview} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="review-status" className="block text-xs font-medium text-foreground">
                    Estado
                  </label>
                  <select id="review-status" name="status" className={INPUT_CLASS}>
                    <option value="draft">Borrador</option>
                    <option value="reviewed">Revisado</option>
                    <option value="approved">Aprobado</option>
                    <option value="flagged">Marcado</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="review-score" className="block text-xs font-medium text-foreground">
                    Score de Preparación (0–100)
                  </label>
                  <input
                    id="review-score"
                    name="readinessScore"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="ej. 80"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="review-notes" className="block text-xs font-medium text-foreground">
                  Notas generales
                </label>
                <textarea
                  id="review-notes"
                  name="overallNotes"
                  rows={3}
                  placeholder="Observaciones metodológicas..."
                  className={INPUT_CLASS}
                />
              </div>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
              >
                Registrar Revisión
              </button>
            </form>
          </div>
        ) : (
          <div className="p-4 border-t border-border bg-muted/30">
            <p className="text-sm text-muted-foreground italic">
              Solo los revisores y gestores autorizados pueden crear revisiones. Contacte a un
              impact manager o reviewer.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
