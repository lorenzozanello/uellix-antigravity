// lib/stella/quota.ts
// Org-level monthly quota on Stella usage. No payment gateway — quotas are
// assigned manually by a super_admin via /admin/services. Every organization
// defaults to quota 0 (blocked) until explicitly assigned. Usage is measured
// by counting existing stella_interactions audit rows for the current UTC
// calendar month — no separate usage-tracking table.

import { db } from '@/db/client'
import { organizations, stellaInteractions } from '@/db/schema'
import { eq, and, gte, count } from 'drizzle-orm'

export type StellaQuotaResult =
  | { allowed: true; used: number; quota: number | null }
  | { allowed: false; used: number; quota: number; reason: 'no_quota' | 'quota_exceeded' }

function startOfCurrentUtcMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

export async function checkStellaQuota(organizationId: string): Promise<StellaQuotaResult> {
  const org = await db
    .select({ stellaMonthlyQuota: organizations.stellaMonthlyQuota })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  // No matching organization row: fail closed, same as an explicit quota of 0.
  if (!org) {
    return { allowed: false, used: 0, quota: 0, reason: 'no_quota' }
  }

  const quota = org.stellaMonthlyQuota

  // null quota means unlimited (no cap assigned/enforced).
  if (quota === null) {
    return { allowed: true, used: 0, quota: null }
  }

  if (quota === 0) {
    return { allowed: false, used: 0, quota: 0, reason: 'no_quota' }
  }

  const used = await db
    .select({ value: count() })
    .from(stellaInteractions)
    .where(
      and(
        eq(stellaInteractions.organizationId, organizationId),
        gte(stellaInteractions.createdAt, startOfCurrentUtcMonth())
      )
    )
    .then((rows) => rows[0]?.value ?? 0)

  if (used >= quota) {
    return { allowed: false, used, quota, reason: 'quota_exceeded' }
  }

  return { allowed: true, used, quota }
}

/** First day of next UTC month, ISO string — for user-facing "resets on" messages. */
export function nextQuotaResetIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString()
}
