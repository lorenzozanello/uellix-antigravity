// lib/pipeline/investments.ts
// Multi-funder investment CRUD operations (Fase 1a/1b)
// Supports per-project, per-funder contribution tracking with FX normalization

import { eq, and, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  projectInvestments,
  funders,
  projects,
  organizationMembers,
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction } from '@/lib/audit/logger'
import { getOrCreateSharedCopRate, convertToUsd } from '@/lib/pipeline/fx'

// ─── Input validation schemas ────────────────────────────────────────────────

const CreateInvestmentInputSchema = z.object({
  funderId: z.string().uuid('Funder ID must be a valid UUID'),
  amount: z.string().min(1, 'Amount is required'),
  currency: z.string().min(1, 'Currency is required'),
  contributionType: z.enum(['cash', 'in_kind']).default('cash'),
  inKindValuationNotes: z.string().optional(),
  year: z.number().int().optional(),
  description: z.string().optional(),
})
export type CreateInvestmentInput = z.input<typeof CreateInvestmentInputSchema>

export const UpdateInvestmentInput = z.object({
  amount: z.string().optional(),
  currency: z.string().optional(),
  contributionType: z.enum(['cash', 'in_kind']).optional(),
  inKindValuationNotes: z.string().optional(),
  year: z.number().int().optional(),
  description: z.string().optional(),
})
export type UpdateInvestmentInput = z.infer<typeof UpdateInvestmentInput>

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Authorize project access and return organization context
 */
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

/**
 * Resolve the frozen USD equivalent of a contribution at save time.
 * USD passes through; COP auto-fetches the TRM (Dec 31 of `year`, or today);
 * any other currency needs a manual rate and is left null here.
 */
async function resolveAmountUsd(
  amount: string,
  currency: string | null,
  year: number | null | undefined,
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

/**
 * Validate that funder belongs to the same organization as the project
 */
async function validateFunderOrganization(funderId: string, organizationId: string) {
  const funder = await db
    .select()
    .from(funders)
    .where(and(eq(funders.id, funderId), eq(funders.organizationId, organizationId)))
    .limit(1)
  if (funder.length === 0) {
    throw new Error('Funder not found or does not belong to this organization')
  }
  return funder[0]
}

/**
 * Validate in-kind investments have valuation notes
 */
function validateInKindRequirements(
  contributionType: string,
  inKindValuationNotes: string | undefined,
) {
  if (contributionType === 'in_kind' && !inKindValuationNotes) {
    throw new Error('In-kind contributions must include valuation notes')
  }
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

/**
 * Create a new investment contribution for a project
 */
export async function createInvestment(
  projectId: string,
  input: CreateInvestmentInput,
) {
  const ctx = await authorize(projectId)
  const validated = CreateInvestmentInputSchema.parse(input)

  // Validate funder belongs to this organization
  await validateFunderOrganization(validated.funderId, ctx.organization.id)

  // Validate in-kind requirements
  validateInKindRequirements(validated.contributionType, validated.inKindValuationNotes)

  // Resolve USD amount
  const { amountUsd, fxRateId } = await resolveAmountUsd(
    validated.amount,
    validated.currency,
    validated.year,
  )

  const investment = await db
    .insert(projectInvestments)
    .values({
      projectId,
      organizationId: ctx.organization.id,
      funderId: validated.funderId,
      amount: validated.amount,
      currency: validated.currency,
      contributionType: validated.contributionType,
      inKindValuationNotes: validated.inKindValuationNotes,
      amountUsd,
      fxRateId,
      year: validated.year,
      description: validated.description,
      status: 'active',
      createdBy: ctx.user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    projectId,
    entityType: 'project_investments',
    entityId: investment[0].id,
    action: 'project_investment.created',
    afterJson: investment[0] as unknown as Record<string, unknown>,
  })

  return investment[0]
}

/**
 * List all active investments for a project
 */
export async function listInvestments(projectId: string) {
  const ctx = await authorize(projectId)

  const investments = await db
    .select()
    .from(projectInvestments)
    .where(
      and(
        eq(projectInvestments.projectId, projectId),
        eq(projectInvestments.organizationId, ctx.organization.id),
        eq(projectInvestments.status, 'active'),
      ),
    )
    .orderBy(projectInvestments.createdAt)

  return investments
}

/**
 * Get a single investment by ID with authorization
 */
export async function getInvestment(investmentId: string) {
  const ctx = await requireOrganizationAccess()

  const investment = await db
    .select()
    .from(projectInvestments)
    .where(
      and(
        eq(projectInvestments.id, investmentId),
        eq(projectInvestments.organizationId, ctx.organization.id),
      ),
    )
    .limit(1)

  if (investment.length === 0) {
    throw new Error('Investment not found or not authorized')
  }

  return investment[0]
}

/**
 * Update an investment's mutable fields
 * Immutable fields: projectId, organizationId, createdBy, createdAt
 */
export async function updateInvestment(
  investmentId: string,
  input: UpdateInvestmentInput,
) {
  const ctx = await requireOrganizationAccess()
  const validated = UpdateInvestmentInput.parse(input)

  // Fetch the investment
  const existing = await getInvestment(investmentId)

  // Build update payload with provided fields
  const updatePayload: Record<string, unknown> = {
    updatedAt: new Date(),
  }

  // Amount and currency may both change; if either changes, recalculate USD
  if (validated.amount !== undefined || validated.currency !== undefined) {
    const amount = validated.amount ?? existing.amount
    const currency = validated.currency ?? existing.currency
    const year = validated.year ?? existing.year ?? undefined

    const { amountUsd, fxRateId } = await resolveAmountUsd(amount, currency, year)
    updatePayload.amount = amount
    updatePayload.currency = currency
    updatePayload.amountUsd = amountUsd
    updatePayload.fxRateId = fxRateId
  }

  // Contribution type may change
  if (validated.contributionType !== undefined) {
    const newType = validated.contributionType
    const notes = validated.inKindValuationNotes ?? existing.inKindValuationNotes ?? undefined
    validateInKindRequirements(newType, notes)
    updatePayload.contributionType = newType
    if (validated.inKindValuationNotes !== undefined) {
      updatePayload.inKindValuationNotes = validated.inKindValuationNotes
    }
  } else if (validated.inKindValuationNotes !== undefined) {
    // If only notes are provided, validate the current contribution type
    validateInKindRequirements(existing.contributionType, validated.inKindValuationNotes)
    updatePayload.inKindValuationNotes = validated.inKindValuationNotes
  }

  // Optional fields
  if (validated.year !== undefined) {
    updatePayload.year = validated.year
  }
  if (validated.description !== undefined) {
    updatePayload.description = validated.description
  }

  // Update in database
  const updated = await db
    .update(projectInvestments)
    .set(updatePayload)
    .where(eq(projectInvestments.id, investmentId))
    .returning()

  if (updated.length === 0) {
    throw new Error('Investment update failed')
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    projectId: existing.projectId,
    entityType: 'project_investments',
    entityId: investmentId,
    action: 'project_investment.updated',
    beforeJson: existing as unknown as Record<string, unknown>,
    afterJson: updated[0] as unknown as Record<string, unknown>,
  })

  return updated[0]
}

/**
 * Archive an investment (soft delete via status = 'archived')
 */
export async function deleteInvestment(investmentId: string) {
  const ctx = await requireOrganizationAccess()

  // Fetch to validate ownership
  const existing = await getInvestment(investmentId)

  const archived = await db
    .update(projectInvestments)
    .set({
      status: 'archived',
      updatedAt: new Date(),
    })
    .where(eq(projectInvestments.id, investmentId))
    .returning()

  if (archived.length === 0) {
    throw new Error('Investment deletion failed')
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    projectId: existing.projectId,
    entityType: 'project_investments',
    entityId: investmentId,
    action: 'project_investment.archived',
    beforeJson: existing as unknown as Record<string, unknown>,
    afterJson: { status: 'archived' },
  })

  return archived[0]
}

