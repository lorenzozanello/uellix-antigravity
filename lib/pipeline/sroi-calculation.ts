// lib/pipeline/sroi-calculation.ts
// Sprint 6B – Deterministic SROI Calculation Engine
// No mocks. No placeholders. No FX conversion. No AI/Stella.

import { eq, and, inArray, sql } from 'drizzle-orm'
import Decimal from 'decimal.js'
import { db } from '@/db/client'
import { z } from 'zod'
import {
  projectInvestments,
  sroiAssignmentInputs,
  sroiFilterSets,
  sroiCalculationRuns,
  sroiCalculationLineItems,
  outcomeProxyAssignments,
  financialProxies,
  outcomes,
  projects,
  evidenceItems,
  outcomeFunderAllocations,
  funders,
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction } from '@/lib/audit/logger'
import { computeFundersBreakdown, type FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'
import { getOrCreateSharedCopRate, convertToUsd } from '@/lib/pipeline/fx'
import { getOrCreatePlaceholderFunder } from '@/lib/pipeline/funders'
import { scenarioFilterPct, SCENARIO_DELTA_PP, type Scenario } from '@/lib/pipeline/sroi-sensitivity'

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const ProjectInvestmentSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  year: z.number().int().optional(),
  description: z.string().optional(),
  // Fase 1b — optional here so the existing single-investment form keeps
  // working; funder defaults to the org's placeholder, type defaults to cash.
  funderId: z.string().uuid().optional(),
  contributionType: z.enum(['cash', 'in_kind']).optional(),
  inKindValuationNotes: z.string().optional(),
})
export type ProjectInvestmentInput = z.infer<typeof ProjectInvestmentSchema>

export const AssignmentInputSchema = z.object({
  quantity: z.string().min(1),
  unit: z.string().min(1),
  year: z.number().int().optional(),
  notes: z.string().optional(),
})
export type AssignmentInput = z.infer<typeof AssignmentInputSchema>

export const FilterSetSchema = z.object({
  deadweightPct: z.string().optional(),
  displacementPct: z.string().optional(),
  attributionPct: z.string().optional(),
  dropoffPct: z.string().optional(),
  durationYears: z.number().int().optional(),
  justification: z.string().optional(),
})
export type FilterSetInput = z.infer<typeof FilterSetSchema>

// ─── Internal helpers ───────────────────────────────────────────────────────

async function authorize(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .limit(1)
  if (proj.length === 0) throw new Error('Project not found or not owned')
  if (!hasRole(ctx.membership.role as Role, 'analyst')) throw new Error('Insufficient role')
  return ctx
}

function parseNum(val: string | null | undefined): number {
  if (!val) return 0
  const n = parseFloat(val)
  return isNaN(n) ? 0 : n
}

function clamp(val: number, lo: number, hi: number) {
  return Math.min(Math.max(val, lo), hi)
}

// ─── Investment ─────────────────────────────────────────────────────────────

// Resolve the frozen USD equivalent of a contribution at save time.
// USD passes through; COP auto-fetches the TRM (Dec 31 of `year`, or today);
// any other currency needs a manual rate (1c UI) and is left null here, which
// the readiness check surfaces as a blocker.
async function resolveAmountUsd(
  amount: string,
  currency: string,
  year: number | undefined,
): Promise<{ amountUsd: string | null; fxRateId: string | null }> {
  if (currency === 'USD') return { amountUsd: amount, fxRateId: null }
  if (currency === 'COP') {
    const date = year ? `${year}-12-31` : new Date().toISOString().slice(0, 10)
    const rate = await getOrCreateSharedCopRate(date)
    if (!rate?.rateToUsd) return { amountUsd: null, fxRateId: null }
    return { amountUsd: convertToUsd(amount, rate.rateToUsd), fxRateId: rate.id }
  }
  return { amountUsd: null, fxRateId: null }
}

