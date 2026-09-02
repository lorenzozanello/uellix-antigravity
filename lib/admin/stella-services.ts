// lib/admin/stella-services.ts
// SuperAdmin management of per-organization Stella usage quotas.
// No payment gateway — plans/quotas are assigned manually. See
// lib/stella/quota.ts for how the quota is enforced at call time.

import { db } from '@/db/client'
import { organizations, stellaInteractions } from '@/db/schema'
import { eq, and, gte, count, sum } from 'drizzle-orm'
import { z } from 'zod'
import { requireAdminAccess } from '@/lib/auth/session'
import {
  callAdminSetStellaService,
  OrganizationAdministrationError,
} from './organization-administration'
import { startOfCurrentUtcMonth } from '@/lib/stella/quota'
import { estimateCostUsd } from '@/lib/stella/cost-model'

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
    // One aggregate query per org: request count (quota unit) + token total.
    // Same current-UTC-month window convention as lib/stella/quota.ts.
    const usage = await db
      .select({ value: count(), tokens: sum(stellaInteractions.tokensUsed) })
      .from(stellaInteractions)
      .where(
        and(
          eq(stellaInteractions.organizationId, org.id),
          gte(stellaInteractions.createdAt, startOfCurrentUtcMonth())
        )
      )
      .then((rows) => rows[0] ?? { value: 0, tokens: null })

    const usedThisMonth = usage.value ?? 0
    // drizzle sum() surfaces as string | null (pg numeric); null when there are
    // no rows or every row has tokens_used = null.
    const tokensThisMonth = Number(usage.tokens ?? 0)
    // Estimate only — blended input/output heuristic over total tokens; see
    // the loudly documented assumptions in lib/stella/cost-model.ts (G9
    // calibrates against real Gemini billing).
    const estimatedCostUsd = estimateCostUsd(tokensThisMonth)

    results.push({ ...org, usedThisMonth, tokensThisMonth, estimatedCostUsd })
  }

  return results
}

/**
 * Assign or update an organization's Stella plan label and monthly quota.
 *
 * Goes through `uellix_capability.admin_set_stella_service`, not through the
 * ORM: since `stella_0011` these two columns are outside every runtime UPDATE
 * grant, so `db.update(organizations).set({ stellaMonthlyQuota })` is refused
 * by the ACL and would be refused for any caller, super_admin or not. See
 * lib/admin/organization-administration.ts for why the deployment is coupled.
 *
 * THE AUDIT ROW IS NOT WRITTEN HERE ANY MORE, and that is the point rather
 * than a simplification. The definer writes the change and its audit_logs row
 * in ONE transaction; this function used to issue them as two awaited calls,
 * so a failure between them left a quota moved with no record of why. Calling
 * `logAuditAction` as well would now produce two rows for one decision.
 *
 * The "organization not found" pre-check is gone with it. The capability
 * answers every refusal identically — not a super_admin, no such organisation,
 * negative quota — so a caller cannot use this endpoint to discover which
 * organisation ids exist.
 */
export async function updateOrganizationStellaService(
  organizationId: string,
  input: unknown
) {
  await requireAdminAccess()
  const data = StellaServiceInput.parse(input)

  await callAdminSetStellaService(organizationId, {
    monthlyQuota: data.monthlyQuota,
    planLabel: data.planLabel,
  })

  // Read back for the caller's benefit. The write is already committed and
  // audited; this is a projection, not part of the transaction.
  const [updated] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      stellaMonthlyQuota: organizations.stellaMonthlyQuota,
      stellaPlanLabel: organizations.stellaPlanLabel,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))

  // See lib/admin/organizations.ts: the declared type says a row.
  if (!updated) throw new OrganizationAdministrationError('stella service read-back')

  return updated
}
