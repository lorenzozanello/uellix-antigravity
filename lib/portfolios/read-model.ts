// lib/portfolios/read-model.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — the paginated multi-project
// comparison read model.
//
// SIZE_CONTRACT (frozen, inherited unchanged from
// PORTFOLIO_COMMERCIAL_V1_AUTHORITY_v1.0.0.json):
//   * pagination applies to the COMPARISON view only — PORTFOLIO_COMPARISON_PAGE_SIZE.
//   * the portfolio AGGREGATE always covers every member, never a page —
//     computed by calling PF1's own aggregatePortfolioSroi over the FULL
//     selected-run population, never over a slice of it.
//   * queries against the member-project population are chunked at
//     PORTFOLIO_READ_MODEL_CHUNK_SIZE to bound drizzle's inArray
//     bind-parameter expansion, never issued one-per-project.
//   * PORTFOLIO_SOFT_SIZE_THRESHOLD gates an informational notice only. It
//     refuses nothing, truncates nothing, and alters no count.
//
// Run selection is NOT reimplemented here. It is PF1's own frozen rule
// (compareRunsForSelection / compareApprovedReviews / toProjectRunSummaryRun,
// all imported from ./analytics) so a PF3 read can never diverge from the
// selection PF1's aggregate already made. evidence-health.ts and
// intelligence.ts import the member/selection helpers from this file rather
// than re-deriving them, for the same reason.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { portfolios, projects, sroiCalculationRuns, sroiRunReviews } from '@/db/schema'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import {
  aggregatePortfolioSroi,
  compareApprovedReviews,
  compareRunsForSelection,
  toProjectRunSummaryRun,
  type PortfolioAggregate,
  type ProjectRunSummary,
} from './analytics'

export const PORTFOLIO_COMPARISON_PAGE_SIZE = 25
export const PORTFOLIO_READ_MODEL_CHUNK_SIZE = 500
export const PORTFOLIO_SOFT_SIZE_THRESHOLD = 250

/** Splits `items` into chunks of at most `size`, preserving order. Pure. */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunkArray: size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[])
  return out
}

export type PortfolioMemberProject = {
  id: string
  name: string
  governanceRegime: string | null
}

/**
 * Every non-deleted project belonging to the portfolio, org-scoped. This is
 * the ONE query that establishes portfolio membership; every other PF3 read
 * derives its population from this list (or a chunk of it), never from a
 * second, independently-written membership query.
 */
export async function listPortfolioMemberProjects(
  portfolioId: string,
  organizationId: string
): Promise<PortfolioMemberProject[]> {
  return db
    .select({ id: projects.id, name: projects.name, governanceRegime: projects.governanceRegime })
    .from(projects)
    .where(
      and(
        eq(projects.portfolioId, portfolioId),
        eq(projects.organizationId, organizationId),
        isNull(projects.deletedAt)
      )
    )
}

/**
 * PF1's selected-run summary for every member project, computed over the
 * WHOLE population in chunks of PORTFOLIO_READ_MODEL_CHUNK_SIZE — never one
 * query per project, and never a query unbounded by member count. Each chunk
 * issues exactly two statements (runs, then reviews-of-approved-candidates),
 * so total statement count is 2 * ceil(N / PORTFOLIO_READ_MODEL_CHUNK_SIZE),
 * independent of N — see POS-SIZE-2.
 *
 * Selection logic is IDENTICAL to lib/portfolios/analytics.ts's
 * getPortfolioAnalytics: approval is filtered before the latest-run choice,
 * the approved review is chosen by created_at DESC / id DESC (never
 * reviewed_at), and both orderings are re-applied in JS via the imported
 * comparators so the result is deterministic independent of driver row order.
 */