export async function upsertProjectInvestment(projectId: string, input: ProjectInvestmentInput) {
  const ctx = await authorize(projectId)
  const validated = ProjectInvestmentSchema.parse(input)

  // Every investment must carry a funder — default to the org's placeholder.
  const funderId =
    validated.funderId ?? (await getOrCreatePlaceholderFunder(ctx.organization.id, ctx.user.id)).id
  const contributionType = validated.contributionType ?? 'cash'
  const { amountUsd, fxRateId } = await resolveAmountUsd(validated.amount, validated.currency, validated.year)

  const values = {
    amount: validated.amount,
    currency: validated.currency,
    year: validated.year,
    description: validated.description,
    funderId,
    contributionType,
    inKindValuationNotes: validated.inKindValuationNotes,
    amountUsd,
    fxRateId,
  }

  const existing = await db.select().from(projectInvestments).where(eq(projectInvestments.projectId, projectId))

  if (existing.length > 0) {
    await db.update(projectInvestments).set({ ...values, updatedAt: new Date() }).where(eq(projectInvestments.id, existing[0].id))
    const updated = await db.select().from(projectInvestments).where(eq(projectInvestments.id, existing[0].id))
    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project_investments',
      entityId: existing[0].id,
      action: 'project_investment.updated',
      afterJson: updated[0] as unknown as Record<string, unknown>,
    })
    return updated[0]
  }

  const inserted = await db.insert(projectInvestments).values({ ...values, projectId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'project_investments',
    entityId: inserted[0].id,
    action: 'project_investment.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

// ─── Project discount rate (Fase 1e) ─────────────────────────────────────────

export async function setProjectDiscountRate(projectId: string, discountRatePct: string | null) {
  const ctx = await authorize(projectId)
  let value: string | null = null
  if (discountRatePct !== null && discountRatePct !== '') {
    const n = parseFloat(discountRatePct)
    if (isNaN(n) || n < 0 || n > 100) throw new Error('La tasa de descuento debe estar entre 0 y 100%')
    value = String(n)
  }
  await db
    .update(projects)
    .set({ discountRatePct: value, updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: 'project.discount_rate_updated',
    afterJson: { discountRatePct: value },
  })
  return { discountRatePct: value }
}

// ─── Assignment Input ────────────────────────────────────────────────────────

export async function upsertSroiAssignmentInput(projectId: string, assignmentId: string, input: AssignmentInput) {
  const ctx = await authorize(projectId)
  const assign = await db.select().from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.id, assignmentId), eq(outcomeProxyAssignments.projectId, projectId)))
  if (assign.length === 0) throw new Error('Assignment not found for project')
  const validated = AssignmentInputSchema.parse(input)
  const existing = await db.select().from(sroiAssignmentInputs).where(eq(sroiAssignmentInputs.assignmentId, assignmentId))

  if (existing.length > 0) {
    await db.update(sroiAssignmentInputs).set({ ...validated, updatedAt: new Date() }).where(eq(sroiAssignmentInputs.id, existing[0].id))
    const updated = await db.select().from(sroiAssignmentInputs).where(eq(sroiAssignmentInputs.id, existing[0].id))
    await logAuditAction({ organizationId: ctx.organization.id, actorUserId: ctx.user.id, entityType: 'sroi_assignment_inputs', entityId: existing[0].id, action: 'sroi_assignment_input.updated', afterJson: updated[0] as unknown as Record<string, unknown> })
    return updated[0]
  }

  const inserted = await db.insert(sroiAssignmentInputs).values({ ...validated, assignmentId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
  await logAuditAction({ organizationId: ctx.organization.id, actorUserId: ctx.user.id, entityType: 'sroi_assignment_inputs', entityId: inserted[0].id, action: 'sroi_assignment_input.created', afterJson: inserted[0] as unknown as Record<string, unknown> })
  return inserted[0]
}

// ─── Filter Set ──────────────────────────────────────────────────────────────

export async function upsertSroiFilterSet(projectId: string, assignmentId: string, input: FilterSetInput) {
  const ctx = await authorize(projectId)
  const assign = await db.select().from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.id, assignmentId), eq(outcomeProxyAssignments.projectId, projectId)))
  if (assign.length === 0) throw new Error('Assignment not found for project')
  const validated = FilterSetSchema.parse(input)
  const existing = await db.select().from(sroiFilterSets).where(and(eq(sroiFilterSets.assignmentId, assignmentId), eq(sroiFilterSets.organizationId, ctx.organization.id)))

  if (existing.length > 0) {
    await db.update(sroiFilterSets).set({ ...validated, updatedAt: new Date() }).where(eq(sroiFilterSets.id, existing[0].id))
    const updated = await db.select().from(sroiFilterSets).where(eq(sroiFilterSets.id, existing[0].id))
    await logAuditAction({ organizationId: ctx.organization.id, actorUserId: ctx.user.id, entityType: 'sroi_filter_sets', entityId: existing[0].id, action: 'sroi_filter_set.updated', afterJson: updated[0] as unknown as Record<string, unknown> })
    return updated[0]
  }

  const inserted = await db.insert(sroiFilterSets).values({ ...validated, assignmentId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
  await logAuditAction({ organizationId: ctx.organization.id, actorUserId: ctx.user.id, entityType: 'sroi_filter_sets', entityId: inserted[0].id, action: 'sroi_filter_set.created', afterJson: inserted[0] as unknown as Record<string, unknown> })
  return inserted[0]
}

// ─── Internal data loader for calculation ───────────────────────────────────

interface AssignmentData {
  assignment: typeof outcomeProxyAssignments.$inferSelect
  input: typeof sroiAssignmentInputs.$inferSelect
  filterSet: typeof sroiFilterSets.$inferSelect
  proxy: typeof financialProxies.$inferSelect
  outcome: typeof outcomes.$inferSelect
}

async function loadCalculationData(projectId: string, orgId: string): Promise<{
  investments: (typeof projectInvestments.$inferSelect)[]
  assignmentData: AssignmentData[]
  allocations: (typeof outcomeFunderAllocations.$inferSelect)[]
  fundersList: (typeof funders.$inferSelect)[]
  discountRatePct: string | null
}> {
  // Load ALL active investment contributions (Fase 1b — a project can have many).
  const investments = await db
    .select()
    .from(projectInvestments)
    .where(and(eq(projectInvestments.projectId, projectId), eq(projectInvestments.organizationId, orgId), eq(projectInvestments.status, 'active')))

  // Fase 1e — project-level annual discount rate (NULL = no discounting).
  const projRow = await db
    .select({ discountRatePct: projects.discountRatePct })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
    .then(r => r[0])
  const discountRatePct = projRow?.discountRatePct ?? null

  // Load active assignments
  const assignments = await db
    .select()
    .from(outcomeProxyAssignments)
    .where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, orgId), eq(outcomeProxyAssignments.assignmentStatus, 'active')))

  if (assignments.length === 0) return { investments, assignmentData: [], allocations: [], fundersList: [], discountRatePct }

  const assignmentIds = assignments.map(a => a.id)
  const proxyIds = assignments.map(a => a.proxyId)
  const outcomeIds = assignments.map(a => a.outcomeId)

  // Load all related data in parallel
  const [inputs, filters, proxiesRows, outcomesRows] = await Promise.all([
    db.select().from(sroiAssignmentInputs).where(and(inArray(sroiAssignmentInputs.assignmentId, assignmentIds), eq(sroiAssignmentInputs.organizationId, orgId))),
    db.select().from(sroiFilterSets).where(and(inArray(sroiFilterSets.assignmentId, assignmentIds), eq(sroiFilterSets.organizationId, orgId))),
    db.select().from(financialProxies).where(inArray(financialProxies.id, proxyIds)),
    db.select().from(outcomes).where(and(inArray(outcomes.id, outcomeIds), eq(outcomes.projectId, projectId))),
  ])

  const inputByAssignment = new Map(inputs.map(i => [i.assignmentId, i]))
  const filterByAssignment = new Map(filters.map(f => [f.assignmentId, f]))
  const proxyById = new Map(proxiesRows.map(p => [p.id, p]))
  const outcomeById = new Map(outcomesRows.map(o => [o.id, o]))

  const assignmentData: AssignmentData[] = []
  for (const a of assignments) {
    const input = inputByAssignment.get(a.id)
    const filterSet = filterByAssignment.get(a.id)
    const proxy = proxyById.get(a.proxyId)
    const outcome = outcomeById.get(a.outcomeId)
    if (input && filterSet && proxy && outcome) {
      assignmentData.push({ assignment: a, input, filterSet, proxy, outcome })
    }
  }

  // Funder attribution: only outcomes that actually feed the calculation matter.
  const calcOutcomeIds = [...new Set(assignmentData.map(d => d.assignment.outcomeId))]
  const allocations = calcOutcomeIds.length > 0
    ? await db.select().from(outcomeFunderAllocations).where(and(eq(outcomeFunderAllocations.organizationId, orgId), inArray(outcomeFunderAllocations.outcomeId, calcOutcomeIds), eq(outcomeFunderAllocations.status, 'active')))
    : []

  const funderIds = [...new Set([...investments.map(i => i.funderId), ...allocations.map(a => a.funderId)])]
  const fundersList = funderIds.length > 0
    ? await db.select().from(funders).where(inArray(funders.id, funderIds))
    : []

  return { investments, assignmentData, allocations, fundersList, discountRatePct }
}

