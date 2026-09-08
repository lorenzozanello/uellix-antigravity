// lib/portfolios/analytics.ts
// Fase 4 — portfolio-level SROI aggregation. Pure, deterministic core.
// THE methodological rule: a portfolio's SROI is Σ net value / Σ investment,
// NEVER the average of per-project ratios (which over/under-weights small
// projects). Aggregation is in USD; runs not denominated in USD (legacy,
// pre-Fase-1) are excluded explicitly rather than summed into a wrong number.
//
// PF1 (PORTFOLIO_PF1_EXECUTION_AUTHORITY_v1.0.0) — the population a portfolio
// aggregates over is the APPROVED one:
//
//   * a project contributes only through its most recent APPROVED eligible run
//     (status = 'calculated' AND a currently-'approved' review of the same
//     organization exists for it);
//   * approval is filtered BEFORE the latest-run choice, so a newer unapproved
//     run never displaces an older approved one;
//   * the approved review that supplies reviewId and the legacy manual
//     readiness value is chosen by created_at DESC, id DESC — NEVER by
//     reviewed_at, which is nullable and sorts NULLs first under DESC;
//   * FIBC-042 legacy runs (projects.governance_regime = 'pre_pc01b', or the
//     SELECTED run's methodology_version IS NULL) are excluded even when
//     approved — approval does not retro-fit a methodology version;
//   * every included component carries its full traceability tuple, so a
//     reader can re-derive the aggregate from the runs and reviews it names.
//
// PF1 emits NO descriptive intelligence (min / median / max, transversal
// facts): those are PF3 obligations and their absence here is correct.

import Decimal from 'decimal.js'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { portfolios, projects, sroiCalculationRuns, sroiRunReviews } from '@/db/schema'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

/** The numeric payload of a selected run, parsed from its persisted columns. */
export type ParsedRunTotals = {
  currency: string
  // PF1: nullable. A run whose persisted total_investment is NULL is not the
  // same thing as a project that was never calculated — see
  // ExcludedProject.reason 'zero_or_invalid_investment'.
  totalInvestment: number | null
  netSocialValue: number
  // W2-B3 completeness (AG-B3-2, FIBC-016) — null when the run carries no
  // SROI ratio (no defensibly monetized outcome). Never coerced to 0 and
  // never recomputed as net/investment on this surface.
  sroiRatio: number | null
}

/**
 * PF1 traceability of the run/review pair a contribution was derived from.
 * The runId here is ALWAYS the run whose approved review is reviewId — a
 * component may never mix a run from one selection path with a review from
 * another.
 */
export type SelectedRunTrace = {
  runId: string
  runVersion: number
  reviewId: string
  methodologyVersion: string | null
}

/**
 * What the aggregate is told about one member project.
 *
 * `selection` is an EXPLICIT discriminator, not something inferred from a null
 * run: "no calculated run at all" and "calculated runs exist but none is
 * approved" are two different frozen exclusion reasons and a `null` cannot
 * distinguish them.
 */
export type ProjectRunSummary = {
  projectId: string
  projectName: string
  /** projects.governance_regime — 'pre_pc01b' | 'pc01b' | null (FIBC-042). */
  governanceRegime: string | null
  // FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17): renamed from readinessScore.
  // Sourced from sroi_run_reviews.readiness_score of the SELECTED APPROVED
  // review, which is LEGACY_NON_AUTHORITATIVE from B5 forward (FIBDB-016
  // stage B). This field MAY continue to be read here, but is never labelled,
  // aggregated or presented as the canonical FIBC-021 readiness — that is
  // readiness_assessments, a FIBIU-27 (Wave 5) surface switch, frozen for B5.
  legacyManualReadinessScore: number | null
} & (
  | { selection: 'no_calculated_run'; run: null; selected: null }
  | { selection: 'no_approved_run'; run: null; selected: null }
  | { selection: 'approved'; run: ParsedRunTotals | null; selected: SelectedRunTrace }
)

