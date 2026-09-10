// lib/portfolios/intelligence.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — TI-1 through TI-8, frozen
// unchanged from PORTFOLIO_COMMERCIAL_V1_AUTHORITY_v1.0.0.json.
//
// UNIVERSAL OBLIGATIONS: every fact is deterministic (same persisted rows in,
// same facts out — no sampling, no randomness, no time-of-day dependence
// beyond the explicit TI-8/EH-6 calculated_at comparison), computed
// server-side from persisted rows, reproducible from its own source
// identifiers, and carries those identifiers.
//
// TI-3/TI-5/TI-6/TI-7/TI-8 are sourced from PF1's aggregate and PF3's own
// EH-2/EH-4/EH-6 — reused, not recomputed, so a portfolio-level fact can
// never diverge from the indicator it is derived from (POS-TI-1,
// POS_AGG_5_RESTATED).
//
// lib/stella/** is a prohibited import for this module. Stella may later
// EXPLAIN these facts; it never produces, calculates, adjusts or ranks any of
// them — see TRANSVERSAL_INTELLIGENCE.stella_boundary / NEG-PF3-STELLA-1.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { sroiReports } from '@/db/schema'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { aggregatePortfolioSroi, type ExcludedProject, type PortfolioIncludedComponent } from './analytics'
import { getPortfolioEvidenceHealth, type Eh2Result, type Eh5DrillRow, type Eh6Result } from './evidence-health'
import { buildPortfolioProjectRunSummaries, listPortfolioMemberProjects } from './read-model'

// ---------------------------------------------------------------------------
// TI-1 — Projects with no approved run
// ---------------------------------------------------------------------------

export type Ti1Result = { projectIds: string[]; projects: { projectId: string; projectName: string }[] }

/** Pure: TI-1 — 'no_approved_run' ONLY, never 'no_run' generally. */
export function ti1FromExcluded(excluded: readonly ExcludedProject[]): Ti1Result {
  const matches = excluded.filter((e) => e.reason === 'no_approved_run')
  return {
    projectIds: matches.map((e) => e.projectId),
    projects: matches.map((e) => ({ projectId: e.projectId, projectName: e.projectName })),
  }
}

// ---------------------------------------------------------------------------
// TI-2 — Projects with an approved run but no report
// ---------------------------------------------------------------------------

export type Ti2Result = { projectIds: string[]; projects: { projectId: string; projectName: string; runId: string }[] }

/** Pure: TI-2 — approved run present, but its id is absent from reportedRunIds. */
export function ti2FromIncludedAndReportedRuns(
  included: readonly PortfolioIncludedComponent[],
  reportedRunIds: ReadonlySet<string>
): Ti2Result {
  const missing = included.filter((c) => !reportedRunIds.has(c.runId))
  return {
    projectIds: missing.map((c) => c.projectId),
    projects: missing.map((c) => ({ projectId: c.projectId, projectName: c.projectName, runId: c.runId })),
  }
}

// ---------------------------------------------------------------------------
// TI-3 — Dispersion of individual project ratios
// ---------------------------------------------------------------------------

export type Ti3Result = {
  minimum: number | null
  median: number | null
  maximum: number | null
  ratioCount: number
  sourceProjectIds: string[]
}

/** Pure: TI-3 — POS_AGG_5_RESTATED. Never confused with portfolioSroiRatio. */
export function computeTi3(includedRatios: { projectId: string; sroiRatio: number }[]): Ti3Result {
  if (includedRatios.length === 0) {
    return { minimum: null, median: null, maximum: null, ratioCount: 0, sourceProjectIds: [] }
  }
  const sorted = [...includedRatios].sort((a, b) => a.sroiRatio - b.sroiRatio)
  const values = sorted.map((r) => r.sroiRatio)
  const mid = Math.floor(values.length / 2)
  const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
  return {
    minimum: values[0],
    median,
    maximum: values[values.length - 1],
    ratioCount: values.length,
    sourceProjectIds: sorted.map((r) => r.projectId),
  }
}

// ---------------------------------------------------------------------------
// TI-4 — Frequency of each exclusion reason
// ---------------------------------------------------------------------------

export type Ti4Result = { byReason: Record<string, number>; excludedProjectIds: string[] }

/** Pure: TI-4. */
export function computeTi4(excluded: readonly ExcludedProject[]): Ti4Result {
  const byReason: Record<string, number> = {}
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1
  return { byReason, excludedProjectIds: excluded.map((e) => e.projectId) }
}

// ---------------------------------------------------------------------------
// TI-5 — Outcomes without approved evidence, grouped by project (source: EH-2)
// ---------------------------------------------------------------------------

export type Ti5Result = {
  byProject: { projectId: string; projectName: string; uncoveredOutcomeIds: string[] }[]
}

/** Pure: TI-5 — source EH-2, reused rather than recomputed. */
export function ti5FromEh2(eh2: Eh2Result): Ti5Result {
  return {
    byProject: eh2.byProject.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      uncoveredOutcomeIds: p.activeOutcomeIds.filter((id) => !p.coveredOutcomeIds.includes(id)),
    })),
  }
}

// ---------------------------------------------------------------------------
// TI-6 — Proxy versions used by more than one member project (source: outcome_proxy_assignments)
// ---------------------------------------------------------------------------

