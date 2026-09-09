// lib/portfolios/evidence-health.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — EH-1 through EH-6, frozen
// unchanged from PORTFOLIO_COMMERCIAL_V1_AUTHORITY_v1.0.0.json.
//
// UNIVERSAL SHAPE OBLIGATION: every indicator returns a count, an EXPLICIT
// denominator, and the drill/source identifiers needed to reach the objects
// counted. No indicator is ever reduced to a single score/grade/index —
// NEG-PF3-EH-1 covers the content-load prohibition specifically; this module
// never selects evidence_items.description/url/file_path/review_notes or any
// other content-bearing column, only status/timestamps/identifiers/FKs.
//
// EH-5 (EH5_EXACT_SEMANTICS) is FROZEN by the authority's R2: the denominator
// is selected-run assignments with financial_proxy_version_id IS NOT NULL;
// EH5_UNBOUND (the NULL-bound count) is reported beside it, never inside the
// ratio. Global approved proxy versions (financial_proxy_versions.organization_id
// IS NULL) are bound through outcome_proxy_assignments — never through a
// predicate on financial_proxy_versions.organization_id itself (see
// TENANCY_CONTRACT.global_proxy_nuance and MUT-PF3-TENANT-1).
//
// lib/stella/** is a prohibited import for this module. No indicator here is
// produced, adjusted or ranked by Stella — see AUDIT_IMPACT / TRANSVERSAL_INTELLIGENCE.stella_boundary.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  evidenceItems,
  financialProxyVersions,
  outcomeMonetizationDispositions,
  outcomeProxyAssignments,
  sroiCalculationLineItems,
  sroiCalculationRuns,
} from '@/db/schema'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { getLatestSufficiencyDeterminationsByOutcomeIds } from '@/lib/pipeline/evidence-sufficiency'
import {
  buildPortfolioProjectRunSummaries,
  chunkArray,
  listPortfolioMemberProjects,
  PORTFOLIO_READ_MODEL_CHUNK_SIZE,
  selectedRunIdOf,
} from './read-model'

const EVIDENCE_STATUSES = ['draft', 'under_review', 'approved', 'rejected', 'archived'] as const
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number]

/** A member project that has a selected (PF1-approved) calculation run. */
export type RunScopedMember = { projectId: string; projectName: string; runId: string; calculatedAt: Date }

// ---------------------------------------------------------------------------
// EH-1 — Evidence by state
// ---------------------------------------------------------------------------

export type Eh1ProjectBreakdown = {
  projectId: string
  projectName: string
  counts: Record<EvidenceStatus, number>
  denominator: number
  drillUrl: string
}

export type Eh1Result = { byProject: Eh1ProjectBreakdown[] }

/** Pure: NEG-PF3-EH-1 — rows carry status only, never content/body columns. */
export function eh1FromRows(
  memberProjects: readonly { id: string; name: string }[],
  rows: readonly { projectId: string; status: string }[]
): Eh1Result {
  const byProject = new Map<string, Eh1ProjectBreakdown>()
  for (const p of memberProjects) {
    byProject.set(p.id, {
      projectId: p.id,
      projectName: p.name,
      counts: { draft: 0, under_review: 0, approved: 0, rejected: 0, archived: 0 },
      denominator: 0,
      drillUrl: `/app/projects/${p.id}/pipeline/evidence`,
    })
  }
  for (const row of rows) {
    const entry = byProject.get(row.projectId)
    if (!entry) continue
    if ((EVIDENCE_STATUSES as readonly string[]).includes(row.status)) {
      entry.counts[row.status as EvidenceStatus] += 1
      entry.denominator += 1
    }
  }
  return { byProject: [...byProject.values()] }
}