export async function buildPortfolioProjectRunSummaries(
  memberProjects: readonly PortfolioMemberProject[],
  organizationId: string
): Promise<ProjectRunSummary[]> {
  if (memberProjects.length === 0) return []

  const summaries: ProjectRunSummary[] = []

  for (const projectChunk of chunkArray(memberProjects, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
    const projectIds = projectChunk.map((p) => p.id)

    // EVERY calculated run of this chunk's projects — not only approved ones
    // — because "no calculated run at all" and "calculated but never
    // approved" are two different frozen exclusion reasons (see
    // lib/portfolios/analytics.ts's ProjectRunSummary.selection discriminator).
    const runs = await db
      .select({
        id: sroiCalculationRuns.id,
        projectId: sroiCalculationRuns.projectId,
        version: sroiCalculationRuns.version,
        calculatedAt: sroiCalculationRuns.calculatedAt,
        methodologyVersion: sroiCalculationRuns.methodologyVersion,
        currency: sroiCalculationRuns.currency,
        totalInvestment: sroiCalculationRuns.totalInvestment,
        netSocialValue: sroiCalculationRuns.netSocialValue,
        sroiRatio: sroiCalculationRuns.sroiRatio,
        organizationId: sroiCalculationRuns.organizationId,
      })
      .from(sroiCalculationRuns)
      .where(
        and(
          inArray(sroiCalculationRuns.projectId, projectIds),
          eq(sroiCalculationRuns.organizationId, organizationId),
          eq(sroiCalculationRuns.status, 'calculated')
        )
      )
      .orderBy(desc(sroiCalculationRuns.version), desc(sroiCalculationRuns.calculatedAt))

    const projectsWithCalculatedRun = new Set(runs.map((r) => r.projectId))

    // Approval EXISTS-correlation, same organization on both sides. Computed
    // in JS from a second bounded query rather than a correlated subquery per
    // run, so the chunk still costs exactly two statements.
    const runIds = runs.map((r) => r.id)
    const allReviewsForChunk =
      runIds.length > 0
        ? await db
            .select({
              id: sroiRunReviews.id,
              calculationRunId: sroiRunReviews.calculationRunId,
              readinessScore: sroiRunReviews.readinessScore,
              createdAt: sroiRunReviews.createdAt,
              status: sroiRunReviews.status,
              organizationId: sroiRunReviews.organizationId,
            })
            .from(sroiRunReviews)
            .where(and(inArray(sroiRunReviews.calculationRunId, runIds), eq(sroiRunReviews.organizationId, organizationId)))
            .orderBy(desc(sroiRunReviews.createdAt), desc(sroiRunReviews.id))
        : []

    const approvedReviewsByRun = new Map<string, { id: string; readinessScore: number | null; createdAt: Date }[]>()
    for (const review of allReviewsForChunk) {
      if (review.status !== 'approved') continue
      const list = approvedReviewsByRun.get(review.calculationRunId) ?? []
      list.push({ id: review.id, readinessScore: review.readinessScore, createdAt: review.createdAt })
      approvedReviewsByRun.set(review.calculationRunId, list)
    }

    const selectedReviewByRunId = new Map<string, { id: string; readinessScore: number | null }>()
    for (const [runId, candidates] of approvedReviewsByRun) {
      const sorted = [...candidates].sort(compareApprovedReviews)
      const chosen = sorted[0]
      selectedReviewByRunId.set(runId, { id: chosen.id, readinessScore: chosen.readinessScore })
    }

    const approvedRuns = runs.filter((r) => selectedReviewByRunId.has(r.id))

    const selectedRunByProject = new Map<string, (typeof runs)[number]>()
    for (const run of [...approvedRuns].sort(compareRunsForSelection)) {
      if (!selectedRunByProject.has(run.projectId)) selectedRunByProject.set(run.projectId, run)
    }

    for (const p of projectChunk) {
      const run = selectedRunByProject.get(p.id)
      if (!run) {
        summaries.push({
          projectId: p.id,
          projectName: p.name,
          governanceRegime: p.governanceRegime,
          selection: projectsWithCalculatedRun.has(p.id) ? 'no_approved_run' : 'no_calculated_run',
          run: null,
          selected: null,
          legacyManualReadinessScore: null,
        })
        continue
      }
      const review = selectedReviewByRunId.get(run.id)!
      summaries.push({
        projectId: p.id,
        projectName: p.name,
        governanceRegime: p.governanceRegime,
        selection: 'approved',
        run: toProjectRunSummaryRun(run),
        selected: {
          runId: run.id,
          runVersion: run.version,
          reviewId: review.id,
          methodologyVersion: run.methodologyVersion,
        },
        legacyManualReadinessScore: review.readinessScore,
      })
    }
  }

  return summaries
}

/** The selected calculation-run id for a member project, or null if none was selected. */
export function selectedRunIdOf(summary: ProjectRunSummary): string | null {
  return summary.selection === 'approved' ? summary.selected.runId : null
}

export type PortfolioComparisonPage = {
  page: number
  pageSize: number
  totalPages: number
  totalMembers: number
  rows: ProjectRunSummary[]
}

export type PortfolioReadModel = {
  portfolio: typeof portfolios.$inferSelect
  /** Always computed over ALL members — never the displayed page. */
  aggregate: PortfolioAggregate
  memberCount: number
  /** PORTFOLIO_SOFT_SIZE_THRESHOLD reached — informational only, nothing is refused. */
  softSizeWarning: boolean
  comparisonPage: PortfolioComparisonPage
}

/**
 * The PF3 comparison read model for one portfolio, scoped to the caller's
 * organization. Returns null when the portfolio does not exist or is not
 * owned by the caller's org — same not-found contract as
 * lib/portfolios/service.ts's getPortfolioByIdForCurrentOrganization.
 *
 * Must be called inside an already-open identity context
 * (runWithOptionalOrganizationAccess / runWithOrganizationAccess) — see
 * db/client.ts: a query issued with no context returns zero rows rather than
 * failing, which is why this module never opens one of its own.
 */
export async function getPortfolioReadModel(
  portfolioId: string,
  options?: { page?: number }
): Promise<PortfolioReadModel | null> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('Unauthenticated')

  const portfolio = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.organizationId, ctx.organization.id)))
    .then((rows) => rows[0] ?? null)
  if (!portfolio) return null

  const memberProjects = await listPortfolioMemberProjects(portfolioId, ctx.organization.id)
  const summaries = await buildPortfolioProjectRunSummaries(memberProjects, ctx.organization.id)

  return buildPortfolioReadModelFromSummaries(portfolio, memberProjects.length, summaries, options?.page ?? 1)
}

