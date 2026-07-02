// lib/admin/stats.ts
// Global platform stats for the SuperAdmin console. Super_admin only.

import { db } from '@/db/client'
import { organizations, users, financialProxies, auditLogs } from '@/db/schema'
import { count, isNull } from 'drizzle-orm'
import { requireAdminAccess } from '@/lib/auth/session'

export interface AdminStats {
  totalOrganizations: number
  totalUsers: number
  totalGlobalProxies: number
  totalAuditLogs: number
}

/** Platform-wide counts for the admin dashboard. Requires super_admin. */
export async function getAdminStats(): Promise<AdminStats> {
  await requireAdminAccess()

  const [orgCount, userCount, proxyCount, logCount] = await Promise.all([
    db.select({ value: count() }).from(organizations).then((r) => r[0]?.value ?? 0),
    db.select({ value: count() }).from(users).then((r) => r[0]?.value ?? 0),
    // "Global" proxies = system-level proxies (organizationId IS NULL), the
    // ones the admin console is actually responsible for curating.
    db
      .select({ value: count() })
      .from(financialProxies)
      .where(isNull(financialProxies.organizationId))
      .then((r) => r[0]?.value ?? 0),
    db.select({ value: count() }).from(auditLogs).then((r) => r[0]?.value ?? 0),
  ])

  return {
    totalOrganizations: orgCount,
    totalUsers: userCount,
    totalGlobalProxies: proxyCount,
    totalAuditLogs: logCount,
  }
}
