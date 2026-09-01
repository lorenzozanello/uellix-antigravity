// lib/pipeline/sroi-results.ts
// Sprint 7B – Services for SROI Results Hardening & Report Foundation
// Implements calculation run detail, comparison, methodological reviews and report drafts.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { requireOrganizationAccess, type OrganizationContext } from '@/lib/auth/session';
import { isInReviewSet, canApproveRunMethodology, type Role } from '@/lib/auth/permissions';
import {
  sroiCalculationRuns,
  sroiCalculationLineItems,
  sroiRunReviews,
  sroiRunReviewItems,
  sroiReports,
  sroiReportSections,
  projects,
  evidenceItems,
  outcomeProxyAssignments,
} from '@/db/schema';
import { getLatestSufficiencyDeterminationsByOutcomeIds } from '@/lib/pipeline/evidence-sufficiency';
import { z } from 'zod';
import { getVariantSectionTypes } from '@/lib/reports/report-variants';
import {
  buildReportNumericAuthority,
  validateReportNarrativeAuthority,
  type ReportNumericAuthority,
  type NarrativeReferenceAuthority,
} from '@/lib/stella/schemas/composer-numeric-guard';

// ---------------------------------------------------------------------------
// Helper schemas
// ---------------------------------------------------------------------------

const ReviewInputSchema = z.object({
  status: z.enum(['draft', 'reviewed', 'approved', 'flagged']).default('draft'),
  readinessScore: z.number().int().min(0).max(100).optional(),
  overallNotes: z.string().optional(),
});

type ReviewInput = z.infer<typeof ReviewInputSchema>;

const ReviewItemInputSchema = z.object({
  itemKey: z.string().min(1),
  status: z.enum(['pass', 'warning', 'fail', 'not_applicable']).default('warning'),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  notes: z.string().optional(),
});

type ReviewItemInput = z.infer<typeof ReviewItemInputSchema>;

const ReportDraftInputSchema = z.object({
  title: z.string().min(1),
  includeFunderBreakdown: z.boolean().optional().default(false),
  reportVariant: z.enum(['funder', 'methodological', 'audit']).optional().default('audit'),
});

type ReportDraftInput = z.input<typeof ReportDraftInputSchema>;

const ReportSectionInputSchema = z.object({
  title: z.string().min(1),
  content: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

type ReportSectionInput = z.infer<typeof ReportSectionInputSchema>;

// ---------------------------------------------------------------------------
// Authorization helper
// ---------------------------------------------------------------------------

async function authorizeProject(projectId: string) {
  const ctx = await requireOrganizationAccess();
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)));
  if (proj.length === 0) throw new Error('Project not found or not owned');
  return ctx;
}

// ---------------------------------------------------------------------------
// CL-1 (MSC-02 HIGH-1) — report narrative numeric authority
//
// Every material numeric claim in persisted/locked report narrative must
// validate server-side against the calculation snapshot belonging to THE RUN
// THIS REPORT IS PINNED TO (report.calculationRunId) — never "whatever run
// happens to be latest for the project", and never merely because the
// Composer's own guard once approved a draft: a human can edit the text
// freely (or type it from scratch) after that point. This is checked again
// both when a section is saved and, independently, right before a report is
// locked (content may have changed again since it was last saved-and-valid).
// ---------------------------------------------------------------------------

type PinnedReportRun = typeof sroiCalculationRuns.$inferSelect;

async function getPinnedReportRun(
  ctx: { organization: { id: string } },
  report: { calculationRunId: string; projectId: string },
): Promise<PinnedReportRun | null> {
  return db
    .select()
    .from(sroiCalculationRuns)
    .where(
      and(
        eq(sroiCalculationRuns.id, report.calculationRunId),
        eq(sroiCalculationRuns.projectId, report.projectId),
        eq(sroiCalculationRuns.organizationId, ctx.organization.id),
      )
    )
    .then((rows) => rows[0] ?? null);
}

