// lib/stella/context/build-reviewer-context.ts
// Fase 5b / WS6 (Fable Moonshot): role-parameterized context builders for the
// reviewer roles (proxy_reviewer, evidence_reviewer, audit_assistant).
//
// RK-17 fix: the three roles previously shared the validator's calculation
// context verbatim, so the prompts demanded data the context never carried
// (proxy source URLs and reference years, evidence integrityVerified, run
// review status). Each role now receives the shared metadata-only base PLUS a
// role-specific enrichment, all org-scoped with the same double filters and
// minimization rules as the base builders (sanitizeString on free text, no
// raw file content, no full URLs — domain only, no PII, no snapshotJson).
//
// Backward compatibility: the `role` parameter is optional. When omitted
// (current call site app/actions/stella/reviewer.ts:87 passes two arguments)
// ALL enrichments are built, so every role's prompt finds its data. WIRING
// NOTE for the coordinator: pass the requested role as the third argument in
// app/actions/stella/reviewer.ts (`buildReviewerContext(projectId,
// ctx.organization.id, role)`) to enable per-role data minimization.

import { db } from '@/db/client'
import {
  outcomeProxyAssignments,
  financialProxies,
  proxySources,
  outcomes,
  evidenceItems,
  sroiRunReviews,
} from '@/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { sanitizeString, hasForbiddenPattern } from './sanitize'
import { buildValidatorContext, StellaBuildValidatorContextError } from './build-validator-context'
import type { StellaProjectContext } from './types'

export { StellaBuildValidatorContextError as StellaBuildReviewerContextError }

/** Canonical reviewer-role union. Re-exported by prompts/reviewer-system.ts. */
export type ReviewerRole = 'proxy_reviewer' | 'evidence_reviewer' | 'audit_assistant'

/**
 * Proxy enrichment for the proxy_reviewer: value + currency, source name and
 * domain-only URL, reference year, approval (review) status, and the outcome
 * this assignment values (id + sanitized title) so appropriateness claims are
 * groundable. Never the full source URL (path/query could carry tokens or
 * tracking), never descriptions or justifications.
 */
export interface ReviewerProxyDetail {
  id: string
  name: string
  value: string | null
  currency: string | null
  sourceName: string
  /** Hostname only — the full URL is never sent to the model. */
  sourceUrlDomain: string | null
  referenceYear: number | null
  /** financial_proxies.review_status: suggested | pending_review | approved | rejected | archived */
  approvalStatus: string
  confidenceLevel: 'high' | 'medium' | 'low' | null
  methodologicalRisk: 'low' | 'medium' | 'high' | null
  /** Outcome this assignment values (outcome_proxy_assignments.outcome_id). */
  outcomeId: string
  /** Sanitized outcome title — never the outcome description. */
  outcomeTitle: string
}

/**
 * Evidence enrichment for the evidence_reviewer: integrity verification state,
 * confidence score and linkage. Metadata only — no filePath, no raw content.
 */
export interface ReviewerEvidenceDetail {
  id: string
  title: string
  type: 'file' | 'url' | 'text'
  status: 'draft' | 'under_review' | 'approved' | 'rejected' | 'archived'
  integrityVerified: boolean | null
  integrityVerifiedAt: string | null
  confidenceScore: number | null
  outcomeId: string | null
  indicatorId: string | null
  /**
   * Sanitized title of the linked outcome (null when unlinked) — per-outcome
   * coverage claims need more grounding than a boolean.
   */
  relatedOutcomeTitle: string | null
  createdAt: string
}

/** Run-review roll-up for the audit_assistant (sroi_run_reviews). */
export interface ReviewerRunReviewSummary {
  reviewCount: number
  latestStatus: string | null
  latestReadinessScore: number | null
  latestReviewedAt: string | null
}

/**
 * The reviewer context: the shared metadata-only project context plus the
 * role-specific enrichments. Enrichment fields are optional — only the fields
 * for the requested role are populated (all of them when role is omitted).
 */
