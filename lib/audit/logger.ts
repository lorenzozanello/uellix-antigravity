import { db } from '@/db/client'
import { auditLogs } from '@/db/schema'

// ---------------------------------------------------------------------------
// Typed audit action constants
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = {
  // Organization lifecycle
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  ORGANIZATION_DELETED: 'organization.deleted',

  // Membership lifecycle
  MEMBERSHIP_CREATED: 'membership.created',
  MEMBERSHIP_UPDATED: 'membership.updated',
  MEMBERSHIP_REMOVED: 'membership.removed',
  MEMBERSHIP_ROLE_CHANGED: 'membership.role_changed',

  // Invitation lifecycle
  INVITATION_SENT: 'invitation.sent',
  INVITATION_ACCEPTED: 'invitation.accepted',
  INVITATION_REVOKED: 'invitation.revoked',
  INVITATION_EXPIRED: 'invitation.expired',

  // Auth events
  USER_PROFILE_SYNCED: 'user.profile_synced',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGGED_OUT: 'user.logged_out',

  // Signup allowlist
  SIGNUP_ALLOWLIST_CREATED: 'signup_allowlist.created',
  SIGNUP_ALLOWLIST_REMOVED: 'signup_allowlist.removed',

  // Stella service/quota management
  STELLA_SERVICE_UPDATED: 'stella_service.updated',

  // Proxy sources
  PROXY_SOURCE_CREATED: 'proxy_source.created',
  PROXY_SOURCE_UPDATED: 'proxy_source.updated',
  PROXY_SOURCE_ARCHIVED: 'proxy_source.archived',

  // Financial proxies
  FINANCIAL_PROXY_CREATED: 'financial_proxy.created',
  FINANCIAL_PROXY_UPDATED: 'financial_proxy.updated',
  FINANCIAL_PROXY_REVIEW_STATUS_CHANGED: 'financial_proxy.review_status_changed',
  FINANCIAL_PROXY_ARCHIVED: 'financial_proxy.archived',

  // Proxy assignments
  PROXY_ASSIGNMENT_CREATED: 'proxy_assignment.created',
  PROXY_ASSIGNMENT_ARCHIVED: 'proxy_assignment.archived',

  // Evidence items
  EVIDENCE_CREATED: 'evidence_item.created',
  EVIDENCE_REVIEW_STATUS_CHANGED: 'evidence_item.review_status_changed',
  EVIDENCE_ARCHIVED: 'evidence_item.archived',
  EVIDENCE_CONFIDENCE_SCORE_UPDATED: 'evidence_item.confidence_score_updated',

  // Theory of change (nodes + links)
  THEORY_OF_CHANGE_NODE_CREATED: 'theory_of_change_node.created',
  THEORY_OF_CHANGE_NODE_ARCHIVED: 'theory_of_change_node.archived',
  THEORY_OF_CHANGE_LINK_CREATED: 'theory_of_change_link.created',
  THEORY_OF_CHANGE_LINK_ARCHIVED: 'theory_of_change_link.archived',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

// ---------------------------------------------------------------------------
// Log entry interface
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  organizationId?: string
  projectId?: string
  actorUserId?: string
  entityType: string
  entityId: string
  action: AuditAction | string
  beforeJson?: Record<string, unknown>
  afterJson?: Record<string, unknown>
  reason?: string
  ipAddress?: string
  userAgent?: string
}

// ---------------------------------------------------------------------------
// logAuditAction
// ---------------------------------------------------------------------------

/**
 * Persists an audit log entry to the database.
 *
 * Uses the service-level Drizzle client (bypasses RLS) — this is intentional.
 * Audit logging must always succeed regardless of the caller's RLS context.
 *
 * All sensitive fields should be passed explicitly; never log plaintext secrets.
 */
export async function logAuditAction(entry: AuditLogEntry): Promise<void> {
  // Basic validation
  if (!entry.entityType || !entry.entityId || !entry.action) {
    console.warn('[audit] logAuditAction called with missing required fields', entry)
    return
  }

  await db.insert(auditLogs).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    beforeJson: entry.beforeJson,
    afterJson: entry.afterJson,
    reason: entry.reason,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
  })
}