// ─── Readiness ───────────────────────────────────────────────────────────────

export interface ReadinessIssue {
  type: 'error' | 'warning'
  messageKey: string
  message: string
  itemIds?: string[]
  actionPath?: string
  actionLabel?: string
}

export interface SroiReadiness {
  hasInvestment: boolean
  zeroOrInvalidInvestment: boolean
  activeAssignmentsCount: number
  missingInputs: string[]
  missingFilterSets: string[]
  unapprovedProxies: string[]
  currencyMismatch: boolean
  invalidQuantities: string[]
  invalidFilters: string[]
  investmentsMissingUsd: string[]
  proxiesMissingUsd: string[]
  overAllocatedOutcomes: string[]
  outcomesWithoutEvidence: string[]
  canCalculate: boolean
  blockingReasons: string[]
  issues: ReadinessIssue[]
}

export async function getSroiCalculationReadiness(projectId: string): Promise<SroiReadiness> {
  const ctx = await authorize(projectId)
  const { investments, allocations } = await loadCalculationData(projectId, ctx.organization.id)

  const blockingReasons: string[] = []

  // Investment: at least one active contribution with amount > 0.
  const hasInvestment = investments.length > 0
  const zeroOrInvalidInvestment = !hasInvestment || investments.some(i => parseNum(i.amount) <= 0)
  if (!hasInvestment) blockingReasons.push('Missing project investment')
  if (zeroOrInvalidInvestment && hasInvestment) blockingReasons.push('Investment amount must be > 0')

  // Every active contribution must resolve to USD (frozen at save time).
  const investmentsMissingUsd = investments.filter(i => i.amountUsd === null || i.amountUsd === undefined).map(i => i.id)
  if (investmentsMissingUsd.length > 0) blockingReasons.push(`Falta conversión a USD para ${investmentsMissingUsd.length} aporte(s)`)

  // Load active assignments count (total, not just those with all data)
  const allAssignments = await db.select().from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, ctx.organization.id), eq(outcomeProxyAssignments.assignmentStatus, 'active')))
  if (allAssignments.length === 0) blockingReasons.push('No active proxy assignments')

  const assignmentIds = allAssignments.map(a => a.id)
  const proxyIds = allAssignments.map(a => a.proxyId)

  const [inputs, filters, proxiesRows] = await Promise.all([
    assignmentIds.length > 0 ? db.select().from(sroiAssignmentInputs).where(and(inArray(sroiAssignmentInputs.assignmentId, assignmentIds), eq(sroiAssignmentInputs.organizationId, ctx.organization.id))) : Promise.resolve([]),
    assignmentIds.length > 0 ? db.select().from(sroiFilterSets).where(and(inArray(sroiFilterSets.assignmentId, assignmentIds), eq(sroiFilterSets.organizationId, ctx.organization.id))) : Promise.resolve([]),
    proxyIds.length > 0 ? db.select().from(financialProxies).where(inArray(financialProxies.id, proxyIds)) : Promise.resolve([]),
  ])

  const inputByAssignment = new Map(inputs.map(i => [i.assignmentId, i]))
  const filterByAssignment = new Map(filters.map(f => [f.assignmentId, f]))
  const proxyById = new Map(proxiesRows.map(p => [p.id, p]))

  const missingInputs: string[] = []
  const missingFilterSets: string[] = []
  const unapprovedProxies: string[] = []
  const invalidQuantities: string[] = []
  const invalidFilters: string[] = []
  const proxiesMissingUsd: string[] = []

  for (const a of allAssignments) {
    const input = inputByAssignment.get(a.id)
    const filterSet = filterByAssignment.get(a.id)
    const proxy = proxyById.get(a.proxyId)

    if (!input) missingInputs.push(a.id)
    if (!filterSet) missingFilterSets.push(a.id)
    if (!proxy || proxy.reviewStatus !== 'approved') unapprovedProxies.push(a.proxyId)

    if (input && parseNum(input.quantity) <= 0) invalidQuantities.push(a.id)
    if (proxy?.value && parseNum(proxy.value) <= 0) invalidQuantities.push(`proxy:${proxy.id}`)
    // Approved proxies must resolve to USD (the calc uses value_usd).
    if (proxy && proxy.reviewStatus === 'approved' && (proxy.valueUsd === null || proxy.valueUsd === undefined)) proxiesMissingUsd.push(proxy.id)

    if (filterSet) {
      const duration = filterSet.durationYears ?? 1
      if (duration < 1 || duration > 50) invalidFilters.push(a.id)
      for (const pct of [filterSet.deadweightPct, filterSet.displacementPct, filterSet.attributionPct, filterSet.dropoffPct]) {
        if (pct !== null && pct !== undefined) {
          const v = parseNum(pct)
          if (v < 0 || v > 100) invalidFilters.push(a.id)
        }
      }
    }
  }

  // Funder attribution per outcome must not exceed 100% (defensive re-check;
  // also enforced on write). Legitimately may be < 100% — that's unattributed.
  const allocByOutcome = new Map<string, number>()
  for (const alloc of allocations) {
    allocByOutcome.set(alloc.outcomeId, (allocByOutcome.get(alloc.outcomeId) ?? 0) + parseNum(alloc.allocationPct))
  }
  const overAllocatedOutcomes = [...allocByOutcome.entries()].filter(([, sum]) => sum > 100).map(([oid]) => oid)

  if (missingInputs.length > 0) blockingReasons.push(`Missing inputs for ${missingInputs.length} assignment(s)`)
  if (missingFilterSets.length > 0) blockingReasons.push(`Missing filter sets for ${missingFilterSets.length} assignment(s)`)
  if (unapprovedProxies.length > 0) blockingReasons.push(`${unapprovedProxies.length} unapproved proxy(ies)`)
  if (invalidQuantities.length > 0) blockingReasons.push(`Invalid quantities in ${invalidQuantities.length} item(s)`)
  if (invalidFilters.length > 0) blockingReasons.push(`Invalid filter values in ${invalidFilters.length} assignment(s)`)
  if (proxiesMissingUsd.length > 0) blockingReasons.push(`Falta conversión a USD para ${proxiesMissingUsd.length} proxy(ies)`)
  if (overAllocatedOutcomes.length > 0) blockingReasons.push(`${overAllocatedOutcomes.length} resultado(s) con atribución de financiadores > 100%`)

  // Evidence gate — every outcome that feeds the calculation must be backed by
  // at least one non-archived, non-rejected evidence item. This enforces the
  // fuente → evidencia → proxy → cálculo chain: an assignment cannot contribute
  // social value if the outcome it monetises has no supporting evidence.
  const activeOutcomeIds = [...new Set(allAssignments.map(a => a.outcomeId))]
  const outcomesWithoutEvidence: string[] = []
  if (activeOutcomeIds.length > 0) {
    const evidenceRows = await db
      .select({ outcomeId: evidenceItems.outcomeId })
      .from(evidenceItems)
      .where(and(
        eq(evidenceItems.projectId, projectId),
        inArray(evidenceItems.outcomeId, activeOutcomeIds),
        inArray(evidenceItems.status, ['draft', 'under_review', 'approved']),
      ))
    const outcomesWithEvidence = new Set(evidenceRows.map(e => e.outcomeId))
    for (const outcomeId of activeOutcomeIds) {
      if (!outcomesWithEvidence.has(outcomeId)) outcomesWithoutEvidence.push(outcomeId)
    }
  }
  if (outcomesWithoutEvidence.length > 0) {
    blockingReasons.push(`${outcomesWithoutEvidence.length} outcome(s) with no supporting evidence`)
  }

  // Mixed currencies no longer block — everything is normalized to USD before
  // the ratio math (Fase 1b). Field kept (always false) for API compatibility.
  const currencyMismatch = false

  const canCalculate = blockingReasons.length === 0

  // Build detailed issues with actionable information
  const issues: ReadinessIssue[] = []

  if (!hasInvestment) {
    issues.push({
      type: 'error',
      messageKey: 'missing_investment',
      message: 'El proyecto requiere al menos una inversión. Agrega un aporte en la sección "Inversión del proyecto".',
      actionPath: `#investment`,
      actionLabel: 'Ir a inversiones',
    })
  }

  if (zeroOrInvalidInvestment && hasInvestment) {
    issues.push({
      type: 'error',
      messageKey: 'invalid_investment_amount',
      message: `El monto de la inversión debe ser mayor a 0. Revisa y actualiza los aportes.`,
      itemIds: investments.filter(i => parseNum(i.amount) <= 0).map(i => i.id),
      actionPath: `#investment`,
      actionLabel: 'Ir a inversiones',
    })
  }

  if (investmentsMissingUsd.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'investments_missing_usd',
      message: `${investmentsMissingUsd.length} aporte(s) falta(n) conversión a USD. Verifica que las inversiones en monedas no-USD tengan tipos de cambio válidos.`,
      itemIds: investmentsMissingUsd,
      actionPath: `#investment`,
      actionLabel: 'Revisar aportes',
    })
  }

  if (allAssignments.length === 0) {
    issues.push({
      type: 'error',
      messageKey: 'no_proxy_assignments',
      message: 'No hay asignaciones de proxy activas. Define resultados (outcomes) y vincula proxies financieros en el paso anterior.',
      actionPath: `/app/projects/${projectId}/pipeline/evidence`,
      actionLabel: 'Ir a evidencia',
    })
  }

  if (missingInputs.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'missing_inputs',
      message: `${missingInputs.length} asignación(es) falta(n) información de cantidad. Define la cantidad de beneficiarios o unidades para cada resultado.`,
      itemIds: missingInputs,
      actionPath: `#sroi-inputs`,
      actionLabel: 'Completar información',
    })
  }

  if (missingFilterSets.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'missing_filter_sets',
      message: `${missingFilterSets.length} asignación(es) falta(n) filtros SROI (deadweight, displacement, etc). Define los supuestos metodológicos para cada resultado.`,
      itemIds: missingFilterSets,
      actionPath: `#sroi-filters`,
      actionLabel: 'Configurar filtros',
    })
  }

  if (unapprovedProxies.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'unapproved_proxies',
      message: `${unapprovedProxies.length} proxy(ies) no aprobado(s). Todo proxy debe ser revisado y aprobado antes del cálculo. Accede a Proxies para revisar.`,
      itemIds: unapprovedProxies,
      actionPath: `/app/projects/${projectId}/pipeline/proxies`,
      actionLabel: 'Revisar proxies',
    })
  }

  if (outcomesWithoutEvidence.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'outcomes_without_evidence',
      message: `${outcomesWithoutEvidence.length} resultado(s) sin evidencia vinculada. Toda variable que alimenta el cálculo SROI debe estar respaldada por evidencia verificable.`,
      itemIds: outcomesWithoutEvidence,
      actionPath: `/app/projects/${projectId}/pipeline/evidence`,
      actionLabel: 'Agregar evidencia',
    })
  }

  if (invalidQuantities.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'invalid_quantities',
      message: `${invalidQuantities.length} elemento(s) con cantidad inválida (≤0). Las cantidades deben ser positivas.`,
      itemIds: invalidQuantities,
    })
  }

  if (invalidFilters.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'invalid_filters',
      message: `${invalidFilters.length} filtro(s) con valor(es) inválido(s). Los porcentajes deben estar entre 0-100, y la duración entre 1-50 años.`,
      itemIds: invalidFilters,
    })
  }

  if (proxiesMissingUsd.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'proxies_missing_usd',
      message: `${proxiesMissingUsd.length} proxy(ies) falta(n) conversión a USD. Verifica que los proxies tengan valores en USD.`,
      itemIds: proxiesMissingUsd,
      actionPath: `/app/projects/${projectId}/pipeline/proxies`,
      actionLabel: 'Revisar proxies',
    })
  }

  if (overAllocatedOutcomes.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'over_allocated_outcomes',
      message: `${overAllocatedOutcomes.length} resultado(s) tiene(n) atribución de financiadores > 100%. Verifica que la suma de aportes por resultado no exceda 100%.`,
      itemIds: overAllocatedOutcomes,
      actionPath: `#funder-attribution`,
      actionLabel: 'Revisar atribución',
    })
  }

  return {
    hasInvestment,
    zeroOrInvalidInvestment,
    activeAssignmentsCount: allAssignments.length,
    missingInputs,
    missingFilterSets,
    unapprovedProxies,
    currencyMismatch,
    invalidQuantities,
    invalidFilters,
    investmentsMissingUsd,
    proxiesMissingUsd,
    overAllocatedOutcomes,
    outcomesWithoutEvidence,
    canCalculate,
    blockingReasons,
    issues,
  }
}