function getReportNumericAuthority(run: PinnedReportRun | null): ReportNumericAuthority {
  if (!run) return buildReportNumericAuthority({});
  const money: unknown[] = [run.totalInvestment, run.grossSocialValue, run.netSocialValue];
  const percentages: unknown[] = [];
  const sroiRatios: unknown[] = [run.sroiRatio];
  const snapshot = run.snapshotJson;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return buildReportNumericAuthority({ money, percentages, sroiRatios });
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  money.push(snapshotRecord.unattributedNsvUsd);

  const funders = snapshotRecord.fundersBreakdown;
  if (Array.isArray(funders)) {
    for (const funder of funders) {
      if (!funder || typeof funder !== 'object' || Array.isArray(funder)) continue;
      const row = funder as Record<string, unknown>;
      money.push(row.investmentUsd, row.attributedNsvUsd);
      sroiRatios.push(row.sroiRatio);
    }
  }

  const assignments = snapshotRecord.assignments;
  if (Array.isArray(assignments)) {
    for (const assignment of assignments) {
      if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) continue;
      const filters = (assignment as Record<string, unknown>).filters;
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) continue;
      const filterRecord = filters as Record<string, unknown>;
      percentages.push(
        filterRecord.deadweightPct,
        filterRecord.attributionPct,
        filterRecord.displacementPct,
        filterRecord.dropoffPct,
      );
    }
  }
  return buildReportNumericAuthority({ money, percentages, sroiRatios });
}

async function getReportNarrativeReferenceAuthority(
  ctx: { organization: { id: string } },
  report: { calculationRunId: string; projectId: string },
  pinnedRun: PinnedReportRun | null,
): Promise<NarrativeReferenceAuthority> {
  const evidence = await db
    .select({ id: evidenceItems.id })
    .from(evidenceItems)
    .where(and(
      eq(evidenceItems.projectId, report.projectId),
      eq(evidenceItems.organizationId, ctx.organization.id),
    ));
  const snapshot = pinnedRun?.snapshotJson as Record<string, unknown> | null | undefined;
  const assignments = snapshot?.assignments as Array<{ proxyId?: unknown }> | undefined;

  return {
    evidenceIds: evidence.map((item) => item.id),
    proxyIds: (assignments ?? [])
      .map((assignment) => assignment.proxyId)
      .filter((proxyId): proxyId is string => typeof proxyId === 'string'),
  };
}

/**
 * Single deterministic report-boundary decision shared by save and lock. Its
 * inputs are already derived on the server from the pinned run and project;
 * callers never accept a client-provided snapshot or reference allowlist.
 */
function validateSectionNarrativeIntegrity(
  title: string,
  content: string,
  numericAuthority: ReportNumericAuthority,
  referenceAuthority: NarrativeReferenceAuthority,
) {
  return validateReportNarrativeAuthority({ title, content, numericAuthority, referenceAuthority });
}

// ---------------------------------------------------------------------------
// 1. Calculation Run Detail (read‑only)
// ---------------------------------------------------------------------------

export async function getCalculationRunDetail(projectId: string, runId: string) {
  const ctx = await authorizeProject(projectId);
  const run = await db
    .select()
    .from(sroiCalculationRuns)
    .where(
      and(
        eq(sroiCalculationRuns.id, runId),
        eq(sroiCalculationRuns.projectId, projectId),
        eq(sroiCalculationRuns.organizationId, ctx.organization.id)
      )
    );
  if (run.length === 0) throw new Error('Calculation run not found');
  const lineItems = await db
    .select()
    .from(sroiCalculationLineItems)
    .where(eq(sroiCalculationLineItems.runId, runId));
  const snapshot = run[0].snapshotJson as Record<string, unknown> | null; // column name from schema
  const currency = run[0].currency ?? 'USD';
  return {
    run: run[0],
    lineItems,
    snapshotJson: snapshot,
    currency,
    projectContext: { id: projectId, organizationId: ctx.organization.id },
  };
}

// ---------------------------------------------------------------------------
// 2. Compare two calculation runs
// ---------------------------------------------------------------------------

