// lib/portfolios/analytics.ts
// Fase 4 — portfolio-level SROI aggregation. Pure, deterministic core.
// THE methodological rule: a portfolio's SROI is Σ net value / Σ investment,
// NEVER the average of per-project ratios (which over/under-weights small
// projects). Aggregation is in USD; runs not denominated in USD (legacy,
// pre-Fase-1) are excluded explicitly rather than summed into a wrong number.

import Decimal from 'decimal.js'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { portfolios, projects, sroiCalculationRuns, sroiRunReviews } from '@/db/schema'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

export type ProjectRunSummary = {
  projectId: string
  projectName: string
  run: {
    currency: string
    totalInvestment: number
    netSocialValue: number
    // W2-B3 completeness (AG-B3-2, FIBC-016) — null when the run carries no
    // SROI ratio (no defensibly monetized outcome). Never coerced to 0 and
    // never recomputed as net/investment on this surface.
    sroiRatio: number | null
  } | null
  // FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17): renamed from readinessScore.
  // Sourced from sroi_run_reviews.readiness_score, which is
  // LEGACY_NON_AUTHORITATIVE from B5 forward (FIBDB-016 stage B). This
  // field MAY continue to be read here, but is never labelled, aggregated
  // or presented as the canonical FIBC-021 readiness — that is
  // readiness_assessments, a FIBIU-27 (Wave 5) surface switch, frozen for B5.
  legacyManualReadinessScore: number | null
}

export type ExcludedProject = {
  projectId: string
  projectName: string
  reason: 'no_run' | 'non_usd_currency' | 'no_sroi_ratio'
}

export type PortfolioAggregate = {
  projectCount: number
  includedCount: number
  totalInvestmentUsd: number
  totalNetSocialValueUsd: number
  portfolioSroiRatio: number | null
  included: { projectId: string; projectName: string; sroiRatio: number }[]
  excluded: ExcludedProject[]
  // FIBIU-17 (W2-B5): renamed from averageReadinessScore/readinessCoverage —
  // see ProjectRunSummary.legacyManualReadinessScore.
  readinessSource: 'LEGACY_NON_AUTHORITATIVE'
  averageLegacyManualReadinessScore: number | null
  legacyManualReadinessCoverage: number
}

export function aggregatePortfolioSroi(projects: ProjectRunSummary[]): PortfolioAggregate {
  const included: PortfolioAggregate['included'] = []
  const excluded: ExcludedProject[] = []
  let totalInvestment = new Decimal(0)
  let totalNet = new Decimal(0)
  let readinessSum = 0
  let readinessCoverage = 0

  for (const p of projects) {
    if (!p.run) {
      excluded.push({ projectId: p.projectId, projectName: p.projectName, reason: 'no_run' })
      continue
    }
    if (p.run.currency !== 'USD') {
      excluded.push({ projectId: p.projectId, projectName: p.projectName, reason: 'non_usd_currency' })
      continue
    }
    // AG-B3-2 — a run without a ratio has nothing defensibly monetized:
    // summing its investment into the denominator with a zero numerator
    // would fabricate a "zero return" project inside the portfolio ratio.
    // Excluded explicitly, with its own reason, never silently.
    if (p.run.sroiRatio === null) {
      excluded.push({ projectId: p.projectId, projectName: p.projectName, reason: 'no_sroi_ratio' })
      continue
    }
    totalInvestment = totalInvestment.plus(p.run.totalInvestment)
    totalNet = totalNet.plus(p.run.netSocialValue)
    included.push({ projectId: p.projectId, projectName: p.projectName, sroiRatio: p.run.sroiRatio })
    if (p.legacyManualReadinessScore !== null) {
      readinessSum += p.legacyManualReadinessScore
      readinessCoverage += 1
    }
  }

  // Σ net / Σ investment — the weighted portfolio ratio. Null when there is no
  // included investment to divide by (empty portfolio or all excluded).
  const portfolioSroiRatio = totalInvestment.gt(0)
    ? totalNet.div(totalInvestment).toNumber()
    : null

  return {
    projectCount: projects.length,
    includedCount: included.length,
    totalInvestmentUsd: totalInvestment.toNumber(),
    totalNetSocialValueUsd: totalNet.toNumber(),
    portfolioSroiRatio,
    included,
    excluded,
    readinessSource: 'LEGACY_NON_AUTHORITATIVE',
    averageLegacyManualReadinessScore: readinessCoverage > 0 ? readinessSum / readinessCoverage : null,
    legacyManualReadinessCoverage: readinessCoverage,
  }
}

