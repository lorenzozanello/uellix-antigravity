import { db } from '@/db/client'
import { auditLogs } from '@/db/schema'

// Etapa A2.4 (DR-004 aprobado) — optional transactional client. Reusing the
// TxClient/QueryClient pattern from lib/stella/aggregation/declaration-service.ts
// (Etapa A2.3.2): a caller that already opened a db.transaction can pass its
// `tx` here so the audit insert commits atomically with the business write it
// documents, instead of the best-effort try/catch pattern used elsewhere in
// Stella (logAuditActionSafely in app/actions/stella/aggregation-declarations.ts).
// Chosen over a transactional-outbox table (evaluated and rejected — see
// STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md#17): this repository has
// no existing outbox/event-processor infrastructure, and introducing one
// (new table, processor, retry loop, idempotency key) purely to guarantee
// consistency for a handful of low-frequency retention/hold operations would
// be a generic event system for the whole platform, which is explicitly out
// of scope for DR-004. Every existing call site keeps working unchanged —
// the parameter is optional and defaults to `db`.
type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type AuditQueryClient = typeof db | TxClient

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

  // Stella AI consent (Etapa A2.1, DR-005)
  STELLA_AI_CONSENT_ACCEPTED: 'stella_ai_consent.accepted',
  STELLA_AI_CONSENT_REVOKED: 'stella_ai_consent.revoked',

  // Stella sensitive-population guardrail (Etapa A2.3, DR-002/DR-003) — the
  // afterJson/reason for this action must only ever carry the fixed reason
  // code (see SENSITIVE_DATA_REASON_CODES), never the text that tripped it.
  STELLA_SENSITIVE_DATA_BLOCKED: 'stella_sensitive_data.blocked',

  // Stella sensitive-aggregation declarations (Etapa A2.3.1, DR-002/DR-003)
  // — afterJson never carries group_size, dimensions values, or any
  // minimization-invariant field beyond entityType/sensitiveCategory.
  STELLA_SENSITIVE_AGGREGATION_DECLARED: 'stella_sensitive_aggregation.declared',
  STELLA_SENSITIVE_AGGREGATION_VERIFIED: 'stella_sensitive_aggregation.verified',
  STELLA_SENSITIVE_AGGREGATION_REVOKED: 'stella_sensitive_aggregation.revoked',

  // Stella retention/purge (Etapa A2.4, DR-004) — afterJson/beforeJson never
  // carry response_json content, only counts/IDs/policy version.
  STELLA_RETENTION_SETTINGS_UPDATED: 'stella_retention_settings.updated',
  STELLA_RETENTION_HOLD_CREATED: 'stella_retention_hold.created',
  STELLA_RETENTION_HOLD_RELEASED: 'stella_retention_hold.released',
  STELLA_RETENTION_PURGE_RUN_STARTED: 'stella_retention_purge_run.started',
  STELLA_RETENTION_PURGE_RUN_COMPLETED: 'stella_retention_purge_run.completed',

  // Stella controlled-pilot operative confirmation (Etapa B0) — distinct
  // from stella_ai_consent (DR-005, organizational); this is a per-user
  // acceptance of the pilot's operating rules.
  STELLA_PILOT_CONFIRMATION_ACCEPTED: 'stella_pilot_confirmation.accepted',
  STELLA_PILOT_CONFIRMATION_REVOKED: 'stella_pilot_confirmation.revoked',
  STELLA_PILOT_ACCESS_DENIED: 'stella_pilot_access.denied',

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

  // Outcomes
  OUTCOME_MATERIALITY_UPDATED: 'outcome.materiality_updated',

  // Methodology review matrix (generalized across pipeline steps)
  METHODOLOGY_REVIEW_STARTED: 'methodology_review.started',
  METHODOLOGY_REVIEW_UPDATED: 'methodology_review.updated',
  METHODOLOGY_REVIEW_ITEM_UPSERTED: 'methodology_review_item.upserted',

  // Interoperability — outcome ↔ standard taxonomy crosswalks
  TAXONOMY_MAPPING_CREATED: 'outcome_taxonomy_mapping.created',
  TAXONOMY_MAPPING_DELETED: 'outcome_taxonomy_mapping.deleted',
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
export async function logAuditAction(entry: AuditLogEntry, client: AuditQueryClient = db): Promise<void> {
  // Basic validation
  if (!entry.entityType || !entry.entityId || !entry.action) {
    console.warn('[audit] logAuditAction called with missing required fields', entry)
    return
  }

  await client.insert(auditLogs).values({
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