// ─── Calculation core ────────────────────────────────────────────────────────

// Number fields are for display/preview (backward-compatible API). The `*Exact`
// string fields carry the full-precision decimal result and are what gets
// persisted, so audit-ready records never inherit binary-float artefacts.
interface LineItemCalc {
  assignmentId: string
  outcomeId: string
  proxyId: string
  quantity: number
  proxyValue: number
  currency: string
  grossValue: number
  adjustedValue: number
  quantityExact: string
  proxyValueExact: string
  grossValueExact: string
  adjustedValueExact: string
  deadweightPct: number
  attributionPct: number
  displacementPct: number
  dropoffPct: number
  durationYears: number
}

interface CalcResult {
  // currency is always 'USD' post Fase 1b — all inputs are normalized first.
  currency: string
  totalInvestment: number
  grossSocialValue: number
  netSocialValue: number
  sroiRatio: number
  totalInvestmentExact: string
  grossSocialValueExact: string
  netSocialValueExact: string
  sroiRatioExact: string
  lineItems: LineItemCalc[]
  fundersBreakdown: FunderBreakdownRow[]
  unattributedNsvUsd: string
}

// Precision of the numeric DB columns (see manual-migration 003). Money and
// quantities carry 4 decimals; the SROI ratio carries 6.
const MONEY_DP = 4
const RATIO_DP = 6

