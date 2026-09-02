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

  // Financial proxy versions (FIBIU-08 — FIBC-002/010/012)
  FINANCIAL_PROXY_VERSION_CREATED: 'financial_proxy_version.created',
  FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED: 'financial_proxy_version.review_status_changed',

  // Financial proxy versions — rubric evaluation (FIBIU-09 — FIBC-011)
  FINANCIAL_PROXY_VERSION_RUBRIC_EVALUATED: 'financial_proxy_version.rubric_evaluated',
  FINANCIAL_PROXY_VERSION_EXCEPTIONAL_DETERMINATION_RECORDED: 'financial_proxy_version.exceptional_determination_recorded',

  // Financial proxy versions — material change policy (FIBIU-10 — FIBC-013)
  FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE: 'financial_proxy_version.invalidated_by_material_change',

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
  // FIBIU-11 (FIBC-015) — the explicit material/not_material classification,
  // distinct from the legacy 1-5 score's own OUTCOME_MATERIALITY_UPDATED verb.
  OUTCOME_MATERIALITY_CLASSIFIED: 'outcome.materiality_classified',

  // Methodology review matrix (generalized across pipeline steps)
  METHODOLOGY_REVIEW_STARTED: 'methodology_review.started',
  METHODOLOGY_REVIEW_UPDATED: 'methodology_review.updated',
  METHODOLOGY_REVIEW_ITEM_UPSERTED: 'methodology_review_item.upserted',

  // Interoperability — outcome ↔ standard taxonomy crosswalks
  TAXONOMY_MAPPING_CREATED: 'outcome_taxonomy_mapping.created',
  TAXONOMY_MAPPING_DELETED: 'outcome_taxonomy_mapping.deleted',

  // ---------------------------------------------------------------------
  // FIBIU-28 (FIBC-040) — governed audit event contract.
  // ---------------------------------------------------------------------
  // Narrowing AuditLogEntry.action below from `AuditAction | string` to the
  // closed union exposed every raw literal call site that used to typecheck
  // only because the union collapsed to `string`. Each entry here replaces
  // exactly one such literal with a domain-correct entity.verb — see FIB
  // §12 FIBIU-28 RISK note ("~30 sites emitting raw literals today").

  // Projects lifecycle (lib/projects/service.ts)
  PROJECT_CREATED: 'project.created',
  PROJECT_DELETION_REQUESTED: 'project.deletion_requested',
  PROJECT_DELETION_APPROVED: 'project.deletion_approved',
  PROJECT_PAUSED: 'project.paused',
  PROJECT_RESUMED: 'project.resumed',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_DISCOUNT_RATE_UPDATED: 'project.discount_rate_updated',

  // Portfolios (lib/portfolios/service.ts)
  PORTFOLIO_CREATED: 'portfolio.created',

  // SROI run reviews and reports (lib/pipeline/sroi-results.ts)
  SROI_RUN_REVIEW_CREATED: 'sroi_run_review.created',
  SROI_RUN_REVIEW_UPDATED: 'sroi_run_review.updated',
  SROI_RUN_REVIEW_ITEM_UPSERTED: 'sroi_run_review_item.upserted',
  SROI_REPORT_CREATED: 'sroi_report.created',
  SROI_REPORT_SECTION_UPDATED: 'sroi_report_section.updated',
  SROI_REPORT_LOCKED: 'sroi_report.locked',

  // SROI calculation pipeline (lib/pipeline/sroi-calculation.ts, investments.ts)
  //
  // W1-05-RM2 (HPO-DEC-3) — the sealed FIBC-001 literal 'sroi_run.calculated'
  // named a table that does not exist ('sroi_run'); this action's own table
  // is sroi_calculation_runs. Superseded prospectively as a naming/
  // correspondence correction only — the substantive requirement that a
  // successful calculation emits a governed calculation event is unchanged.
  // Historical audit rows under the earlier constant name are immutable and
  // are never rewritten.
  SROI_CALCULATION_RUN_CALCULATED: 'sroi_calculation_run.calculated',
  PROJECT_INVESTMENT_CREATED: 'project_investment.created',
  PROJECT_INVESTMENT_UPDATED: 'project_investment.updated',
  PROJECT_INVESTMENT_ARCHIVED: 'project_investment.archived',
  SROI_ASSIGNMENT_INPUT_CREATED: 'sroi_assignment_input.created',
  SROI_ASSIGNMENT_INPUT_UPDATED: 'sroi_assignment_input.updated',
  SROI_FILTER_SET_CREATED: 'sroi_filter_set.created',
  SROI_FILTER_SET_UPDATED: 'sroi_filter_set.updated',

  // Funders (lib/pipeline/funders.ts)
  FUNDER_CREATED: 'funder.created',

  // Outcome-funder allocations. Two pre-existing services (allocations.ts,
  // outcome-funder-allocations.ts) write the same entityType
  // ('outcome_funder_allocation') under two different verb prefixes
  // ('outcome_funder_allocation.*' and 'allocation.*') — a verb/object
  // mismatch of exactly the kind FIBC-040 names as a defect. Both are
  // reconciled onto the single family below.
  OUTCOME_FUNDER_ALLOCATION_CREATED: 'outcome_funder_allocation.created',
  OUTCOME_FUNDER_ALLOCATION_UPDATED: 'outcome_funder_allocation.updated',
  OUTCOME_FUNDER_ALLOCATION_DELETED: 'outcome_funder_allocation.deleted',
  OUTCOME_FUNDER_ALLOCATION_ARCHIVED: 'outcome_funder_allocation.archived',

  // Corrective annotation — a NEW event referencing a historical audit_logs
  // row without altering it (FIBC-040). See recordAuditCorrection below.
  AUDIT_CORRECTION_RECORDED: 'audit_entry.correction_recorded',

  // ---------------------------------------------------------------------
  // FIBIU-03 (FIBC-002/FIBC-045) — generic domain-object version lineage.
  // ---------------------------------------------------------------------
  INDICATOR_ARCHIVED: 'indicator.archived',
  STAKEHOLDER_GROUP_ARCHIVED: 'stakeholder_group.archived',

  // ---------------------------------------------------------------------
  // W1-05-RM1 R-1 (FIBC-040) — verb/object correspondence correction.
  // ---------------------------------------------------------------------
  // indicators.ts, outcomes.ts, stakeholders.ts and narratives.ts recorded
  // their own object's creation/update under the unrelated organization.*
  // verb — a governed vocabulary value, but not the domain-correct one for
  // the transition actually performed, exactly the defect FIBC-040 names.
  // Corrected prospectively; the historical organization.* rows those
  // services wrote are never rewritten.
  INDICATOR_CREATED: 'indicator.created',
  OUTCOME_CREATED: 'outcome.created',
  STAKEHOLDER_GROUP_CREATED: 'stakeholder_group.created',
  IMPACT_NARRATIVE_CREATED: 'impact_narrative.created',
  IMPACT_NARRATIVE_UPDATED: 'impact_narrative.updated',

  // ---------------------------------------------------------------------
  // FIBIU-29 (FIBC-041) — governed permission-denial event.
  // ---------------------------------------------------------------------
  // The single Wave 1 denial event: FIBIU-29 hard-depends on FIBIU-28
  // because "denial events need governed verbs" (FIB §12). Wave 1's only
  // consumer of that dependency is canApproveRunMethodology's segregation-
  // of-duties enforcement (V-04) — the other five discrete permissions have
  // no Wave 1 caller, so no generic "audit every denial" vocabulary is
  // introduced here.
  SROI_CALCULATION_RUN_METHODOLOGY_APPROVAL_DENIED: 'sroi_calculation_run.methodology_approval_denied',

  // ---------------------------------------------------------------------
  // FIBIU-04 (FIBC-005/FIBC-006) — evidence version lineage and content
  // persistence.
  // ---------------------------------------------------------------------
  EVIDENCE_VERSION_CREATED: 'evidence_version.created',
  EVIDENCE_VERSION_INTEGRITY_VERIFIED: 'evidence_version.integrity_verified',

  // ---------------------------------------------------------------------
  // FIBIU-05 (FIBC-007) — evidence sensitivity and treatment. Both are
  // contentModifying: they change what a version's classification/treatment
  // fields say the evidence IS, and every output surface (report, export,
  // public, Stella) governs exposure on the resulting value.
  // ---------------------------------------------------------------------
  EVIDENCE_VERSION_SENSITIVITY_CLASSIFIED: 'evidence_version.sensitivity_classified',
  EVIDENCE_VERSION_TREATMENT_RECORDED: 'evidence_version.treatment_recorded',

  // ---------------------------------------------------------------------
  // FIBIU-06 (FIBC-008) — human evidence sufficiency determination.
  // ---------------------------------------------------------------------
  EVIDENCE_SUFFICIENCY_DETERMINATION_RECORDED: 'evidence_sufficiency_determination.recorded',

  // ---------------------------------------------------------------------
  // FIBIU-07 (FIBC-009) — governed evidence content erasure. Three families
  // for the operation's request and its two possible outcomes; `completed`
  // covers both erasure_complete and erasure_partial (afterJson.erasureState
  // disambiguates) since both are "the operation ran and reached a terminal
  // state", as opposed to `blocked`, where nothing was erased at all.
  // ---------------------------------------------------------------------
  EVIDENCE_TOMBSTONE_ERASURE_REQUESTED: 'evidence_tombstone.erasure_requested',
  EVIDENCE_TOMBSTONE_ERASURE_COMPLETED: 'evidence_tombstone.erasure_completed',
  EVIDENCE_TOMBSTONE_ERASURE_BLOCKED: 'evidence_tombstone.erasure_blocked',
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
  action: AuditAction
  beforeJson?: Record<string, unknown>
  afterJson?: Record<string, unknown>
  reason?: string
  ipAddress?: string
  userAgent?: string
  /**
   * FIBC-040 — set on a transition that MODIFIES existing methodological
   * content (never on a creation, and never on a pure status/lifecycle
   * transition that carries no reconstructable prior content). When true,
   * `beforeJson` becomes mandatory and logAuditAction fails closed if it is
   * absent, rather than recording a content change with nothing to
   * reconstruct the transition against.
   */
  contentModifying?: boolean
}

