// lib/pipeline/sroi-calculation.ts
// Sprint 6B – Deterministic SROI Calculation Engine
// No mocks. No placeholders. No FX conversion. No AI/Stella.

import { eq, and, inArray } from 'drizzle-orm'
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
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction } from '@/lib/audit/logger'

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const ProjectInvestmentSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  year: z.number().int().optional(),
  description: z.string().optional(),
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

export async function upsertProjectInvestment(projectId: string, input: ProjectInvestmentInput) {
  const ctx = await authorize(projectId)
  const validated = ProjectInvestmentSchema.parse(input)
  const existing = await db.select().from(projectInvestments).where(eq(projectInvestments.projectId, projectId))

  if (existing.length > 0) {
    await db.update(projectInvestments).set({ ...validated, updatedAt: new Date() }).where(eq(projectInvestments.id, existing[0].id))
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

  const inserted = await db.insert(projectInvestments).values({ ...validated, projectId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
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
  const validated = FilterSetSchema.parse(input)
  const existing = await db.select().from(sroiFilterSets).where(eq(sroiFilterSets.assignmentId, assignmentId))

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
  investment: typeof projectInvestments.$inferSelect | null
  assignmentData: AssignmentData[]
}> {
  // Load investment
  const invRows = await db.select().from(projectInvestments).where(and(eq(projectInvestments.projectId, projectId), eq(projectInvestments.organizationId, orgId)))
  const investment = invRows[0] ?? null

  // Load active assignments
  const assignments = await db
    .select()
    .from(outcomeProxyAssignments)
    .where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, orgId), eq(outcomeProxyAssignments.assignmentStatus, 'active')))

  if (assignments.length === 0) return { investment, assignmentData: [] }

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

  return { investment, assignmentData }
}

// ─── Readiness ───────────────────────────────────────────────────────────────

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
  canCalculate: boolean
  blockingReasons: string[]
}

export async function getSroiCalculationReadiness(projectId: string): Promise<SroiReadiness> {
  const ctx = await authorize(projectId)
  const { investment } = await loadCalculationData(projectId, ctx.organization.id)


  const blockingReasons: string[] = []

  const hasInvestment = investment !== null
  const zeroOrInvalidInvestment = !hasInvestment || parseNum(investment!.amount) <= 0
  if (!hasInvestment) blockingReasons.push('Missing project investment')
  if (zeroOrInvalidInvestment && hasInvestment) blockingReasons.push('Investment amount must be > 0')

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
  const proxyCurrencies = new Set<string>()

  for (const a of allAssignments) {
    const input = inputByAssignment.get(a.id)
    const filterSet = filterByAssignment.get(a.id)
    const proxy = proxyById.get(a.proxyId)

    if (!input) missingInputs.push(a.id)
    if (!filterSet) missingFilterSets.push(a.id)
    if (!proxy || proxy.reviewStatus !== 'approved') unapprovedProxies.push(a.proxyId)

    if (input && parseNum(input.quantity) <= 0) invalidQuantities.push(a.id)
    if (proxy?.value && parseNum(proxy.value) <= 0) invalidQuantities.push(`proxy:${proxy.id}`)

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

    if (proxy?.currency) proxyCurrencies.add(proxy.currency)
  }

  if (missingInputs.length > 0) blockingReasons.push(`Missing inputs for ${missingInputs.length} assignment(s)`)
  if (missingFilterSets.length > 0) blockingReasons.push(`Missing filter sets for ${missingFilterSets.length} assignment(s)`)
  if (unapprovedProxies.length > 0) blockingReasons.push(`${unapprovedProxies.length} unapproved proxy(ies)`)
  if (invalidQuantities.length > 0) blockingReasons.push(`Invalid quantities in ${invalidQuantities.length} item(s)`)
  if (invalidFilters.length > 0) blockingReasons.push(`Invalid filter values in ${invalidFilters.length} assignment(s)`)

  // Currency consistency
  const invCurrency = investment?.currency ?? null
  if (invCurrency) proxyCurrencies.add(invCurrency)
  const currencyMismatch = proxyCurrencies.size > 1
  if (currencyMismatch) blockingReasons.push(`Mixed currencies detected: ${[...proxyCurrencies].join(', ')} – FX conversion not supported`)

  const canCalculate = blockingReasons.length === 0

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
    canCalculate,
    blockingReasons,
  }
}

// ─── Calculation core ────────────────────────────────────────────────────────

interface LineItemCalc {
  assignmentId: string
  outcomeId: string
  proxyId: string
  quantity: number
  proxyValue: number
  currency: string
  grossValue: number
  adjustedValue: number
  deadweightPct: number
  attributionPct: number
  displacementPct: number
  dropoffPct: number
  durationYears: number
}

interface CalcResult {
  currency: string
  totalInvestment: number
  grossSocialValue: number
  netSocialValue: number
  sroiRatio: number
  lineItems: LineItemCalc[]
}