export interface ReviewerContext extends StellaProjectContext {
  reviewerRole: ReviewerRole | null
  proxyDetails?: ReviewerProxyDetail[]
  evidenceDetails?: ReviewerEvidenceDetail[]
  runReviewSummary?: ReviewerRunReviewSummary
}

/**
 * Sanitize a free-text label for the model: injection-bearing values are
 * replaced by a fixed placeholder (same policy as evidence titles), clean
 * values are control-char-stripped and truncated.
 */
function sanitizeLabel(value: string, placeholder: string, maxLength: number): string {
  return hasForbiddenPattern(value) ? placeholder : sanitizeString(value, maxLength)
}

/**
 * Reduce a stored source URL to its hostname. Full URLs never reach the
 * model: paths and query strings may embed document names, tokens or PII.
 */
export function extractUrlDomain(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const hostname = new URL(url).hostname
    return hostname ? sanitizeString(hostname, 100) : null
  } catch {
    return null
  }
}

async function buildProxyDetails(
  projectId: string,
  organizationId: string
): Promise<ReviewerProxyDetail[]> {
  // Org isolation double filter: assignment row must match BOTH the project
  // and the requesting organization, and be active.
  const rows = await db
    .select({
      proxyId: outcomeProxyAssignments.proxyId,
      name: financialProxies.name,
      value: financialProxies.value,
      currency: financialProxies.currency,
      referenceYear: financialProxies.referenceYear,
      reviewStatus: financialProxies.reviewStatus,
      confidenceLevel: financialProxies.confidenceLevel,
      methodologicalRisk: financialProxies.methodologicalRisk,
      sourceName: proxySources.name,
      sourceUrl: proxySources.url,
      outcomeId: outcomeProxyAssignments.outcomeId,
      outcomeTitle: outcomes.title,
    })
    .from(outcomeProxyAssignments)
    .innerJoin(financialProxies, eq(financialProxies.id, outcomeProxyAssignments.proxyId))
    .innerJoin(proxySources, eq(proxySources.id, financialProxies.sourceId))
    .innerJoin(outcomes, eq(outcomes.id, outcomeProxyAssignments.outcomeId))
    .where(
      and(
        eq(outcomeProxyAssignments.projectId, projectId),
        eq(outcomeProxyAssignments.organizationId, organizationId),
        eq(outcomeProxyAssignments.assignmentStatus, 'active')
      )
    )

  return rows.map((row) => ({
    id: row.proxyId,
    name: sanitizeLabel(row.name, '[Proxy]', 200),
    value: row.value ?? null,
    currency: row.currency ?? null,
    sourceName: sanitizeLabel(row.sourceName, '[Fuente]', 150),
    sourceUrlDomain: extractUrlDomain(row.sourceUrl),
    referenceYear: row.referenceYear ?? null,
    approvalStatus: row.reviewStatus,
    confidenceLevel: (row.confidenceLevel as ReviewerProxyDetail['confidenceLevel']) ?? null,
    methodologicalRisk:
      (row.methodologicalRisk as ReviewerProxyDetail['methodologicalRisk']) ?? null,
    outcomeId: row.outcomeId,
    outcomeTitle: sanitizeLabel(row.outcomeTitle, '[Outcome]', 200),
  }))
}