// ---------------------------------------------------------------------------
// Fail-closed contract errors
// ---------------------------------------------------------------------------

/**
 * FIBC-040 — a governed audit write that does not satisfy the contract must
 * never appear to have succeeded. Thrown, never swallowed, by
 * logAuditAction. Callers that treat audit persistence as a precondition of
 * delivery (FIBC-029) are expected to let this propagate; callers that log
 * fire-and-forget (e.g. Stella's logStellaAudit) already catch and report
 * every error this function can throw, this one included.
 */
export class AuditContractViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditContractViolationError'
  }
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
  // Fail-closed validation (FIBC-040): a governed methodological transition
  // must not appear successful if the required audit contract was not
  // satisfied. This used to console.warn and silently return — the audit
  // trail would then not be written and NOTHING said so.
  if (!entry.entityType || !entry.entityId || !entry.action) {
    throw new AuditContractViolationError(
      'logAuditAction requires entityType, entityId and action; refusing to record an incomplete governed audit event.'
    )
  }
  if (entry.contentModifying && !entry.beforeJson) {
    throw new AuditContractViolationError(
      `logAuditAction: action "${entry.action}" modifies existing content but supplies no beforeJson — ` +
        'FIBC-040 requires enough prior state to reconstruct the transition.'
    )
  }

  await db.insert(auditLogs).values({
    organizationId: entry.organizationId,
    projectId: entry.projectId,
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

// ---------------------------------------------------------------------------
// Corrective annotation (FIBC-040)
// ---------------------------------------------------------------------------

export interface AuditCorrectionInput {
  organizationId?: string
  projectId?: string
  actorUserId?: string
  /** The audit_logs.id of the historical event this correction concerns. */
  correctedEventId: string
  /** What the action should have been, when the original verb was wrong. */
  correctedAction?: AuditAction
  /** Why this correction is being recorded. */
  reason: string
  /** Any additional structured context for the correction. */
  details?: Record<string, unknown>
}

/**
 * Records a correction for a historical audit_logs row WITHOUT modifying it.
 *
 * FIBC-040: "historically misclassified events are preserved as originals
 * and may be complemented by a traceable corrective annotation without
 * altering the source event." This INSERTs a new row — entityType
 * 'audit_log_entry', entityId set to the corrected row's id — so the
 * reference is queryable through the same audit_logs table with no new
 * schema object. The original row is never UPDATEd (the append-only trigger
 * would reject that regardless).
 */
export async function recordAuditCorrection(input: AuditCorrectionInput): Promise<void> {
  await logAuditAction({
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    entityType: 'audit_log_entry',
    entityId: input.correctedEventId,
    action: AUDIT_ACTIONS.AUDIT_CORRECTION_RECORDED,
    reason: input.reason,
    afterJson: {
      correctedEventId: input.correctedEventId,
      correctedAction: input.correctedAction,
      ...input.details,
    },
  })
}
