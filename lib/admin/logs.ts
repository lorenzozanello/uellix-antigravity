// lib/admin/logs.ts
// Global audit log visibility across all organizations. Super_admin only.

import { db } from '@/db/client'
import { auditLogs, organizations, users } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { requireAdminAccess } from '@/lib/auth/session'

const DEFAULT_LIMIT = 100

/** Most recent audit log entries across the platform, newest first. */
export async function listRecentAuditLogs(limit: number = DEFAULT_LIMIT) {
  await requireAdminAccess()

  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      reason: auditLogs.reason,
      createdAt: auditLogs.createdAt,
      organizationName: organizations.name,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(organizations, eq(auditLogs.organizationId, organizations.id))
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
}