export type Ti6Result = {
  sharedVersions: { financialProxyVersionId: string; projectIds: string[]; assignmentIds: string[] }[]
}

/**
 * Pure: TI-6 — source EH-5's bound-assignment rows, which are already
 * organization-bound through outcome_proxy_assignments (see
 * MUT-PF3-TENANT-1). A version is "shared" when its assignments span more
 * than one DISTINCT project.
 */
export function ti6FromEh5Rows(denominatorRows: readonly Eh5DrillRow[]): Ti6Result {
  const byVersion = new Map<string, { projectIds: Set<string>; assignmentIds: string[] }>()
  for (const row of denominatorRows) {
    if (!row.financialProxyVersionId) continue
    const entry = byVersion.get(row.financialProxyVersionId) ?? { projectIds: new Set<string>(), assignmentIds: [] }
    entry.projectIds.add(row.projectId)
    entry.assignmentIds.push(row.assignmentId)
    byVersion.set(row.financialProxyVersionId, entry)
  }
  return {
    sharedVersions: [...byVersion.entries()]
      .filter(([, v]) => v.projectIds.size > 1)
      .map(([financialProxyVersionId, v]) => ({
        financialProxyVersionId,
        projectIds: [...v.projectIds],
        assignmentIds: v.assignmentIds,
      })),
  }
}

// ---------------------------------------------------------------------------
// TI-7 — not_monetized dispositions aggregated by reason (source: EH-4)
// ---------------------------------------------------------------------------

export type Ti7Result = { byReason: Record<string, number> }

// ---------------------------------------------------------------------------
// TI-8 — Projects whose evidence was updated after the selected run (source: EH-6)
// ---------------------------------------------------------------------------

export type Ti8Result = { projectIds: string[]; projects: { projectId: string; projectName: string; count: number }[] }

/** Pure: TI-8 — source EH-6. */
export function ti8FromEh6(eh6: Eh6Result): Ti8Result {
  const projects = eh6.byProject.filter((p) => p.count > 0)
  return {
    projectIds: projects.map((p) => p.projectId),
    projects: projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName, count: p.count })),
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type PortfolioTransversalIntelligence = {
  ti1: Ti1Result
  ti2: Ti2Result
  ti3: Ti3Result
  ti4: Ti4Result
  ti5: Ti5Result
  ti6: Ti6Result
  ti7: Ti7Result
  ti8: Ti8Result
}

/**
 * The full TI-1..TI-8 surface for one portfolio, scoped to the caller's
 * organization. Returns null when the portfolio has no members and no
 * evidence-health surface to derive from — mirrors
 * getPortfolioEvidenceHealth's own contract (an existing, memberless
 * portfolio still returns a defined, empty result via that path; this
 * function returns null only when evidence-health itself does, e.g. the
 * portfolio is not owned by the caller's org — see its own doc comment).
 *
 * Must be called inside an already-open identity context — see
 * lib/portfolios/read-model.ts's getPortfolioReadModel doc comment.
 */
export async function getPortfolioTransversalIntelligence(
  portfolioId: string
): Promise<PortfolioTransversalIntelligence | null> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('Unauthenticated')

  const evidenceHealth = await getPortfolioEvidenceHealth(portfolioId)
  if (!evidenceHealth) return null

  const memberProjects = await listPortfolioMemberProjects(portfolioId, ctx.organization.id)
  const summaries = await buildPortfolioProjectRunSummaries(memberProjects, ctx.organization.id)
  const aggregate = aggregatePortfolioSroi(summaries)

  // TI-1 — the aggregate's own exclusion set, reason 'no_approved_run' ONLY.
  const ti1 = ti1FromExcluded(aggregate.excluded)

  // TI-2 — approved run, but sroi_reports carries none for it.
  const runIds = aggregate.included.map((c) => c.runId)
  const reportedRunIds = new Set<string>()
  if (runIds.length > 0) {
    const rows = await db
      .select({ calculationRunId: sroiReports.calculationRunId })
      .from(sroiReports)
      .where(and(inArray(sroiReports.calculationRunId, runIds), eq(sroiReports.organizationId, ctx.organization.id)))
    for (const row of rows) reportedRunIds.add(row.calculationRunId)
  }
  const ti2 = ti2FromIncludedAndReportedRuns(aggregate.included, reportedRunIds)

  // TI-3 — POS_AGG_5_RESTATED: distinct from portfolioSroiRatio, returned
  // under its own name.
  const ti3 = computeTi3(aggregate.included.map((c) => ({ projectId: c.projectId, sroiRatio: c.sroiRatio })))

  // TI-4
  const ti4 = computeTi4(aggregate.excluded)

  // TI-5 — source: EH-2.
  const ti5 = ti5FromEh2(evidenceHealth.eh2)

  // TI-6 — source: EH-5's bound-assignment rows.
  const ti6 = ti6FromEh5Rows(evidenceHealth.eh5.denominatorRows)

  // TI-7 — source: EH-4's byReason.
  const ti7: Ti7Result = { byReason: evidenceHealth.eh4.byReason }

  // TI-8 — source: EH-6.
  const ti8 = ti8FromEh6(evidenceHealth.eh6)

  return { ti1, ti2, ti3, ti4, ti5, ti6, ti7, ti8 }
}