/**
 * Pure composition step, split out from getPortfolioReadModel so the
 * aggregate-vs-pagination separation (SIZE_CONTRACT, POS-SIZE-1,
 * NEG-PF3-SIZE-1, MUT-SIZE-1) is testable without a database — mirrors
 * lib/portfolios/analytics.ts's own split between the pure
 * aggregatePortfolioSroi and the DB-bound getPortfolioAnalytics.
 *
 * `summaries` MUST be the FULL selected-run population, never a page of it —
 * the aggregate below is computed over exactly what is passed in, so calling
 * this with a paginated slice would silently produce a wrong portfolio
 * aggregate. See MUT-SIZE-1.
 */
export function buildPortfolioReadModelFromSummaries(
  portfolio: typeof portfolios.$inferSelect,
  memberCount: number,
  summaries: readonly ProjectRunSummary[],
  requestedPage: number
): PortfolioReadModel {
  // The aggregate ALWAYS covers every member — see SIZE_CONTRACT above.
  const aggregate = aggregatePortfolioSroi([...summaries])

  const pageSize = PORTFOLIO_COMPARISON_PAGE_SIZE
  const totalMembers = summaries.length
  const totalPages = Math.max(1, Math.ceil(totalMembers / pageSize))
  const page = Math.min(Math.max(1, requestedPage), totalPages)
  const start = (page - 1) * pageSize
  const rows = summaries.slice(start, start + pageSize) as ProjectRunSummary[]

  return {
    portfolio,
    aggregate,
    memberCount,
    softSizeWarning: memberCount >= PORTFOLIO_SOFT_SIZE_THRESHOLD,
    comparisonPage: { page, pageSize, totalPages, totalMembers, rows },
  }
}
