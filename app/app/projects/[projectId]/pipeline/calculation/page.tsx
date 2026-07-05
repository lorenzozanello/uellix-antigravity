import Stepper from '@/components/sroi/Stepper'
import { PipelineStepHeader } from '@/components/sroi/PipelineStepHeader'
import { calculateSroiRunAction } from './calculateSroiRun.action'
import { upsertProjectInvestmentAction } from './upsertProjectInvestment.action'
import { upsertSroiAssignmentInputAction } from './upsertSroiAssignmentInput.action'
import { upsertSroiFilterSetAction } from './upsertSroiFilterSet.action'
import Link from 'next/link'
import { BarChart2, GitCompare, FileText, CheckCircle2, AlertTriangle, Info, Calculator } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'
import { ErrorState } from '@/components/states/ErrorState'
import { StellaAdvisorPanel, StellaValidatorPanel } from '@/components/stella'
import {
  listSroiCalculationRuns,
  getSroiCalculationReadiness,
  calculateSroiPreview,
} from '@/lib/pipeline/sroi-calculation'
import { listFundersForCurrentOrganization, FUNDER_TYPES } from '@/lib/pipeline/funders'
import { listAllocationsForProject, sumPct } from '@/lib/pipeline/allocations'
import { createFunderAction, addAllocationAction, archiveAllocationAction } from './funderAllocation.actions'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { db } from '@/db/client'
import {
  outcomeProxyAssignments,
  projectInvestments,
  sroiAssignmentInputs,
  sroiFilterSets,
  financialProxies,
  outcomes,
} from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export const dynamic = 'force-dynamic'