/**
 * The six frozen exclusion reasons, in their frozen evaluation order.
 * Evaluation is FIRST-MATCH-WINS in exactly this order; a project qualifying
 * for more than one reason reports the earliest and no other. The set is
 * CLOSED — a seventh reason may not be added, two may not be merged, and the
 * union may not be widened to `string` (which would let a seventh in without a
 * type error).
 */
export type ExcludedProject = {
  projectId: string
  projectName: string
  reason:
    | 'no_run'
    | 'no_approved_run'
    | 'legacy_non_authoritative'
    | 'non_usd_currency'
    | 'no_sroi_ratio'
    | 'zero_or_invalid_investment'
}

/**
 * PF1 traceability tuple — EXACTLY these nine fields, no more. Widening this
 * with descriptive intelligence (minimum / median / maximum) is a PF3 surface,
 * not a PF1 one.
 */
export type PortfolioIncludedComponent = {
  projectId: string
  projectName: string
  runId: string
  runVersion: number
  reviewId: string
  // Non-null by construction: a selected run with a NULL methodology_version
  // is excluded as legacy_non_authoritative before it can be included.
  methodologyVersion: string
  sroiRatio: number
  totalInvestment: number
  netSocialValue: number
}

export type PortfolioAggregate = {
  projectCount: number
  includedCount: number
  totalInvestmentUsd: number
  totalNetSocialValueUsd: number
  portfolioSroiRatio: number | null
  included: PortfolioIncludedComponent[]
  excluded: ExcludedProject[]
  // FIBIU-17 (W2-B5): renamed from averageReadinessScore/readinessCoverage —
  // see ProjectRunSummary.legacyManualReadinessScore.
  readinessSource: 'LEGACY_NON_AUTHORITATIVE'
  averageLegacyManualReadinessScore: number | null
  legacyManualReadinessCoverage: number
}

/** FIBC-042 — persisted governance-regime value that makes a project legacy. */
const LEGACY_GOVERNANCE_REGIME = 'pre_pc01b'

export function aggregatePortfolioSroi(projects: ProjectRunSummary[]): PortfolioAggregate {
  const included: PortfolioIncludedComponent[] = []
  const excluded: ExcludedProject[] = []
  let totalInvestment = new Decimal(0)
  let totalNet = new Decimal(0)
  let readinessSum = 0
  let readinessCoverage = 0

  for (const p of projects) {
    const exclude = (reason: ExcludedProject['reason']) => {
      excluded.push({ projectId: p.projectId, projectName: p.projectName, reason })
    }

    // (1) no_run — the project has no calculated run at all.
    if (p.selection === 'no_calculated_run') {
      exclude('no_run')
      continue
    }
    // (2) no_approved_run — calculated runs exist, none carries a currently
    // approved review. A later ineligible run NEVER substitutes for an
    // approved one, so reaching this branch means there is no approved run of
    // ANY version, not merely that the newest one is unapproved.
    if (p.selection === 'no_approved_run') {
      exclude('no_approved_run')
      continue
    }
    // A selected approved run whose net social value does not parse carries
    // nothing aggregatable. Pre-PF1 behaviour, deliberately preserved: PF1
    // corrects the INVESTMENT classification (below), not the parser.
    const run = p.run
    if (run === null) {
      exclude('no_run')
      continue
    }
    // (3) legacy_non_authoritative (FIBC-042). Persisted facts only, never
    // inferred, and tested against the SELECTED run. An approved review does
    // NOT override it: approval establishes methodological review, it does not
    // retro-fit a methodology version onto a run that predates versioning.
    const methodologyVersion = p.selected.methodologyVersion
    if (p.governanceRegime === LEGACY_GOVERNANCE_REGIME || methodologyVersion === null) {
      exclude('legacy_non_authoritative')
      continue
    }
    // (4) non_usd_currency — aggregation is in USD; a non-USD run is excluded
    // explicitly rather than summed into a wrong number.
    if (run.currency !== 'USD') {
      exclude('non_usd_currency')
      continue
    }
    // (5) no_sroi_ratio — AG-B3-2: a run without a ratio has nothing
    // defensibly monetized. Summing its investment into the denominator with a
    // zero numerator would fabricate a "zero return" project inside the
    // portfolio ratio. Excluded explicitly, with its own reason, never
    // silently.
    const sroiRatio = run.sroiRatio
    if (sroiRatio === null) {
      exclude('no_sroi_ratio')
      continue
    }
    // (6) zero_or_invalid_investment — a null, zero or negative investment on
    // an otherwise valid selected run. Reported with its OWN reason so a
    // reader can tell a project that was never calculated from one whose
    // calculated run carries an unusable investment, and so that neither a
    // zero nor a negative ever reaches the denominator.
    const investment = run.totalInvestment
    if (investment === null || !(investment > 0)) {
      exclude('zero_or_invalid_investment')
      continue
    }

    // Σ/Σ over EXACTLY the included population — numerator and denominator are
    // drawn from the same universe, and an excluded project contributes to
    // neither.
    totalInvestment = totalInvestment.plus(investment)
    totalNet = totalNet.plus(run.netSocialValue)
    included.push({
      projectId: p.projectId,
      projectName: p.projectName,
      runId: p.selected.runId,
      runVersion: p.selected.runVersion,
      reviewId: p.selected.reviewId,
      methodologyVersion,
      sroiRatio,
      totalInvestment: investment,
      netSocialValue: run.netSocialValue,
    })
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
 * Pure mapping of a selected-run row to the totals the aggregate consumes.
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
}): ParsedRunTotals | null {
  const net = toNumberOrNull(run.netSocialValue)
  // A run without a valid net social value can't be aggregated at all — there
  // is no numerator to contribute. Treated as no run, as before PF1.
  if (net === null) return null
  return {
    currency: run.currency ?? 'USD',
    // PF1: a NULL or unusable investment no longer collapses the whole run to
    // null. It is carried through so the aggregate can report
    // zero_or_invalid_investment at its frozen precedence position instead of
    // the project being indistinguishable from one that was never calculated.
    totalInvestment: toNumberOrNull(run.totalInvestment),
    netSocialValue: net,
    sroiRatio: toNumberOrNull(run.sroiRatio),
  }
}

