// lib/admin/stella-services.ts
// SuperAdmin management of per-organization Stella usage quotas.
// No payment gateway — plans/quotas are assigned manually. See
// lib/stella/quota.ts for how the quota is enforced at call time.

import { db } from '@/db/client'
import { organizations, stellaInteractions } from '@/db/schema'
import { eq, and, gte, count } from 'drizzle-orm'
import { z } from 'zod'
import { requireAdminAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { startOfCurrentUtcMonth } from '@/lib/stella/quota'

const StellaServiceInput = z.object({
  planLabel: z.string().max(100).optional(),
  monthlyQuota: z.number().int().min(0).nullable(),
})

/** All organizations with their current Stella plan/quota and this month's usage. */
export async function listOrganizationsWithStellaUsage() {
  await requireAdminAccess()

  const orgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      stellaMonthlyQuota: organizations.stellaMonthlyQuota,
      stellaPlanLabel: organizations.stellaPlanLabel,
    })
    .from(organizations)

  const results = []
  for (const org of orgs) {
    const usedThisMonth = await db
      .select({ value: count() })
      .from(stellaInteractions)
      .where(
        and(
          eq(stellaInteractions.organizationId, org.id),
          gte(stellaInteractions.createdAt, startOfCurrentUtcMonth())
        )
      )
      .then((rows) => rows[0]?.value ?? 0)

    results.push({ ...org, usedThisMonth })
  }

  return results
}

/** Assign or update an organization's Stella plan label and monthly quota. */
export async function updateOrganizationStellaService(
  organizationId: string,
  input: unknown
) {
  const admin = await requireAdminAccess()
  const data = StellaServiceInput.parse(input)

  const before = await db
    .select({
      stellaMonthlyQuota: organizations.stellaMonthlyQuota,
      stellaPlanLabel: organizations.stellaPlanLabel,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .then((rows) => rows[0])

  if (!before) throw new Error('Organization not found')

  const [updated] = await db
    .update(organizations)
    .set({
      stellaMonthlyQuota: data.monthlyQuota,
      stellaPlanLabel: data.planLabel,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId))
    .returning()

  if (!updated) throw new Error('Organization not found')

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'organization',
    entityId: organizationId,
    action: AUDIT_ACTIONS.STELLA_SERVICE_UPDATED,
    beforeJson: { stellaMonthlyQuota: before.stellaMonthlyQuota, stellaPlanLabel: before.stellaPlanLabel },
    afterJson: { stellaMonthlyQuota: updated.stellaMonthlyQuota, stellaPlanLabel: updated.stellaPlanLabel },
  })

  return updated
}