const RUN_STATUS: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  calculated: { variant: 'success', label: 'Calculado' },
  pending:    { variant: 'warning', label: 'Pendiente' },
  failed:     { variant: 'danger',  label: 'Fallido' },
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export default async function CalculationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const ctx = await requireOrganizationAccess()
  const canEdit = ctx && ['organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role)

  const readiness = await getSroiCalculationReadiness(projectId)

  // calculateSroiPreview only throws for genuine unexpected failures (e.g. a
  // race condition where the investment row disappears between the readiness
  // check and the calc). "Not ready yet" is a normal, non-throwing result
  // (`canCalculate: false`). We must not conflate the two — silently
  // swallowing a real error here would show an incomplete pipeline page with
  // no signal that anything went wrong, which is worse than surfacing it.
  let preview: Awaited<ReturnType<typeof calculateSroiPreview>> | null = null
  let previewError: string | null = null
  try {
    preview = await calculateSroiPreview(projectId)
  } catch (err) {
    previewError = err instanceof Error ? err.message : 'Unknown error'
  }

  const runs      = await listSroiCalculationRuns(projectId)

  const investment = await db
    .select()
    .from(projectInvestments)
    .where(
      and(
        eq(projectInvestments.projectId, projectId),
        eq(projectInvestments.status, 'active')
      )
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)

  const assignmentsData = await db
    .select({
      assignment: outcomeProxyAssignments,
      outcome: outcomes,
      proxy: financialProxies,
    })
    .from(outcomeProxyAssignments)
    .innerJoin(outcomes, eq(outcomes.id, outcomeProxyAssignments.outcomeId))
    .innerJoin(financialProxies, eq(financialProxies.id, outcomeProxyAssignments.proxyId))
    .where(
      and(
        eq(outcomeProxyAssignments.projectId, projectId),
        eq(outcomeProxyAssignments.organizationId, ctx.organization.id),
        eq(outcomeProxyAssignments.assignmentStatus, 'active')
      )
    )

  const inputs = await db
    .select()
    .from(sroiAssignmentInputs)
    .where(eq(sroiAssignmentInputs.organizationId, ctx.organization.id))

  const filterSets = await db
    .select()
    .from(sroiFilterSets)
    .where(eq(sroiFilterSets.organizationId, ctx.organization.id))

  const inputMap     = new Map(inputs.map((i) => [i.assignmentId, i]))
  const filterSetMap = new Map(filterSets.map((f) => [f.assignmentId, f]))

  // Fase 1c — funders + funder↔outcome attribution.
  const fundersList = await listFundersForCurrentOrganization()
  const allocations = await listAllocationsForProject(projectId)
  // Outcomes that actually feed the calculation (unique, in assignment order).
  const calcOutcomes = Array.from(
    new Map(assignmentsData.map(({ outcome }) => [outcome.id, outcome])).values()
  )
  const allocationsByOutcome = new Map<string, typeof allocations>()
  for (const a of allocations) {
    const list = allocationsByOutcome.get(a.outcomeId) ?? []
    list.push(a)
    allocationsByOutcome.set(a.outcomeId, list)
  }

  // Lookup map for preview line items: assignmentId → display names
  const assignmentLookup = new Map(
    assignmentsData.map(({ assignment, outcome, proxy }) => [
      assignment.id,
      { outcomeName: outcome.title, proxyName: proxy.name },
    ])
  )

  // Server Actions — wiring unchanged
  async function handleUpsertInvestment(formData: FormData) {
    'use server'
    await upsertProjectInvestmentAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  async function handleUpsertAssignmentInput(formData: FormData) {
    'use server'
    await upsertSroiAssignmentInputAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  async function handleUpsertFilterSet(formData: FormData) {
    'use server'
    await upsertSroiFilterSetAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  async function handleCalculateRun(formData: FormData) {
    'use server'
    await calculateSroiRunAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  async function handleCreateFunder(formData: FormData) {
    'use server'
    await createFunderAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  async function handleAddAllocation(formData: FormData) {
    'use server'
    await addAllocationAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  async function handleArchiveAllocation(formData: FormData) {
    'use server'
    await archiveAllocationAction(formData)
    revalidatePath(`/app/projects/${projectId}/pipeline/calculation`)
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <PipelineStepHeader
        step={8}
        title="Cálculo SROI"
        description="Configura la inversión, asigna cantidades de impacto y filtros SROI, y luego genera una corrida de cálculo trazable."
        methodologyNote="Basado en los Principios 3–7 del Estándar SROI de Social Value International: valora lo que importa, incluye solo lo material, no sobreestimes los resultados."
      />

      <Stepper />

      {/* Quick navigation */}
      <section aria-label="Vistas relacionadas" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          href={`/app/projects/${projectId}/pipeline`}
          className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <Card className="h-full hover:shadow-md transition-shadow group-focus-visible:ring-2 group-focus-visible:ring-ring">
            <CardContent className="p-5 flex gap-3 items-start">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#FF6A00]/10 text-[#FF6A00]" aria-hidden="true">
                <BarChart2 className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">Pasos del pipeline</p>
                <p className="text-xs text-muted-foreground mt-0.5">Ver todas las etapas del pipeline SROI y el progreso actual</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link
          href={`/app/projects/${projectId}/pipeline/calculation/compare`}
          className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <Card className="h-full hover:shadow-md transition-shadow">
            <CardContent className="p-5 flex gap-3 items-start">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                <GitCompare className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">Comparar corridas</p>
                <p className="text-xs text-muted-foreground mt-0.5">Analiza diferencias entre dos corridas</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link
          href={`/app/projects/${projectId}/report`}
          className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <Card className="h-full hover:shadow-md transition-shadow">
            <CardContent className="p-5 flex gap-3 items-start">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">Reportes SROI</p>
                <p className="text-xs text-muted-foreground mt-0.5">Gestiona borradores de reporte vinculados a corridas</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </section>

      {/* Methodology notice */}
      <div className="flex gap-3 rounded-lg border border-border bg-muted/30 p-4" role="note">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            Este panel realiza un{' '}
            <strong className="font-semibold text-foreground">cálculo metodológico trazable</strong>{' '}
            del retorno social sobre la inversión (SROI).
          </p>
          <p>
            Los resultados representan un{' '}
            <strong className="font-semibold text-foreground">ratio SROI preliminar</strong>{' '}
            que requiere{' '}
            <strong className="font-semibold text-foreground">revisión humana</strong>{' '}
            antes de la validación final. Este resultado no constituye certificación ni auditoría independiente.
          </p>
        </div>
      </div>

      {/* Readiness */}
      <Card>
        <CardHeader>
          <CardTitle>Requisitos para el cálculo</CardTitle>
          <CardDescription>Requisitos mínimos para generar una corrida de cálculo SROI válida</CardDescription>
        </CardHeader>
        <CardContent>
          {readiness.canCalculate ? (
            <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-700" aria-hidden="true" />
              <div>
                <p className="font-semibold text-green-800">Listo para calcular</p>
                <p className="text-sm text-green-700 mt-0.5">
                  Todos los requisitos mínimos están completos. Ya puedes guardar una corrida de cálculo.
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-red-200 bg-red-50 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
                <p className="font-semibold text-red-800 text-sm">Requisitos faltantes para habilitar el cálculo:</p>
              </div>
              <ul className="space-y-1 pl-6 list-disc">
                {readiness.blockingReasons.map((reason, idx) => (
                  <li key={idx} className="text-sm text-red-700">{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <StellaAdvisorPanel projectId={projectId} step="Cálculo" highlightHint={!readiness.hasInvestment} />

      <StellaValidatorPanel projectId={projectId} step="Cálculo" />

      {/* Investment */}
      <Card>
        <CardHeader>
          <CardTitle>Inversión del proyecto</CardTitle>
          <CardDescription>
            Capital total invertido en el período de intervención. Se usa como denominador en el ratio SROI.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {investment && (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm space-y-1">
              <p>
                <span className="font-medium text-foreground">Monto actual:</span>{' '}
                <span className="text-foreground">{investment.amount} {investment.currency}</span>
              </p>
              <p>
                <span className="font-medium text-foreground">Equivalente USD:</span>{' '}
                {investment.amountUsd ? (
                  <span className="text-foreground tabular-nums">{parseFloat(investment.amountUsd).toLocaleString()} USD</span>
                ) : (
                  <span className="text-red-600">pendiente de conversión</span>
                )}
              </p>
              {investment.year && (
                <p>
                  <span className="font-medium text-foreground">Año de referencia:</span>{' '}
                  <span className="text-muted-foreground">{investment.year}</span>
                </p>
              )}
              {investment.description && (
                <p>
                  <span className="font-medium text-foreground">Notas:</span>{' '}
                  <span className="text-muted-foreground">{investment.description}</span>
                </p>
              )}
            </div>
          )}

          <form action={handleUpsertInvestment} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input type="hidden" name="projectId" value={projectId} />

            <div>
              <label htmlFor="inv-funder" className="block text-sm font-medium text-foreground">
                Financiador
              </label>
              <select
                id="inv-funder"
                name="funderId"
                disabled={!canEdit}
                defaultValue={investment?.funderId ?? ''}
                className={INPUT_CLASS}
              >
                <option value="">— Sin especificar —</option>
                {fundersList.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="inv-ctype" className="block text-sm font-medium text-foreground">
                Tipo de aporte
              </label>
              <select
                id="inv-ctype"
                name="contributionType"
                disabled={!canEdit}
                defaultValue={investment?.contributionType ?? 'cash'}
                className={INPUT_CLASS}
              >
                <option value="cash">Efectivo</option>
                <option value="in_kind">En especie</option>
              </select>
            </div>

            <div>
              <label htmlFor="inv-amount" className="block text-sm font-medium text-foreground">
                Monto de inversión <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <input
                id="inv-amount"
                name="amount"
                type="text"
                required
                disabled={!canEdit}
                defaultValue={investment?.amount ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="inv-currency" className="block text-sm font-medium text-foreground">
                Moneda <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <input
                id="inv-currency"
                name="currency"
                type="text"
                required
                disabled={!canEdit}
                defaultValue={investment?.currency ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="inv-year" className="block text-sm font-medium text-foreground">
                Año de referencia
                <span className="ml-1 text-xs text-muted-foreground font-normal">(opcional)</span>
              </label>
              <input
                id="inv-year"
                name="year"
                type="number"
                disabled={!canEdit}
                defaultValue={investment?.year ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="inv-description" className="block text-sm font-medium text-foreground">
                Notas
                <span className="ml-1 text-xs text-muted-foreground font-normal">(opcional)</span>
              </label>
              <input
                id="inv-description"
                name="description"
                type="text"
                disabled={!canEdit}
                defaultValue={investment?.description ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            {canEdit && (
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                >
                  Guardar inversión
                </button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Fase 1c — Funder attribution */}
      <Card>
        <CardHeader>
          <CardTitle>Atribución por financiador</CardTitle>
          <CardDescription>
            Asigna qué porcentaje del valor social de cada resultado corresponde a cada financiador.
            El remanente sin asignar queda como <strong className="text-foreground">valor no atribuido</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {canEdit && (
            <form action={handleCreateFunder} className="flex flex-wrap items-end gap-3 border-b border-border pb-4">
              <div className="flex-1 min-w-[180px]">
                <label htmlFor="new-funder-name" className="block text-xs font-medium text-foreground">Nuevo financiador</label>
                <input id="new-funder-name" name="name" type="text" placeholder="Nombre del financiador" className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="new-funder-type" className="block text-xs font-medium text-foreground">Tipo</label>
                <select id="new-funder-type" name="funderType" defaultValue="foundation" className={INPUT_CLASS}>
                  {FUNDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <button type="submit" className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
                Agregar financiador
              </button>
            </form>
          )}

          {calcOutcomes.length === 0 ? (
            <EmptyState
              title="No hay resultados en el cálculo"
              description="Asigna proxies a resultados para poder atribuir su valor social a financiadores."
            />
          ) : (
            <div className="space-y-4">
              {calcOutcomes.map((outcome) => {
                const outcomeAllocs = allocationsByOutcome.get(outcome.id) ?? []
                const allocated = sumPct(outcomeAllocs.map((a) => String(a.allocationPct)))
                const remaining = (100 - parseFloat(allocated)).toFixed(2)
                return (
                  <div key={outcome.id} className="rounded-md border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-sm text-foreground">{outcome.title}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Atribuido {allocated}% · Disponible {remaining}%
                      </p>
                    </div>

                    {outcomeAllocs.length > 0 && (
                      <ul className="space-y-1">
                        {outcomeAllocs.map((a) => (
                          <li key={a.id} className="flex items-center justify-between text-sm">
                            <span className="text-foreground">{a.funderName} — <span className="tabular-nums">{a.allocationPct}%</span></span>
                            {canEdit && (
                              <form action={handleArchiveAllocation}>
                                <input type="hidden" name="projectId" value={projectId} />
                                <input type="hidden" name="allocationId" value={a.id} />
                                <button type="submit" className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors">Quitar</button>
                              </form>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {canEdit && fundersList.length > 0 && parseFloat(remaining) > 0 && (
                      <form action={handleAddAllocation} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="outcomeId" value={outcome.id} />
                        <div className="flex-1 min-w-[160px]">
                          <label htmlFor={`alloc-funder-${outcome.id}`} className="block text-[10px] font-medium text-muted-foreground">Financiador</label>
                          <select id={`alloc-funder-${outcome.id}`} name="funderId" className={INPUT_CLASS}>
                            {fundersList.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                        </div>
                        <div className="w-24">
                          <label htmlFor={`alloc-pct-${outcome.id}`} className="block text-[10px] font-medium text-muted-foreground">%</label>
                          <input id={`alloc-pct-${outcome.id}`} name="allocationPct" type="text" placeholder="0" className={INPUT_CLASS} />
                        </div>
                        <button type="submit" className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">Atribuir</button>
                      </form>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Assignment Inputs & SROI Filters */}
      <section aria-labelledby="assignments-heading">
        <h2
          id="assignments-heading"
          className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Insumos de asignación y filtros SROI
        </h2>

        {assignmentsData.length === 0 ? (
          <EmptyState
            title="No hay asignaciones de proxies activas"
            description="Asigna proxies financieros a resultados en el paso de Proxies antes de configurar insumos y filtros."
          />
        ) : (
          <div className="space-y-4">
            {assignmentsData.map(({ assignment, outcome, proxy }) => {
              const currentInput  = inputMap.get(assignment.id)
              const currentFilter = filterSetMap.get(assignment.id)

              return (
                <Card key={assignment.id}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-foreground">{outcome.title}</CardTitle>
                    <CardDescription>
                      Proxy: <strong className="text-foreground">{proxy.name}</strong>
                      {' '}— {proxy.value} {proxy.currency} / {proxy.unit}
                    </CardDescription>
                  </CardHeader>

                  <CardContent>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Quantities & Inputs */}
                      <form action={handleUpsertAssignmentInput} className="space-y-3">
                        <p className="text-sm font-semibold text-foreground">Cantidades e insumos</p>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label
                              htmlFor={`qty-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Cantidad <span className="text-red-500" aria-hidden="true">*</span>
                            </label>
                            <input
                              id={`qty-${assignment.id}`}
                              name="quantity"
                              type="text"
                              required
                              disabled={!canEdit}
                              defaultValue={currentInput?.quantity ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`unit-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Unidad <span className="text-red-500" aria-hidden="true">*</span>
                            </label>
                            <input
                              id={`unit-${assignment.id}`}
                              name="unit"
                              type="text"
                              required
                              disabled={!canEdit}
                              defaultValue={currentInput?.unit ?? proxy.unit ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`inp-year-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Año
                              <span className="ml-1 text-[10px] text-muted-foreground font-normal">(opcional)</span>
                            </label>
                            <input
                              id={`inp-year-${assignment.id}`}
                              name="year"
                              type="number"
                              disabled={!canEdit}
                              defaultValue={currentInput?.year ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`inp-notes-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Notas
                              <span className="ml-1 text-[10px] text-muted-foreground font-normal">(opcional)</span>
                            </label>
                            <input
                              id={`inp-notes-${assignment.id}`}
                              name="notes"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentInput?.notes ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                        </div>

                        {canEdit && (
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                          >
                            Guardar insumos
                          </button>
                        )}
                      </form>

                      {/* SROI Filters */}
                      <form action={handleUpsertFilterSet} className="space-y-3">
                        <p className="text-sm font-semibold text-foreground">Filtros de impacto SROI</p>
                        <p className="text-xs text-muted-foreground">
                          Ajustes porcentuales que reflejan supuestos metodológicos sobre atribución de impacto.
                        </p>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label
                              htmlFor={`dw-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Deadweight %
                            </label>
                            <input
                              id={`dw-${assignment.id}`}
                              name="deadweightPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.deadweightPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % que habría ocurrido sin la intervención
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`at-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Atribución %
                            </label>
                            <input
                              id={`at-${assignment.id}`}
                              name="attributionPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.attributionPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % atribuible a otros actores
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`dp-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Desplazamiento %
                            </label>
                            <input
                              id={`dp-${assignment.id}`}
                              name="displacementPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.displacementPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % de efectos positivos desplazados a otro lugar
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`do-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Decaimiento %
                            </label>
                            <input
                              id={`do-${assignment.id}`}
                              name="dropoffPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.dropoffPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % de reducción anual del impacto después del año 1
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`dur-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Duración (años)
                            </label>
                            <input
                              id={`dur-${assignment.id}`}
                              name="durationYears"
                              type="number"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.durationYears ?? 1}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`just-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Justificación
                              <span className="ml-1 text-[10px] text-muted-foreground font-normal">(opcional)</span>
                            </label>
                            <input
                              id={`just-${assignment.id}`}
                              name="justification"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.justification ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                        </div>

                        {canEdit && (
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                          >
                            Guardar filtros
                          </button>
                        )}
                      </form>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* Preview calculation error — distinct from "not ready yet" */}
      {previewError && (
        <ErrorState
          title="Falló el cálculo de vista previa"
          message="Algo salió mal al generar el cálculo de vista previa. Esto no afecta tus datos guardados — intenta refrescar la página."
          details={previewError}
        />
      )}

      {/* Preview Results */}
      {preview?.canCalculate && preview.result && (
        <Card>
          <CardHeader>
            <CardTitle>Resultados de vista previa</CardTitle>
            <CardDescription>
              Cálculo preliminar basado en los insumos actuales. Requiere revisión humana antes de usarse en reportes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* KPI summary */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Ratio SROI preliminar</p>
                <p className="mt-1 text-2xl font-bold text-foreground tabular-nums font-ibm-plex-mono">
                  {parseFloat(preview.result.sroiRatio.toString()).toFixed(2)}:1
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Valor social neto</p>
                <p className="mt-1 text-xl font-bold text-foreground">
                  {parseFloat(preview.result.netSocialValue.toString()).toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{preview.result.currency}</span>
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Valor social bruto</p>
                <p className="mt-1 text-xl font-bold text-foreground">
                  {parseFloat(preview.result.grossSocialValue.toString()).toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{preview.result.currency}</span>
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Inversión total</p>
                <p className="mt-1 text-xl font-bold text-foreground">
                  {parseFloat(preview.result.totalInvestment.toString()).toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{preview.result.currency}</span>
                </p>
              </div>
            </div>

            {/* Line items breakdown */}
            <div>
              <h3 className="mb-3 text-sm font-semibold text-foreground">Detalle del cálculo</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Resultado / Proxy</TableHead>
                    <TableHead className="text-right">Cantidad</TableHead>
                    <TableHead className="text-right">Valor de proxy</TableHead>
                    <TableHead className="text-right">Bruto</TableHead>
                    <TableHead className="text-right">Ajustado (neto)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.result.lineItems.map((li, idx) => {
                    const info = assignmentLookup.get(li.assignmentId)
                    return (
                      <TableRow key={idx}>
                        <TableCell>
                          <p className="font-medium text-foreground text-sm">
                            {info?.outcomeName ?? `Asignación ${li.assignmentId.slice(0, 8)}…`}
                          </p>
                          {info?.proxyName && (
                            <p className="text-xs text-muted-foreground">{info.proxyName}</p>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            DW {li.deadweightPct}% · AT {li.attributionPct}% · DP {li.displacementPct}% · DO {li.dropoffPct}% · {li.durationYears}yr
                          </p>
                        </TableCell>
                        <TableCell className="text-right">{li.quantity}</TableCell>
                        <TableCell className="text-right">
                          {li.proxyValue.toLocaleString()} {li.currency}
                        </TableCell>
                        <TableCell className="text-right">
                          {li.grossValue.toLocaleString()} {li.currency}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-foreground">
                          {li.adjustedValue.toLocaleString()} {li.currency}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Per-funder breakdown */}
            {preview.result.fundersBreakdown && preview.result.fundersBreakdown.length > 0 && (
              <div>
                <h3 className="mb-3 text-sm font-semibold text-foreground">Desglose por financiador (USD)</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Financiador</TableHead>
                      <TableHead className="text-right">Inversión</TableHead>
                      <TableHead className="text-right">Valor atribuido</TableHead>
                      <TableHead className="text-right">Ratio SROI</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.result.fundersBreakdown.map((f) => (
                      <TableRow key={f.funderId}>
                        <TableCell className="font-medium text-foreground">{f.funderName || '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{parseFloat(f.investmentUsd).toLocaleString()} USD</TableCell>
                        <TableCell className="text-right tabular-nums">{parseFloat(f.attributedNsvUsd).toLocaleString()} USD</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums font-ibm-plex-mono">{parseFloat(f.sroiRatio).toFixed(2)}:1</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-2 text-xs text-muted-foreground">
                  Valor social no atribuido:{' '}
                  <span className="font-medium text-foreground tabular-nums">
                    {parseFloat(preview.result.unattributedNsvUsd).toLocaleString()} USD
                  </span>
                </p>
              </div>
            )}

            {/* Register run */}
            {canEdit && (
              <div className="border-t border-border pt-4">
                <p className="text-xs text-muted-foreground mb-3">
                  Registrar una corrida persiste el cálculo actual con su trazabilidad de auditoría completa. Esto no se puede deshacer.
                </p>
                <form action={handleCalculateRun}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors shadow-sm"
                  >
                    <Calculator className="h-4 w-4" aria-hidden="true" />
                    Guardar corrida de cálculo
                  </button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Run History */}
      <Card>
        <CardHeader>
          <CardTitle>Historial de corridas de cálculo</CardTitle>
          <CardDescription>
            Todas las corridas de cálculo SROI registradas para este proyecto. Cada corrida es inmutable y trazable para auditoría.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyState
              title="Aún no hay corridas de cálculo"
              description="Completa la inversión y los insumos de asignación de arriba, luego guarda tu primera corrida de cálculo."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Versión</TableHead>
                  <TableHead>Fecha</TableHead>
                  <TableHead className="text-right">Inversión</TableHead>
                  <TableHead className="text-right">Valor bruto</TableHead>
                  <TableHead className="text-right">Valor neto</TableHead>
                  <TableHead className="text-right">Ratio SROI</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const statusConfig = RUN_STATUS[run.status] ?? { variant: 'neutral' as const, label: run.status }
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="font-medium">v{run.version}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(run.createdAt).toLocaleString('es-MX', {
                          year: 'numeric', month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </TableCell>
                      <TableCell className="text-right">
                        {run.totalInvestment ? parseFloat(run.totalInvestment).toLocaleString() : '0'}{' '}
                        <span className="text-xs text-muted-foreground">{run.currency}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {run.grossSocialValue ? parseFloat(run.grossSocialValue).toLocaleString() : '0'}{' '}
                        <span className="text-xs text-muted-foreground">{run.currency}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {run.netSocialValue ? parseFloat(run.netSocialValue).toLocaleString() : '0'}{' '}
                        <span className="text-xs text-muted-foreground">{run.currency}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="font-bold text-foreground tabular-nums font-ibm-plex-mono">
                          {run.sroiRatio ? parseFloat(run.sroiRatio).toFixed(2) : '0.00'}:1
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/app/projects/${projectId}/pipeline/calculation/runs/${run.id}`}
                          className="text-xs font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                          aria-label={`Ver detalles de la corrida v${run.version}`}
                        >
                          Ver →
                        </Link>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