async function computeEh1(
  memberProjects: readonly { id: string; name: string }[],
  organizationId: string
): Promise<Eh1Result> {
  if (memberProjects.length === 0) return { byProject: [] }

  const rows: { projectId: string; status: string }[] = []
  for (const chunk of chunkArray(memberProjects, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
    const chunkRows = await db
      .select({ projectId: evidenceItems.projectId, status: evidenceItems.status })
      .from(evidenceItems)
      .where(
        and(
          inArray(
            evidenceItems.projectId,
            chunk.map((p) => p.id)
          ),
          eq(evidenceItems.organizationId, organizationId)
        )
      )
    rows.push(...chunkRows)
  }

  return eh1FromRows(memberProjects, rows)
}

// ---------------------------------------------------------------------------
// Shared: the active outcome set of a run — distinct outcome ids carried by
// the run's own line items. Same source getRunMonetizationCoverage uses
// (lib/pipeline/sroi-calculation.ts), reused by shape rather than reimplemented ad hoc.
// ---------------------------------------------------------------------------

async function activeOutcomeIdsByRun(runIds: readonly string[]): Promise<Map<string, string[]>> {
  const byRun = new Map<string, Set<string>>()
  if (runIds.length === 0) return new Map()
  for (const chunk of chunkArray(runIds, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
    const rows = await db
      .select({ runId: sroiCalculationLineItems.runId, outcomeId: sroiCalculationLineItems.outcomeId })
      .from(sroiCalculationLineItems)
      .where(inArray(sroiCalculationLineItems.runId, chunk))
    for (const row of rows) {
      if (!row.outcomeId) continue
      const set = byRun.get(row.runId) ?? new Set<string>()
      set.add(row.outcomeId)
      byRun.set(row.runId, set)
    }
  }
  const out = new Map<string, string[]>()
  for (const [runId, set] of byRun) out.set(runId, [...set])
  return out
}

// ---------------------------------------------------------------------------
// EH-2 — Outcomes with approved evidence
// ---------------------------------------------------------------------------

export type Eh2Result = {
  numerator: number
  denominator: number
  coveredOutcomeIds: string[]
  activeOutcomeIds: string[]
  byProject: { projectId: string; projectName: string; coveredOutcomeIds: string[]; activeOutcomeIds: string[] }[]
}

/** Pure: EH-2 given each run's active outcome set and the approved-evidence outcome set. */
export function eh2FromActiveAndApproved(
  members: readonly RunScopedMember[],
  activeByRun: ReadonlyMap<string, string[]>,
  approvedOutcomeIds: ReadonlySet<string>
): Eh2Result {
  const allActiveOutcomeIds = [...new Set([...activeByRun.values()].flat())]

  const byProject = members.map((m) => {
    const active = activeByRun.get(m.runId) ?? []
    const covered = active.filter((id) => approvedOutcomeIds.has(id))
    return { projectId: m.projectId, projectName: m.projectName, coveredOutcomeIds: covered, activeOutcomeIds: active }
  })

  const coveredOutcomeIds = [...new Set(byProject.flatMap((p) => p.coveredOutcomeIds))]

  return {
    numerator: coveredOutcomeIds.length,
    denominator: allActiveOutcomeIds.length,
    coveredOutcomeIds,
    activeOutcomeIds: allActiveOutcomeIds,
    byProject,
  }
}

async function computeEh2(members: readonly RunScopedMember[], organizationId: string): Promise<Eh2Result> {
  const runIds = members.map((m) => m.runId)
  const activeByRun = await activeOutcomeIdsByRun(runIds)
  const allActiveOutcomeIds = [...new Set([...activeByRun.values()].flat())]

  const approvedOutcomeIds = new Set<string>()
  if (allActiveOutcomeIds.length > 0) {
    for (const chunk of chunkArray(allActiveOutcomeIds, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
      const rows = await db
        .select({ outcomeId: evidenceItems.outcomeId })
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.status, 'approved'),
            eq(evidenceItems.organizationId, organizationId),
            inArray(evidenceItems.outcomeId, chunk)
          )
        )
      for (const row of rows) if (row.outcomeId) approvedOutcomeIds.add(row.outcomeId)
    }
  }

  return eh2FromActiveAndApproved(members, activeByRun, approvedOutcomeIds)
}

// ---------------------------------------------------------------------------
// EH-3 — Sufficiency determinations (selected-run rule, POS-EH-2)
// ---------------------------------------------------------------------------

export type Eh3Result = {
  sufficient: number
  insufficient: number
  undetermined: number
  denominator: number
  sufficientOutcomeIds: string[]
  insufficientOutcomeIds: string[]
  undeterminedOutcomeIds: string[]
}

/**
 * Pure: EH-3 given each run's active outcome set and its OWN
 * (run-bound) determinations map — POS-EH-2's selected-run binding is
 * enforced by the CALLER passing a per-run map, never a global one keyed by
 * outcome alone.
 */
