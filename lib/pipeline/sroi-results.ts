// lib/pipeline/sroi-results.ts
// Sprint 7B – Services for SROI Results Hardening & Report Foundation
// Implements calculation run detail, comparison, methodological reviews and report drafts.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { logAuditAction } from '@/lib/audit/logger';
import { requireOrganizationAccess } from '@/lib/auth/session';
import {
  sroiCalculationRuns,
  sroiCalculationLineItems,
  sroiRunReviews,
  sroiRunReviewItems,
  sroiReports,
  sroiReportSections,
  projects,
} from '@/db/schema';
import { z } from 'zod';

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
});

type ReportDraftInput = z.infer<typeof ReportDraftInputSchema>;

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
  return {
    run: run[0],
    lineItems,
    snapshotJson: snapshot,
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

export async function createSroiRunReview(projectId: string, runId: string, input: ReviewInput) {
  const ctx = await authorizeProject(projectId);
  const allowed = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer'];
  if (!allowed.includes(ctx.membership.role)) throw new Error('Insufficient role to create review');

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
    actorUserId: ctx.user.id,
    entityType: 'sroi_run_review',
    entityId: inserted[0].id,
    action: 'sroi_run_review.created',
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  });
  return inserted[0];
}

export async function updateSroiRunReview(projectId: string, reviewId: string, input: ReviewInput) {
  const ctx = await authorizeProject(projectId);
  const allowed = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer'];
  if (!allowed.includes(ctx.membership.role)) throw new Error('Insufficient role to update review');

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
    actorUserId: ctx.user.id,
    entityType: 'sroi_run_review',
    entityId: reviewId,
    action: 'sroi_run_review.updated',
    afterJson: updated[0] as unknown as Record<string, unknown>,
  });
  return updated[0];
}

export async function upsertSroiRunReviewItem(projectId: string, reviewId: string, input: ReviewItemInput) {
  const ctx = await authorizeProject(projectId);
  const allowed = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer'];
  if (!allowed.includes(ctx.membership.role)) throw new Error('Insufficient role to upsert review item');

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
    actorUserId: ctx.user.id,
    entityType: 'sroi_run_review_item',
    entityId: result[0].id,
    action: 'sroi_run_review_item.upserted',
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

const initialSections = [
  'executive_summary',
  'project_context',
  'theory_of_change',
  'stakeholders',
  'outcomes',
  'evidence_summary',
  'proxy_methodology',
  'sroi_filters',
  'calculation_results',
  'limitations',
  'review_notes',
  'appendix',
];

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
      createdBy: ctx.user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

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
    actorUserId: ctx.user.id,
    entityType: 'sroi_report',
    entityId: report[0].id,
    action: 'sroi_report.created',
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
  return { ...report[0], sections };
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
  const updated = await db
    .update(sroiReportSections)
    .set({
      title: validated.title,
      content: validated.content,
      sortOrder: validated.sortOrder,
      updatedAt: new Date(),
      updatedBy: ctx.user.id,
    })
    .where(eq(sroiReportSections.id, sectionId))
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'sroi_report_section',
    entityId: sectionId,
    action: 'sroi_report_section.updated',
    afterJson: updated[0] as unknown as Record<string, unknown>,
  });
  return updated[0];
}

export async function lockReportDraft(projectId: string, reportId: string) {
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

  const locked = await db
    .update(sroiReports)
    .set({
      status: 'locked',
      lockedBy: ctx.user.id,
      lockedAt: new Date(),
      updatedAt: new Date(),
      updatedBy: ctx.user.id,
    })
    .where(eq(sroiReports.id, reportId))
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'sroi_report',
    entityId: reportId,
    action: 'sroi_report.locked',
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