export async function compareCalculationRuns(projectId: string, runIdA: string, runIdB: string) {
  const ctx = await authorizeProject(projectId);
  const [runA, runB] = await Promise.all([
    db
      .select()
      .from(sroiCalculationRuns)
      .where(
        and(
          eq(sroiCalculationRuns.id, runIdA),
          eq(sroiCalculationRuns.projectId, projectId),
          eq(sroiCalculationRuns.organizationId, ctx.organization.id)
        )
      )
      .then(r => r[0]),
    db
      .select()
      .from(sroiCalculationRuns)
      .where(
        and(
          eq(sroiCalculationRuns.id, runIdB),
          eq(sroiCalculationRuns.projectId, projectId),
          eq(sroiCalculationRuns.organizationId, ctx.organization.id)
        )
      )
      .then(r => r[0]),
  ]);
  if (!runA || !runB) throw new Error('One or both runs not found');

  const warning = runA.currency !== runB.currency ? { currencyMismatch: true, message: 'Different currencies – no FX conversion' } : null;

  const [lineItemsA, lineItemsB] = await Promise.all([
    db.select().from(sroiCalculationLineItems).where(eq(sroiCalculationLineItems.runId, runIdA)),
    db.select().from(sroiCalculationLineItems).where(eq(sroiCalculationLineItems.runId, runIdB)),
  ]);

  const valA_inv = parseFloat(runA.totalInvestment || '0');
  const valB_inv = parseFloat(runB.totalInvestment || '0');
  const valA_gross = parseFloat(runA.grossSocialValue || '0');
  const valB_gross = parseFloat(runB.grossSocialValue || '0');
  const valA_net = parseFloat(runA.netSocialValue || '0');
  const valB_net = parseFloat(runB.netSocialValue || '0');
  const valA_ratio = parseFloat(runA.sroiRatio || '0');
  const valB_ratio = parseFloat(runB.sroiRatio || '0');

  return {
    totalInvestment: valA_inv - valB_inv,
    grossSocialValue: valA_gross - valB_gross,
    netSocialValue: valA_net - valB_net,
    sroiRatio: valA_ratio - valB_ratio,
    lineItemCount: lineItemsA.length - lineItemsB.length,
    version: runA.version - runB.version,
    status: runA.status,
    calculatedAt: runA.calculatedAt,
    currency: runA.currency,
    warning,
  };
}

// ---------------------------------------------------------------------------
// 3. Methodological Reviews
// ---------------------------------------------------------------------------

/**
 * FIBIU-29 (FIBC-041) / W1-05-RM1 R-5 — the single shared segregation-of-duties
 * enforcement point for both the CREATE and UPDATE paths into an 'approved'
 * review, so the invariant cannot drift between the two call sites the way it
 * did before this remediation (createSroiRunReview never checked it at all).
 *
 * No-op unless targetStatus === 'approved'. Evaluates two DISTINCT invariants:
 *
 *   I1 — canApproveRunMethodology(actorRole, actorIsRunAuthor) must be true.
 *        The ACTOR performing this call must not be the run's own author.
 *   I2 — the resulting row must never have reviewer_id = run.calculated_by.
 *        The REVIEW's own reviewerId field (who it is attributed to as
 *        reviewer) must not equal the run's author, independent of who the
 *        current actor is — updateSroiRunReview lets any review-set member
 *        approve a review row that was created (and reviewer-attributed) by
 *        someone else, so I1 alone cannot see this case.
 *
 * On denial, the FIBIU-29→FIBIU-28 governed denial event is written and
 * awaited BEFORE the throw (FIBC-040 fail-closed): if the audit write itself
 * fails, that exception propagates and the approval is rejected regardless.
 */
