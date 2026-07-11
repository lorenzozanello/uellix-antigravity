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
    sroiRatio: number
  } | null
  readinessScore: number | null
}

export type ExcludedProject = {
  projectId: string
  projectName: string
  reason: 'no_run' | 'non_usd_currency'
}

export type PortfolioAggregate = {
  projectCount: number
  includedCount: number
  totalInvestmentUsd: number
  totalNetSocialValueUsd: number
  portfolioSroiRatio: number | null
  included: { projectId: string; projectName: string; sroiRatio: number }[]
  excluded: ExcludedProject[]
  averageReadinessScore: number | null
  readinessCoverage: number
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
    totalInvestment = totalInvestment.plus(p.run.totalInvestment)
    totalNet = totalNet.plus(p.run.netSocialValue)
    included.push({ projectId: p.projectId, projectName: p.projectName, sroiRatio: p.run.sroiRatio })
    if (p.readinessScore !== null) {
      readinessSum += p.readinessScore
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
    averageReadinessScore: readinessCoverage > 0 ? readinessSum / readinessCoverage : null,
    readinessCoverage,
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
    const investment = run ? toNumberOrNull(run.totalInvestment) : null
    const net = run ? toNumberOrNull(run.netSocialValue) : null
    // A run without valid numeric totals can't be aggregated — treat as no run.
    const usableRun =
      run && investment !== null && net !== null
        ? {
            currency: run.currency ?? 'USD',
            totalInvestment: investment,
            netSocialValue: net,
            sroiRatio: toNumberOrNull(run.sroiRatio) ?? (investment > 0 ? net / investment : 0),
          }
        : null
    return {
      projectId: p.id,
      projectName: p.name,
      run: usableRun,
      readinessScore: run ? readinessByRunId.get(run.id) ?? null : null,
    }
  })

  return { portfolio, aggregate: aggregatePortfolioSroi(summaries) }
}
