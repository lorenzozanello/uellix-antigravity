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

  // Stella runtime audit trail (WS3b). Metadata only — payloads must NEVER
  // include prompt, context or model response content (ids/codes/counts only).
  STELLA_INVOKED: 'stella.invoked',
  STELLA_DENIED: 'stella.denied',
  STELLA_INTEGRITY_REJECTED: 'stella.integrity_rejected',
  STELLA_DECISION_RECORDED: 'stella.decision_recorded',

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
  // M2-COMP-01. A file upload that reserved a row and never produced stored
  // bytes. Distinct from EVIDENCE_ARCHIVED because the two archive the same row
  // for opposite reasons: one is a reviewer retiring real evidence, this one is
  // the platform withdrawing a row whose file does not exist. Collapsing them
  // would make "why is there no file here?" unanswerable from the trail — and
  // this row is the ONLY durable record when the compensation itself fails,
  // since nothing else survives to say a row was left behind.
  EVIDENCE_UPLOAD_FAILED: 'evidence_item.upload_failed',
  // G-01. One attempt to index an evidence file into the governed grounding
  // corpus — recorded whether it indexed, was refused or failed, because "who
  // tried to change what a reviewer can be shown" is the question this row
  // exists to answer.
  EVIDENCE_INDEXED: 'evidence_item.indexed',

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
 * ---------------------------------------------------------------------------
 * CORRECTION (G1-B, Fable finding): THIS DOES NOT BYPASS RLS.
 * ---------------------------------------------------------------------------
 * This comment used to read "uses the service-level Drizzle client (bypasses
 * RLS) — this is intentional. Audit logging must always succeed regardless of
 * the caller's RLS context." Every clause of that was false after the runtime
 * cutover, and believing it is how a dead audit path stayed invisible.
 *
 * What actually happens: `db` is the PROXY exported by db/client.ts. Inside an
 * identity context it resolves to the drizzle handle bound to that request's
 * transaction — connected as `uellix_app`, which is NOBYPASSRLS, owns nothing,
 * and is subject to every policy on `public.audit_logs`. Outside a context it
 * falls back to a claimless pooled handle that sees no rows.
 *
 * TWO CONSEQUENCES FOR CALLERS, and both are requirements rather than advice:
 *
 *   1. A Stella audit write MUST run inside `withOrganizationDatabaseContext`
 *      (or `withDatabaseIdentityContext`). The INSERT policy's WITH CHECK reads
 *      `auth.uid()` and `current_user_org_ids()`, both of which resolve from
 *      `request.jwt.claims` — a setting only the identity context installs.
 *      Outside one, `auth.uid()` is NULL and the row is refused. The five
 *      Stella actions do this: see `logStellaAudit`.
 *   2. It can FAIL, and it does. The policy must exist on the target database:
 *      it is created locally by prepared stella_0005c and on the hosted side by
 *      prepared stella_hosted_0008. Where the policy is absent, RLS refuses
 *      every append even though the table GRANT is present.
 *
 * "Audit logging must always succeed" was never a property of this function. It
 * is a property the CALLERS provide — by treating the write as fire-and-forget
 * so a failure cannot change a user-facing result — and G1-B made that failure
 * observable (`reportStellaFailure(..., 'AUDIT_ERROR', ...)`) instead of silent.
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