// Tolerant Decimal constructor: readiness has already validated these values,
// but never throw inside the engine over a stray string.
function dec(v: string | number | null | undefined): Decimal {
  try {
    return new Decimal(v ?? 0)
  } catch {
    return new Decimal(0)
  }
}

function runDeterministicCalc(
  investments: (typeof projectInvestments.$inferSelect)[],
  assignmentData: AssignmentData[],
  allocations: (typeof outcomeFunderAllocations.$inferSelect)[],
  fundersList: (typeof funders.$inferSelect)[],
  discountRatePct: string | null,
): CalcResult {
  // All contributions are normalized to USD (amount_usd, frozen at save time);
  // readiness guarantees every active contribution has one.
  let totalInvestment = new Decimal(0)
  for (const inv of investments) totalInvestment = totalInvestment.plus(dec(inv.amountUsd))
  if (totalInvestment.lte(0)) throw new Error('Investment amount must be > 0')

  const currency = 'USD'
  // Fase 1e — present value: year `yr` is discounted by 1/(1+r)^(yr-1), so year 1
  // is undiscounted (consistent with the dropoff base year). r = 0 → factor 1
  // for every year, i.e. exactly the pre-1e result (zero regression).
  const onePlusDiscount = new Decimal(1).plus(dec(discountRatePct).div(100))

  let grossSocialValue = new Decimal(0)
  let netSocialValue = new Decimal(0)
  // Per-outcome net social value (USD) — drives the per-funder attribution.
  const outcomeNsv = new Map<string, Decimal>()
  const lineItems: LineItemCalc[] = []

  for (const { assignment, input, filterSet, proxy } of assignmentData) {
    const quantity = dec(input.quantity)
    const proxyValue = dec(proxy.valueUsd ?? '0') // USD-normalized proxy value
    if (quantity.lte(0) || proxyValue.lte(0)) continue

    const deadweightPct = clamp(parseNum(filterSet.deadweightPct), 0, 100)
    const attributionPct = clamp(parseNum(filterSet.attributionPct), 0, 100)
    const displacementPct = clamp(parseNum(filterSet.displacementPct), 0, 100)
    const dropoffPct = clamp(parseNum(filterSet.dropoffPct), 0, 100)
    const durationYears = Math.min(Math.max(filterSet.durationYears ?? 1, 1), 50)

    const baseGrossValue = quantity.mul(proxyValue)
    const baseAdjustmentFactor = new Decimal(1).minus(dec(deadweightPct).div(100))
      .mul(new Decimal(1).minus(dec(attributionPct).div(100)))
      .mul(new Decimal(1).minus(dec(displacementPct).div(100)))

    const dropoffBase = new Decimal(1).minus(dec(dropoffPct).div(100))
    let adjustedValue = new Decimal(0)
    for (let yr = 1; yr <= durationYears; yr++) {
      const dropoffFactor = dropoffBase.pow(yr - 1)
      const discountFactor = new Decimal(1).div(onePlusDiscount.pow(yr - 1))
      adjustedValue = adjustedValue.plus(baseGrossValue.mul(baseAdjustmentFactor).mul(dropoffFactor).mul(discountFactor))
    }

    const grossValue = baseGrossValue.mul(durationYears)

    grossSocialValue = grossSocialValue.plus(grossValue)
    netSocialValue = netSocialValue.plus(adjustedValue)
    outcomeNsv.set(assignment.outcomeId, (outcomeNsv.get(assignment.outcomeId) ?? new Decimal(0)).plus(adjustedValue))

    lineItems.push({
      assignmentId: assignment.id,
      outcomeId: assignment.outcomeId,
      proxyId: proxy.id,
      quantity: quantity.toNumber(),
      proxyValue: proxyValue.toNumber(),
      currency,
      grossValue: grossValue.toNumber(),
      adjustedValue: adjustedValue.toNumber(),
      quantityExact: quantity.toString(),
      proxyValueExact: proxyValue.toString(),
      grossValueExact: grossValue.toFixed(MONEY_DP),
      adjustedValueExact: adjustedValue.toFixed(MONEY_DP),
      deadweightPct,
      attributionPct,
      displacementPct,
      dropoffPct,
      durationYears,
    })
  }

  const sroiRatio = netSocialValue.div(totalInvestment)

  // Per-funder attribution (all in USD, 4dp — consistent with the money model).
  const outcomeNsvUsd: Record<string, string> = {}
  for (const [oid, v] of outcomeNsv) outcomeNsvUsd[oid] = v.toFixed(MONEY_DP)
  const { fundersBreakdown, unattributedNsvUsd } = computeFundersBreakdown({
    netSocialValueUsd: netSocialValue.toFixed(MONEY_DP),
    outcomeNsvUsd,
    investments: investments.map(i => ({ funderId: i.funderId, amountUsd: dec(i.amountUsd).toFixed(MONEY_DP) })),
    allocations: allocations.map(a => ({ outcomeId: a.outcomeId, funderId: a.funderId, allocationPct: String(a.allocationPct ?? '0') })),
    funders: fundersList.map(f => ({ id: f.id, name: f.name, funderType: f.funderType })),
  })

  return {
    currency,
    totalInvestment: totalInvestment.toNumber(),
    grossSocialValue: grossSocialValue.toNumber(),
    netSocialValue: netSocialValue.toNumber(),
    sroiRatio: sroiRatio.toNumber(),
    totalInvestmentExact: totalInvestment.toFixed(MONEY_DP),
    grossSocialValueExact: grossSocialValue.toFixed(MONEY_DP),
    netSocialValueExact: netSocialValue.toFixed(MONEY_DP),
    sroiRatioExact: sroiRatio.toFixed(RATIO_DP),
    lineItems,
    fundersBreakdown,
    unattributedNsvUsd,
  }
}

