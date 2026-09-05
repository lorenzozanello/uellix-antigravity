import Link from 'next/link';
import { notFound } from 'next/navigation';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { isInReviewSet, canDetermineEvidenceSufficiency, hasRole } from '@/lib/auth/permissions';
import {
  getCalculationRunDetail,
  listSroiRunReviews,
} from '@/lib/pipeline/sroi-results';
import {
  detectRunInputDrift,
  getRunMonetizationCoverage,
  MONETIZATION_REASON_VALUES,
} from '@/lib/pipeline/sroi-calculation';
import { getLatestSufficiencyDeterminationsByOutcomeIds } from '@/lib/pipeline/evidence-sufficiency';
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { getReadinessAssessment, READINESS_CRITERIA_COUNT } from '@/lib/pipeline/sroi-readiness';
import { getRunSensitivityCompleteness, listSensitivityCandidates, listSensitivityScenarios, computeScenarioEnvelope } from '@/lib/pipeline/sroi-sensitivity';
import { createSroiRunReviewAction } from '../createSroiRunReview.action';
import { recordEvidenceSufficiencyDeterminationAction } from '../recordEvidenceSufficiencyDetermination.action';
import { recordOutcomeMonetizationDispositionAction } from '../recordOutcomeMonetizationDisposition.action';
import { computeReadinessAssessmentAction } from '../computeReadinessAssessment.action';
import { registerSensitivityCandidatesAction } from '../registerSensitivityCandidates.action';
import { dispositionSensitivityCandidateAction } from '../dispositionSensitivityCandidate.action';
import { recordSensitivityScenarioAction } from '../recordSensitivityScenario.action';
import { revalidatePath } from 'next/cache';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { CalculationResultsCard } from '@/components/calculation-results/CalculationResultsCard';
import { ArrowLeft } from 'lucide-react';

export const dynamic = 'force-dynamic';

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
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y';

const SUFFICIENCY_BADGE: Record<string, { variant: 'success' | 'danger' | 'neutral'; label: string }> = {
  sufficient: { variant: 'success', label: 'Suficiente' },
  insufficient: { variant: 'danger', label: 'Insuficiente' },
};

// FIBIU-12 (FIBC-016) — the seven governed not_monetized reasons, each with
// its own label: never collapsed into one generic omission category.
const MONETIZATION_REASON_LABEL: Record<string, string> = {
  no_defensible_proxy: 'Sin proxy defendible',
  proxy_not_approved: 'Proxy no aprobado',
  insufficient_evidence: 'Evidencia insuficiente',
  not_material: 'No material',
  not_yet_eligible: 'Aún no elegible',
  superseded_version: 'Versión superada',
  other_governed_reason: 'Otra razón gobernada',
};