function runDeterministicCalc(investment: typeof projectInvestments.$inferSelect, assignmentData: AssignmentData[]): CalcResult {
  const totalInvestment = parseNum(investment.amount)
  if (totalInvestment <= 0) throw new Error('Investment amount must be > 0')

  const currency = investment.currency

  let grossSocialValue = 0
  let netSocialValue = 0
  const lineItems: LineItemCalc[] = []

  for (const { assignment, input, filterSet, proxy } of assignmentData) {
    const quantity = parseNum(input.quantity)
    const proxyValue = parseNum(proxy.value ?? '0')
    if (quantity <= 0 || proxyValue <= 0) continue

    const deadweightPct = clamp(parseNum(filterSet.deadweightPct), 0, 100)
    const attributionPct = clamp(parseNum(filterSet.attributionPct), 0, 100)
    const displacementPct = clamp(parseNum(filterSet.displacementPct), 0, 100)
    const dropoffPct = clamp(parseNum(filterSet.dropoffPct), 0, 100)
    const durationYears = Math.min(Math.max(filterSet.durationYears ?? 1, 1), 50)

    const baseGrossValue = quantity * proxyValue
    const baseAdjustmentFactor =
      (1 - deadweightPct / 100) *
      (1 - attributionPct / 100) *
      (1 - displacementPct / 100)

    let adjustedValue = 0
    for (let yr = 1; yr <= durationYears; yr++) {
      const dropoffFactor = Math.pow(1 - dropoffPct / 100, yr - 1)
      adjustedValue += baseGrossValue * baseAdjustmentFactor * dropoffFactor
    }

    const grossValue = baseGrossValue * durationYears

    grossSocialValue += grossValue
    netSocialValue += adjustedValue

    lineItems.push({
      assignmentId: assignment.id,
      outcomeId: assignment.outcomeId,
      proxyId: proxy.id,
      quantity,
      proxyValue,
      currency,
      grossValue,
      adjustedValue,
      deadweightPct,
      attributionPct,
      displacementPct,
      dropoffPct,
      durationYears,
    })
  }

  if (totalInvestment === 0) throw new Error('Division by zero: totalInvestment is 0')
  const sroiRatio = netSocialValue / totalInvestment

  return { currency, totalInvestment, grossSocialValue, netSocialValue, sroiRatio, lineItems }
}

// ─── Preview (non-persisted) ─────────────────────────────────────────────────

export async function calculateSroiPreview(projectId: string) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)

  if (!readiness.canCalculate) {
    return { canCalculate: false, readiness, result: null }
  }

  const { investment, assignmentData } = await loadCalculationData(projectId, ctx.organization.id)
  if (!investment) throw new Error('Investment disappeared after readiness check')

  const result = runDeterministicCalc(investment, assignmentData)

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
      formulaNotes: 'No discount rate applied (Sprint 6B). FX conversion not supported.',
    },
  }
}

// ─── Persist calculation run ──────────────────────────────────────────────────

export async function calculateAndPersistSroiRun(projectId: string) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)

  if (!readiness.canCalculate) {
    throw new Error(`Cannot calculate: ${readiness.blockingReasons.join('; ')}`)
  }

  const { investment, assignmentData } = await loadCalculationData(projectId, ctx.organization.id)
  if (!investment) throw new Error('Investment disappeared after readiness check')

  const result = runDeterministicCalc(investment, assignmentData)

  // Determine next version for this project
  const existingRuns = await db.select().from(sroiCalculationRuns).where(eq(sroiCalculationRuns.projectId, projectId))
  const version = existingRuns.length + 1

  const calculatedAt = new Date()

  const snapshotJson = {
    version,
    currency: result.currency,
    totalInvestment: result.totalInvestment,
    grossSocialValue: result.grossSocialValue,
    netSocialValue: result.netSocialValue,
    sroiRatio: result.sroiRatio,
    investment: { id: investment.id, amount: investment.amount, currency: investment.currency, year: investment.year },
    assignments: result.lineItems.map(li => ({
      assignmentId: li.assignmentId,
      outcomeId: li.outcomeId,
      proxyId: li.proxyId,
      quantity: li.quantity,
      proxyValue: li.proxyValue,
      grossValue: li.grossValue,
      adjustedValue: li.adjustedValue,
      filters: {
        deadweightPct: li.deadweightPct,
        attributionPct: li.attributionPct,
        displacementPct: li.displacementPct,
        dropoffPct: li.dropoffPct,
        durationYears: li.durationYears,
      },
    })),
    formulaNotes: 'No discount rate applied (Sprint 6B). FX conversion not supported.',
    calculatedBy: ctx.user.id,
    calculatedAt: calculatedAt.toISOString(),
    readiness,
  }

  const runInsert = await db
    .insert(sroiCalculationRuns)
    .values({
      projectId,
      organizationId: ctx.organization.id,
      version,
      currency: result.currency,
      totalInvestment: result.totalInvestment.toString(),
      grossSocialValue: result.grossSocialValue.toString(),
      netSocialValue: result.netSocialValue.toString(),
      sroiRatio: result.sroiRatio.toString(),
      snapshotJson,
      status: 'calculated',
      calculatedBy: ctx.user.id,
      calculatedAt,
    })
    .returning()

  const run = runInsert[0]

  // Persist real line items – one per calculable assignment
  const lineItemInserts = result.lineItems.map(li => ({
    runId: run.id,
    assignmentId: li.assignmentId,
    organizationId: ctx.organization.id,
    outcomeId: li.outcomeId,
    proxyId: li.proxyId,
    quantity: li.quantity.toString(),
    proxyValue: li.proxyValue.toString(),
    currency: li.currency,
    grossValue: li.grossValue.toString(),
    adjustedValue: li.adjustedValue.toString(),
    deadweightPct: li.deadweightPct.toString(),
    attributionPct: li.attributionPct.toString(),
    displacementPct: li.displacementPct.toString(),
    dropoffPct: li.dropoffPct.toString(),
    durationYears: li.durationYears,
  }))

  const lineItemRows = lineItemInserts.length > 0
    ? await db.insert(sroiCalculationLineItems).values(lineItemInserts).returning()
    : []

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'sroi_calculation_runs',
    entityId: run.id,
    action: 'sroi_calculation_run.created',
    afterJson: { runId: run.id, version, sroiRatio: result.sroiRatio } as Record<string, unknown>,
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