async function buildEvidenceDetails(
  projectId: string,
  organizationId: string
): Promise<ReviewerEvidenceDetail[]> {
  const rows = await db
    .select({
      id: evidenceItems.id,
      title: evidenceItems.title,
      type: evidenceItems.type,
      status: evidenceItems.status,
      integrityVerified: evidenceItems.integrityVerified,
      integrityVerifiedAt: evidenceItems.integrityVerifiedAt,
      confidenceScore: evidenceItems.confidenceScore,
      outcomeId: evidenceItems.outcomeId,
      indicatorId: evidenceItems.indicatorId,
      relatedOutcomeTitle: outcomes.title,
      createdAt: evidenceItems.createdAt,
      // filePath intentionally excluded — never send storage paths to Gemini
    })
    .from(evidenceItems)
    .leftJoin(outcomes, eq(outcomes.id, evidenceItems.outcomeId))
    .where(
      and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.organizationId, organizationId))
    )

  return rows.map((row) => ({
    id: row.id,
    title: sanitizeLabel(row.title, '[Evidence item]', 150),
    type: row.type as ReviewerEvidenceDetail['type'],
    status: row.status as ReviewerEvidenceDetail['status'],
    integrityVerified: row.integrityVerified ?? null,
    integrityVerifiedAt: row.integrityVerifiedAt ? row.integrityVerifiedAt.toISOString() : null,
    confidenceScore: row.confidenceScore ?? null,
    outcomeId: row.outcomeId ?? null,
    indicatorId: row.indicatorId ?? null,
    relatedOutcomeTitle: row.relatedOutcomeTitle
      ? sanitizeLabel(row.relatedOutcomeTitle, '[Outcome]', 200)
      : null,
    createdAt: row.createdAt.toISOString(),
  }))
}

async function buildRunReviewSummary(
  projectId: string,
  organizationId: string
): Promise<ReviewerRunReviewSummary> {
  const rows = await db
    .select({
      status: sroiRunReviews.status,
      readinessScore: sroiRunReviews.readinessScore,
      reviewedAt: sroiRunReviews.reviewedAt,
      createdAt: sroiRunReviews.createdAt,
    })
    .from(sroiRunReviews)
    .where(
      and(eq(sroiRunReviews.projectId, projectId), eq(sroiRunReviews.organizationId, organizationId))
    )
    .orderBy(desc(sroiRunReviews.createdAt))

  const latest = rows[0] ?? null
  return {
    reviewCount: rows.length,
    latestStatus: latest?.status ?? null,
    latestReadinessScore: latest?.readinessScore ?? null,
    latestReviewedAt: latest?.reviewedAt ? latest.reviewedAt.toISOString() : null,
  }
}

/**
 * Build the context for a reviewer role. The base is the shared metadata-only
 * project context (same org-boundary check and minimization as the validator);
 * the enrichment depends on the role:
 *
 * - proxy_reviewer    → proxyDetails (value/currency, source name + domain,
 *                       reference year, approval status, assigned outcome)
 * - evidence_reviewer → evidenceDetails (integrityVerified/-At, confidence
 *                       score, status, linkage incl. outcome title)
 * - audit_assistant   → runReviewSummary (sroi_run_reviews roll-up) on top of
 *                       the calculation snapshot the base already carries
 *
 * When `role` is omitted, all three enrichments are included (legacy call
 * sites keep working and every prompt finds its data).
 */
export async function buildReviewerContext(
  projectId: string,
  organizationId: string,
  role?: ReviewerRole
): Promise<ReviewerContext> {
  // The 'calculation' step satisfies the validator builder's step gate; the
  // resulting base context is the whole project regardless of role.
  // RK-08: the base already carries `sensitivePopulations` (computed by
  // buildValidatorContext from stakeholder types, narrative and outcome
  // titles) — the spread propagates it to every reviewer role unchanged.
  const base = await buildValidatorContext(projectId, organizationId, 'calculation')

  const context: ReviewerContext = { ...base, reviewerRole: role ?? null }

  if (!role || role === 'proxy_reviewer') {
    context.proxyDetails = await buildProxyDetails(projectId, organizationId)
  }
  if (!role || role === 'evidence_reviewer') {
    context.evidenceDetails = await buildEvidenceDetails(projectId, organizationId)
  }
  if (!role || role === 'audit_assistant') {
    context.runReviewSummary = await buildRunReviewSummary(projectId, organizationId)
  }

  return context
}