const MATERIALITY_LABEL: Record<string, string> = {
  material: 'Material',
  not_material: 'No material',
};

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}) {
  const { projectId, runId } = await params;

  const loaded = await runWithOrganizationAccess(async (ctx) => {
    let detail: Awaited<ReturnType<typeof getCalculationRunDetail>>;
    try {
      detail = await getCalculationRunDetail(projectId, runId);
    } catch {
      return null;
    }
    // R4 (R-B1-02, FIBIU-06) — the outcomes actually monetized BY THIS RUN,
    // read from its own immutable line items rather than the project's
    // current (possibly since-changed) proxy assignments. This is the
    // run-unambiguous signal the sufficiency panel below is bound to.
    const monetizedOutcomeIds = Array.from(
      new Set(detail.lineItems.map((li) => li.outcomeId).filter((id): id is string => !!id))
    );
    return {
      detail,
      canReview: isInReviewSet(ctx.membership.role),
      // FIBIU-29 (FIBC-041) / W1-05-RM1 R-5 — the author never sees the
      // approve action, in addition to the server-side enforcement in
      // assertRunMethodologyApprovalAllowed (lib/pipeline/sroi-results.ts),
      // which remains authoritative regardless of what the UI renders.
      canApproveThisRun: isInReviewSet(ctx.membership.role) && detail.run.calculatedBy !== ctx.user.id,
      reviews: await listSroiRunReviews(projectId, runId),
      // FIBIU-03 (FIBC-002/FIBC-045) / W1-05-RM1 R-6 — computed from the
      // run's own frozen fingerprint (FIBC-023: never persisted, never
      // mutates the immutable run); a legacy run with no fingerprint reads
      // as no drift, never fabricated either way.
      inputDrift: await detectRunInputDrift(detail.run),
      canDetermineSufficiency: canDetermineEvidenceSufficiency(ctx.membership.role),
      monetizedOutcomeIds,
      outcomes: await fetchOutcomes(projectId),
      sufficiencyByOutcome: await getLatestSufficiencyDeterminationsByOutcomeIds(monetizedOutcomeIds, runId),
      // FIBIU-12 (FIBC-016, W2-B3 completeness) — the coverage view a reviewer
      // must see BEFORE approving: composed from this run's own immutable
      // line items, the dispositions recorded for it, the project's active
      // assignment outcomes, and FIBIU-11's classification per outcome.
      coverage: await getRunMonetizationCoverage(projectId, runId),
      // The same analyst+ floor the service (authorize) and the 0059/0060
      // policies enforce; the service and the database remain authoritative.
      canRecordDisposition: hasRole(ctx.membership.role, 'analyst'),
      runApproved: (await listSroiRunReviews(projectId, runId)).some((r) => r.status === 'approved'),
      // FIBIU-17/18 (W2-B5) — RD-BLK-1: these are governed reads, not optional
      // enrichment. No catch here: an authorization/RLS/unexpected failure
      // must fail the whole page render (same as every other read above),
      // never be swallowed into a synthesized empty/complete state. There is
      // no reliable error taxonomy to distinguish "genuinely nothing to
      // report" from "could not be verified" at this boundary, so the only
      // safe behavior is to let a thrown error propagate.
      // FIBIU-17 (FIBC-021, W2-B5) — canonical readiness; null until computed.
      readiness: await getReadinessAssessment(projectId, runId),
      // FIBIU-18 (FIBC-022, W2-B5) — governed sensitivity register/scenarios.
      sensitivityCandidates: await listSensitivityCandidates(projectId, runId),
      sensitivityScenarios: await listSensitivityScenarios(projectId, runId),
      sensitivityCompleteness: await getRunSensitivityCompleteness(projectId, runId),
    };
  });

  if (!loaded) notFound();
  const {
    detail,
    canReview,
    canApproveThisRun,
    reviews,
    inputDrift,
    canDetermineSufficiency,
    monetizedOutcomeIds,
    outcomes,
    sufficiencyByOutcome,
    coverage,
    canRecordDisposition,
    runApproved,
    readiness,
    sensitivityCandidates,
    sensitivityScenarios,
    sensitivityCompleteness,
  } = loaded;

  const { run, lineItems, snapshotJson } = detail;
  const outcomeTitleById = new Map((outcomes ?? []).map((o) => [o.id, o.title]));
  const noRatioReason = (snapshotJson as { noRatioReason?: string | null } | null)?.noRatioReason ?? null;
  const hasRatio = run.sroiRatio !== null && run.sroiRatio !== undefined;
  const readinessBandLabel: Record<string, string> = {
    initial_preparation: 'Preparación inicial',
    partial_preparation: 'Preparación parcial',
    advanced_preparation: 'Preparación avanzada',
    high_preparation: 'Preparación alta',
  };
  const scenarioEnvelope = sensitivityScenarios.length === 0
    ? null
    : computeScenarioEnvelope(
        { netSocialValueExact: run.netSocialValue ?? '0', sroiRatioExact: run.sroiRatio },
        sensitivityScenarios.map((s) => s.resultJson as { netSocialValueExact: string; sroiRatioExact: string | null })
      );

  async function handleRecordDisposition(formData: FormData) {
    'use server';
    const outcomeId = formData.get('outcomeId') as string;
    const disposition = formData.get('disposition') as string;
    const reason = (formData.get('reason') as string) || undefined;
    const justification = (formData.get('justification') as string) || undefined;
    await recordOutcomeMonetizationDispositionAction(projectId, outcomeId, runId, {
      disposition,
      reason: disposition === 'not_monetized' ? reason : undefined,
      justification: disposition === 'not_monetized' ? justification : undefined,
    });
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  async function handleRecordSufficiency(formData: FormData) {
    'use server';
    const outcomeId = formData.get('outcomeId') as string;
    await recordEvidenceSufficiencyDeterminationAction(projectId, outcomeId, runId, {
      determination: formData.get('determination') as string,
      rationale: formData.get('rationale') as string,
    });
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  async function handleCreateReview(formData: FormData) {
    'use server';
    await createSroiRunReviewAction(projectId, runId, {
      status: formData.get('status') as string,
      overallNotes: (formData.get('overallNotes') as string) || undefined,
    });
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  async function handleComputeReadiness() {
    'use server';
    await computeReadinessAssessmentAction(projectId, runId);
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  async function handleRegisterSensitivityCandidates() {
    'use server';
    await registerSensitivityCandidatesAction(projectId, runId);
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  async function handleDispositionCandidate(formData: FormData) {
    'use server';
    await dispositionSensitivityCandidateAction(projectId, formData.get('candidateId') as string, {
      disposition: formData.get('disposition') as string,
      rationale: formData.get('rationale') as string,
    });
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation/runs/${runId}`);
  }

  async function handleRecordScenario(formData: FormData) {
    'use server';
    await recordSensitivityScenarioAction(projectId, runId, {
      scenarioKind: formData.get('scenarioKind') as string,
      substitutions: [{ candidateId: formData.get('candidateId') as string, alternativeValue: formData.get('alternativeValue') as string }],
      reason: formData.get('reason') as string,
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
            {/* FIBIU-12 (FIBC-016, AG-B3-2) — an explicit no-ratio state, never '—' alone and never 0.00:1. */}
            {hasRatio ? (
              `${parseFloat(run.sroiRatio!).toFixed(2)}:1`
            ) : (
              <span className="text-base font-semibold text-amber-800" data-testid="run-no-ratio">Sin ratio SROI</span>
            )}
          </p>
          {!hasRatio && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {noRatioReason === 'NO_DEFENSIBLE_MONETIZATION'
                ? 'Ningún resultado tiene monetización defendible en esta corrida (FIBC-016). Los resultados se reportan sin ratio.'
                : 'Esta corrida no persistió un ratio SROI.'}
            </p>
          )}
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

      {/* Input drift (FIBIU-03 / FIBC-045) — never a mutation, never an error state. */}
      {inputDrift.hasDrift && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100">
          <p className="font-medium">Esta corrida dejó de ser elegible; genere una nueva.</p>
          <p className="mt-1 text-xs text-yellow-800 dark:text-yellow-200">
            Los siguientes datos usados en este cálculo cambiaron desde entonces:
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs">
            {inputDrift.driftedObjects.map((o) => (
              <li key={`${o.objectType}:${o.objectId}`}>
                {o.objectType} ({o.objectId})
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Run version identity triple (FIBIU-02 / FIBC-001) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identidad de Versión de Corrida</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Identidades resueltas por el sistema al momento del cálculo — nunca editables.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground block text-xs">Metodología</span>
            <span
              className="font-medium text-foreground tabular-nums"
              style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
            >
              {run.methodologyVersion ?? '— (corrida heredada, anterior al versionado)'}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs">Motor de Cálculo</span>
            <span
              className="font-medium text-foreground tabular-nums"
              style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
            >
              {run.calculationEngineVersion ?? '— (corrida heredada, anterior al versionado)'}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs">Identidad de Build</span>
            <span
              className="font-medium text-foreground tabular-nums break-all"
              style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
            >
              {run.buildIdentity ?? '— (corrida heredada, anterior al versionado)'}
            </span>
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

      {/* Calculation Results with Per-Funder Breakdown */}
      <CalculationResultsCard
        snapshotJson={snapshotJson}
        currency={run.currency || 'USD'}
        showFxAudit={true}
      />

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

      {/* Evidence sufficiency (FIBIU-06 / FIBC-008 / FIBDB-014) — a governed
          human determination over each monetized outcome's evidence SET,
          bound to THIS run (never inferred from count/status/confidence, and
          never satisfied by a determination made for a different run). The
          run is fixed via a hidden field, not user-editable, so the panel
          can only ever record a determination for the run currently being
          viewed. */}
      {monetizedOutcomeIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Suficiencia de Evidencia</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Determinación humana, por resultado monetizado, de si la evidencia disponible es
              suficiente para esta corrida específica. No se infiere de la cantidad ni del estado
              de la evidencia.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resultado</TableHead>
                  <TableHead>Determinación actual</TableHead>
                  {canDetermineSufficiency && <TableHead>Registrar determinación</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {monetizedOutcomeIds.map((outcomeId) => {
                  const current = sufficiencyByOutcome.get(outcomeId);
                  const currentConfig = current
                    ? SUFFICIENCY_BADGE[current.determination] ?? {
                        variant: 'neutral' as const,
                        label: current.determination,
                      }
                    : null;
                  const determinationSelectId = `sufficiency-determination-${outcomeId}`;
                  const rationaleId = `sufficiency-rationale-${outcomeId}`;
                  return (
                    <TableRow key={outcomeId}>
                      <TableCell className="font-medium text-foreground max-w-[220px]">
                        <span className="line-clamp-1">
                          {outcomeTitleById.get(outcomeId) ?? outcomeId}
                        </span>
                      </TableCell>
                      <TableCell>
                        {currentConfig ? (
                          <div className="flex flex-col gap-1">
                            <Badge variant={currentConfig.variant}>{currentConfig.label}</Badge>
                            <span className="text-[10px] text-muted-foreground">
                              {current!.rationale}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">Sin determinar</span>
                        )}
                      </TableCell>
                      {canDetermineSufficiency && (
                        <TableCell>
                          <form action={handleRecordSufficiency} className="flex flex-col gap-1.5 max-w-xs">
                            <input type="hidden" name="outcomeId" value={outcomeId} />
                            <label htmlFor={determinationSelectId} className="sr-only">
                              Determinación de suficiencia
                            </label>
                            <Select
                              id={determinationSelectId}
                              name="determination"
                              defaultValue=""
                              required
                              className="h-7 text-xs"
                            >
                              <option value="" disabled>
                                Determinar…
                              </option>
                              <option value="sufficient">Suficiente</option>
                              <option value="insufficient">Insuficiente</option>
                            </Select>
                            <label htmlFor={rationaleId} className="sr-only">
                              Justificación
                            </label>
                            <textarea
                              id={rationaleId}
                              name="rationale"
                              rows={2}
                              required
                              placeholder="Justificación (requerida)"
                              className={TEXTAREA_CLASS}
                            />
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Guardar determinación
                            </button>
                          </form>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Monetization coverage + per-outcome disposition (FIBIU-12 / FIBC-016 /
          FIBDB-009) — rendered BEFORE the review/approval form, so coverage is
          visible before any approval decision. Every outcome the run touched
          or the project actively assigns appears exactly once; an outcome
          without a disposition is shown as missing, never dropped; each
          not_monetized reason keeps its own governed label. The disposition
          is a HUMAN act bound to THIS run by a hidden field the user cannot
          edit; the run is read-only once approved (0060 DB guard). */}
      <section data-testid="monetization-coverage" aria-label="Cobertura de monetización">
      <Card>
        <CardHeader>
          <CardTitle>Cobertura de Monetización (antes de aprobar)</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Disposición humana por resultado para esta corrida: monetizado o no monetizado con razón gobernada y
            justificación. El ratio SROI cubre únicamente los resultados con monetización defendible. Stella explica
            exclusiones; nunca decide qué excluir.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <span className="text-muted-foreground block text-xs">Monetización defendible</span>
              <span className="font-medium text-foreground" data-testid="coverage-defensible">
                {coverage.hasDefensibleMonetization ? 'Sí — ratio emitido' : 'No — sin ratio SROI'}
              </span>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <span className="text-muted-foreground block text-xs">Monetizados</span>
              <span className="font-medium text-foreground">{coverage.monetizedOutcomeIds.length}</span>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <span className="text-muted-foreground block text-xs">Materiales no monetizados</span>
              <span className="font-medium text-foreground">{coverage.materialNotMonetizedOutcomeIds.length}</span>
            </div>
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
              <span className="text-amber-900 block text-xs">Sin disposición registrada</span>
              <span className="font-medium text-amber-900" data-testid="coverage-missing-count">
                {coverage.missingDispositionOutcomeIds.length}
              </span>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-foreground mb-1">No monetizados por razón gobernada</p>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs text-muted-foreground" data-testid="coverage-by-reason">
              {MONETIZATION_REASON_VALUES.map((reason) => (
                <li key={reason} className="flex justify-between rounded border border-border/60 px-2 py-1">
                  <span>{MONETIZATION_REASON_LABEL[reason] ?? reason}</span>
                  <span className="tabular-nums text-foreground" data-testid={`coverage-reason-${reason}`}>
                    {coverage.notMonetizedByReason[reason].length}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {coverage.outcomes.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Esta corrida no tiene resultados que cubrir.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resultado</TableHead>
                  <TableHead>Materialidad</TableHead>
                  <TableHead>Motor</TableHead>
                  <TableHead>Disposición actual</TableHead>
                  {canRecordDisposition && !runApproved && <TableHead>Registrar disposición</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {coverage.outcomes.map((o) => {
                  const dispositionSelectId = `disposition-${o.outcomeId}`;
                  const reasonSelectId = `disposition-reason-${o.outcomeId}`;
                  const justificationId = `disposition-justification-${o.outcomeId}`;
                  return (
                    <TableRow key={o.outcomeId} data-testid={`coverage-row-${o.outcomeId}`}>
                      <TableCell className="font-medium text-foreground max-w-[220px]">
                        <span className="line-clamp-1">{outcomeTitleById.get(o.outcomeId) ?? o.outcomeId}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {o.materialityClassification === null ? (
                          <span className="text-amber-800">Sin clasificar</span>
                        ) : (
                          MATERIALITY_LABEL[o.materialityClassification] ?? o.materialityClassification
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {o.engineMonetized ? 'Monetizado en esta corrida' : 'Sin línea en esta corrida'}
                      </TableCell>
                      <TableCell>
                        {o.bucket === 'missing_disposition' ? (
                          <Badge variant="warning">Sin disposición</Badge>
                        ) : o.bucket === 'monetized' ? (
                          <Badge variant="success">Monetizado</Badge>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <Badge variant="neutral">
                              No monetizado — {MONETIZATION_REASON_LABEL[o.disposition?.reason ?? ''] ?? o.disposition?.reason}
                            </Badge>
                            {o.disposition?.justification && (
                              <span className="text-[10px] text-muted-foreground">{o.disposition.justification}</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      {canRecordDisposition && !runApproved && (
                        <TableCell>
                          <form action={handleRecordDisposition} className="flex flex-col gap-1.5 max-w-xs">
                            <input type="hidden" name="outcomeId" value={o.outcomeId} />
                            <label htmlFor={dispositionSelectId} className="sr-only">
                              Disposición de monetización
                            </label>
                            <Select
                              id={dispositionSelectId}
                              name="disposition"
                              defaultValue={o.engineMonetized ? 'monetized' : 'not_monetized'}
                              required
                              className="h-7 text-xs"
                            >
                              <option value="monetized">Monetizado</option>
                              <option value="not_monetized">No monetizado</option>
                            </Select>
                            <label htmlFor={reasonSelectId} className="sr-only">
                              Razón gobernada
                            </label>
                            <Select id={reasonSelectId} name="reason" defaultValue="" className="h-7 text-xs">
                              <option value="">Razón (requerida si no monetizado)…</option>
                              {MONETIZATION_REASON_VALUES.map((reason) => (
                                <option key={reason} value={reason}>
                                  {MONETIZATION_REASON_LABEL[reason] ?? reason}
                                </option>
                              ))}
                            </Select>
                            <label htmlFor={justificationId} className="sr-only">
                              Justificación de la disposición
                            </label>
                            <textarea
                              id={justificationId}
                              name="justification"
                              rows={2}
                              placeholder="Justificación (requerida si no monetizado)"
                              className={TEXTAREA_CLASS}
                            />
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Guardar disposición
                            </button>
                          </form>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {runApproved && (
            <p className="text-xs text-muted-foreground italic">
              Corrida aprobada: las disposiciones son inmutables (FIBDB-009, aplicado por la base de datos).
            </p>
          )}
        </CardContent>
      </Card>
      </section>

      {/* FIBIU-17 (FIBC-021, W2-B5) — canonical readiness */}
      <Card>
        <CardHeader>
          <CardTitle>Preparación (Readiness)</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Puntaje canónico computado por el sistema — {READINESS_CRITERIA_COUNT} criterios en diez dimensiones. Nunca aprueba ni bloquea el cálculo; ningún humano ni Stella puede asignarlo.
          </p>
        </CardHeader>
        <CardContent>
          {readiness ? (
            <div className="flex items-center gap-4">
              <p className="text-2xl font-bold text-foreground tabular-nums font-ibm-plex-mono">
                {Number(readiness.globalScore).toFixed(1)}
              </p>
              <div>
                <Badge variant="info">{readinessBandLabel[readiness.band] ?? readiness.band}</Badge>
                <p className="text-xs text-muted-foreground mt-1">Modelo {readiness.readinessModelVersion}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground italic">Aún no se ha computado la preparación para esta corrida.</p>
              {canRecordDisposition && (
                <form action={handleComputeReadiness}>
                  <button type="submit" className="text-sm px-3 py-1.5 rounded-md border border-input bg-background hover:bg-muted">
                    Computar preparación
                  </button>
                </form>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* FIBIU-18 (FIBC-022, W2-B5) — governed sensitivity register/scenarios */}
      <Card>
        <CardHeader>
          <CardTitle>Análisis de sensibilidad gobernado</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Registro de candidatos por insumo realmente usado; cada candidato requiere disposición humana. Ningún umbral universal determina materialidad — el sistema calcula deltas, el revisor determina y registra materialidad.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {sensitivityCandidates.length === 0 ? (
            canRecordDisposition && (
              <form action={handleRegisterSensitivityCandidates}>
                <button type="submit" className="text-sm px-3 py-1.5 rounded-md border border-input bg-background hover:bg-muted">
                  Registrar candidatos de sensibilidad
                </button>
              </form>
            )
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {sensitivityCompleteness.complete
                  ? 'Registro completo: sin candidatos pendientes, cada variation_required tiene al menos un escenario.'
                  : `Incompleto — ${sensitivityCompleteness.pendingCandidateIds.length} pendiente(s), ${sensitivityCompleteness.variationRequiredWithoutScenarioIds.length} sin escenario.`}
              </p>
              <div className="divide-y divide-border border rounded-md">
                {sensitivityCandidates.map((c) => (
                  <div key={c.id} className="px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{c.candidateKey}</span>
                      <Badge variant={c.disposition === 'pending' ? 'warning' : 'success'}>{c.disposition}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">Valor base: {c.baseValue ?? '—'}</p>
                    {c.disposition === 'pending' && canRecordDisposition && !runApproved && (
                      <form action={handleDispositionCandidate} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="candidateId" value={c.id} />
                        <select name="disposition" className={INPUT_CLASS} style={{ maxWidth: 260 }}>
                          <option value="variation_required">Requiere variación</option>
                          <option value="no_additional_variation_required">No requiere variación adicional</option>
                        </select>
                        <input name="rationale" placeholder="Justificación (requerida)" className={INPUT_CLASS} style={{ maxWidth: 320 }} />
                        <button type="submit" className="text-xs px-2 py-1.5 rounded-md border border-input bg-background hover:bg-muted">
                          Registrar disposición
                        </button>
                      </form>
                    )}
                    {c.disposition === 'variation_required' && canRecordDisposition && !runApproved && (
                      <form action={handleRecordScenario} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="candidateId" value={c.id} />
                        <input type="hidden" name="scenarioKind" value="one_at_a_time" />
                        <input name="alternativeValue" placeholder="Valor alternativo" className={INPUT_CLASS} style={{ maxWidth: 200 }} />
                        <input name="reason" placeholder="Razón (requerida)" className={INPUT_CLASS} style={{ maxWidth: 320 }} />
                        <button type="submit" className="text-xs px-2 py-1.5 rounded-md border border-input bg-background hover:bg-muted">
                          Registrar escenario
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
              {scenarioEnvelope && (
                <div className="rounded-md border p-3 bg-muted/30">
                  <p className="text-xs font-medium text-muted-foreground">Envolvente de escenario (scenario envelope) — nunca un intervalo de confianza</p>
                  <p className="text-sm text-foreground mt-1">
                    Valor neto: {scenarioEnvelope.netSocialValueMinExact} – {scenarioEnvelope.netSocialValueMaxExact}
                  </p>
                  {scenarioEnvelope.sroiRatioMinExact && (
                    <p className="text-sm text-foreground">
                      Ratio SROI: {scenarioEnvelope.sroiRatioMinExact} – {scenarioEnvelope.sroiRatioMaxExact}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

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
                        // FIBIU-17 (FIBC-021, W2-B5) — FIBDB-016 stage B: historical
                        // manual score, retained but LEGACY_NON_AUTHORITATIVE. Never
                        // written by a new review; only pre-B5 rows carry it.
                        <span className="text-xs text-muted-foreground">
                          Score legado (no autoritativo): {review.readinessScore}/100
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
                    {canApproveThisRun && <option value="approved">Aprobado</option>}
                    <option value="flagged">Marcado</option>
                  </select>
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
