// lib/pipeline/allocations.ts
// Fase 1c — funder↔outcome allocation service. Attribution is at the OUTCOME
// level (every proxy assignment under an outcome inherits it). The active
// allocations for an outcome must not exceed 100%; the unallocated remainder is
// "unattributed value" (a legitimate state, enforced by the calc engine).

import { db } from '@/db/client'
import { outcomeFunderAllocations, outcomes, funders } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import Decimal from 'decimal.js'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction } from '@/lib/audit/logger'

const PCT_DP = 4

// ─── Pure cap math ───────────────────────────────────────────────────────────

export function sumPct(pcts: string[]): string {
  return pcts.reduce((acc, p) => acc.plus(new Decimal(p || 0)), new Decimal(0)).toFixed(PCT_DP)
}

/** True when adding `newPct` to the existing active allocations exceeds 100%. */
export function wouldExceedCap(activePcts: string[], newPct: string): boolean {
  return new Decimal(sumPct(activePcts)).plus(new Decimal(newPct || 0)).gt(100)
}

// ─── Service ─────────────────────────────────────────────────────────────────

const AddAllocationSchema = z.object({
  outcomeId: z.string().uuid(),
  funderId: z.string().uuid(),
  allocationPct: z.string().min(1),
})
export type AddAllocationInput = z.infer<typeof AddAllocationSchema>

async function authorizeWrite() {
  const ctx = await requireOrganizationAccess()
  if (!hasRole(ctx.membership.role as Role, 'analyst')) throw new Error('Insufficient role')
  return ctx
}

/** Active allocations for every outcome of a project, with the funder's name. */
export async function listAllocationsForProject(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const projectOutcomes = await db
    .select({ id: outcomes.id })
    .from(outcomes)
    .where(eq(outcomes.projectId, projectId))
  const outcomeIds = projectOutcomes.map(o => o.id)
  if (outcomeIds.length === 0) return []

  return db
    .select({
      id: outcomeFunderAllocations.id,
      outcomeId: outcomeFunderAllocations.outcomeId,
      funderId: outcomeFunderAllocations.funderId,
      funderName: funders.name,
      allocationPct: outcomeFunderAllocations.allocationPct,
      status: outcomeFunderAllocations.status,
    })
    .from(outcomeFunderAllocations)
    .innerJoin(funders, eq(funders.id, outcomeFunderAllocations.funderId))
    .where(and(
      eq(outcomeFunderAllocations.organizationId, ctx.organization.id),
      inArray(outcomeFunderAllocations.outcomeId, outcomeIds),
      eq(outcomeFunderAllocations.status, 'active'),
    ))
}

export async function addOutcomeFunderAllocation(projectId: string, input: AddAllocationInput) {
  const ctx = await authorizeWrite()
  const validated = AddAllocationSchema.parse(input)

  const pct = new Decimal(validated.allocationPct)
  if (pct.lte(0) || pct.gt(100)) throw new Error('La atribución debe estar entre 0 y 100%')

  // Outcome must belong to this project; funder to this org.
  const outcome = await db.select().from(outcomes).where(and(eq(outcomes.id, validated.outcomeId), eq(outcomes.projectId, projectId))).then(r => r[0])
  if (!outcome) throw new Error('Outcome not found for project')
  const funder = await db.select().from(funders).where(and(eq(funders.id, validated.funderId), eq(funders.organizationId, ctx.organization.id))).then(r => r[0])
  if (!funder) throw new Error('Funder not found for organization')

  // Cap: existing active allocations for this outcome + new must be <= 100%.
  const existing = await db
    .select({ allocationPct: outcomeFunderAllocations.allocationPct })
    .from(outcomeFunderAllocations)
    .where(and(
      eq(outcomeFunderAllocations.outcomeId, validated.outcomeId),
      eq(outcomeFunderAllocations.organizationId, ctx.organization.id),
      eq(outcomeFunderAllocations.status, 'active'),
    ))
  if (wouldExceedCap(existing.map(e => String(e.allocationPct)), validated.allocationPct)) {
    throw new Error('La atribución total del resultado superaría el 100%')
  }

  const inserted = await db
    .insert(outcomeFunderAllocations)
    .values({
      outcomeId: validated.outcomeId,
      funderId: validated.funderId,
      organizationId: ctx.organization.id,
      allocationPct: validated.allocationPct,
      createdBy: ctx.user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'outcome_funder_allocation',
    entityId: inserted[0].id,
    action: 'outcome_funder_allocation.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

export async function archiveOutcomeFunderAllocation(projectId: string, allocationId: string) {
  const ctx = await authorizeWrite()
  const existing = await db
    .select()
    .from(outcomeFunderAllocations)
    .where(and(eq(outcomeFunderAllocations.id, allocationId), eq(outcomeFunderAllocations.organizationId, ctx.organization.id)))
    .then(r => r[0])
  if (!existing) throw new Error('Allocation not found')

  await db
    .update(outcomeFunderAllocations)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(outcomeFunderAllocations.id, allocationId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'outcome_funder_allocation',
    entityId: allocationId,
    action: 'outcome_funder_allocation.archived',
    beforeJson: existing as unknown as Record<string, unknown>,
  })
  return { id: allocationId, status: 'archived' as const }
}
