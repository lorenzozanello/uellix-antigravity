// lib/pipeline/outcome-funder-allocations.ts
// Fase 1a — outcome-funder allocations service (many-to-many attribution with % split).
// Validates that per-outcome allocations don't exceed 100%.

import { db } from '@/db/client'
import { outcomeFunderAllocations, funders, outcomes, projects } from '@/db/schema'
import { and, eq, ne, sum } from 'drizzle-orm'
import { z } from 'zod'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { logAuditAction } from '@/lib/audit/logger'
import Decimal from 'decimal.js'

const CreateAllocationSchema = z.object({
  outcomeId: z.string().uuid(),
  funderId: z.string().uuid(),
  allocationPct: z.number().positive().lte(100),
})
export type CreateAllocationInput = z.infer<typeof CreateAllocationSchema>

const UpdateAllocationSchema = z.object({
  allocationPct: z.number().positive().lte(100),
})
export type UpdateAllocationInput = z.infer<typeof UpdateAllocationSchema>

/**
 * Allocation object returned from service, includes remainingPct computed from other allocations.
 */
export interface OutcomeFunderAllocation {
  id: string
  outcomeId: string
  funderId: string
  organizationId: string
  allocationPct: number
  status: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
  remainingPct?: number
}

/**
 * Verify that the outcome exists and belongs to the current organization.
 */
async function verifyOutcomeAccess(outcomeId: string, ctx: { organization: { id: string } }) {
  const outcomes_result = await db
    .select({ projectId: projects.id, organizationId: projects.organizationId })
    .from(outcomes)
    .innerJoin(projects, eq(outcomes.projectId, projects.id))
    .where(eq(outcomes.id, outcomeId))
    .limit(1)

  const outcome = outcomes_result[0] ?? null

  if (!outcome) throw new Error('Outcome not found')
  if (outcome.organizationId !== ctx.organization.id) {
    throw new Error('Outcome does not belong to your organization')
  }
  return outcome
}

/**
 * Verify that the funder exists and belongs to the current organization.
 */
async function verifyFunderAccess(funderId: string, ctx: { organization: { id: string } }) {
  const funder_result = await db
    .select()
    .from(funders)
    .where(and(eq(funders.id, funderId), eq(funders.organizationId, ctx.organization.id)))
    .limit(1)

  const funder = funder_result[0] ?? null

  if (!funder) throw new Error('Funder does not belong to your organization')
  return funder
}

/**
 * Calculate the total allocation % already assigned to an outcome,
 * optionally excluding a specific allocation ID (for updates).
 */
async function calculateExistingAllocationTotal(outcomeId: string, excludeAllocationId?: string) {
  const query = db
    .select({ allocationPct: outcomeFunderAllocations.allocationPct })
    .from(outcomeFunderAllocations)
    .where(
      and(
        eq(outcomeFunderAllocations.outcomeId, outcomeId),
        eq(outcomeFunderAllocations.status, 'active'),
        excludeAllocationId ? ne(outcomeFunderAllocations.id, excludeAllocationId) : undefined,
      ),
    )

  const rows = await query.execute()
  const total = rows.reduce((acc, row) => acc + parseFloat(row.allocationPct.toString()), 0)
  return total
}

/**
 * Create an allocation for an outcome-funder pair.
 * Validates: allocationPct in (0, 100], total for outcome doesn't exceed 100%,
 * outcome and funder belong to org.
 */
export async function createAllocation(
  outcomeId: string,
  funderId: string,
  allocationPct: number,
): Promise<OutcomeFunderAllocation> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('No organization context')

  const validated = CreateAllocationSchema.parse({ outcomeId, funderId, allocationPct })

  // Verify outcome and funder belong to org
  await verifyOutcomeAccess(validated.outcomeId, ctx)
  await verifyFunderAccess(validated.funderId, ctx)

  // Check that adding this allocation won't exceed 100%
  const existing = await calculateExistingAllocationTotal(validated.outcomeId)
  const newTotal = existing + validated.allocationPct
  if (newTotal > 100) {
    throw new Error(
      `Cannot create allocation: total would be ${newTotal}%, exceeds 100%. Existing: ${existing}%, new: ${validated.allocationPct}%`,
    )
  }

  const inserted = await db
    .insert(outcomeFunderAllocations)
    .values({
      outcomeId: validated.outcomeId,
      funderId: validated.funderId,
      organizationId: ctx.organization.id,
      allocationPct: new Decimal(validated.allocationPct).toFixed(4),
      status: 'active',
      createdBy: ctx.user.id,
    })
    .returning()

  const allocation = inserted[0]
  const remainingPct = 100 - newTotal

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'outcome_funder_allocation',
    entityId: allocation.id,
    action: 'allocation.created',
    afterJson: { ...allocation, remainingPct },
  })

  return {
    ...allocation,
    allocationPct: parseFloat(allocation.allocationPct.toString()),
    remainingPct,
  }
}

