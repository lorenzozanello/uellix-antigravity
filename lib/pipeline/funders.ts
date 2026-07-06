// lib/pipeline/funders.ts
// Fase 1b — funders service (per-org catalog of funding entities).
// Minimal surface for the engine: get-or-create the placeholder funder used to
// keep every investment attributable to a funder, plus create/list for the
// (1c) UI. No approval workflow — any analyst+ can create a funder.

import { db } from '@/db/client'
import { funders } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireOrganizationAccess, getCurrentOrganizationContext } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction } from '@/lib/audit/logger'

export const PLACEHOLDER_FUNDER_NAME = 'Financiador no especificado'

export const FUNDER_TYPES = ['public', 'private', 'foundation', 'multilateral', 'individual', 'other'] as const

const CreateFunderSchema = z.object({
  name: z.string().min(1),
  funderType: z.enum(FUNDER_TYPES),
})
export type CreateFunderInput = z.infer<typeof CreateFunderSchema>

/**
 * Returns the org's placeholder funder ("Financiador no especificado"),
 * creating it on first use. Lets an investment always carry a funder_id even
 * before the user has assigned a real funder — the same funder the 1b backfill
 * points legacy rows at.
 */
export async function getOrCreatePlaceholderFunder(organizationId: string, createdBy: string) {
  const existing = await db
    .select()
    .from(funders)
    .where(and(eq(funders.organizationId, organizationId), eq(funders.name, PLACEHOLDER_FUNDER_NAME)))
    .limit(1)
  if (existing[0]) return existing[0]

  const inserted = await db
    .insert(funders)
    .values({ organizationId, name: PLACEHOLDER_FUNDER_NAME, funderType: 'other', createdBy })
    .returning()
  return inserted[0]
}

export async function listFundersForCurrentOrganization() {
  const { organization } = await requireOrganizationAccess()
  return db.select().from(funders).where(eq(funders.organizationId, organization.id))
}

export async function createFunderForCurrentOrganization(input: CreateFunderInput) {
  const { organization, user, membership } = await requireOrganizationAccess()
  if (!hasRole(membership.role as Role, 'analyst')) throw new Error('Insufficient role to create a funder')
  const validated = CreateFunderSchema.parse(input)

  const inserted = await db
    .insert(funders)
    .values({ organizationId: organization.id, name: validated.name, funderType: validated.funderType, createdBy: user.id })
    .returning()

  await logAuditAction({
    organizationId: organization.id,
    actorUserId: user.id,
    entityType: 'funder',
    entityId: inserted[0].id,
    action: 'funder.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

/**
 * TDD-style exported functions matching the exact test interface.
 * These use getCurrentOrganizationContext for session context.
 */
export async function createFunder(name: string, funderType: typeof FUNDER_TYPES[number]) {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('No organization context')

  const validated = CreateFunderSchema.parse({ name, funderType })

  const inserted = await db
    .insert(funders)
    .values({ organizationId: ctx.organization.id, name: validated.name, funderType: validated.funderType, createdBy: ctx.user.id })
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'funder',
    entityId: inserted[0].id,
    action: 'funder.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

export async function listFundersForOrganization() {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('No organization context')

  return db
    .select()
    .from(funders)
    .where(eq(funders.organizationId, ctx.organization.id))
    .execute()
}