async function assertRunMethodologyApprovalAllowed(params: {
  ctx: OrganizationContext
  projectId: string
  calculationRunId: string
  targetStatus: string | undefined
  reviewerId: string | undefined
  path: 'create' | 'update'
  beforeJson?: Record<string, unknown>
}): Promise<void> {
  const { ctx, projectId, calculationRunId, targetStatus, reviewerId, path, beforeJson } = params
  if (targetStatus !== 'approved') return

  const run = await db
    .select({ calculatedBy: sroiCalculationRuns.calculatedBy })
    .from(sroiCalculationRuns)
    .where(
      and(
        eq(sroiCalculationRuns.id, calculationRunId),
        eq(sroiCalculationRuns.projectId, projectId),
        eq(sroiCalculationRuns.organizationId, ctx.organization.id)
      )
    );
  const runAuthorUserId = run[0]?.calculatedBy ?? null;
  const actorIsRunAuthor = runAuthorUserId !== null && runAuthorUserId === ctx.user.id;
  const actorRole = ctx.membership.role as Role;

  const i1Ok = canApproveRunMethodology(actorRole, actorIsRunAuthor);
  const i2Ok = reviewerId === undefined || runAuthorUserId === null || reviewerId !== runAuthorUserId;
  if (i1Ok && i2Ok) return;

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_calculation_run',
    entityId: calculationRunId,
    action: AUDIT_ACTIONS.SROI_CALCULATION_RUN_METHODOLOGY_APPROVAL_DENIED,
    contentModifying: false,
    reason:
      'canApproveRunMethodology denegado (FIBC-041 / V-04): el aprobador no puede ser el autor de la corrida',
    ...(beforeJson ? { beforeJson } : {}),
    afterJson: {
      deniedPermission: 'canApproveRunMethodology',
      attemptedStatus: 'approved',
      calculationRunId,
      runAuthorUserId,
      attemptedReviewerId: reviewerId ?? null,
      actorRole,
      path,
      violatedInvariant: !i1Ok ? 'I1' : 'I2',
    },
  });

  throw new Error('A reviewer cannot approve the methodology of their own run');
}

/**
 * FIBIU-06 (FIBC-008) — "approval eligibility additionally requires ... an
 * explicit human determination per monetized outcome". The existing
 * "≥1 non-rejected evidence" gate (lib/pipeline/sroi-calculation.ts) is
 * retained unchanged as the minimum for preliminary work; THIS is the hard
 * block, at run-review approval, the same call-site shape as
 * assertRunMethodologyApprovalAllowed. No-op unless targetStatus ===
 * 'approved'. "Monetized" is approximated, as it already is at readiness,
 * by an active proxy assignment — FIBIU-12's formal monetization
 * disposition (FIBDB-009) is a later Wave 2 unit this one hard-depends on
 * FIBIU-04 only, not FIBIU-12.
 */
async function assertEvidenceSufficiencyForApproval(params: {
  projectId: string;
  targetStatus: string | undefined;
}): Promise<void> {
  const { projectId, targetStatus } = params;
  if (targetStatus !== 'approved') return;

  const assignments = await db
    .select({ outcomeId: outcomeProxyAssignments.outcomeId })
    .from(outcomeProxyAssignments)
    .where(
      and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.assignmentStatus, 'active'))
    );
  const activeOutcomeIds = [...new Set(assignments.map((a) => a.outcomeId))];
  if (activeOutcomeIds.length === 0) return;

  const [approvedEvidenceRows, determinationsByOutcome] = await Promise.all([
    db
      .select({ outcomeId: evidenceItems.outcomeId })
      .from(evidenceItems)
      .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.status, 'approved'), inArray(evidenceItems.outcomeId, activeOutcomeIds))),
    getLatestSufficiencyDeterminationsByOutcomeIds(activeOutcomeIds),
  ]);
  const outcomesWithApprovedEvidence = new Set(approvedEvidenceRows.map((r) => r.outcomeId));

  const undetermined: string[] = [];
  for (const outcomeId of activeOutcomeIds) {
    const determination = determinationsByOutcome.get(outcomeId);
    const hasApprovedEvidence = outcomesWithApprovedEvidence.has(outcomeId);
    if (!hasApprovedEvidence || !determination || determination.determination !== 'sufficient') {
      undetermined.push(outcomeId);
    }
  }

  if (undetermined.length > 0) {
    throw new Error(
      `EVIDENCE_SUFFICIENCY_UNDETERMINED: ${undetermined.length} monetized outcome(s) lack ≥1 approved evidence and/or a sufficient human determination`
    );
  }
}