// ─── Preview (non-persisted) ─────────────────────────────────────────────────

export async function calculateSroiPreview(projectId: string) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)

  if (!readiness.canCalculate) {
    return { canCalculate: false, readiness, result: null }
  }

  const { investments, assignmentData, allocations, fundersList, discountRatePct } = await loadCalculationData(projectId, ctx.organization.id)
  if (investments.length === 0) throw new Error('Investment disappeared after readiness check')

  const result = runDeterministicCalc(investments, assignmentData, allocations, fundersList, discountRatePct)

  return {
    canCalculate: true,
    readiness,
    result: {
      currency: result.currency,
      totalInvestment: result.totalInvestment,
      grossSocialValue: result.grossSocialValue,
      netSocialValue: result.netSocialValue,
      sroiRatio: result.sroiRatio,
      lineItems: result.lineItems,
      fundersBreakdown: result.fundersBreakdown,
      unattributedNsvUsd: result.unattributedNsvUsd,
      discountRatePct: discountRatePct,
      formulaNotes: discountRatePct && parseNum(discountRatePct) > 0
        ? `Values normalized to USD; multi-year outcomes present-valued at ${discountRatePct}% annual discount rate.`
        : 'Values normalized to USD. No discount rate applied.',
    },
  }
}

// ─── Sensitivity: conservative / base / optimistic scenarios ──────────────────

