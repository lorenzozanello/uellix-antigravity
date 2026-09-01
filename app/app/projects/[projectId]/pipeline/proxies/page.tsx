// app/app/projects/[projectId]/pipeline/proxies/page.tsx

import Stepper from '@/components/sroi/Stepper'
import { PipelineStepHeader } from '@/components/sroi/PipelineStepHeader'
import { StellaContextualAdvisorPanel, StellaReviewerPanel } from '@/components/stella'
// Server-only config read (READ-ONLY module) — availability passed as prop (U5).
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { MethodologyReviewPanel } from '@/components/methodology/MethodologyReviewPanel'
import { ProxyBankSearch } from '@/app/components/proxy-bank-search/ProxyBankSearch'
import { canReviewMethodology } from '@/lib/pipeline/methodology-review'
import { canEvaluateProxyRubric } from '@/lib/auth/permissions'
import { runWithOptionalOrganizationAccess } from '@/lib/auth/session'
import {
  listFinancialProxies,
  listProxySources,
  listProxyAssignmentsForProject,
} from '@/lib/pipeline/proxies'
import { getLatestFinancialProxyVersionsByProxyIds } from '@/lib/pipeline/financial-proxy-versions'
import { CONFIDENCE_FACTOR_KEYS, RISK_FACTOR_KEYS } from '@/lib/pipeline/financial-proxy-rubric'
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions'
import { createProxySourceAction } from '@/app/app/projects/[projectId]/pipeline/proxies/createProxySource.action'
import { createFinancialProxyAction } from '@/app/app/projects/[projectId]/pipeline/proxies/createFinancialProxy.action'
import { assignProxyToOutcomeAction } from '@/app/app/projects/[projectId]/pipeline/proxies/assignProxyToOutcome.action'
import { archiveOutcomeProxyAssignmentAction } from '@/app/app/projects/[projectId]/pipeline/proxies/archiveOutcomeProxyAssignment.action'
import { updateFinancialProxyReviewStatusAction } from '@/app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxyReviewStatus.action'
import { evaluateProxyRubricAction } from '@/app/app/projects/[projectId]/pipeline/proxies/evaluateProxyRubric.action'
import { updateFinancialProxyAction } from '@/app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxy.action'
import { MATERIAL_CATEGORY_LABELS } from '@/lib/pipeline/proxy-material-change'
import { revalidatePath } from 'next/cache'
import { Archive, BookOpen, DollarSign, GitMerge } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'

export const dynamic = 'force-dynamic'

const PROXY_STATUS: Record<
  string,
  { variant: 'neutral' | 'info' | 'success' | 'danger'; label: string }
> = {
  suggested: { variant: 'neutral', label: 'Sugerido' },
  under_review: { variant: 'info', label: 'En revisión' },
  approved: { variant: 'success', label: 'Aprobado' },
  rejected: { variant: 'danger', label: 'Rechazado' },
}

const CONFIDENCE_BADGE: Record<
  string,
  { variant: 'success' | 'warning' | 'danger'; label: string }
> = {
  high: { variant: 'success', label: 'Alta' },
  medium: { variant: 'warning', label: 'Media' },
  low: { variant: 'danger', label: 'Baja' },
}

const RISK_BADGE: Record<
  string,
  { variant: 'success' | 'warning' | 'danger'; label: string }
> = {
  low: { variant: 'success', label: 'Riesgo bajo' },
  medium: { variant: 'warning', label: 'Riesgo medio' },
  high: { variant: 'danger', label: 'Riesgo alto' },
}

const ASSIGNMENT_STATUS: Record<
  string,
  { variant: 'info' | 'neutral'; label: string }
> = {
  active: { variant: 'info', label: 'Activo' },
  archived: { variant: 'neutral', label: 'Archivado' },
}