export async function createSroiRunReview(projectId: string, runId: string, input: ReviewInput) {
  const ctx = await authorizeProject(projectId);
  if (!isInReviewSet(ctx.membership.role as Role)) throw new Error('Insufficient role to create review');

  const run = await db
    .select()
    .from(sroiCalculationRuns)
    .where(
      and(
        eq(sroiCalculationRuns.id, runId),
        eq(sroiCalculationRuns.projectId, projectId),
        eq(sroiCalculationRuns.organizationId, ctx.organization.id)
      )
    );
  if (run.length === 0) throw new Error('Run not found');

  const validated = ReviewInputSchema.parse(input);

  await assertRunMethodologyApprovalAllowed({
    ctx,
    projectId,
    calculationRunId: runId,
    targetStatus: validated.status,
    reviewerId: ctx.user.id,
    path: 'create',
  });
  await assertEvidenceSufficiencyForApproval({ projectId, targetStatus: validated.status });

  const inserted = await db
    .insert(sroiRunReviews)
    .values({
      organizationId: ctx.organization.id,
      projectId,
      calculationRunId: runId,
      reviewerId: ctx.user.id,
      status: validated.status,
      readinessScore: validated.readinessScore,
      overallNotes: validated.overallNotes,
      createdBy: ctx.user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_run_review',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.SROI_RUN_REVIEW_CREATED,
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  });
  return inserted[0];
}

export async function updateSroiRunReview(projectId: string, reviewId: string, input: ReviewInput) {
  const ctx = await authorizeProject(projectId);
  if (!isInReviewSet(ctx.membership.role as Role)) throw new Error('Insufficient role to update review');

  const review = await db
    .select()
    .from(sroiRunReviews)
    .where(
      and(
        eq(sroiRunReviews.id, reviewId),
        eq(sroiRunReviews.projectId, projectId),
        eq(sroiRunReviews.organizationId, ctx.organization.id)
      )
    );
  if (review.length === 0) throw new Error('Review not found');
  if (review[0].status === 'archived') throw new Error('Cannot modify archived review');

  const validated = ReviewInputSchema.parse(input);

  await assertRunMethodologyApprovalAllowed({
    ctx,
    projectId,
    calculationRunId: review[0].calculationRunId,
    targetStatus: validated.status,
    reviewerId: review[0].reviewerId,
    path: 'update',
    beforeJson: { id: review[0].id, status: review[0].status, reviewerId: review[0].reviewerId },
  });
  await assertEvidenceSufficiencyForApproval({ projectId, targetStatus: validated.status });

  const updated = await db
    .update(sroiRunReviews)
    .set({
      status: validated.status,
      readinessScore: validated.readinessScore,
      overallNotes: validated.overallNotes,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      updatedBy: ctx.user.id,
    })
    .where(eq(sroiRunReviews.id, reviewId))
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_run_review',
    entityId: reviewId,
    action: AUDIT_ACTIONS.SROI_RUN_REVIEW_UPDATED,
    contentModifying: true,
    beforeJson: review[0] as unknown as Record<string, unknown>,
    afterJson: updated[0] as unknown as Record<string, unknown>,
  });
  return updated[0];
}