export interface SroiScenarioResult {
  scenario: Scenario
  currency: string
  netSocialValue: number
  netSocialValueExact: string
  sroiRatio: number
  sroiRatioExact: string
}

// Non-persisted sensitivity band: re-runs the deterministic engine with every
// SROI filter shifted uniformly by ±deltaPp (conservative up, optimistic down),
// leaving the audited persist path untouched. Reuses the same runDeterministicCalc
// so the scenarios can never drift from the real formula.
export async function calculateSroiScenarios(projectId: string, deltaPp: number = SCENARIO_DELTA_PP) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)
  if (!readiness.canCalculate) {
    return { canCalculate: false as const, readiness, scenarios: null, deltaPp }
  }

  const { investments, assignmentData, allocations, fundersList, discountRatePct } = await loadCalculationData(projectId, ctx.organization.id)
  if (investments.length === 0) throw new Error('Investment disappeared after readiness check')

  const scenarios: SroiScenarioResult[] = (['conservative', 'base', 'optimistic'] as const).map((sc) => {
    const adjusted: AssignmentData[] = assignmentData.map((d) => ({
      ...d,
      filterSet: {
        ...d.filterSet,
        deadweightPct: String(scenarioFilterPct(parseNum(d.filterSet.deadweightPct), sc, deltaPp)),
        attributionPct: String(scenarioFilterPct(parseNum(d.filterSet.attributionPct), sc, deltaPp)),
        displacementPct: String(scenarioFilterPct(parseNum(d.filterSet.displacementPct), sc, deltaPp)),
        dropoffPct: String(scenarioFilterPct(parseNum(d.filterSet.dropoffPct), sc, deltaPp)),
      },
    }))
    const result = runDeterministicCalc(investments, adjusted, allocations, fundersList, discountRatePct)
    return {
      scenario: sc,
      currency: result.currency,
      netSocialValue: result.netSocialValue,
      netSocialValueExact: result.netSocialValueExact,
      sroiRatio: result.sroiRatio,
      sroiRatioExact: result.sroiRatioExact,
    }
  })

  return { canCalculate: true as const, readiness, scenarios, deltaPp }
}

// ─── Persist calculation run ──────────────────────────────────────────────────