/**
 * PF1 run selection order: highest version first, calculated_at as a
 * defensive second key.
 *
 * `uq_sroi_run_project_version` (db/migrations/0029_integrity.sql:6-7) is a
 * UNIQUE INDEX on (project_id, version), so version DESC is ALREADY total
 * within a project and the second key cannot be reached through it. That
 * uniqueness is NOT declared in db/schema.ts — a reader who checks the Drizzle
 * constraint array alone will wrongly conclude there is none.
 *
 * Applied in SQL (ORDER BY) and again here, so the selection is deterministic
 * independently of what order a driver happens to return rows in.
 */
export function compareRunsForSelection(
  a: { version: number; calculatedAt: Date },
  b: { version: number; calculatedAt: Date }
): number {
  if (a.version !== b.version) return b.version - a.version
  return b.calculatedAt.getTime() - a.calculatedAt.getTime()
}

/**
 * PF1 approved-review tie-break: created_at DESC, then id DESC.
 *
 * NEVER reviewed_at. `reviewed_at` is `timestamp('reviewed_at')` with no
 * .notNull() (db/schema.ts:927), and PostgreSQL sorts NULLs FIRST under DESC —
 * so an approved review that was never stamped would outrank one that was,
 * which is the opposite of "most recent". `created_at` is
 * `.defaultNow().notNull()` (db/schema.ts:928) and `id` is a uuid PRIMARY KEY
 * (db/schema.ts:910), so the two keys together admit no residual tie.
 */
