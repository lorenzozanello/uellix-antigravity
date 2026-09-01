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
import { getLatestEvidenceVersionsByEvidenceIds } from '@/lib/pipeline/evidence-versions';

/**
 * PUBLIC VERIFICATION READ — BLOCKED BY DESIGN AFTER THE RUNTIME CUTOVER.
 *
 * The verification hash is a capability: whoever holds it may read that one
 * locked report. That model was implemented in the APPLICATION (`WHERE
 * verification_hash = … AND status = 'locked'`) and enforced by nothing else,
 * because the connection used to bypass RLS.
 *
 * `sroi_reports`, `projects`, `organizations` and `sroi_report_sections` all
 * carry member-scoped SELECT policies and no anonymous one, so as `uellix_app`
 * with no claims this returns zero rows and both callers — the /verify page and
 * its PDF route — answer 404.
 *
 * That is fail-closed and correct as a default. Making public verification work
 * again needs a SELECT policy that expresses the capability in the database
 * (locked reports, matched by hash, readable with no claims) rather than a
 * bypass — a privilege decision, deliberately NOT taken in this unit.
 *
 * No fabricated identity is used here: an anonymous visitor has none, and the
 * function is left to return `null`.
 */
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

    // FIBIU-05 (FIBC-007) — "sensitive evidence is absent from ... the
    // public surface". Every output surface governs exposure on the
    // classification value; an unclassified (never-evaluated) item is
    // treated the same as a classified-sensitive one — only an explicit
    // 'non_sensitive' classification clears an item for this surface.
    db
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.projectId, result.project.id))
      .then(async (rows) => {
        const versions = await getLatestEvidenceVersionsByEvidenceIds(rows.map((r) => r.id));
        return rows.filter((r) => versions.get(r.id)?.sensitivityClassification === 'non_sensitive');
      }),

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