// ---------------------------------------------------------------------------
// Service layer (authorized, org-scoped)
// ---------------------------------------------------------------------------

function toNumberOrNull(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Pure mapping of a latest-run row to the summary the aggregate consumes.
 * W2-B3 completeness (AG-B3-2): the run's persisted sroi_ratio is the ONLY
 * source of the project ratio — NULL stays null. The historical
 * `?? (investment > 0 ? net / investment : 0)` fallback recomputed a ratio
 * the authoritative run deliberately did not emit; it is gone.
 */
export function toProjectRunSummaryRun(run: {
  currency: string | null
  totalInvestment: string | null
  netSocialValue: string | null
  sroiRatio: string | null
}): ProjectRunSummary['run'] {
  const investment = toNumberOrNull(run.totalInvestment)
  const net = toNumberOrNull(run.netSocialValue)
  // A run without valid numeric totals can't be aggregated — treat as no run.
  if (investment === null || net === null) return null
  return {
    currency: run.currency ?? 'USD',
    totalInvestment: investment,
    netSocialValue: net,
    sroiRatio: toNumberOrNull(run.sroiRatio),
  }
}

/**
 * Build the portfolio SROI analytics for the current organization. Reads the
 * latest calculated run per project (plus its readiness score) and aggregates
 * with aggregatePortfolioSroi. Three queries, no N+1. Returns null if the
 * portfolio doesn't exist or isn't owned by the caller's org.
 */
export async function getPortfolioAnalytics(portfolioId: string) {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('Unauthenticated')

  const portfolio = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.organizationId, ctx.organization.id)))
    .then((rows) => rows[0] ?? null)
  if (!portfolio) return null

  // Portfolio projects (exclude soft-deleted; their runs no longer count).
  const portfolioProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        eq(projects.portfolioId, portfolioId),
        eq(projects.organizationId, ctx.organization.id),
        isNull(projects.deletedAt)
      )
    )

  const projectIds = portfolioProjects.map((p) => p.id)
  if (projectIds.length === 0) {
    return { portfolio, aggregate: aggregatePortfolioSroi([]) }
  }

  // All calculated runs for these projects, newest first. Pick the latest per
  // project in JS (one query beats N per-project lookups).
  const runs = await db
    .select({
      id: sroiCalculationRuns.id,
      projectId: sroiCalculationRuns.projectId,
      currency: sroiCalculationRuns.currency,
      totalInvestment: sroiCalculationRuns.totalInvestment,
      netSocialValue: sroiCalculationRuns.netSocialValue,
      sroiRatio: sroiCalculationRuns.sroiRatio,
    })
    .from(sroiCalculationRuns)
    .where(
      and(
        inArray(sroiCalculationRuns.projectId, projectIds),
        eq(sroiCalculationRuns.organizationId, ctx.organization.id),
        eq(sroiCalculationRuns.status, 'calculated')
      )
    )
    .orderBy(desc(sroiCalculationRuns.version), desc(sroiCalculationRuns.calculatedAt))

  const latestRunByProject = new Map<string, (typeof runs)[number]>()
  for (const run of runs) {
    if (!latestRunByProject.has(run.projectId)) latestRunByProject.set(run.projectId, run)
  }

  // Readiness score of each latest run's review (latest review wins if several).
  const latestRunIds = [...latestRunByProject.values()].map((r) => r.id)
  const readinessByRunId = new Map<string, number | null>()
  if (latestRunIds.length > 0) {
    const reviews = await db
      .select({
        calculationRunId: sroiRunReviews.calculationRunId,
        readinessScore: sroiRunReviews.readinessScore,
      })
      .from(sroiRunReviews)
      .where(
        and(
          inArray(sroiRunReviews.calculationRunId, latestRunIds),
          eq(sroiRunReviews.organizationId, ctx.organization.id)
        )
      )
      .orderBy(desc(sroiRunReviews.reviewedAt))
    for (const review of reviews) {
      if (!readinessByRunId.has(review.calculationRunId)) {
        readinessByRunId.set(review.calculationRunId, review.readinessScore)
      }
    }
  }

  const summaries: ProjectRunSummary[] = portfolioProjects.map((p) => {
    const run = latestRunByProject.get(p.id)
    return {
      projectId: p.id,
      projectName: p.name,
      run: run ? toProjectRunSummaryRun(run) : null,
      legacyManualReadinessScore: run ? readinessByRunId.get(run.id) ?? null : null,
    }
  })

  return { portfolio, aggregate: aggregatePortfolioSroi(summaries) }
}
