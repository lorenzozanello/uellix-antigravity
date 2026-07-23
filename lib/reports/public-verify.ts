import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  evidenceItems,
  methodologyReviewMatrix,
  organizations,
  projects,
  sroiCalculationRuns,
  sroiReports,
  sroiReportSections,
} from '@/db/schema';
import { listOutcomeMappingsForProject } from '@/lib/taxonomies/service';

export async function getPublicVerifiedReport(verificationHash: string) {
  const reportRecords = await db
    .select({
      report: sroiReports,
      project: projects,
      organization: organizations,
      run: sroiCalculationRuns,
    })
    .from(sroiReports)
    .innerJoin(projects, eq(sroiReports.projectId, projects.id))
    .innerJoin(organizations, eq(sroiReports.organizationId, organizations.id))
    .innerJoin(sroiCalculationRuns, eq(sroiReports.calculationRunId, sroiCalculationRuns.id))
    .where(
      and(
        eq(sroiReports.verificationHash, verificationHash),
        eq(sroiReports.status, 'locked')
      )
    );

  if (reportRecords.length === 0) {
    return null;
  }

  const result = reportRecords[0];

  const [sections, evidence, reviews, mappings] = await Promise.all([
    db
      .select()
      .from(sroiReportSections)
      .where(eq(sroiReportSections.reportId, result.report.id))
      .orderBy(sroiReportSections.sortOrder),

    db
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.projectId, result.project.id)),

    db
      .select({
        pipelineStep: methodologyReviewMatrix.pipelineStep,
        status: methodologyReviewMatrix.status,
        readinessScore: methodologyReviewMatrix.readinessScore,
      })
      .from(methodologyReviewMatrix)
      .where(eq(methodologyReviewMatrix.projectId, result.project.id)),

    listOutcomeMappingsForProject(result.project.id).catch(() => [])
  ]);

  return {
    ...result,
    sections,
    evidence,
    methodologyReviews: reviews,
    mappings,
  };
}