export async function upsertSroiRunReviewItem(projectId: string, reviewId: string, input: ReviewItemInput) {
  const ctx = await authorizeProject(projectId);
  if (!isInReviewSet(ctx.membership.role as Role)) throw new Error('Insufficient role to upsert review item');

  const review = await db
    .select()
    .from(sroiRunReviews)
    .where(
      and(
        eq(sroiRunReviews.id, reviewId),
        eq(sroiRunReviews.projectId, projectId),
        eq(sroiRunReviews.organizationId, ctx.organization.id)
      )
    );
  if (review.length === 0) throw new Error('Parent review not found');

  const validated = ReviewItemInputSchema.parse(input);
  const existing = await db
    .select()
    .from(sroiRunReviewItems)
    .where(
      and(
        eq(sroiRunReviewItems.reviewId, reviewId),
        eq(sroiRunReviewItems.itemKey, validated.itemKey)
      )
    );
  let result;
  if (existing.length > 0) {
    result = await db
      .update(sroiRunReviewItems)
      .set({
        status: validated.status,
        severity: validated.severity,
        notes: validated.notes,
        updatedAt: new Date(),
        updatedBy: ctx.user.id,
      })
      .where(eq(sroiRunReviewItems.id, existing[0].id))
      .returning();
  } else {
    result = await db
      .insert(sroiRunReviewItems)
      .values({
        organizationId: ctx.organization.id,
        projectId,
        reviewId,
        itemKey: validated.itemKey,
        status: validated.status,
        severity: validated.severity,
        notes: validated.notes,
        createdBy: ctx.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_run_review_item',
    entityId: result[0].id,
    action: AUDIT_ACTIONS.SROI_RUN_REVIEW_ITEM_UPSERTED,
    ...(existing.length > 0
      ? { contentModifying: true, beforeJson: existing[0] as unknown as Record<string, unknown> }
      : {}),
    afterJson: result[0] as unknown as Record<string, unknown>,
  });
  return result[0];
}

export async function listSroiRunReviews(projectId: string, runId: string) {
  const ctx = await authorizeProject(projectId);
  const reviews = await db
    .select()
    .from(sroiRunReviews)
    .where(
      and(
        eq(sroiRunReviews.projectId, projectId),
        eq(sroiRunReviews.calculationRunId, runId),
        eq(sroiRunReviews.organizationId, ctx.organization.id)
      )
    );
  const reviewIds = reviews.map(r => r.id);
  const items = await db
    .select()
    .from(sroiRunReviewItems)
    .where(inArray(sroiRunReviewItems.reviewId, reviewIds));
  return reviews.map(r => ({ ...r, items: items.filter(i => i.reviewId === r.id) }));
}

// ---------------------------------------------------------------------------
// 4. Report Foundation
// ---------------------------------------------------------------------------

export async function createReportDraftFromRun(projectId: string, runId: string, input: ReportDraftInput) {
  const ctx = await authorizeProject(projectId);
  const allowed = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'];
  if (!allowed.includes(ctx.membership.role)) throw new Error('Insufficient role to create report draft');

  const run = await db
    .select()
    .from(sroiCalculationRuns)
    .where(
      and(
        eq(sroiCalculationRuns.id, runId),
        eq(sroiCalculationRuns.projectId, projectId),
        eq(sroiCalculationRuns.organizationId, ctx.organization.id)
      )
    );
  if (run.length === 0) throw new Error('Run not found');

  const validated = ReportDraftInputSchema.parse(input);
  const report = await db
    .insert(sroiReports)
    .values({
      organizationId: ctx.organization.id,
      projectId,
      calculationRunId: runId,
      title: validated.title,
      status: 'draft',
      includeFunderBreakdown: validated.includeFunderBreakdown,
      reportVariant: validated.reportVariant,
      createdBy: ctx.user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  // Single source of truth for which sections a report has and their order —
  // shared with the editable detail view and the print/PDF view so a report's
  // stored sections always match what those views render. funder_breakdown is
  // only included when the report opts in.
  const initialSections = getVariantSectionTypes(validated.reportVariant, validated.includeFunderBreakdown);

  const sections = initialSections.map((type, idx) => ({
    organizationId: ctx.organization.id,
    projectId,
    reportId: report[0].id,
    sectionType: type,
    title: type.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
    content: '',
    sortOrder: idx,
    createdBy: ctx.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  await db.insert(sroiReportSections).values(sections);

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_report',
    entityId: report[0].id,
    action: AUDIT_ACTIONS.SROI_REPORT_CREATED,
    afterJson: report[0] as unknown as Record<string, unknown>,
  });
  return report[0];
}

export async function getReportDraft(projectId: string, reportId: string) {
  const ctx = await authorizeProject(projectId);
  const report = await db
    .select()
    .from(sroiReports)
    .where(
      and(
        eq(sroiReports.id, reportId),
        eq(sroiReports.projectId, projectId),
        eq(sroiReports.organizationId, ctx.organization.id)
      )
    );
  if (report.length === 0) throw new Error('Report not found');
  const sections = await db
    .select()
    .from(sroiReportSections)
    .where(eq(sroiReportSections.reportId, reportId))
    .orderBy(sroiReportSections.sortOrder);

  // Fetch calculation run to include snapshotJson for rendering funder_breakdown
  const run = await db
    .select({ snapshotJson: sroiCalculationRuns.snapshotJson, currency: sroiCalculationRuns.currency })
    .from(sroiCalculationRuns)
    .where(eq(sroiCalculationRuns.id, report[0].calculationRunId))
    .then(rows => rows[0] ?? null);

  const snapshotJson = (run?.snapshotJson as Record<string, unknown> | null) ?? null;
  const currency = run?.currency ?? 'USD';

  return { ...report[0], sections, snapshotJson, currency };
}

export async function updateReportSection(projectId: string, reportId: string, sectionId: string, input: ReportSectionInput) {
  const ctx = await authorizeProject(projectId);
  const allowed = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'];
  if (!allowed.includes(ctx.membership.role)) throw new Error('Insufficient role to edit report section');

  const report = await db
    .select()
    .from(sroiReports)
    .where(
      and(
        eq(sroiReports.id, reportId),
        eq(sroiReports.projectId, projectId),
        eq(sroiReports.organizationId, ctx.organization.id)
      )
    );
  if (report.length === 0) throw new Error('Report not found');
  if (report[0].status === 'locked') throw new Error('Report is locked');

  const validated = ReportSectionInputSchema.parse(input);

  // CL-1C — the persisted content itself must be checked against the
  // report's PINNED run: a human can freely edit the text after any
  // Composer-time check ran (or type it from scratch, never touching
  // Composer at all). Pure computation only — no AI, no network, no
  // auto-correction; a violation refuses the write outright.
  const pinnedRun = await getPinnedReportRun(ctx, report[0]);
  const authority = getReportNumericAuthority(pinnedRun);
  const referenceAuthority = await getReportNarrativeReferenceAuthority(ctx, report[0], pinnedRun);
  const integrity = validateSectionNarrativeIntegrity(
    validated.title,
    validated.content ?? '',
    authority,
    referenceAuthority,
  );
  if (!integrity.numeric.ok) {
    throw new Error(
      'El contenido de la sección contiene cifras que no coinciden con la corrida de cálculo del reporte.'
    );
  }
  if (!integrity.references.ok) {
    throw new Error(
      'El contenido de la sección contiene referencias que no coinciden con la autoridad del reporte.'
    );
  }

  // FIBC-040 — the prior section state must be retained so the update can be
  // reconstructed; this SELECT existed nowhere in this function before.
  const existingSection = await db
    .select()
    .from(sroiReportSections)
    .where(and(eq(sroiReportSections.id, sectionId), eq(sroiReportSections.reportId, reportId)));
  if (existingSection.length === 0) throw new Error('Report section not found for this report');

  const updated = await db
    .update(sroiReportSections)
    .set({
      title: validated.title,
      content: validated.content,
      sortOrder: validated.sortOrder,
      updatedAt: new Date(),
      updatedBy: ctx.user.id,
    })
    .where(and(eq(sroiReportSections.id, sectionId), eq(sroiReportSections.reportId, reportId)))
    .returning();
  if (updated.length === 0) throw new Error('Report section not found for this report');

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_report_section',
    entityId: sectionId,
    action: AUDIT_ACTIONS.SROI_REPORT_SECTION_UPDATED,
    contentModifying: true,
    beforeJson: existingSection[0] as unknown as Record<string, unknown>,
    afterJson: updated[0] as unknown as Record<string, unknown>,
  });
  return updated[0];
}

export interface LockReportAttestation {
  /**
   * CL-1E (MSC-02 HIGH-1/HR-01) — the lock action must be an explicit human
   * attestation that the CURRENT narrative was reviewed, not an automatic
   * consequence of the calculation review being approved. There is no
   * separate approval entity/table for this: the durable record of a
   * successful attested transition is the existing lockedBy/lockedAt pair
   * this function already sets once the lock actually goes through.
   */
  narrativeReviewed: boolean;
}

export async function lockReportDraft(
  projectId: string,
  reportId: string,
  attestation: LockReportAttestation,
) {
  const ctx = await authorizeProject(projectId);
  const allowed = ['super_admin', 'organization_admin', 'impact_manager'];
  if (!allowed.includes(ctx.membership.role)) throw new Error('Insufficient role to lock report');

  const report = await db
    .select()
    .from(sroiReports)
    .where(
      and(
        eq(sroiReports.id, reportId),
        eq(sroiReports.projectId, projectId),
        eq(sroiReports.organizationId, ctx.organization.id)
      )
    );
  if (report.length === 0) throw new Error('Report not found');
  if (report[0].status === 'locked') throw new Error('Report already locked');

  if (!attestation?.narrativeReviewed) {
    throw new Error('Cannot lock: explicit narrative review attestation is required');
  }

  // Human-review gate: a report cannot be finalized (locked/"audit-ready")
  // unless the calculation run it is built on carries an approved methodological
  // review. This makes "human review is the final step" an enforced invariant
  // rather than an optional side table.
  const approvedReview = await db
    .select({ id: sroiRunReviews.id })
    .from(sroiRunReviews)
    .where(and(
      eq(sroiRunReviews.calculationRunId, report[0].calculationRunId),
      eq(sroiRunReviews.organizationId, ctx.organization.id),
      eq(sroiRunReviews.status, 'approved'),
    ))
    .then(r => r[0]);
  if (!approvedReview) {
    throw new Error('Cannot lock: the calculation run has no approved methodological review');
  }

  // CL-1D — re-validate every CURRENTLY PERSISTED section against the
  // report's pinned run before allowing the lock. A section may have passed
  // updateReportSection's guard at save time and been edited again since (a
  // second draft cycle, a direct DB fixup, a legacy row from before CL-1C
  // existed) — the lock is the last point this can be caught before the
  // content becomes the audit-anchored, hash-verifiable artifact.
  const pinnedRun = await getPinnedReportRun(ctx, report[0]);
  const authority = getReportNumericAuthority(pinnedRun);
  const referenceAuthority = await getReportNarrativeReferenceAuthority(ctx, report[0], pinnedRun);
  const sections = await db
    .select()
    .from(sroiReportSections)
    .where(eq(sroiReportSections.reportId, reportId));
  for (const section of sections) {
    const integrity = validateSectionNarrativeIntegrity(
      section.title ?? '',
      section.content ?? '',
      authority,
      referenceAuthority,
    );
    if (!integrity.numeric.ok) {
      throw new Error(
        `Cannot lock: section "${section.title}" contains figures that do not match the report's calculation run.`
      );
    }
    if (!integrity.references.ok) {
      throw new Error(
        `Cannot lock: section "${section.title}" references do not match the report's authority.`
      );
    }
  }

  const locked = await db
    .update(sroiReports)
    .set({
      status: 'locked',
      verificationHash: crypto.randomUUID(),
      lockedBy: ctx.user.id,
      lockedAt: new Date(),
      updatedAt: new Date(),
      updatedBy: ctx.user.id,
    })
    .where(eq(sroiReports.id, reportId))
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_report',
    entityId: reportId,
    action: AUDIT_ACTIONS.SROI_REPORT_LOCKED,
    beforeJson: report[0] as unknown as Record<string, unknown>,
    afterJson: locked[0] as unknown as Record<string, unknown>,
  });
  return locked[0];
}

export async function getRunList(projectId: string) {
  const ctx = await authorizeProject(projectId);
  const runs = await db
    .select({
      id: sroiCalculationRuns.id,
      version: sroiCalculationRuns.version,
      createdAt: sroiCalculationRuns.createdAt,
      status: sroiCalculationRuns.status,
      sroiRatio: sroiCalculationRuns.sroiRatio,
      totalInvestment: sroiCalculationRuns.totalInvestment,
      currency: sroiCalculationRuns.currency,
    })
    .from(sroiCalculationRuns)
    .where(and(eq(sroiCalculationRuns.projectId, projectId), eq(sroiCalculationRuns.organizationId, ctx.organization.id)));
  return runs;
}

export async function listProjectReports(projectId: string) {
  const ctx = await authorizeProject(projectId);
  const reports = await db
    .select()
    .from(sroiReports)
    .where(and(eq(sroiReports.projectId, projectId), eq(sroiReports.organizationId, ctx.organization.id)));
  return reports;
}

// End of file