export function compareApprovedReviews(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string }
): number {
  const at = a.createdAt.getTime()
  const bt = b.createdAt.getTime()
  if (at !== bt) return bt - at
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/**
 * Build the portfolio SROI analytics for the current organization.
 *
 * Four queries, no N+1: the portfolio, its projects, every CALCULATED run of
 * those projects carrying an EXISTS correlation to a currently-approved review
 * of the same organization, and the approved reviews of the runs that
 * correlation admitted. Returns null if the portfolio doesn't exist or isn't
 * owned by the caller's org.
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
    .select({ id: projects.id, name: projects.name, governanceRegime: projects.governanceRegime })
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

  // EVERY calculated run of these projects — not only the approved ones —
  // because "no calculated run at all" and "calculated but never approved" are
  // two different frozen exclusion reasons. Approval travels with each row as
  // an EXISTS correlation on calculation_run_id, status = 'approved' AND the
  // SAME organization as the run: the organization correlation is required on
  // the review side too, never only on the run side.
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
      hasApprovedReview: sql<boolean>`EXISTS (
        SELECT 1 FROM ${sroiRunReviews}
         WHERE ${sroiRunReviews.calculationRunId} = ${sroiCalculationRuns.id}
           AND ${sroiRunReviews.organizationId} = ${sroiCalculationRuns.organizationId}
           AND ${sroiRunReviews.status} = 'approved'
      )`,
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

  const projectsWithCalculatedRun = new Set(runs.map((r) => r.projectId))

  // APPROVAL FILTERING HAPPENS HERE — BEFORE the latest-run choice below. The
  // two orderings are indistinguishable on a population where every run is
  // approved and differ exactly where the newest run is unapproved: filtering
  // afterwards would report no_approved_run for a project that in fact has an
  // older approved run, and would drop its contribution from the aggregate.
  const approvedRuns = runs.filter((r) => r.hasApprovedReview === true)

  // The approved review of each approved run — created_at DESC, id DESC, never
  // reviewed_at. Fetched for every approved CANDIDATE run rather than only for
  // the finally-selected ones, so candidacy and the review that proves it are
  // established from the same rows.
  const approvedRunIds = approvedRuns.map((r) => r.id)
  const selectedReviewByRunId = new Map<string, { id: string; readinessScore: number | null }>()
  if (approvedRunIds.length > 0) {
    const reviews = await db
      .select({
        id: sroiRunReviews.id,
        calculationRunId: sroiRunReviews.calculationRunId,
        readinessScore: sroiRunReviews.readinessScore,
        createdAt: sroiRunReviews.createdAt,
      })
      .from(sroiRunReviews)
      .where(
        and(
          inArray(sroiRunReviews.calculationRunId, approvedRunIds),
          eq(sroiRunReviews.organizationId, ctx.organization.id),
          eq(sroiRunReviews.status, 'approved')
        )
      )
      .orderBy(desc(sroiRunReviews.createdAt), desc(sroiRunReviews.id))
    for (const review of [...reviews].sort(compareApprovedReviews)) {
      if (!selectedReviewByRunId.has(review.calculationRunId)) {
        selectedReviewByRunId.set(review.calculationRunId, {
          id: review.id,
          readinessScore: review.readinessScore,
        })
      }
    }
  }

  // Latest APPROVED run per project — the choice is made over the already
  // approval-filtered candidates, never over all calculated runs.
  const selectedRunByProject = new Map<string, (typeof runs)[number]>()
  for (const run of [...approvedRuns].sort(compareRunsForSelection)) {
    if (!selectedReviewByRunId.has(run.id)) continue
    if (!selectedRunByProject.has(run.projectId)) selectedRunByProject.set(run.projectId, run)
  }

  const summaries: ProjectRunSummary[] = portfolioProjects.map((p) => {
    const run = selectedRunByProject.get(p.id)
    if (!run) {
      return {
        projectId: p.id,
        projectName: p.name,
        governanceRegime: p.governanceRegime,
        selection: projectsWithCalculatedRun.has(p.id) ? 'no_approved_run' : 'no_calculated_run',
        run: null,
        selected: null,
        legacyManualReadinessScore: null,
      }
    }
    // Non-null by construction: a run only reaches selectedRunByProject when
    // selectedReviewByRunId already holds its approved review.
    const review = selectedReviewByRunId.get(run.id)!
    return {
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
      // The legacy manual readiness value belongs to the SELECTED approved
      // review — the same review that supplies reviewId above.
      legacyManualReadinessScore: review.readinessScore,
    }
  })

  return { portfolio, aggregate: aggregatePortfolioSroi(summaries) }
}