/**
 * List all allocations for an outcome.
 * Returns each allocation with remainingPct: 100 - sum(all allocations for this outcome).
 */
export async function listAllocations(outcomeId: string): Promise<OutcomeFunderAllocation[]> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('No organization context')

  // Verify outcome belongs to org
  await verifyOutcomeAccess(outcomeId, ctx)

  const allocations = await db
    .select()
    .from(outcomeFunderAllocations)
    .where(
      and(
        eq(outcomeFunderAllocations.outcomeId, outcomeId),
        eq(outcomeFunderAllocations.organizationId, ctx.organization.id),
      ),
    )
    .execute()

  const total = allocations.reduce((acc, alloc) => acc + parseFloat(alloc.allocationPct.toString()), 0)
  const remainingPct = 100 - total

  return allocations.map((alloc) => ({
    ...alloc,
    allocationPct: parseFloat(alloc.allocationPct.toString()),
    remainingPct,
  }))
}

/**
 * Update an allocation's percentage.
 * Validates: new allocationPct in (0, 100], total for outcome doesn't exceed 100%.
 */
export async function updateAllocation(
  allocationId: string,
  allocationPct: number,
): Promise<OutcomeFunderAllocation> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('No organization context')

  const validated = UpdateAllocationSchema.parse({ allocationPct })

  // Fetch the allocation to check org membership
  const alloc_result = await db
    .select()
    .from(outcomeFunderAllocations)
    .where(eq(outcomeFunderAllocations.id, allocationId))
    .limit(1)

  const allocation = alloc_result[0] ?? null

  if (!allocation) throw new Error('Allocation not found')
  if (allocation.organizationId !== ctx.organization.id) {
    throw new Error('Allocation does not belong to your organization')
  }

  // Check that updating won't exceed 100% (exclude current allocation from total)
  const existingOthers = await calculateExistingAllocationTotal(allocation.outcomeId, allocationId)
  const newTotal = existingOthers + validated.allocationPct
  if (newTotal > 100) {
    throw new Error(
      `Cannot update allocation: total would be ${newTotal}%, exceeds 100%. Others: ${existingOthers}%, new: ${validated.allocationPct}%`,
    )
  }

  const oldPct = parseFloat(allocation.allocationPct.toString())
  const updated = await db
    .update(outcomeFunderAllocations)
    .set({
      allocationPct: new Decimal(validated.allocationPct).toFixed(4),
      updatedAt: new Date(),
    })
    .where(eq(outcomeFunderAllocations.id, allocationId))
    .returning()

  const updatedAllocation = updated[0]
  const remainingPct = 100 - newTotal

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'outcome_funder_allocation',
    entityId: allocationId,
    action: 'allocation.updated',
    beforeJson: { allocationPct: oldPct },
    afterJson: { allocationPct: validated.allocationPct, remainingPct },
  })

  return {
    ...updatedAllocation,
    allocationPct: parseFloat(updatedAllocation.allocationPct.toString()),
    remainingPct,
  }
}

/**
 * Delete an allocation (hard delete for MVP).
 */
export async function deleteAllocation(allocationId: string): Promise<void> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('No organization context')

  // Fetch the allocation to check org membership
  const alloc_result = await db
    .select()
    .from(outcomeFunderAllocations)
    .where(eq(outcomeFunderAllocations.id, allocationId))
    .limit(1)

  const allocation = alloc_result[0] ?? null

  if (!allocation) throw new Error('Allocation not found')
  if (allocation.organizationId !== ctx.organization.id) {
    throw new Error('Allocation does not belong to your organization')
  }

  const deletedPct = parseFloat(allocation.allocationPct.toString())

  await db.delete(outcomeFunderAllocations).where(eq(outcomeFunderAllocations.id, allocationId))

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'outcome_funder_allocation',
    entityId: allocationId,
    action: 'allocation.deleted',
    beforeJson: { allocationPct: deletedPct },
  })
}
