import { db } from '@/db/client'
import { auditLogs } from '@/db/schema'

export async function logAuditAction({
  organizationId,
  actorUserId,
  entityType,
  entityId,
  action,
  beforeJson,
  afterJson,
  reason,
  ipAddress,
  userAgent,
}: {
  organizationId?: string
  actorUserId?: string
  entityType: string
  entityId: string
  action: string
  beforeJson?: Record<string, unknown>
  afterJson?: Record<string, unknown>
  reason?: string
  ipAddress?: string
  userAgent?: string
}) {
  await db.insert(auditLogs).values({
    organizationId,
    actorUserId,
    entityType,
    entityId,
    action,
    beforeJson,
    afterJson,
    reason,
    ipAddress,
    userAgent,
  })
}