/**
 * Get investments for multiple projects (admin/bulk operations)
 */
export async function listProjectsInvestments(projectIds: string[]) {
  const ctx = await requireOrganizationAccess()

  if (projectIds.length === 0) return []

  // Verify all projects belong to this organization
  const projects_check = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        inArray(projects.id, projectIds),
        eq(projects.organizationId, ctx.organization.id),
      ),
    )

  if (projects_check.length !== projectIds.length) {
    throw new Error('Some projects not found or not authorized')
  }

  const investments = await db
    .select()
    .from(projectInvestments)
    .where(
      and(
        inArray(projectInvestments.projectId, projectIds),
        eq(projectInvestments.organizationId, ctx.organization.id),
        eq(projectInvestments.status, 'active'),
      ),
    )

  return investments
}

/**
 * Calculate total investment per project and currency
 */
export async function getProjectInvestmentSummary(projectId: string) {
  const ctx = await authorize(projectId)

  const investments = await listInvestments(projectId)

  const summary = {
    totalCount: investments.length,
    totalAmountsByType: {} as Record<string, { cash: number; inKind: number; total: number }>,
    totalUsd: 0,
    byFunder: {} as Record<
      string,
      {
        funderId: string
        count: number
        totalAmount: number
        totalAmountUsd: number | null
        contributionTypes: string[]
      }
    >,
  }

  for (const inv of investments) {
    const currency = inv.currency || 'USD'

    // Track by currency
    if (!summary.totalAmountsByType[currency]) {
      summary.totalAmountsByType[currency] = { cash: 0, inKind: 0, total: 0 }
    }

    const amount = parseFloat(inv.amount || '0')
    if (inv.contributionType === 'cash') {
      summary.totalAmountsByType[currency].cash += amount
    } else {
      summary.totalAmountsByType[currency].inKind += amount
    }
    summary.totalAmountsByType[currency].total += amount

    // Sum USD
    if (inv.amountUsd) {
      summary.totalUsd += parseFloat(inv.amountUsd)
    }

    // Track by funder
    if (!summary.byFunder[inv.funderId]) {
      summary.byFunder[inv.funderId] = {
        funderId: inv.funderId,
        count: 0,
        totalAmount: 0,
        totalAmountUsd: 0,
        contributionTypes: [],
      }
    }

    summary.byFunder[inv.funderId].count += 1
    summary.byFunder[inv.funderId].totalAmount += amount
    if (inv.amountUsd) {
      summary.byFunder[inv.funderId].totalAmountUsd = summary.byFunder[inv.funderId].totalAmountUsd
        ? parseFloat(String(summary.byFunder[inv.funderId].totalAmountUsd)) +
          parseFloat(inv.amountUsd)
        : parseFloat(inv.amountUsd)
    }

    if (!summary.byFunder[inv.funderId].contributionTypes.includes(inv.contributionType)) {
      summary.byFunder[inv.funderId].contributionTypes.push(inv.contributionType)
    }
  }

  return summary
}