// FIBIU-09 (FIBC-011) — the thirteen rubric factor labels, in the exact
// order deriveRubricClassification reads them.
const CONFIDENCE_FACTOR_LABELS: Record<string, string> = {
  c1SourceQualityVerifiability: 'C1 — Calidad y verificabilidad de la fuente',
  c2OutcomeCorrespondence: 'C2 — Correspondencia con el resultado',
  c3StakeholderPopulationFit: 'C3 — Ajuste a la población de stakeholders',
  c4GeographicContextFit: 'C4 — Ajuste al contexto geográfico',
  c5TemporalFit: 'C5 — Ajuste temporal',
  c6MethodologicalUnitComparability: 'C6 — Comparabilidad metodológica de la unidad',
}
const RISK_FACTOR_LABELS: Record<string, string> = {
  r1ProvenanceRisk: 'R1 — Riesgo de procedencia',
  r2SourceLimitationRisk: 'R2 — Riesgo de limitación de la fuente',
  r3ConceptualFitRisk: 'R3 — Riesgo de ajuste conceptual',
  r4GeographicPopulationTransferRisk: 'R4 — Riesgo de transferencia geográfica/poblacional',
  r5TemporalObsolescenceRisk: 'R5 — Riesgo de obsolescencia temporal',
  r6TransformationRisk: 'R6 — Riesgo de transformación',
  r7MethodologicalUncertaintyRisk: 'R7 — Riesgo de incertidumbre metodológica',
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'

export default async function ProxiesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const {
    canEdit,
    canEvaluateRubric,
    canReviewMethodologyHere,
    financialProxies,
    proxySources,
    assignments,
    outcomes,
    proxyVersionsById,
  } = await runWithOptionalOrganizationAccess(async (ctx) => {
      if (!ctx) {
        return {
          canEdit: false,
          canEvaluateRubric: false,
          canReviewMethodologyHere: false,
          financialProxies: [],
          proxySources: [],
          assignments: [],
          outcomes: [],
          proxyVersionsById: new Map(),
        } as const
      }
      const [financialProxies, proxySources, assignments, outcomes] = await Promise.all([
        listFinancialProxies(),
        listProxySources(),
        listProxyAssignmentsForProject(projectId),
        fetchOutcomes(projectId),
      ])
      const proxyVersionsById = await getLatestFinancialProxyVersionsByProxyIds(
        financialProxies.map((p) => p.id)
      )
      return {
        canEdit: ['organization_admin', 'impact_manager', 'analyst'].includes(
          ctx.membership.role
        ),
        canEvaluateRubric: canEvaluateProxyRubric(ctx.membership.role),
        canReviewMethodologyHere: canReviewMethodology(ctx.membership.role),
        financialProxies,
        proxySources,
        assignments,
        outcomes,
        proxyVersionsById,
      }
    })

  // Mirror the corresponding server-action feature-flag gates (app/actions/stella/*).
  const stellaAdvisorEnabled =
    stellaConfig.isEnabled && stellaConfig.isAdvisorEnabled && stellaState.canUseStella
  const proxyReviewerEnabled =
    stellaConfig.isEnabled && stellaConfig.isProxyReviewerEnabled && stellaState.canUseStella

  // O(1) lookup maps — resolve UUIDs to display names without extra DB calls
  const sourceById = new Map(proxySources.map((s) => [s.id, s.name]))
  const outcomeById = new Map(outcomes.map((o) => [o.id, o.title]))
  const proxyById = new Map(financialProxies.map((p) => [p.id, p]))

  // Server Actions — declared inside component for closure access to projectId
  async function handleCreateSource(formData: FormData) {
    'use server'
    const name = formData.get('name') as string
    const url = formData.get('url') as string
    const description = formData.get('description') as string

    await createProxySourceAction(projectId, {
      name,
      url: url || undefined,
      description: description || undefined,
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  async function handleCreateProxy(formData: FormData) {
    'use server'
    const sourceId = formData.get('sourceId') as string
    const name = formData.get('name') as string
    const description = formData.get('description') as string
    const value = formData.get('value') as string
    const currency = formData.get('currency') as string
    const unit = formData.get('unit') as string
    const referenceYearStr = formData.get('referenceYear') as string
    const confidenceLevel = formData.get('confidenceLevel') as string
    const methodologicalRisk = formData.get('methodologicalRisk') as string

    await createFinancialProxyAction(projectId, {
      sourceId,
      name,
      description: description || undefined,
      value,
      currency,
      unit,
      referenceYear: Number(referenceYearStr),
      confidenceLevel: confidenceLevel || undefined,
      methodologicalRisk: methodologicalRisk || undefined,
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  async function handleAssignProxy(formData: FormData) {
    'use server'
    const outcomeId = formData.get('outcomeId') as string
    const proxyId = formData.get('proxyId') as string
    const justification = formData.get('justification') as string
    const territorialAdjustmentNotes = formData.get(
      'territorialAdjustmentNotes'
    ) as string

    await assignProxyToOutcomeAction(projectId, {
      outcomeId,
      proxyId,
      justification,
      territorialAdjustmentNotes: territorialAdjustmentNotes || undefined,
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  async function handleArchiveAssignment(formData: FormData) {
    'use server'
    const assignmentId = formData.get('assignmentId') as string

    await archiveOutcomeProxyAssignmentAction(projectId, {
      assignmentId,
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  async function handleUpdateProxy(formData: FormData) {
    'use server'
    const proxyId = formData.get('proxyId') as string
    const value = formData.get('value') as string
    const currency = formData.get('currency') as string
    const unit = formData.get('unit') as string
    const referenceYearStr = formData.get('referenceYear') as string

    await updateFinancialProxyAction(projectId, proxyId, {
      value: value || undefined,
      currency: currency || undefined,
      unit: unit || undefined,
      referenceYear: referenceYearStr ? Number(referenceYearStr) : undefined,
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  async function handleSuggestProxy(formData: FormData) {
    'use server'
    const proxyId = formData.get('proxyId') as string
    await updateFinancialProxyReviewStatusAction(projectId, {
      proxyId,
      newStatus: 'pending_review'
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  async function handleEvaluateRubric(formData: FormData) {
    'use server'
    const proxyId = formData.get('proxyId') as string
    const rationale = formData.get('rationale') as string
    const exceptionalDefendibilityDetermination = formData.get(
      'exceptionalDefendibilityDetermination'
    ) as string
    const factors = Object.fromEntries(
      [...CONFIDENCE_FACTOR_KEYS, ...RISK_FACTOR_KEYS].map((key) => [key, formData.get(key)])
    )
    await evaluateProxyRubricAction(projectId, {
      proxyId,
      ...factors,
      rationale,
      exceptionalDefendibilityDetermination: exceptionalDefendibilityDetermination || undefined,
    })
    revalidatePath(`/app/projects/${projectId}/pipeline/proxies`)
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <PipelineStepHeader
        step={6}
        title="Inteligencia de Proxies"
        description="Selecciona y asigna proxies financieros defendibles a los resultados. Todos los proxies son trazables a fuentes verificadas y requieren revisión metodológica humana antes de usarse en el cálculo SROI."
        methodologyNote="Los valores de proxy no representan una monetización de impacto garantizada. Son supuestos metodológicos que requieren validación humana y revisión por pares antes de reportar externamente."
      />

      <Stepper />

      {/* U3: proxy assignments are structured records (values, currencies,
          confidence) — no free-text apply target, so apply offers
          copy-to-clipboard. */}
      <StellaContextualAdvisorPanel
        projectId={projectId}
        step="proxies"
        enabled={stellaAdvisorEnabled}
        title="Stella — Asesoría contextual (Proxies)"
      />
      <StellaReviewerPanel
        projectId={projectId}
        role="proxy_reviewer"
        title="Revisor de Proxies (Stella)"
        enabled={proxyReviewerEnabled}
      />
      {canReviewMethodologyHere && (
        <MethodologyReviewPanel projectId={projectId} step="proxies" title="Revisión metodológica — Proxies" />
      )}

      {/* Proxy Bank */}
      <section aria-labelledby="proxy-bank-heading">
        <h2
          id="proxy-bank-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Banco de proxies
        </h2>

        {financialProxies.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-6 w-6 text-neutral-500" />}
            title="No hay proxies disponibles"
            description="Aún no se han agregado proxies financieros al banco de la organización. Usa el formulario de abajo para crear el primer proxy con una fuente trazable."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre del proxy</TableHead>
                <TableHead>Fuente</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Unidad</TableHead>
                <TableHead>Año de referencia</TableHead>
                <TableHead>Estado de revisión</TableHead>
                <TableHead>Confianza</TableHead>
                <TableHead>Riesgo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {financialProxies.map((p) => {
                const statusConfig =
                  PROXY_STATUS[p.reviewStatus] ?? {
                    variant: 'neutral' as const,
                    label: p.reviewStatus ?? 'suggested',
                  }
                const confidenceConfig = p.confidenceLevel
                  ? (CONFIDENCE_BADGE[p.confidenceLevel] ?? null)
                  : null
                const riskConfig = p.methodologicalRisk
                  ? (RISK_BADGE[p.methodologicalRisk] ?? null)
                  : null

                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-foreground max-w-[180px]">
                      <span className="line-clamp-2">{p.name}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs max-w-[140px]">
                      <span className="line-clamp-1">
                        {p.sourceId
                          ? (sourceById.get(p.sourceId) ?? (
                              <span className="tabular-nums text-xs" style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}>{p.sourceId.slice(0, 8)}…</span>
                            ))
                          : <span className="text-muted-foreground/50">—</span>}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums text-foreground">
                      <span className="tabular-nums text-sm" style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}>
                        {p.value != null
                          ? parseFloat(p.value).toLocaleString('en-US', {
                              minimumFractionDigits: 0,
                              maximumFractionDigits: 2,
                            })
                          : '—'}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">{p.currency}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.unit}</TableCell>
                    <TableCell className="tabular-nums text-xs text-muted-foreground">
                      {p.referenceYear}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                      {p.reviewStatus === 'suggested' && canEdit && (
                        <form action={handleSuggestProxy} className="mt-2">
                          <input type="hidden" name="proxyId" value={p.id} />
                          <button
                            type="submit"
                            className="text-[10px] bg-blue-100 text-blue-700 hover:bg-blue-200 px-2 py-1 rounded transition-colors"
                          >
                            Sugerir al Banco Global
                          </button>
                        </form>
                      )}
                    </TableCell>
                    <TableCell>
                      {confidenceConfig ? (
                        <Badge variant={confidenceConfig.variant}>
                          {confidenceConfig.label}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground/60" aria-label="Sin definir">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {riskConfig ? (
                        <Badge variant={riskConfig.variant}>{riskConfig.label}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground/60" aria-label="Sin definir">
                          —
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Defendibility rubric — FIBIU-09 (FIBC-011). The confidence and risk
          levels shown here are SYSTEM-DERIVED from the thirteen factors
          below; there is no field to type a level directly. */}
      {financialProxies.length > 0 && (
        <section aria-labelledby="rubric-heading">
          <h2
            id="rubric-heading"
            className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Rúbrica de defendibilidad (FIBC-011)
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            La confianza y el riesgo metodológico se calculan a partir de estos trece factores — no
            se establecen directamente. Un factor sin calificar bloquea la aprobación del proxy.
          </p>
          <div className="space-y-3">
            {financialProxies.map((p) => {
              const version = proxyVersionsById.get(p.id)
              const confidenceConfig = version?.confidenceLevel
                ? CONFIDENCE_BADGE[version.confidenceLevel]
                : null
              const riskConfig = version?.methodologicalRisk
                ? RISK_BADGE[version.methodologicalRisk]
                : null
              const allFactorsRated = version
                ? [...CONFIDENCE_FACTOR_KEYS, ...RISK_FACTOR_KEYS].every(
                    (key) => (version as Record<string, unknown>)[key] != null
                  )
                : false
              const needsExceptionalDetermination =
                version?.confidenceLevel === 'low' || version?.methodologicalRisk === 'high'

              return (
                <Card key={p.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm">{p.name}</CardTitle>
                      <div className="flex flex-wrap items-center gap-2">
                        {confidenceConfig ? (
                          <Badge variant={confidenceConfig.variant}>
                            Confianza: {confidenceConfig.label} ({version?.confidenceScore ?? '—'})
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">Rúbrica sin calificar</span>
                        )}
                        {riskConfig && (
                          <Badge variant={riskConfig.variant}>
                            {riskConfig.label} ({version?.methodologicalRiskScore ?? '—'})
                          </Badge>
                        )}
                      </div>
                    </div>
                    {allFactorsRated && needsExceptionalDetermination && (
                      <p className="mt-1 text-xs text-amber-700">
                        {version?.exceptionalDefendibilityDetermination
                          ? 'Confianza baja o riesgo alto — el techo/piso de la rúbrica lo determinó; hay una determinación excepcional registrada.'
                          : 'Confianza baja o riesgo alto — requiere una determinación excepcional explícita antes de poder aprobarse.'}
                      </p>
                    )}
                  </CardHeader>
                  {canEvaluateRubric && (
                    <CardContent>
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-foreground">
                          {allFactorsRated ? 'Volver a calificar' : 'Calificar los trece factores'}
                        </summary>
                        <form action={handleEvaluateRubric} className="mt-3 space-y-3">
                          <input type="hidden" name="proxyId" value={p.id} />
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {[...CONFIDENCE_FACTOR_KEYS, ...RISK_FACTOR_KEYS].map((key) => {
                              const label =
                                CONFIDENCE_FACTOR_LABELS[key] ?? RISK_FACTOR_LABELS[key] ?? key
                              const current = version
                                ? (version as Record<string, unknown>)[key]
                                : null
                              return (
                                <div key={key}>
                                  <label
                                    htmlFor={`${p.id}-${key}`}
                                    className="block text-xs font-medium text-foreground"
                                  >
                                    {label}
                                  </label>
                                  <Select
                                    id={`${p.id}-${key}`}
                                    name={key}
                                    required
                                    defaultValue={current != null ? String(current) : ''}
                                    className="mt-1"
                                  >
                                    <option value="">— Sin calificar —</option>
                                    <option value="0">0</option>
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    <option value="3">3</option>
                                  </Select>
                                </div>
                              )
                            })}
                          </div>
                          <div>
                            <label
                              htmlFor={`${p.id}-rationale`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Justificación{' '}
                              <span className="text-danger" aria-hidden="true">
                                *
                              </span>
                            </label>
                            <textarea
                              id={`${p.id}-rationale`}
                              name="rationale"
                              rows={2}
                              required
                              placeholder="Motivo de estas calificaciones, con referencias"
                              className={TEXTAREA_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`${p.id}-exceptional`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Determinación excepcional de defendibilidad
                            </label>
                            <textarea
                              id={`${p.id}-exceptional`}
                              name="exceptionalDefendibilityDetermination"
                              rows={2}
                              defaultValue={version?.exceptionalDefendibilityDetermination ?? ''}
                              placeholder="Requerida solo si la confianza resulta baja o el riesgo resulta alto"
                              className={TEXTAREA_CLASS}
                            />
                          </div>
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                          >
                            Registrar evaluación
                          </button>
                        </form>
                      </details>
                    </CardContent>
                  )}
                  {/* FIBIU-10 (FIBC-013) — the pre-edit invalidation notice
                      naming the material category affected, before any edit
                      is submitted. */}
                  {canEdit && (
                    <CardContent>
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-foreground">
                          Editar campos materiales
                        </summary>
                        <form action={handleUpdateProxy} className="mt-3 space-y-3">
                          <input type="hidden" name="proxyId" value={p.id} />
                          {p.reviewStatus === 'approved' && (
                            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                              Este proxy está <strong>aprobado</strong>. Editar cualquiera de los campos
                              siguientes es un cambio material — invalidará la aprobación actual y abrirá
                              una nueva versión sin calificar para revisión. Los categorías afectadas son:{' '}
                              {MATERIAL_CATEGORY_LABELS.identity_economic_value} (valor/moneda/unidad/año) y{' '}
                              {MATERIAL_CATEGORY_LABELS.source_provenance} (fuente). La versión aprobada
                              anterior se conserva intacta para los cálculos históricos que ya la usan.
                            </p>
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`${p.id}-edit-value`} className="block text-xs font-medium text-foreground">
                                Valor ({MATERIAL_CATEGORY_LABELS.identity_economic_value})
                              </label>
                              <input id={`${p.id}-edit-value`} name="value" type="text" defaultValue={p.value ?? ''} className={INPUT_CLASS} />
                            </div>
                            <div>
                              <label htmlFor={`${p.id}-edit-currency`} className="block text-xs font-medium text-foreground">
                                Moneda ({MATERIAL_CATEGORY_LABELS.identity_economic_value})
                              </label>
                              <input id={`${p.id}-edit-currency`} name="currency" type="text" defaultValue={p.currency ?? ''} className={INPUT_CLASS} />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`${p.id}-edit-unit`} className="block text-xs font-medium text-foreground">
                                Unidad ({MATERIAL_CATEGORY_LABELS.identity_economic_value})
                              </label>
                              <input id={`${p.id}-edit-unit`} name="unit" type="text" defaultValue={p.unit ?? ''} className={INPUT_CLASS} />
                            </div>
                            <div>
                              <label htmlFor={`${p.id}-edit-year`} className="block text-xs font-medium text-foreground">
                                Año de referencia ({MATERIAL_CATEGORY_LABELS.identity_economic_value})
                              </label>
                              <input id={`${p.id}-edit-year`} name="referenceYear" type="number" defaultValue={p.referenceYear ?? ''} className={INPUT_CLASS} />
                            </div>
                          </div>
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                          >
                            Guardar cambios
                          </button>
                        </form>
                      </details>
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        </section>
      )}

      {/* Creation forms — restricted to permitted roles */}
      {canEdit && (
        <section aria-labelledby="manage-proxies-heading">
          <h2
            id="manage-proxies-heading"
            className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Gestión de Proxies
          </h2>
          
          <ProxyBankSearch />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Create Source */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Registrar fuente</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Registra una fuente de referencia verificada para valores de proxy (ej. HACT, ONS,
                  bases de datos estadísticas gubernamentales).
                </p>
              </CardHeader>
              <CardContent>
                <form action={handleCreateSource} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />

                  <div>
                    <label
                      htmlFor="src-name"
                      className="block text-xs font-medium text-foreground"
                    >
                      Nombre de la fuente{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      id="src-name"
                      name="name"
                      type="text"
                      required
                      placeholder="ej. Base de datos de proxies financieros HACT"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="src-url"
                      className="block text-xs font-medium text-foreground"
                    >
                      URL de referencia
                    </label>
                    <input
                      id="src-url"
                      name="url"
                      type="url"
                      placeholder="https://…"
                      className={INPUT_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Enlace opcional a la publicación oficial de la fuente.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="src-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Descripción
                    </label>
                    <textarea
                      id="src-description"
                      name="description"
                      rows={2}
                      placeholder="Breve descripción del alcance y procedencia"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Registrar fuente
                  </button>
                </form>
              </CardContent>
            </Card>

            {/* Create Financial Proxy */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Crear proxy financiero</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Agrega un valor de proxy financiero trazable a una fuente registrada. Las
                  calificaciones de confianza y riesgo respaldan una selección de proxy defendible.
                </p>
              </CardHeader>
              <CardContent>
                <form action={handleCreateProxy} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />

                  <div>
                    <label
                      htmlFor="proxy-source"
                      className="block text-xs font-medium text-foreground"
                    >
                      Fuente{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <Select id="proxy-source" name="sourceId" required className="mt-1">
                      <option value="">— Seleccionar fuente —</option>
                      {proxySources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="proxy-name"
                      className="block text-xs font-medium text-foreground"
                    >
                      Nombre del proxy{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      id="proxy-name"
                      name="name"
                      type="text"
                      required
                      placeholder="ej. Costo de tratar depresión leve"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="proxy-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Descripción
                    </label>
                    <textarea
                      id="proxy-description"
                      name="description"
                      rows={2}
                      placeholder="Base metodológica de este valor de proxy"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label
                        htmlFor="proxy-value"
                        className="block text-xs font-medium text-foreground"
                      >
                        Valor{' '}
                        <span className="text-danger" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <input
                        id="proxy-value"
                        name="value"
                        type="text"
                        required
                        placeholder="ej. 1200.00"
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="proxy-currency"
                        className="block text-xs font-medium text-foreground"
                      >
                        Moneda{' '}
                        <span className="text-danger" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <input
                        id="proxy-currency"
                        name="currency"
                        type="text"
                        required
                        placeholder="MXN"
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label
                        htmlFor="proxy-unit"
                        className="block text-xs font-medium text-foreground"
                      >
                        Unidad{' '}
                        <span className="text-danger" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <input
                        id="proxy-unit"
                        name="unit"
                        type="text"
                        required
                        placeholder="por persona por año"
                        className={INPUT_CLASS}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="proxy-year"
                        className="block text-xs font-medium text-foreground"
                      >
                        Año de referencia{' '}
                        <span className="text-danger" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <input
                        id="proxy-year"
                        name="referenceYear"
                        type="number"
                        required
                        placeholder={String(new Date().getFullYear())}
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label
                        htmlFor="proxy-confidence"
                        className="block text-xs font-medium text-foreground"
                      >
                        Confianza
                      </label>
                      <Select id="proxy-confidence" name="confidenceLevel" className="mt-1">
                        <option value="">Sin definir</option>
                        <option value="high">Alta</option>
                        <option value="medium">Media</option>
                        <option value="low">Baja</option>
                      </Select>
                    </div>
                    <div>
                      <label
                        htmlFor="proxy-risk"
                        className="block text-xs font-medium text-foreground"
                      >
                        Riesgo metodológico
                      </label>
                      <Select id="proxy-risk" name="methodologicalRisk" className="mt-1">
                        <option value="">Sin definir</option>
                        <option value="low">Bajo</option>
                        <option value="medium">Medio</option>
                        <option value="high">Alto</option>
                      </Select>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Crear proxy
                  </button>
                </form>
              </CardContent>
            </Card>

            {/* Assign Proxy to Outcome */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <GitMerge className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Asignar proxy a resultado</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Vincula un proxy financiero a un resultado del proyecto con una justificación
                  defendible y notas opcionales de ajuste territorial.
                </p>
              </CardHeader>
              <CardContent>
                <form action={handleAssignProxy} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />

                  <div>
                    <label
                      htmlFor="assign-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Resultado{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <Select id="assign-outcome" name="outcomeId" required className="mt-1">
                      <option value="">— Seleccionar resultado —</option>
                      {outcomes.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="assign-proxy"
                      className="block text-xs font-medium text-foreground"
                    >
                      Proxy financiero{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <Select id="assign-proxy" name="proxyId" required className="mt-1">
                      <option value="">— Seleccionar proxy —</option>
                      {financialProxies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.currency})
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="assign-justification"
                      className="block text-xs font-medium text-foreground"
                    >
                      Justificación{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <textarea
                      id="assign-justification"
                      name="justification"
                      rows={3}
                      required
                      placeholder="Explica por qué este proxy es metodológicamente apropiado para este resultado…"
                      className={TEXTAREA_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Se requiere una justificación escrita para una selección de proxy trazable para auditoría.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="assign-territorial"
                      className="block text-xs font-medium text-foreground"
                    >
                      Notas de ajuste territorial
                    </label>
                    <textarea
                      id="assign-territorial"
                      name="territorialAdjustmentNotes"
                      rows={2}
                      placeholder="Notas opcionales sobre ajustes geográficos o demográficos aplicados"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Asignar proxy
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      {/* Proxy Assignments */}
      <section aria-labelledby="assignments-heading">
        <h2
          id="assignments-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Asignaciones de proxies
        </h2>

        {assignments.length === 0 ? (
          <EmptyState
            icon={<GitMerge className="h-6 w-6 text-neutral-500" />}
            title="No hay asignaciones de proxies"
            description={
              canEdit
                ? 'Aún no se han asignado proxies a resultados. Usa el formulario de arriba para crear una asignación de proxy defendible con una justificación escrita.'
                : 'Aún no se han asignado proxies a resultados para este proyecto.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resultado</TableHead>
                <TableHead>Proxy</TableHead>
                <TableHead>Justificación</TableHead>
                <TableHead>Ajuste territorial</TableHead>
                <TableHead>Estado</TableHead>
                {canEdit && <TableHead>Acciones</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments.map((a) => {
                const outcomeName = outcomeById.get(a.outcomeId)
                const proxy = proxyById.get(a.proxyId)
                const statusKey = a.assignmentStatus ?? 'active'
                const statusConfig =
                  ASSIGNMENT_STATUS[statusKey] ?? {
                    variant: 'neutral' as const,
                    label: statusKey,
                  }

                return (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm font-medium text-foreground max-w-[150px]">
                      {outcomeName ? (
                        <span className="line-clamp-2">{outcomeName}</span>
                      ) : (
                        <span className="tabular-nums text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}>
                          {a.outcomeId.slice(0, 8)}…
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-foreground max-w-[150px]">
                      {proxy ? (
                        <span className="line-clamp-2">
                          {proxy.name}
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({proxy.currency})
                          </span>
                        </span>
                      ) : (
                        <span className="tabular-nums text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}>
                          {a.proxyId.slice(0, 8)}…
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                      <span className="line-clamp-3">{a.justification}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[160px]">
                      {a.territorialAdjustmentNotes ? (
                        <span className="line-clamp-2">{a.territorialAdjustmentNotes}</span>
                      ) : (
                        <span className="text-muted-foreground/50" aria-label="Sin notas de ajuste">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        {statusKey !== 'archived' && (
                          <form action={handleArchiveAssignment} className="inline-flex">
                            <input type="hidden" name="assignmentId" value={a.id} />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                              aria-label={`Archivar asignación de proxy para: ${outcomeName ?? a.outcomeId}`}
                            >
                              <Archive className="h-3 w-3" aria-hidden="true" />
                              Archivar
                            </button>
                          </form>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}