export async function calculateAndPersistSroiRun(projectId: string) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)

  if (!readiness.canCalculate) {
    throw new Error(`Cannot calculate: ${readiness.blockingReasons.join('; ')}`)
  }

  const { investments, assignmentData, allocations, fundersList, discountRatePct } = await loadCalculationData(projectId, ctx.organization.id)
  if (investments.length === 0) throw new Error('Investment disappeared after readiness check')

  const result = runDeterministicCalc(investments, assignmentData, allocations, fundersList, discountRatePct)

  const calculatedAt = new Date()

  // Atomicity: version assignment, run row and all line items are persisted in
  // a single transaction. Previously these were separate awaits, so a line-item
  // failure could leave an orphaned run marked 'calculated' with no items.
  const { run, lineItems: lineItemRows } = await db.transaction(async (tx) => {
    // Compute the next version inside the transaction to shrink the race window.
    // The authoritative guard is the (project_id, version) unique index added in
    // the accompanying migration; without it, two concurrent runs could still
    // collide — the unique index turns that collision into a clean retryable
    // error instead of a duplicate version.
    const maxRow = await tx
      .select({ maxV: sql<number>`coalesce(max(${sroiCalculationRuns.version}), 0)` })
      .from(sroiCalculationRuns)
      .where(eq(sroiCalculationRuns.projectId, projectId))
    const version = (Number(maxRow[0]?.maxV) || 0) + 1

    const snapshotJson = {
      version,
      currency: result.currency,
      totalInvestment: result.totalInvestmentExact,
      grossSocialValue: result.grossSocialValueExact,
      netSocialValue: result.netSocialValueExact,
      sroiRatio: result.sroiRatioExact,
      investments: investments.map(inv => ({
        id: inv.id,
        funderId: inv.funderId,
        contributionType: inv.contributionType,
        amount: inv.amount,
        currency: inv.currency,
        amountUsd: inv.amountUsd,
        fxRateId: inv.fxRateId,
        year: inv.year,
      })),
      fundersBreakdown: result.fundersBreakdown,
      unattributedNsvUsd: result.unattributedNsvUsd,
      assignments: result.lineItems.map(li => ({
        assignmentId: li.assignmentId,
        outcomeId: li.outcomeId,
        proxyId: li.proxyId,
        quantity: li.quantityExact,
        proxyValue: li.proxyValueExact,
        grossValue: li.grossValueExact,
        adjustedValue: li.adjustedValueExact,
        filters: {
          deadweightPct: li.deadweightPct,
          attributionPct: li.attributionPct,
          displacementPct: li.displacementPct,
          dropoffPct: li.dropoffPct,
          durationYears: li.durationYears,
        },
      })),
      discountRatePct: discountRatePct,
      formulaNotes: discountRatePct && parseNum(discountRatePct) > 0
        ? `Values normalized to USD; multi-year outcomes present-valued at ${discountRatePct}% annual discount rate.`
        : 'Values normalized to USD. No discount rate applied.',
      calculatedBy: ctx.user.id,
      calculatedAt: calculatedAt.toISOString(),
      readiness,
    }

    const runInsert = await tx
      .insert(sroiCalculationRuns)
      .values({
        projectId,
        organizationId: ctx.organization.id,
        version,
        currency: result.currency,
        totalInvestment: result.totalInvestmentExact,
        grossSocialValue: result.grossSocialValueExact,
        netSocialValue: result.netSocialValueExact,
        sroiRatio: result.sroiRatioExact,
        snapshotJson,
        status: 'calculated',
        calculatedBy: ctx.user.id,
        calculatedAt,
      })
      .returning()

    const insertedRun = runInsert[0]

    // Persist real line items – one per calculable assignment
    const lineItemInserts = result.lineItems.map(li => ({
      runId: insertedRun.id,
      assignmentId: li.assignmentId,
      organizationId: ctx.organization.id,
      outcomeId: li.outcomeId,
      proxyId: li.proxyId,
      quantity: li.quantityExact,
      proxyValue: li.proxyValueExact,
      currency: li.currency,
      grossValue: li.grossValueExact,
      adjustedValue: li.adjustedValueExact,
      deadweightPct: li.deadweightPct.toString(),
      attributionPct: li.attributionPct.toString(),
      displacementPct: li.displacementPct.toString(),
      dropoffPct: li.dropoffPct.toString(),
      durationYears: li.durationYears,
    }))

    const insertedItems = lineItemInserts.length > 0
      ? await tx.insert(sroiCalculationLineItems).values(lineItemInserts).returning()
      : []

    return { run: insertedRun, lineItems: insertedItems }
  })

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'sroi_calculation_runs',
    entityId: run.id,
    action: 'sroi_calculation_run.created',
    afterJson: { runId: run.id, version: run.version, sroiRatio: result.sroiRatio } as Record<string, unknown>,
  })

  return { run, lineItems: lineItemRows }
}

// ─── List / Get runs ─────────────────────────────────────────────────────────

export async function listSroiCalculationRuns(projectId: string) {
  await authorize(projectId)
  return db.select().from(sroiCalculationRuns).where(eq(sroiCalculationRuns.projectId, projectId))
}

export async function getSroiCalculationRun(projectId: string, runId: string) {
  await authorize(projectId)
  const run = await db
    .select()
    .from(sroiCalculationRuns)
    .where(and(eq(sroiCalculationRuns.id, runId), eq(sroiCalculationRuns.projectId, projectId)))
  if (run.length === 0) throw new Error('Run not found')
  const items = await db.select().from(sroiCalculationLineItems).where(eq(sroiCalculationLineItems.runId, runId))
  return { run: run[0], items }
}