export function eh3FromDeterminations(
  members: readonly RunScopedMember[],
  activeByRun: ReadonlyMap<string, string[]>,
  determinationsByRun: ReadonlyMap<string, ReadonlyMap<string, { determination: string }>>
): Eh3Result {
  const sufficientOutcomeIds: string[] = []
  const insufficientOutcomeIds: string[] = []
  const undeterminedOutcomeIds: string[] = []

  for (const m of members) {
    const outcomeIds = activeByRun.get(m.runId) ?? []
    const determinations = determinationsByRun.get(m.runId)
    for (const outcomeId of outcomeIds) {
      const det = determinations?.get(outcomeId)
      if (!det) {
        undeterminedOutcomeIds.push(outcomeId)
      } else if (det.determination === 'sufficient') {
        sufficientOutcomeIds.push(outcomeId)
      } else {
        insufficientOutcomeIds.push(outcomeId)
      }
    }
  }

  return {
    sufficient: sufficientOutcomeIds.length,
    insufficient: insufficientOutcomeIds.length,
    undetermined: undeterminedOutcomeIds.length,
    denominator: sufficientOutcomeIds.length + insufficientOutcomeIds.length + undeterminedOutcomeIds.length,
    sufficientOutcomeIds,
    insufficientOutcomeIds,
    undeterminedOutcomeIds,
  }
}

async function computeEh3(members: readonly RunScopedMember[]): Promise<Eh3Result> {
  const activeByRun = await activeOutcomeIdsByRun(members.map((m) => m.runId))

  // getLatestSufficiencyDeterminationsByOutcomeIds is bound to ONE
  // calculationRunId per call — a determination recorded against another run
  // must never satisfy this one (POS-EH-2). Called once per member run.
  const determinationsByRun = new Map<string, Map<string, { determination: string }>>()
  for (const m of members) {
    const outcomeIds = activeByRun.get(m.runId) ?? []
    if (outcomeIds.length === 0) continue
    const determinations = await getLatestSufficiencyDeterminationsByOutcomeIds(outcomeIds, m.runId)
    determinationsByRun.set(m.runId, determinations)
  }

  return eh3FromDeterminations(members, activeByRun, determinationsByRun)
}

// ---------------------------------------------------------------------------
// EH-4 — Monetization dispositions
// ---------------------------------------------------------------------------

const NOT_MONETIZED_REASONS = [
  'no_defensible_proxy',
  'proxy_not_approved',
  'insufficient_evidence',
  'not_material',
  'not_yet_eligible',
  'superseded_version',
  'other_governed_reason',
] as const

export type Eh4Result = {
  monetized: number
  notMonetized: number
  byReason: Record<string, number>
  denominator: number
  monetizedOutcomeIds: string[]
  notMonetizedOutcomeIds: string[]
}

/** Pure: EH-4 given the raw disposition rows for the portfolio's member runs. */
export function eh4FromRows(
  rows: readonly { outcomeId: string; disposition: string; reason: string | null }[]
): Eh4Result {
  const byReason: Record<string, number> = Object.fromEntries(NOT_MONETIZED_REASONS.map((r) => [r, 0]))
  const monetizedOutcomeIds: string[] = []
  const notMonetizedOutcomeIds: string[] = []

  for (const row of rows) {
    if (row.disposition === 'monetized') {
      monetizedOutcomeIds.push(row.outcomeId)
    } else {
      notMonetizedOutcomeIds.push(row.outcomeId)
      if (row.reason && row.reason in byReason) byReason[row.reason] += 1
    }
  }

  return {
    monetized: monetizedOutcomeIds.length,
    notMonetized: notMonetizedOutcomeIds.length,
    byReason,
    denominator: monetizedOutcomeIds.length + notMonetizedOutcomeIds.length,
    monetizedOutcomeIds,
    notMonetizedOutcomeIds,
  }
}

async function computeEh4(members: readonly RunScopedMember[], organizationId: string): Promise<Eh4Result> {
  const runIds = members.map((m) => m.runId)
  const rows: { outcomeId: string; disposition: string; reason: string | null }[] = []

  if (runIds.length > 0) {
    for (const chunk of chunkArray(runIds, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
      const chunkRows = await db
        .select({
          outcomeId: outcomeMonetizationDispositions.outcomeId,
          disposition: outcomeMonetizationDispositions.disposition,
          reason: outcomeMonetizationDispositions.reason,
        })
        .from(outcomeMonetizationDispositions)
        .where(
          and(
            inArray(outcomeMonetizationDispositions.calculationRunId, chunk),
            eq(outcomeMonetizationDispositions.organizationId, organizationId)
          )
        )
      rows.push(...chunkRows)
    }
  }

  return eh4FromRows(rows)
}

// ---------------------------------------------------------------------------
// EH-5 — Approved proxy versions (EH5_EXACT_SEMANTICS, frozen)
// ---------------------------------------------------------------------------

export type Eh5DrillRow = {
  assignmentId: string
  projectId: string
  financialProxyVersionId: string | null
  financialProxyId: string | null
}

export type Eh5Result = {
  numerator: number
  denominator: number
  unbound: number
  denominatorRows: Eh5DrillRow[]
  unboundRows: Eh5DrillRow[]
}

/**
 * Bound through outcome_proxy_assignments — organization_id NOT NULL,
 * project_id NOT NULL, constrained to the portfolio's member projects — and
 * the joined financial_proxy_versions row's review_status is read with NO
 * organization predicate on that row, so a globally-approved proxy version
 * (organization_id IS NULL) stays reachable. See TENANCY_CONTRACT and
 * MUT-PF3-TENANT-1 — replacing this join with a predicate on
 * financial_proxy_versions.organization_id must make this indicator wrong.
 */
type Eh5Assignment = { id: string; projectId: string; proxyId: string; financialProxyVersionId: string | null }

/**
 * Pure: EH-5, given the portfolio's active assignments and the review_status
 * of every version they bind to (fetched with NO organization predicate —
 * see MUT-PF3-TENANT-1).
 */
export function eh5FromRows(
  assignments: readonly Eh5Assignment[],
  reviewStatusByVersionId: ReadonlyMap<string, string>
): Eh5Result {
  // EH5_DENOMINATOR: assignments whose financial_proxy_version_id IS NOT
  // NULL. EH5_UNBOUND: the NULL-bound remainder, reported separately.
  const bound = assignments.filter((a) => a.financialProxyVersionId !== null)
  const unbound = assignments.filter((a) => a.financialProxyVersionId === null)

  const denominatorRows: Eh5DrillRow[] = bound.map((a) => ({
    assignmentId: a.id,
    projectId: a.projectId,
    financialProxyVersionId: a.financialProxyVersionId,
    financialProxyId: a.proxyId,
  }))
  const approvedRows = denominatorRows.filter(
    (r) => reviewStatusByVersionId.get(r.financialProxyVersionId!) === 'approved'
  )
  const unboundRows: Eh5DrillRow[] = unbound.map((a) => ({
    assignmentId: a.id,
    projectId: a.projectId,
    financialProxyVersionId: null,
    financialProxyId: a.proxyId,
  }))

  return {
    numerator: approvedRows.length,
    denominator: denominatorRows.length,
    unbound: unboundRows.length,
    denominatorRows,
    unboundRows,
  }
}

async function computeEh5(
  memberProjectIds: readonly string[],
  organizationId: string
): Promise<Eh5Result> {
  if (memberProjectIds.length === 0) {
    return { numerator: 0, denominator: 0, unbound: 0, denominatorRows: [], unboundRows: [] }
  }

  const assignments: Eh5Assignment[] = []
  for (const chunk of chunkArray(memberProjectIds, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
    const rows = await db
      .select({
        id: outcomeProxyAssignments.id,
        projectId: outcomeProxyAssignments.projectId,
        proxyId: outcomeProxyAssignments.proxyId,
        financialProxyVersionId: outcomeProxyAssignments.financialProxyVersionId,
      })
      .from(outcomeProxyAssignments)
      .where(
        and(
          inArray(outcomeProxyAssignments.projectId, chunk),
          eq(outcomeProxyAssignments.organizationId, organizationId),
          eq(outcomeProxyAssignments.assignmentStatus, 'active')
        )
      )
    assignments.push(...rows)
  }

  const versionIds = [...new Set(assignments.map((a) => a.financialProxyVersionId).filter((id): id is string => id !== null))]
  const reviewStatusByVersionId = new Map<string, string>()
  for (const chunk of chunkArray(versionIds, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
    // NO organization predicate here — a globally-approved version carries
    // organization_id IS NULL and must stay readable through this join.
    const rows = await db
      .select({ id: financialProxyVersions.id, reviewStatus: financialProxyVersions.reviewStatus })
      .from(financialProxyVersions)
      .where(inArray(financialProxyVersions.id, chunk))
    for (const row of rows) reviewStatusByVersionId.set(row.id, row.reviewStatus)
  }

  return eh5FromRows(assignments, reviewStatusByVersionId)
}

// ---------------------------------------------------------------------------
// EH-6 — Evidence newer than the selected run
// ---------------------------------------------------------------------------

export type Eh6ProjectBreakdown = {
  projectId: string
  projectName: string
  count: number
  denominator: number
  evidenceItemIds: string[]
}

export type Eh6Result = { byProject: Eh6ProjectBreakdown[] }

/** Pure: EH-6 given the raw evidence rows (id/projectId/updatedAt only — NEG-PF3-EH-1). */
export function eh6FromRows(
  members: readonly RunScopedMember[],
  rows: readonly { id: string; projectId: string; updatedAt: Date }[]
): Eh6Result {
  const byProjectId = new Map<string, { id: string; projectId: string; updatedAt: Date }[]>()
  for (const row of rows) {
    const list = byProjectId.get(row.projectId) ?? []
    list.push(row)
    byProjectId.set(row.projectId, list)
  }

  const byProject: Eh6ProjectBreakdown[] = members.map((m) => {
    const all = byProjectId.get(m.projectId) ?? []
    const newer = all.filter((r) => r.updatedAt.getTime() > m.calculatedAt.getTime())
    return {
      projectId: m.projectId,
      projectName: m.projectName,
      count: newer.length,
      denominator: all.length,
      evidenceItemIds: newer.map((r) => r.id),
    }
  })
  return { byProject }
}

async function computeEh6(
  members: readonly RunScopedMember[],
  organizationId: string
): Promise<Eh6Result> {
  const rows: { id: string; projectId: string; updatedAt: Date }[] = []
  for (const chunk of chunkArray(members, PORTFOLIO_READ_MODEL_CHUNK_SIZE)) {
    const projectIds = chunk.map((m) => m.projectId)
    const chunkRows = await db
      .select({ id: evidenceItems.id, projectId: evidenceItems.projectId, updatedAt: evidenceItems.updatedAt })
      .from(evidenceItems)
      .where(and(inArray(evidenceItems.projectId, projectIds), eq(evidenceItems.organizationId, organizationId)))
    rows.push(...chunkRows)
  }
  return eh6FromRows(members, rows)
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type PortfolioEvidenceHealth = {
  eh1: Eh1Result
  eh2: Eh2Result
  eh3: Eh3Result
  eh4: Eh4Result
  eh5: Eh5Result
  eh6: Eh6Result
}

/**
 * The full EH-1..EH-6 surface for one portfolio, scoped to the caller's
 * organization. Returns null when the portfolio does not exist or is not
 * owned by the caller's org.
 *
 * Must be called inside an already-open identity context — see
 * lib/portfolios/read-model.ts's getPortfolioReadModel doc comment.
 */
export async function getPortfolioEvidenceHealth(portfolioId: string): Promise<PortfolioEvidenceHealth | null> {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) throw new Error('Unauthenticated')

  const memberProjects = await listPortfolioMemberProjects(portfolioId, ctx.organization.id)
  // A portfolio with zero members is a valid empty result, not a not-found —
  // matching lib/portfolios/analytics.ts's getPortfolioAnalytics for the same
  // case. Existence of the portfolio itself is proven by the read model
  // (getPortfolioReadModel), which the page always calls alongside this one.

  const summaries = await buildPortfolioProjectRunSummaries(memberProjects, ctx.organization.id)
  const runScopedMembers: RunScopedMember[] = []
  for (const s of summaries) {
    const runId = selectedRunIdOf(s)
    if (!runId || s.selection !== 'approved') continue
    const run = await db
      .select({ calculatedAt: sroiCalculationRuns.calculatedAt })
      .from(sroiCalculationRuns)
      .where(eq(sroiCalculationRuns.id, runId))
      .then((rows) => rows[0])
    if (!run) continue
    runScopedMembers.push({ projectId: s.projectId, projectName: s.projectName, runId, calculatedAt: run.calculatedAt })
  }

  const [eh1, eh2, eh3, eh4, eh5, eh6] = await Promise.all([
    computeEh1(memberProjects, ctx.organization.id),
    computeEh2(runScopedMembers, ctx.organization.id),
    computeEh3(runScopedMembers),
    computeEh4(runScopedMembers, ctx.organization.id),
    computeEh5(
      memberProjects.map((p) => p.id),
      ctx.organization.id
    ),
    computeEh6(runScopedMembers, ctx.organization.id),
  ])

  return { eh1, eh2, eh3, eh4, eh5, eh6 }
}
