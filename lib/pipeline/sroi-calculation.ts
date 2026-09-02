// lib/pipeline/sroi-calculation.ts
// Sprint 6B – Deterministic SROI Calculation Engine
// No mocks. No placeholders. No FX conversion. No AI/Stella.

// Pin the shared Decimal configuration (precision/rounding) before anything
// else touches decimal.js — determinism guard, see decimal-config.ts.
import '@/lib/pipeline/decimal-config'
import { eq, and, inArray, sql } from 'drizzle-orm'
import Decimal from 'decimal.js'
import { db } from '@/db/client'
import { z } from 'zod'
import {
  projectInvestments,
  sroiAssignmentInputs,
  sroiFilterSets,
  sroiCalculationRuns,
  sroiCalculationLineItems,
  sroiRunReviews,
  outcomeMonetizationDispositions,
  outcomeProxyAssignments,
  financialProxies,
  financialProxyVersions,
  outcomes,
  projects,
  evidenceItems,
  outcomeFunderAllocations,
  funders,
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import { type Role } from '@/lib/auth/roles'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { computeFundersBreakdown, type FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'
import { getOrCreateSharedCopRate, convertToUsd } from '@/lib/pipeline/fx'
import { getOrCreatePlaceholderFunder } from '@/lib/pipeline/funders'
import { scenarioFilterPct, SCENARIO_DELTA_PP, type Scenario } from '@/lib/pipeline/sroi-sensitivity'
import { resolveRunVersionIdentity } from '@/lib/pipeline/run-version-identity'
import {
  createDomainObjectVersion,
  getLatestDomainObjectVersion,
} from '@/lib/pipeline/domain-object-versions'

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const ProjectInvestmentSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  year: z.number().int().optional(),
  description: z.string().optional(),
  // Fase 1b — optional here so the existing single-investment form keeps
  // working; funder defaults to the org's placeholder, type defaults to cash.
  funderId: z.string().uuid().optional(),
  contributionType: z.enum(['cash', 'in_kind']).optional(),
  inKindValuationNotes: z.string().optional(),
})
export type ProjectInvestmentInput = z.infer<typeof ProjectInvestmentSchema>

export const AssignmentInputSchema = z.object({
  quantity: z.string().min(1),
  unit: z.string().min(1),
  year: z.number().int().optional(),
  notes: z.string().optional(),
})
export type AssignmentInput = z.infer<typeof AssignmentInputSchema>

export const FilterSetSchema = z.object({
  deadweightPct: z.string().optional(),
  displacementPct: z.string().optional(),
  attributionPct: z.string().optional(),
  dropoffPct: z.string().optional(),
  durationYears: z.number().int().optional(),
  justification: z.string().optional(),
  // FIBIU-13 (FIBC-017/FIBDB-010) — one discrete justification per filter,
  // independent of the legacy shared `justification` column above and never
  // auto-distributed from it (NPDD-03).
  deadweightJustification: z.string().optional(),
  attributionJustification: z.string().optional(),
  displacementJustification: z.string().optional(),
  dropoffJustification: z.string().optional(),
  durationJustification: z.string().optional(),
})
export type FilterSetInput = z.infer<typeof FilterSetSchema>

// ─── Internal helpers ───────────────────────────────────────────────────────

async function authorize(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .limit(1)
  if (proj.length === 0) throw new Error('Project not found or not owned')
  if (!hasRole(ctx.membership.role as Role, 'analyst')) throw new Error('Insufficient role')
  return ctx
}

// Matches the leading numeric token exactly as parseFloat would consume it:
// optional sign, then Infinity | digits[.digits][exponent] | .digits[exponent].
const LEADING_NUMBER_RE = /^[+-]?(?:Infinity|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/

// Exported for characterization tests (tests/sroi-parse-num.test.ts) — the
// accepted input formats are pinned there; keep them green if you touch this.
//
// Decimal-based replacement for the historical parseFloat implementation
// (U1, WS4): same accepted formats — leading/trailing whitespace tolerated,
// trailing garbage ignored, Infinity preserved, invalid input → 0 — but the
// numeric interpretation now flows through the pinned Decimal configuration
// instead of the platform float parser.
export function parseNum(val: string | null | undefined): number {
  if (!val) return 0
  const match = LEADING_NUMBER_RE.exec(val.trimStart())
  if (!match) return 0
  // decimal.js rejects a trailing bare dot ('5.'); parseFloat accepted it.
  const token = match[0].endsWith('.') ? match[0].slice(0, -1) : match[0]
  try {
    return new Decimal(token).toNumber()
  } catch {
    return 0
  }
}

function clamp(val: number, lo: number, hi: number) {
  return Math.min(Math.max(val, lo), hi)
}

// ─── Investment ─────────────────────────────────────────────────────────────

// Resolve the frozen USD equivalent of a contribution at save time.
// USD passes through; COP auto-fetches the TRM (Dec 31 of `year`, or today);
// any other currency needs a manual rate (1c UI) and is left null here, which
// the readiness check surfaces as a blocker.
async function resolveAmountUsd(
  amount: string,
  currency: string,
  year: number | undefined,
): Promise<{ amountUsd: string | null; fxRateId: string | null }> {
  if (currency === 'USD') return { amountUsd: amount, fxRateId: null }
  if (currency === 'COP') {
    const date = year ? `${year}-12-31` : new Date().toISOString().slice(0, 10)
    const rate = await getOrCreateSharedCopRate(date)
    if (!rate?.rateToUsd) return { amountUsd: null, fxRateId: null }
    return { amountUsd: convertToUsd(amount, rate.rateToUsd), fxRateId: rate.id }
  }
  return { amountUsd: null, fxRateId: null }
}

export async function upsertProjectInvestment(projectId: string, input: ProjectInvestmentInput) {
  const ctx = await authorize(projectId)
  const validated = ProjectInvestmentSchema.parse(input)

  // Every investment must carry a funder — default to the org's placeholder.
  const funderId =
    validated.funderId ?? (await getOrCreatePlaceholderFunder(ctx.organization.id, ctx.user.id)).id
  const contributionType = validated.contributionType ?? 'cash'
  const { amountUsd, fxRateId } = await resolveAmountUsd(validated.amount, validated.currency, validated.year)

  const values = {
    amount: validated.amount,
    currency: validated.currency,
    year: validated.year,
    description: validated.description,
    funderId,
    contributionType,
    inKindValuationNotes: validated.inKindValuationNotes,
    amountUsd,
    fxRateId,
  }

  const existing = await db.select().from(projectInvestments).where(eq(projectInvestments.projectId, projectId))

  if (existing.length > 0) {
    await db.update(projectInvestments).set({ ...values, updatedAt: new Date() }).where(eq(projectInvestments.id, existing[0].id))
    const updated = await db.select().from(projectInvestments).where(eq(projectInvestments.id, existing[0].id))
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'project_investments',
      entityId: existing[0].id,
      action: AUDIT_ACTIONS.PROJECT_INVESTMENT_UPDATED,
      contentModifying: true,
      beforeJson: existing[0] as unknown as Record<string, unknown>,
      afterJson: updated[0] as unknown as Record<string, unknown>,
    })
    // FIBIU-03 (FIBC-002/FIBC-045) — a new version, never a rewrite of the
    // one an already-calculated run's input fingerprint may point to.
    await createDomainObjectVersion({
      organizationId: ctx.organization.id,
      objectType: 'project_investment',
      objectId: existing[0].id,
      payload: updated[0] as unknown as Record<string, unknown>,
      actorId: ctx.user.id,
    })
    return updated[0]
  }

  const inserted = await db.insert(projectInvestments).values({ ...values, projectId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project_investments',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.PROJECT_INVESTMENT_CREATED,
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  // FIBIU-03 (FIBC-002/FIBC-045) — first version of this object's lineage.
  await createDomainObjectVersion({
    organizationId: ctx.organization.id,
    objectType: 'project_investment',
    objectId: inserted[0].id,
    payload: inserted[0] as unknown as Record<string, unknown>,
    actorId: ctx.user.id,
  })
  return inserted[0]
}

// ─── Project discount rate (Fase 1e) ─────────────────────────────────────────

export async function setProjectDiscountRate(projectId: string, discountRatePct: string | null) {
  const ctx = await authorize(projectId)
  let value: string | null = null
  if (discountRatePct !== null && discountRatePct !== '') {
    const n = parseFloat(discountRatePct)
    if (isNaN(n) || n < 0 || n > 100) throw new Error('La tasa de descuento debe estar entre 0 y 100%')
    value = String(n)
  }
  const existing = await db
    .select({ discountRatePct: projects.discountRatePct })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))

  await db
    .update(projects)
    .set({ discountRatePct: value, updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_DISCOUNT_RATE_UPDATED,
    contentModifying: true,
    beforeJson: { discountRatePct: existing[0]?.discountRatePct ?? null },
    afterJson: { discountRatePct: value },
  })
  return { discountRatePct: value }
}

// ─── Assignment Input ────────────────────────────────────────────────────────

export async function upsertSroiAssignmentInput(projectId: string, assignmentId: string, input: AssignmentInput) {
  const ctx = await authorize(projectId)
  const assign = await db.select().from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.id, assignmentId), eq(outcomeProxyAssignments.projectId, projectId)))
  if (assign.length === 0) throw new Error('Assignment not found for project')
  const validated = AssignmentInputSchema.parse(input)
  const existing = await db.select().from(sroiAssignmentInputs).where(eq(sroiAssignmentInputs.assignmentId, assignmentId))

  if (existing.length > 0) {
    await db.update(sroiAssignmentInputs).set({ ...validated, updatedAt: new Date() }).where(eq(sroiAssignmentInputs.id, existing[0].id))
    const updated = await db.select().from(sroiAssignmentInputs).where(eq(sroiAssignmentInputs.id, existing[0].id))
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'sroi_assignment_inputs',
      entityId: existing[0].id,
      action: AUDIT_ACTIONS.SROI_ASSIGNMENT_INPUT_UPDATED,
      contentModifying: true,
      beforeJson: existing[0] as unknown as Record<string, unknown>,
      afterJson: updated[0] as unknown as Record<string, unknown>,
    })
    // FIBIU-03 (FIBC-002/FIBC-045) — a new version, never a rewrite of the
    // one an already-calculated run's input fingerprint may point to.
    await createDomainObjectVersion({
      organizationId: ctx.organization.id,
      objectType: 'sroi_assignment_input',
      objectId: existing[0].id,
      payload: updated[0] as unknown as Record<string, unknown>,
      actorId: ctx.user.id,
    })
    return updated[0]
  }

  const inserted = await db.insert(sroiAssignmentInputs).values({ ...validated, assignmentId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_assignment_inputs',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.SROI_ASSIGNMENT_INPUT_CREATED,
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  // FIBIU-03 (FIBC-002/FIBC-045) — first version of this object's lineage.
  await createDomainObjectVersion({
    organizationId: ctx.organization.id,
    objectType: 'sroi_assignment_input',
    objectId: inserted[0].id,
    payload: inserted[0] as unknown as Record<string, unknown>,
    actorId: ctx.user.id,
  })
  return inserted[0]
}

// ─── Filter Set ──────────────────────────────────────────────────────────────

export async function upsertSroiFilterSet(projectId: string, assignmentId: string, input: FilterSetInput) {
  const ctx = await authorize(projectId)
  const assign = await db.select().from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.id, assignmentId), eq(outcomeProxyAssignments.projectId, projectId)))
  if (assign.length === 0) throw new Error('Assignment not found for project')
  const validated = FilterSetSchema.parse(input)
  const existing = await db.select().from(sroiFilterSets).where(and(eq(sroiFilterSets.assignmentId, assignmentId), eq(sroiFilterSets.organizationId, ctx.organization.id)))

  if (existing.length > 0) {
    await db.update(sroiFilterSets).set({ ...validated, updatedAt: new Date() }).where(eq(sroiFilterSets.id, existing[0].id))
    const updated = await db.select().from(sroiFilterSets).where(eq(sroiFilterSets.id, existing[0].id))
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'sroi_filter_sets',
      entityId: existing[0].id,
      action: AUDIT_ACTIONS.SROI_FILTER_SET_UPDATED,
      contentModifying: true,
      beforeJson: existing[0] as unknown as Record<string, unknown>,
      afterJson: updated[0] as unknown as Record<string, unknown>,
    })
    return updated[0]
  }

  const inserted = await db.insert(sroiFilterSets).values({ ...validated, assignmentId, organizationId: ctx.organization.id, createdBy: ctx.user.id }).returning()
  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sroi_filter_sets',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.SROI_FILTER_SET_CREATED,
    afterJson: inserted[0] as unknown as Record<string, unknown>,
  })
  return inserted[0]
}

/** One of V-01's five gated filters (discount_rate_pct is deliberately excluded). */
export type FilterName = 'deadweight' | 'attribution' | 'displacement' | 'dropoff' | 'duration'
export type FilterJustificationIssueCode = 'FILTER_VALUE_MISSING' | 'FILTER_JUSTIFICATION_MISSING'
export interface FilterJustificationIssue {
  filter: FilterName
  issue: FilterJustificationIssueCode
}

/**
 * FIBIU-13 (FIBC-017, FIBDB-010) — pure composable primitive for the
 * approval-eligibility/report-lock gate: for each of the five filters,
 * reports FILTER_VALUE_MISSING when the value itself is absent, or
 * FILTER_JUSTIFICATION_MISSING when a value is present but its own discrete
 * justification is not — `0` is a valid, present value and never exempts
 * justification. Deliberately checks null/undefined/empty BEFORE any
 * parseNum call, so an unset filter is never indistinguishable from a
 * justified `0` (the parseNum(null) -> 0 coercion this replaces on the
 * authoritative path).
 *
 * Not wired into getSroiCalculationReadiness()/canCalculate: FIBC-017
 * explicitly permits preliminary calculation with unjustified filters, and
 * this unit's own FILES_OR_DOMAINS does not reach the eligibility
 * composition (FIBIU-19, Wave 3, composes over FIBIU-06/09/11/12/13/14/15/
 * 16/17/18) — the same boundary already drawn for FIBIU-11's materiality
 * classification.
 */
export function getFilterJustificationIssues(
  filterSet: Pick<
    typeof sroiFilterSets.$inferSelect,
    | 'deadweightPct' | 'attributionPct' | 'displacementPct' | 'dropoffPct' | 'durationYears'
    | 'deadweightJustification' | 'attributionJustification' | 'displacementJustification'
    | 'dropoffJustification' | 'durationJustification'
  > | null | undefined,
): FilterJustificationIssue[] {
  if (!filterSet) {
    return (['deadweight', 'attribution', 'displacement', 'dropoff', 'duration'] as const)
      .map((filter) => ({ filter, issue: 'FILTER_VALUE_MISSING' as const }))
  }

  const isBlank = (v: string | number | null | undefined) => v === null || v === undefined || v === ''

  const checks: { filter: FilterName; value: string | number | null | undefined; justification: string | null | undefined }[] = [
    { filter: 'deadweight', value: filterSet.deadweightPct, justification: filterSet.deadweightJustification },
    { filter: 'attribution', value: filterSet.attributionPct, justification: filterSet.attributionJustification },
    { filter: 'displacement', value: filterSet.displacementPct, justification: filterSet.displacementJustification },
    { filter: 'dropoff', value: filterSet.dropoffPct, justification: filterSet.dropoffJustification },
    { filter: 'duration', value: filterSet.durationYears, justification: filterSet.durationJustification },
  ]

  const issues: FilterJustificationIssue[] = []
  for (const { filter, value, justification } of checks) {
    if (isBlank(value)) {
      issues.push({ filter, issue: 'FILTER_VALUE_MISSING' })
    } else if (isBlank(justification)) {
      issues.push({ filter, issue: 'FILTER_JUSTIFICATION_MISSING' })
    }
  }
  return issues
}

// ─── Monetization disposition ───────────────────────────────────────────────

export const MONETIZATION_REASON_VALUES = [
  'no_defensible_proxy', 'proxy_not_approved', 'insufficient_evidence',
  'not_material', 'not_yet_eligible', 'superseded_version', 'other_governed_reason',
] as const
export type MonetizationReason = (typeof MONETIZATION_REASON_VALUES)[number]

export const OutcomeMonetizationDispositionSchema = z.object({
  disposition: z.enum(['monetized', 'not_monetized']),
  reason: z.enum(MONETIZATION_REASON_VALUES).optional(),
  justification: z.string().min(1).optional(),
}).refine(
  (data) => data.disposition !== 'not_monetized' || data.reason !== undefined,
  { message: 'reason is required when disposition is not_monetized', path: ['reason'] },
).refine(
  (data) => data.reason === undefined || (data.justification !== undefined && data.justification.length > 0),
  { message: 'justification is required when reason is set', path: ['justification'] },
)
export type OutcomeMonetizationDispositionInput = z.infer<typeof OutcomeMonetizationDispositionSchema>

/**
 * FIBIU-12 (FIBC-016, FIBDB-009/045) — explicit human disposition per
 * outcome per calculation run: monetized | not_monetized, with reason +
 * justification required when not_monetized. Create-or-update (FIBIU-12's
 * versioning_reuse_map disposition is REUSE_EXISTING_VERSIONING, mirroring
 * FIBIU-11's setOutcomeMaterialityClassification), but refuses any write —
 * insert or update — once the run has an approved review: FIBDB-009's
 * "immutable once the run is approved".
 */
export async function recordOutcomeMonetizationDisposition(
  projectId: string,
  outcomeId: string,
  calculationRunId: string,
  input: OutcomeMonetizationDispositionInput,
) {
  const ctx = await authorize(projectId)
  const validated = OutcomeMonetizationDispositionSchema.parse(input)

  const outcomeRows = await db.select().from(outcomes).where(and(eq(outcomes.id, outcomeId), eq(outcomes.projectId, projectId)))
  if (outcomeRows.length === 0) throw new Error('Outcome not found for project')

  const runRows = await db.select().from(sroiCalculationRuns).where(and(eq(sroiCalculationRuns.id, calculationRunId), eq(sroiCalculationRuns.projectId, projectId)))
  if (runRows.length === 0) throw new Error('Calculation run not found for project')

  // Early, user-facing refusal. The AUTHORITATIVE refusal is the database
  // guard installed by 0060 (race-safe through advisory locks — see
  // W2_B3_COMPLETENESS_AUTHORITY AG-B3-6); this check only spares the user a
  // round trip and is never the reason the invariant holds.
  const approvedReview = await db.select().from(sroiRunReviews).where(and(eq(sroiRunReviews.calculationRunId, calculationRunId), eq(sroiRunReviews.status, 'approved')))
  if (approvedReview.length > 0) {
    throw new Error('Cannot record monetization disposition: this calculation run is already approved')
  }

  // W2-B3 completeness (AG-B3-2, disposition/engine consistency): the human
  // disposition attests and justifies what the IMMUTABLE run actually did.
  // 'monetized' for an outcome the run carries no line item for would
  // fabricate coverage the run does not have; 'not_monetized' for an outcome
  // the run DID monetize would contradict the persisted numerator. Both are
  // refused with a named error — a different disposition needs a new run.
  const runLineItems = await db
    .select({ outcomeId: sroiCalculationLineItems.outcomeId })
    .from(sroiCalculationLineItems)
    .where(eq(sroiCalculationLineItems.runId, calculationRunId))
  const engineMonetized = runLineItems.some((li) => li.outcomeId === outcomeId)
  if (validated.disposition === 'monetized' && !engineMonetized) {
    throw new Error(`Cannot record 'monetized': calculation run ${calculationRunId} carries no line item for outcome ${outcomeId} (FIBC-016 — a disposition never fabricates coverage the run does not have)`)
  }
  if (validated.disposition === 'not_monetized' && engineMonetized) {
    throw new Error(`Cannot record 'not_monetized': calculation run ${calculationRunId} monetized outcome ${outcomeId} in its line items (FIBC-016 — exclude it from a NEW run instead of contradicting this one)`)
  }

  const payload = {
    disposition: validated.disposition,
    reason: validated.reason ?? null,
    justification: validated.reason ? (validated.justification ?? null) : null,
  }

  const existing = await db.select().from(outcomeMonetizationDispositions).where(and(eq(outcomeMonetizationDispositions.outcomeId, outcomeId), eq(outcomeMonetizationDispositions.calculationRunId, calculationRunId)))

  let saved: typeof outcomeMonetizationDispositions.$inferSelect
  if (existing.length > 0) {
    // SERVICE_ZERO_ROW_FAIL_CLOSED (W2-B3 completeness, PG-12 F11): the UPDATE
    // must return the row it changed. Zero rows means row-level security or
    // the 0060 approved-run guard refused the write — recording an audit
    // event and a version row for a mutation that never happened is exactly
    // the fictional-success hazard PG-12 measured, so nothing is recorded.
    const updated = await db
      .update(outcomeMonetizationDispositions)
      .set(payload)
      .where(eq(outcomeMonetizationDispositions.id, existing[0].id))
      .returning()
    if (updated.length === 0) {
      throw new Error('Monetization disposition update affected no row (refused by row-level security or the approved-run guard) — nothing was recorded')
    }
    saved = updated[0]
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'outcome_monetization_disposition',
      entityId: existing[0].id,
      action: AUDIT_ACTIONS.OUTCOME_MONETIZATION_DISPOSITION_RECORDED,
      contentModifying: true,
      beforeJson: existing[0] as unknown as Record<string, unknown>,
      afterJson: saved as unknown as Record<string, unknown>,
    })
  } else {
    const inserted = await db.insert(outcomeMonetizationDispositions).values({
      ...payload,
      outcomeId,
      calculationRunId,
      organizationId: ctx.organization.id,
      createdBy: ctx.user.id,
    }).returning()
    saved = inserted[0]
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'outcome_monetization_disposition',
      entityId: saved.id,
      action: AUDIT_ACTIONS.OUTCOME_MONETIZATION_DISPOSITION_RECORDED,
      afterJson: saved as unknown as Record<string, unknown>,
    })
  }

  await createDomainObjectVersion({
    organizationId: ctx.organization.id,
    objectType: 'outcome_monetization_disposition',
    objectId: saved.id,
    payload: saved as unknown as Record<string, unknown>,
    actorId: ctx.user.id,
  })

  return saved
}

/**
 * W2-B3 completeness (AG-B3-2, COVERAGE_COMPLETENESS) — one row per outcome
 * in the run's coverage view. `bucket` is the distinct governed state:
 * 'monetized', 'missing_disposition', or `not_monetized:<reason>` with the
 * reason kept verbatim — the seven governed reasons are NEVER collapsed into
 * a generic omission category (FIBC-016). `material` and `engineMonetized`
 * are carried alongside so "material not monetized" is a derived, visible
 * view rather than a bucket that would hide the reason.
 */
export type MonetizationCoverageBucket = 'monetized' | 'missing_disposition' | `not_monetized:${MonetizationReason}`
export interface MonetizationCoverageOutcome {
  outcomeId: string
  bucket: MonetizationCoverageBucket
  /** FIBIU-11 classification: 'material' | 'not_material' | null (pending). */
  materialityClassification: string | null
  /** True when the immutable run carries >= 1 line item for this outcome. */
  engineMonetized: boolean
  disposition: Pick<typeof outcomeMonetizationDispositions.$inferSelect, 'disposition' | 'reason' | 'justification'> | null
}
export interface MonetizationCoverage {
  outcomes: MonetizationCoverageOutcome[]
  monetizedOutcomeIds: string[]
  missingDispositionOutcomeIds: string[]
  /** Per governed reason, the outcomes recorded not_monetized for it — every key present, empty or not. */
  notMonetizedByReason: Record<MonetizationReason, string[]>
  /** Outcomes classified 'material' that the run did not monetize (derived view; their reason stays in notMonetizedByReason / bucket). */
  materialNotMonetizedOutcomeIds: string[]
  /** Outcomes whose FIBIU-11 classification is still pending — visible, never dropped. */
  unclassifiedOutcomeIds: string[]
  // FIBC-016 — "if no outcome has defensible monetization, no SROI ratio is
  // emitted": true iff the immutable run carries >= 1 line item. This is the
  // engine's own truth; a disposition can never fabricate it.
  hasDefensibleMonetization: boolean
}

/**
 * FIBIU-12 (FIBC-016) — pure coverage aggregation. Every outcome in
 * `candidateOutcomeIds` (run line-item outcomes ∪ outcomes with a disposition
 * for the run ∪ the project's active-assignment outcomes at coverage time) is
 * represented exactly once; an outcome without a disposition is bucketed
 * 'missing_disposition' — visible, never silently dropped. Pure so it is
 * independently testable; getRunMonetizationCoverage is the DB-backed caller.
 */
export function getMonetizationCoverage(
  dispositions: Pick<typeof outcomeMonetizationDispositions.$inferSelect, 'outcomeId' | 'disposition' | 'reason' | 'justification'>[],
  materialityByOutcome: Map<string, string | null>,
  engineMonetizedOutcomeIds: readonly string[],
  candidateOutcomeIds: readonly string[] = [],
): MonetizationCoverage {
  const engineMonetized = new Set(engineMonetizedOutcomeIds)
  const dispositionByOutcome = new Map(dispositions.map((d) => [d.outcomeId, d]))
  const allOutcomeIds = [...new Set([...engineMonetizedOutcomeIds, ...dispositions.map((d) => d.outcomeId), ...candidateOutcomeIds])]

  const notMonetizedByReason = Object.fromEntries(MONETIZATION_REASON_VALUES.map((r) => [r, [] as string[]])) as Record<MonetizationReason, string[]>
  const outcomes: MonetizationCoverageOutcome[] = []
  const monetizedOutcomeIds: string[] = []
  const missingDispositionOutcomeIds: string[] = []
  const materialNotMonetizedOutcomeIds: string[] = []
  const unclassifiedOutcomeIds: string[] = []

  for (const outcomeId of allOutcomeIds) {
    const d = dispositionByOutcome.get(outcomeId) ?? null
    const materialityClassification = materialityByOutcome.get(outcomeId) ?? null
    const isEngineMonetized = engineMonetized.has(outcomeId)
    let bucket: MonetizationCoverageBucket
    if (!d) {
      bucket = 'missing_disposition'
      missingDispositionOutcomeIds.push(outcomeId)
    } else if (d.disposition === 'monetized') {
      bucket = 'monetized'
      monetizedOutcomeIds.push(outcomeId)
    } else {
      // The DB CHECK (0059) guarantees a governed reason on every not_monetized row.
      const reason = (d.reason ?? 'other_governed_reason') as MonetizationReason
      bucket = `not_monetized:${reason}`
      notMonetizedByReason[reason].push(outcomeId)
    }
    if (materialityClassification === 'material' && !isEngineMonetized) materialNotMonetizedOutcomeIds.push(outcomeId)
    if (materialityClassification === null) unclassifiedOutcomeIds.push(outcomeId)
    outcomes.push({
      outcomeId,
      bucket,
      materialityClassification,
      engineMonetized: isEngineMonetized,
      disposition: d ? { disposition: d.disposition, reason: d.reason, justification: d.justification } : null,
    })
  }

  return {
    outcomes,
    monetizedOutcomeIds,
    missingDispositionOutcomeIds,
    notMonetizedByReason,
    materialNotMonetizedOutcomeIds,
    unclassifiedOutcomeIds,
    hasDefensibleMonetization: engineMonetized.size > 0,
  }
}

/** FIBIU-12 — the recorded dispositions of one run (org-scoped, run must belong to the project). */
export async function listOutcomeMonetizationDispositionsForRun(projectId: string, calculationRunId: string) {
  const ctx = await authorize(projectId)
  const runRows = await db.select({ id: sroiCalculationRuns.id }).from(sroiCalculationRuns).where(and(eq(sroiCalculationRuns.id, calculationRunId), eq(sroiCalculationRuns.projectId, projectId), eq(sroiCalculationRuns.organizationId, ctx.organization.id)))
  if (runRows.length === 0) throw new Error('Calculation run not found for project')
  return db
    .select()
    .from(outcomeMonetizationDispositions)
    .where(and(eq(outcomeMonetizationDispositions.calculationRunId, calculationRunId), eq(outcomeMonetizationDispositions.organizationId, ctx.organization.id)))
}

/**
 * FIBIU-12 (FIBC-016) — the coverage view a reviewer must see BEFORE
 * approving a run: composed from the run's own immutable line items (engine
 * truth), the dispositions recorded for the run, the project's active
 * assignment outcomes, and FIBIU-11's classification per outcome.
 */
export async function getRunMonetizationCoverage(projectId: string, calculationRunId: string): Promise<MonetizationCoverage> {
  const ctx = await authorize(projectId)
  const runRows = await db.select({ id: sroiCalculationRuns.id }).from(sroiCalculationRuns).where(and(eq(sroiCalculationRuns.id, calculationRunId), eq(sroiCalculationRuns.projectId, projectId), eq(sroiCalculationRuns.organizationId, ctx.organization.id)))
  if (runRows.length === 0) throw new Error('Calculation run not found for project')

  const [lineItems, dispositions, activeAssignments, outcomeRows] = await Promise.all([
    db.select({ outcomeId: sroiCalculationLineItems.outcomeId }).from(sroiCalculationLineItems).where(eq(sroiCalculationLineItems.runId, calculationRunId)),
    db.select().from(outcomeMonetizationDispositions).where(and(eq(outcomeMonetizationDispositions.calculationRunId, calculationRunId), eq(outcomeMonetizationDispositions.organizationId, ctx.organization.id))),
    db.select({ outcomeId: outcomeProxyAssignments.outcomeId }).from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, ctx.organization.id), eq(outcomeProxyAssignments.assignmentStatus, 'active'))),
    db.select({ id: outcomes.id, materialityClassification: outcomes.materialityClassification }).from(outcomes).where(eq(outcomes.projectId, projectId)),
  ])

  const materialityByOutcome = new Map(outcomeRows.map((o) => [o.id, o.materialityClassification ?? null]))
  return getMonetizationCoverage(
    dispositions,
    materialityByOutcome,
    [...new Set(lineItems.map((li) => li.outcomeId).filter((id): id is string => !!id))],
    activeAssignments.map((a) => a.outcomeId),
  )
}

// ─── Internal data loader for calculation ───────────────────────────────────

export interface AssignmentData {
  assignment: typeof outcomeProxyAssignments.$inferSelect
  input: typeof sroiAssignmentInputs.$inferSelect
  filterSet: typeof sroiFilterSets.$inferSelect
  proxy: typeof financialProxies.$inferSelect
  // FIBIU-08 (FIBC-012) — the exact version this assignment was bound to at
  // assignment time, never re-derived from the proxy's CURRENT state. Null
  // when the assignment predates FIBDB-039 or was never bound — read as
  // ineligible, the same as any other missing required field here.
  proxyVersion: typeof financialProxyVersions.$inferSelect | null
  outcome: typeof outcomes.$inferSelect
}

// CL-2D (SROI-01) — `enforceApproval` defaults to false because
// getSroiCalculationReadiness() also calls this loader (just for investments/
// allocations) and must keep reporting an unapproved proxy as a graceful
// `blockingReasons` entry, never as a thrown exception. The actual calculation
// entry points (preview/scenarios/persist) opt into enforcement: THEY are the
// boundary where a stale-but-approved-looking proxy would otherwise have its
// value silently consumed.
// Exported (mirrors runDeterministicCalc above) so FIBIU-12's loadSkipped
// itemization can be unit-tested directly against a deliberately incomplete
// assignment, without needing to first reproduce the readiness/loadCalculationData
// TOCTOU race (two separate round trips, see the CL-2D comment below) that is
// the only way this path is reachable through the public calculation entry points.
export async function loadCalculationData(projectId: string, orgId: string, enforceApproval = false): Promise<{
  investments: (typeof projectInvestments.$inferSelect)[]
  assignmentData: AssignmentData[]
  allocations: (typeof outcomeFunderAllocations.$inferSelect)[]
  fundersList: (typeof funders.$inferSelect)[]
  discountRatePct: string | null
  // FIBIU-12 (FIBC-016) — see SkippedAssignment's missing_* variants.
  loadSkipped: SkippedAssignment[]
}> {
  // Load ALL active investment contributions (Fase 1b — a project can have many).
  const investments = await db
    .select()
    .from(projectInvestments)
    .where(and(eq(projectInvestments.projectId, projectId), eq(projectInvestments.organizationId, orgId), eq(projectInvestments.status, 'active')))

  // Fase 1e — project-level annual discount rate (NULL = no discounting).
  const projRow = await db
    .select({ discountRatePct: projects.discountRatePct })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
    .then(r => r[0])
  const discountRatePct = projRow?.discountRatePct ?? null

  // Load active assignments
  const assignments = await db
    .select()
    .from(outcomeProxyAssignments)
    .where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, orgId), eq(outcomeProxyAssignments.assignmentStatus, 'active')))

  if (assignments.length === 0) return { investments, assignmentData: [], allocations: [], fundersList: [], discountRatePct, loadSkipped: [] }

  const assignmentIds = assignments.map(a => a.id)
  const proxyIds = assignments.map(a => a.proxyId)
  const outcomeIds = assignments.map(a => a.outcomeId)
  const proxyVersionIds = assignments
    .map(a => a.financialProxyVersionId)
    .filter((id): id is string => id !== null)

  // Load all related data in parallel
  const [inputs, filters, proxiesRows, proxyVersionRows, outcomesRows] = await Promise.all([
    db.select().from(sroiAssignmentInputs).where(and(inArray(sroiAssignmentInputs.assignmentId, assignmentIds), eq(sroiAssignmentInputs.organizationId, orgId))),
    db.select().from(sroiFilterSets).where(and(inArray(sroiFilterSets.assignmentId, assignmentIds), eq(sroiFilterSets.organizationId, orgId))),
    db.select().from(financialProxies).where(inArray(financialProxies.id, proxyIds)),
    proxyVersionIds.length > 0 ? db.select().from(financialProxyVersions).where(inArray(financialProxyVersions.id, proxyVersionIds)) : Promise.resolve([]),
    db.select().from(outcomes).where(and(inArray(outcomes.id, outcomeIds), eq(outcomes.projectId, projectId))),
  ])

  const inputByAssignment = new Map(inputs.map(i => [i.assignmentId, i]))
  const filterByAssignment = new Map(filters.map(f => [f.assignmentId, f]))
  const proxyById = new Map(proxiesRows.map(p => [p.id, p]))
  const proxyVersionById = new Map(proxyVersionRows.map(v => [v.id, v]))
  const outcomeById = new Map(outcomesRows.map(o => [o.id, o]))

  const assignmentData: AssignmentData[] = []
  // FIBIU-12 (FIBC-016) — every exclusion is itemized, including this
  // upstream one: an assignment missing input/filterSet/proxy/outcome used
  // to be dropped here with no `else` branch and no record at all.
  const loadSkipped: SkippedAssignment[] = []
  for (const a of assignments) {
    const input = inputByAssignment.get(a.id)
    const filterSet = filterByAssignment.get(a.id)
    const proxy = proxyById.get(a.proxyId)
    const proxyVersion = a.financialProxyVersionId ? proxyVersionById.get(a.financialProxyVersionId) ?? null : null
    const outcome = outcomeById.get(a.outcomeId)
    if (input && filterSet && proxy && outcome) {
      // CL-2D (SROI-01) — readiness already checked reviewStatus === 'approved',
      // but that read and this one are two separate round trips, not one
      // transaction: a concurrent edit/revocation between them could otherwise
      // let a no-longer-approved proxy's value be silently consumed here. Fail
      // the WHOLE calculation closed rather than quietly drop the line item —
      // an SROI run that is missing a line item without saying so is exactly
      // the silent-corruption failure mode this guards against. Only the real
      // calculation entry points enforce this (see `enforceApproval` above) —
      // readiness's own use of this loader must stay graceful.
      //
      // FIBIU-08 (FIBC-012) — "eligibility binds to the exact reviewed
      // version": the live proxy row can drift forward (a later edit could
      // reset reviewStatus, or a later version could exist) without this
      // assignment's own frozen version ever changing, so BOTH must be
      // approved — the live check preserved as the double-assertion the
      // FIB's own TESTS clause requires, the version check as the new,
      // actually-binding one. A NULL financialProxyVersionId (no version was
      // ever bound) is exactly as fatal as an unapproved one.
      if (enforceApproval && proxy.reviewStatus !== 'approved') {
        throw new Error(
          `Cannot calculate: proxy ${proxy.id} is not approved (reviewStatus=${proxy.reviewStatus})`
        )
      }
      if (enforceApproval && (!proxyVersion || proxyVersion.reviewStatus !== 'approved')) {
        throw new Error(
          `Cannot calculate: proxy ${proxy.id}'s assigned version is not approved (financialProxyVersionId=${a.financialProxyVersionId ?? 'null'})`
        )
      }
      assignmentData.push({ assignment: a, input, filterSet, proxy, proxyVersion, outcome })
    } else {
      // One entry per missing piece, so a single assignment lacking multiple
      // things is never collapsed into one ambiguous skip reason.
      if (!input) loadSkipped.push({ outcomeId: a.outcomeId, reason: 'missing_input' })
      if (!filterSet) loadSkipped.push({ outcomeId: a.outcomeId, reason: 'missing_filter_set' })
      if (!proxy) loadSkipped.push({ outcomeId: a.outcomeId, reason: 'missing_proxy' })
      if (!outcome) loadSkipped.push({ outcomeId: a.outcomeId, reason: 'missing_outcome' })
    }
  }

  // Funder attribution: only outcomes that actually feed the calculation matter.
  const calcOutcomeIds = [...new Set(assignmentData.map(d => d.assignment.outcomeId))]
  const allocations = calcOutcomeIds.length > 0
    ? await db.select().from(outcomeFunderAllocations).where(and(eq(outcomeFunderAllocations.organizationId, orgId), inArray(outcomeFunderAllocations.outcomeId, calcOutcomeIds), eq(outcomeFunderAllocations.status, 'active')))
    : []

  const funderIds = [...new Set([...investments.map(i => i.funderId), ...allocations.map(a => a.funderId)])]
  const fundersList = funderIds.length > 0
    ? await db.select().from(funders).where(inArray(funders.id, funderIds))
    : []

  return { investments, assignmentData, allocations, fundersList, discountRatePct, loadSkipped }
}

// ─── Readiness ───────────────────────────────────────────────────────────────

export interface ReadinessIssue {
  type: 'error' | 'warning'
  messageKey: string
  message: string
  itemIds?: string[]
  actionPath?: string
  actionLabel?: string
}

/**
 * Pure input for `buildReadinessIssues`, factored out of
 * `getSroiCalculationReadiness` so the fail-closed blocker -> remediation-CTA
 * contract (RE-U1 U1-F04 / RE-U4 sroi_remediation_matrix) can be unit tested
 * without a database. Every field here is already computed by
 * `getSroiCalculationReadiness` before the issues array is built — this
 * extraction changes nothing about WHAT is computed, only where the
 * CTA-attachment logic lives.
 */
export interface ReadinessIssueInput {
  projectId: string
  hasInvestment: boolean
  zeroOrInvalidInvestment: boolean
  invalidInvestmentIds: string[]
  investmentsMissingUsd: string[]
  activeAssignmentsCount: number
  missingInputs: string[]
  missingFilterSets: string[]
  unapprovedProxies: string[]
  outcomesWithoutEvidence: string[]
  invalidQuantities: string[]
  invalidFilters: string[]
  proxiesMissingUsd: string[]
  overAllocatedOutcomes: string[]
}

/**
 * Builds the fail-closed readiness issue list, each with the canonical
 * remediation CTA frozen in RE_U4_COMMERCIAL_V1_JOURNEY_DELTA_v1.0.0.json ::
 * sroi_remediation_matrix. Project-scoped destinations use the REAL
 * `/app/projects/${projectId}/pipeline/*` routes (never a hardcoded
 * projectId, never an invented top-level `/app/proxies`); same-page
 * destinations use the stable DOM anchors added to
 * app/app/projects/[projectId]/pipeline/calculation/page.tsx (#investment,
 * #sroi-inputs, #sroi-filters, #funder-attribution).
 */
export function buildReadinessIssues(input: ReadinessIssueInput): ReadinessIssue[] {
  const {
    projectId,
    hasInvestment,
    zeroOrInvalidInvestment,
    invalidInvestmentIds,
    investmentsMissingUsd,
    missingInputs,
    missingFilterSets,
    unapprovedProxies,
    outcomesWithoutEvidence,
    invalidQuantities,
    invalidFilters,
    proxiesMissingUsd,
    overAllocatedOutcomes,
  } = input

  const issues: ReadinessIssue[] = []

  if (!hasInvestment) {
    issues.push({
      type: 'error',
      messageKey: 'missing_investment',
      message: 'El proyecto requiere al menos una inversión. Agrega un aporte en la sección "Inversión del proyecto".',
      actionPath: `#investment`,
      actionLabel: 'Ir a inversiones',
    })
  }

  if (zeroOrInvalidInvestment && hasInvestment) {
    issues.push({
      type: 'error',
      messageKey: 'invalid_investment_amount',
      message: `El monto de la inversión debe ser mayor a 0. Revisa y actualiza los aportes.`,
      itemIds: invalidInvestmentIds,
      actionPath: `#investment`,
      actionLabel: 'Ir a inversiones',
    })
  }

  if (investmentsMissingUsd.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'investments_missing_usd',
      message: `${investmentsMissingUsd.length} aporte(s) falta(n) conversión a USD. Verifica que las inversiones en monedas no-USD tengan tipos de cambio válidos.`,
      itemIds: investmentsMissingUsd,
      actionPath: `#investment`,
      actionLabel: 'Revisar aportes',
    })
  }

  if (input.activeAssignmentsCount === 0) {
    issues.push({
      type: 'error',
      messageKey: 'no_proxy_assignments',
      message: 'No hay asignaciones de proxy activas. Define resultados (outcomes) y vincula proxies financieros en el paso anterior.',
      actionPath: `/app/projects/${projectId}/pipeline/evidence`,
      actionLabel: 'Ir a evidencia',
    })
  }

  if (missingInputs.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'missing_inputs',
      message: `${missingInputs.length} asignación(es) falta(n) información de cantidad. Define la cantidad de beneficiarios o unidades para cada resultado.`,
      itemIds: missingInputs,
      actionPath: `#sroi-inputs`,
      actionLabel: 'Completar información',
    })
  }

  if (missingFilterSets.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'missing_filter_sets',
      message: `${missingFilterSets.length} asignación(es) falta(n) filtros SROI (deadweight, displacement, etc). Define los supuestos metodológicos para cada resultado.`,
      itemIds: missingFilterSets,
      actionPath: `#sroi-filters`,
      actionLabel: 'Configurar filtros',
    })
  }

  if (unapprovedProxies.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'unapproved_proxies',
      message: `${unapprovedProxies.length} proxy(ies) no aprobado(s). Todo proxy debe ser revisado y aprobado antes del cálculo. Accede a Proxies para revisar.`,
      itemIds: unapprovedProxies,
      actionPath: `/app/projects/${projectId}/pipeline/proxies`,
      actionLabel: 'Revisar proxies',
    })
  }

  if (outcomesWithoutEvidence.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'outcomes_without_evidence',
      message: `${outcomesWithoutEvidence.length} resultado(s) sin evidencia vinculada. Toda variable que alimenta el cálculo SROI debe estar respaldada por evidencia verificable.`,
      itemIds: outcomesWithoutEvidence,
      actionPath: `/app/projects/${projectId}/pipeline/evidence`,
      actionLabel: 'Agregar evidencia',
    })
  }

  if (invalidQuantities.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'invalid_quantities',
      message: `${invalidQuantities.length} elemento(s) con cantidad inválida (≤0). Las cantidades deben ser positivas.`,
      itemIds: invalidQuantities,
      actionPath: `#sroi-inputs`,
      actionLabel: 'Revisar cantidades',
    })
  }

  if (invalidFilters.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'invalid_filters',
      message: `${invalidFilters.length} filtro(s) con valor(es) inválido(s). Los porcentajes deben estar entre 0-100, y la duración entre 1-50 años.`,
      itemIds: invalidFilters,
      actionPath: `#sroi-filters`,
      actionLabel: 'Revisar filtros',
    })
  }

  if (proxiesMissingUsd.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'proxies_missing_usd',
      message: `${proxiesMissingUsd.length} proxy(ies) falta(n) conversión a USD. Verifica que los proxies tengan valores en USD.`,
      itemIds: proxiesMissingUsd,
      actionPath: `/app/projects/${projectId}/pipeline/proxies`,
      actionLabel: 'Revisar proxies',
    })
  }

  if (overAllocatedOutcomes.length > 0) {
    issues.push({
      type: 'error',
      messageKey: 'over_allocated_outcomes',
      message: `${overAllocatedOutcomes.length} resultado(s) tiene(n) atribución de financiadores > 100%. Verifica que la suma de aportes por resultado no exceda 100%.`,
      itemIds: overAllocatedOutcomes,
      actionPath: `#funder-attribution`,
      actionLabel: 'Revisar atribución',
    })
  }

  return issues
}

export interface SroiReadiness {
  hasInvestment: boolean
  zeroOrInvalidInvestment: boolean
  activeAssignmentsCount: number
  missingInputs: string[]
  missingFilterSets: string[]
  unapprovedProxies: string[]
  currencyMismatch: boolean
  invalidQuantities: string[]
  invalidFilters: string[]
  investmentsMissingUsd: string[]
  proxiesMissingUsd: string[]
  overAllocatedOutcomes: string[]
  outcomesWithoutEvidence: string[]
  canCalculate: boolean
  blockingReasons: string[]
  issues: ReadinessIssue[]
}

export async function getSroiCalculationReadiness(projectId: string): Promise<SroiReadiness> {
  const ctx = await authorize(projectId)
  const { investments, allocations } = await loadCalculationData(projectId, ctx.organization.id)

  const blockingReasons: string[] = []

  // Investment: at least one active contribution with amount > 0.
  const hasInvestment = investments.length > 0
  const zeroOrInvalidInvestment = !hasInvestment || investments.some(i => parseNum(i.amount) <= 0)
  if (!hasInvestment) blockingReasons.push('Missing project investment')
  if (zeroOrInvalidInvestment && hasInvestment) blockingReasons.push('Investment amount must be > 0')

  // Every active contribution must resolve to USD (frozen at save time).
  const investmentsMissingUsd = investments.filter(i => i.amountUsd === null || i.amountUsd === undefined).map(i => i.id)
  if (investmentsMissingUsd.length > 0) blockingReasons.push(`Falta conversión a USD para ${investmentsMissingUsd.length} aporte(s)`)

  // Load active assignments count (total, not just those with all data)
  const allAssignments = await db.select().from(outcomeProxyAssignments).where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, ctx.organization.id), eq(outcomeProxyAssignments.assignmentStatus, 'active')))
  if (allAssignments.length === 0) blockingReasons.push('No active proxy assignments')

  const assignmentIds = allAssignments.map(a => a.id)
  const proxyIds = allAssignments.map(a => a.proxyId)
  const proxyVersionIds = allAssignments
    .map(a => a.financialProxyVersionId)
    .filter((id): id is string => id !== null)

  const [inputs, filters, proxiesRows, proxyVersionRows] = await Promise.all([
    assignmentIds.length > 0 ? db.select().from(sroiAssignmentInputs).where(and(inArray(sroiAssignmentInputs.assignmentId, assignmentIds), eq(sroiAssignmentInputs.organizationId, ctx.organization.id))) : Promise.resolve([]),
    assignmentIds.length > 0 ? db.select().from(sroiFilterSets).where(and(inArray(sroiFilterSets.assignmentId, assignmentIds), eq(sroiFilterSets.organizationId, ctx.organization.id))) : Promise.resolve([]),
    proxyIds.length > 0 ? db.select().from(financialProxies).where(inArray(financialProxies.id, proxyIds)) : Promise.resolve([]),
    proxyVersionIds.length > 0 ? db.select().from(financialProxyVersions).where(inArray(financialProxyVersions.id, proxyVersionIds)) : Promise.resolve([]),
  ])

  const inputByAssignment = new Map(inputs.map(i => [i.assignmentId, i]))
  const filterByAssignment = new Map(filters.map(f => [f.assignmentId, f]))
  const proxyById = new Map(proxiesRows.map(p => [p.id, p]))
  const proxyVersionById = new Map(proxyVersionRows.map(v => [v.id, v]))

  const missingInputs: string[] = []
  const missingFilterSets: string[] = []
  const unapprovedProxies: string[] = []
  const invalidQuantities: string[] = []
  const invalidFilters: string[] = []
  const proxiesMissingUsd: string[] = []

  for (const a of allAssignments) {
    const input = inputByAssignment.get(a.id)
    const filterSet = filterByAssignment.get(a.id)
    const proxy = proxyById.get(a.proxyId)
    const proxyVersion = a.financialProxyVersionId ? proxyVersionById.get(a.financialProxyVersionId) ?? null : null

    if (!input) missingInputs.push(a.id)
    if (!filterSet) missingFilterSets.push(a.id)
    // FIBIU-08 (FIBC-012) — an assignment with no bound version, or one bound
    // to a version that is not itself approved, is exactly as unready as an
    // unapproved live proxy row (see loadCalculationData's enforceApproval
    // path, which is the actual gate — this is only the graceful preview).
    if (!proxy || proxy.reviewStatus !== 'approved' || !proxyVersion || proxyVersion.reviewStatus !== 'approved') {
      unapprovedProxies.push(a.proxyId)
    }

    if (input && parseNum(input.quantity) <= 0) invalidQuantities.push(a.id)
    if (proxy?.value && parseNum(proxy.value) <= 0) invalidQuantities.push(`proxy:${proxy.id}`)
    // Approved proxies must resolve to USD (the calc uses value_usd).
    // R-B2-05 (AG-B2-1): the BOUND version is the monetary source, so USD
    // presence is measured there, never on the mutable live row.
    if (proxy && proxyVersion && proxyVersion.reviewStatus === 'approved' && (proxyVersion.valueUsd === null || proxyVersion.valueUsd === undefined)) proxiesMissingUsd.push(proxy.id)

    if (filterSet) {
      const duration = filterSet.durationYears ?? 1
      if (duration < 1 || duration > 50) invalidFilters.push(a.id)
      for (const pct of [filterSet.deadweightPct, filterSet.displacementPct, filterSet.attributionPct, filterSet.dropoffPct]) {
        if (pct !== null && pct !== undefined) {
          const v = parseNum(pct)
          if (v < 0 || v > 100) invalidFilters.push(a.id)
        }
      }
    }
  }

  // Funder attribution per outcome must not exceed 100% (defensive re-check;
  // also enforced on write). Legitimately may be < 100% — that's unattributed.
  const allocByOutcome = new Map<string, number>()
  for (const alloc of allocations) {
    allocByOutcome.set(alloc.outcomeId, (allocByOutcome.get(alloc.outcomeId) ?? 0) + parseNum(alloc.allocationPct))
  }
  const overAllocatedOutcomes = [...allocByOutcome.entries()].filter(([, sum]) => sum > 100).map(([oid]) => oid)

  if (missingInputs.length > 0) blockingReasons.push(`Missing inputs for ${missingInputs.length} assignment(s)`)
  if (missingFilterSets.length > 0) blockingReasons.push(`Missing filter sets for ${missingFilterSets.length} assignment(s)`)
  if (unapprovedProxies.length > 0) blockingReasons.push(`${unapprovedProxies.length} unapproved proxy(ies)`)
  if (invalidQuantities.length > 0) blockingReasons.push(`Invalid quantities in ${invalidQuantities.length} item(s)`)
  if (invalidFilters.length > 0) blockingReasons.push(`Invalid filter values in ${invalidFilters.length} assignment(s)`)
  if (proxiesMissingUsd.length > 0) blockingReasons.push(`Falta conversión a USD para ${proxiesMissingUsd.length} proxy(ies)`)
  if (overAllocatedOutcomes.length > 0) blockingReasons.push(`${overAllocatedOutcomes.length} resultado(s) con atribución de financiadores > 100%`)

  // Evidence gate — every outcome that feeds the calculation must be backed by
  // at least one non-archived, non-rejected evidence item. This enforces the
  // fuente → evidencia → proxy → cálculo chain: an assignment cannot contribute
  // social value if the outcome it monetises has no supporting evidence.
  const activeOutcomeIds = [...new Set(allAssignments.map(a => a.outcomeId))]
  const outcomesWithoutEvidence: string[] = []
  if (activeOutcomeIds.length > 0) {
    const evidenceRows = await db
      .select({ outcomeId: evidenceItems.outcomeId })
      .from(evidenceItems)
      .where(and(
        eq(evidenceItems.projectId, projectId),
        inArray(evidenceItems.outcomeId, activeOutcomeIds),
        inArray(evidenceItems.status, ['draft', 'under_review', 'approved']),
      ))
    const outcomesWithEvidence = new Set(evidenceRows.map(e => e.outcomeId))
    for (const outcomeId of activeOutcomeIds) {
      if (!outcomesWithEvidence.has(outcomeId)) outcomesWithoutEvidence.push(outcomeId)
    }
  }
  // W2-B1-R3 (R-B1-04, M-1) — the informational
  // outcomesMissingSufficiencyDetermination signal B1 added here was
  // removed: FIBDB-014 now binds every determination to an explicit
  // calculationRunId, and readiness/preliminary work runs BEFORE a
  // calculation run exists, so there is no run identity to check a
  // determination against at this point without inventing one — exactly
  // the "heuristic freshness" R-B1-04 forbids. The existing >=1-non-
  // rejected-evidence gate above is untouched and remains the minimum for
  // preliminary work, per FIBC-008's own text. The real, run-bound
  // sufficiency check lives where a concrete run actually exists:
  // lib/pipeline/sroi-results.ts's assertEvidenceSufficiencyForApproval.

  if (outcomesWithoutEvidence.length > 0) {
    blockingReasons.push(`${outcomesWithoutEvidence.length} outcome(s) with no supporting evidence`)
  }

  // Mixed currencies no longer block — everything is normalized to USD before
  // the ratio math (Fase 1b). Field kept (always false) for API compatibility.
  const currencyMismatch = false

  const canCalculate = blockingReasons.length === 0

  // Fail-closed blocker -> remediation-CTA attachment lives in the pure,
  // independently-unit-tested buildReadinessIssues (RE-U1 U1-F04 / RE-U4
  // sroi_remediation_matrix). This computation above is unchanged.
  const issues = buildReadinessIssues({
    projectId,
    hasInvestment,
    zeroOrInvalidInvestment,
    invalidInvestmentIds: investments.filter(i => parseNum(i.amount) <= 0).map(i => i.id),
    investmentsMissingUsd,
    activeAssignmentsCount: allAssignments.length,
    missingInputs,
    missingFilterSets,
    unapprovedProxies,
    outcomesWithoutEvidence,
    invalidQuantities,
    invalidFilters,
    proxiesMissingUsd,
    overAllocatedOutcomes,
  })

  return {
    hasInvestment,
    zeroOrInvalidInvestment,
    activeAssignmentsCount: allAssignments.length,
    missingInputs,
    missingFilterSets,
    unapprovedProxies,
    currencyMismatch,
    invalidQuantities,
    invalidFilters,
    investmentsMissingUsd,
    proxiesMissingUsd,
    overAllocatedOutcomes,
    outcomesWithoutEvidence,
    canCalculate,
    blockingReasons,
    issues,
  }
}

// ─── Calculation core ────────────────────────────────────────────────────────

// Number fields are for display/preview (backward-compatible API). The `*Exact`
// string fields carry the full-precision decimal result and are what gets
// persisted, so audit-ready records never inherit binary-float artefacts.
interface LineItemCalc {
  assignmentId: string
  outcomeId: string
  proxyId: string
  quantity: number
  proxyValue: number
  currency: string
  grossValue: number
  adjustedValue: number
  quantityExact: string
  proxyValueExact: string
  grossValueExact: string
  adjustedValueExact: string
  deadweightPct: number
  attributionPct: number
  displacementPct: number
  dropoffPct: number
  durationYears: number
}

// U3 (WS4) — a line the engine could not monetise is REPORTED, never silently
// dropped. Readiness normally blocks these upstream (quantity ≤ 0 / proxy value
// ≤ 0), but the engine no longer trusts that silently: any skipped assignment
// surfaces here so previews, snapshots and audits can show what was excluded.
export interface SkippedAssignment {
  outcomeId: string
  reason:
    | 'non_positive_quantity'
    | 'non_positive_proxy_value'
    // FIBIU-12 (FIBC-016) — loadCalculationData's own completeness gate used
    // to drop these silently (no `else` branch, no record). Every exclusion
    // is now itemized, including this upstream one.
    | 'missing_input'
    | 'missing_filter_set'
    | 'missing_proxy'
    | 'missing_outcome'
    // W2-B3 completeness (AG-B3-1, FIBC-015) — a 'not_material' outcome is
    // excluded from the authoritative numerator and RETAINED here with its
    // exclusion reason (traceability), never silently dropped.
    | 'not_material'
}

/**
 * W2-B3 completeness (AG-B3-4, FIBC-017/FIBDB-010) — which filter semantics
 * the engine runs under. There is deliberately NO default: every caller
 * names the path it is on.
 *
 *   'authoritative' — calculateAndPersistSroiRun. A NULL/blank value for any
 *                     of the five governed filters is UNKNOWN, never zero:
 *                     the engine throws FILTER_VALUE_UNKNOWN and nothing is
 *                     computed or persisted from an invented zero.
 *   'preliminary'   — calculateSroiPreview / calculateSroiScenarios, both
 *                     rendered under the product's "Cálculo preliminar"
 *                     label. A NULL filter is coerced as before AND every
 *                     coercion is itemized in preliminaryFilterAssumptions,
 *                     so the preview is labelled and never silent.
 */
export type FilterSemantics = 'authoritative' | 'preliminary'
export interface EngineOptions {
  filterSemantics: FilterSemantics
}
export interface PreliminaryFilterAssumption {
  assignmentId: string
  outcomeId: string
  filter: FilterName
  assumedValue: number
}
export const NO_RATIO_REASON = 'NO_DEFENSIBLE_MONETIZATION' as const

export interface CalcResult {
  // currency is always 'USD' post Fase 1b — all inputs are normalized first.
  currency: string
  totalInvestment: number
  grossSocialValue: number
  netSocialValue: number
  // W2-B3 completeness (AG-B3-2, FIBC-016) — null when no outcome has
  // defensible monetization (zero line items): NO ratio exists, and no
  // consumer may fabricate one from this null (not 0, not net/investment).
  sroiRatio: number | null
  totalInvestmentExact: string
  grossSocialValueExact: string
  netSocialValueExact: string
  sroiRatioExact: string | null
  noRatioReason?: typeof NO_RATIO_REASON
  lineItems: LineItemCalc[]
  fundersBreakdown: FunderBreakdownRow[]
  unattributedNsvUsd: string
  // Additive (non-breaking): existing callers that destructure named fields
  // are unaffected; new consumers can verify nothing was silently excluded.
  skippedAssignments: SkippedAssignment[]
  /** Outcomes with >= 1 computed line item — the engine's own "defensibly monetized" set. */
  monetizedOutcomeIds: string[]
  /** AG-B3-1 — unclassified (NULL) outcomes that contributed: itemized, never silent. */
  materialityUnclassifiedOutcomeIds: string[]
  /** AG-B3-4 — every NULL filter the 'preliminary' path coerced (always empty on 'authoritative'). */
  preliminaryFilterAssumptions: PreliminaryFilterAssumption[]
}

export interface MaterialityExclusion {
  included: AssignmentData[]
  skipped: SkippedAssignment[]
  materialityUnclassifiedOutcomeIds: string[]
}

/**
 * W2-B3 completeness (AG-B3-1, FIBC-015) — pure materiality gate applied
 * before any value is computed. 'not_material' assignments are excluded and
 * itemized with their reason; 'material' assignments pass; an unclassified
 * (NULL) outcome passes — FIBC-015 permits preliminary work while
 * classification is pending and FIBIU-19 owns the approval block — but is
 * itemized so it can never contribute silently. The legacy 1-5 score is
 * never read here (NPDD-03).
 */
export function applyMaterialityExclusion(assignmentData: AssignmentData[]): MaterialityExclusion {
  const included: AssignmentData[] = []
  const skipped: SkippedAssignment[] = []
  const unclassified = new Set<string>()
  for (const d of assignmentData) {
    const classification = d.outcome?.materialityClassification ?? null
    if (classification === 'not_material') {
      skipped.push({ outcomeId: d.assignment.outcomeId, reason: 'not_material' })
      continue
    }
    if (classification === null) unclassified.add(d.assignment.outcomeId)
    included.push(d)
  }
  return { included, skipped, materialityUnclassifiedOutcomeIds: [...unclassified] }
}

// Precision of the numeric DB columns (see manual-migration 003). Money and
// quantities carry 4 decimals; the SROI ratio carries 6.
const MONEY_DP = 4
const RATIO_DP = 6

// Tolerant Decimal constructor: readiness has already validated these values,
// but never throw inside the engine over a stray string.
function dec(v: string | number | null | undefined): Decimal {
  try {
    return new Decimal(v ?? 0)
  } catch {
    return new Decimal(0)
  }
}

// Exported (U2/U3, WS4) so golden/property tests can pin exact result strings
// without a database. Production callers inside this module are unchanged.
export function runDeterministicCalc(
  investments: (typeof projectInvestments.$inferSelect)[],
  assignmentData: AssignmentData[],
  allocations: (typeof outcomeFunderAllocations.$inferSelect)[],
  fundersList: (typeof funders.$inferSelect)[],
  discountRatePct: string | null,
  options: EngineOptions,
): CalcResult {
  // All contributions are normalized to USD (amount_usd, frozen at save time);
  // readiness guarantees every active contribution has one.
  let totalInvestment = new Decimal(0)
  for (const inv of investments) totalInvestment = totalInvestment.plus(dec(inv.amountUsd))
  if (totalInvestment.lte(0)) throw new Error('Investment amount must be > 0')

  const currency = 'USD'
  // Fase 1e — present value: year `yr` is discounted by 1/(1+r)^(yr-1), so year 1
  // is undiscounted (consistent with the dropoff base year). r = 0 → factor 1
  // for every year, i.e. exactly the pre-1e result (zero regression).
  const onePlusDiscount = new Decimal(1).plus(dec(discountRatePct).div(100))

  let grossSocialValue = new Decimal(0)
  let netSocialValue = new Decimal(0)
  // Per-outcome net social value (USD) — drives the per-funder attribution.
  const outcomeNsv = new Map<string, Decimal>()
  const lineItems: LineItemCalc[] = []
  const skippedAssignments: SkippedAssignment[] = []
  const preliminaryFilterAssumptions: PreliminaryFilterAssumption[] = []

  // AG-B3-1 — materiality gate first: not_material never reaches the sum.
  const materiality = applyMaterialityExclusion(assignmentData)
  skippedAssignments.push(...materiality.skipped)

  // AG-B3-4 — a filter value is resolved through ONE function that knows
  // which path it is on. isBlank mirrors getFilterJustificationIssues so the
  // two can never disagree on what "unknown" means.
  const isBlank = (v: string | number | null | undefined) => v === null || v === undefined || v === ''
  const resolveFilter = (filter: FilterName, raw: string | number | null | undefined, assignmentId: string, outcomeId: string, assumedValue: number): number => {
    if (!isBlank(raw)) return typeof raw === 'number' ? raw : parseNum(raw)
    if (options.filterSemantics === 'authoritative') {
      throw new Error(
        `FILTER_VALUE_UNKNOWN: assignment ${assignmentId} (outcome ${outcomeId}) has no ${filter} value — refusing to compute an authoritative line from an invented ${assumedValue} (FIBC-017 / FIBDB-010, AG-B3-4)`
      )
    }
    preliminaryFilterAssumptions.push({ assignmentId, outcomeId, filter, assumedValue })
    return assumedValue
  }

  for (const { assignment, input, filterSet, proxy, proxyVersion } of materiality.included) {
    const quantity = dec(input.quantity)
    // W2-B2-R1 / R-B2-05 (AG-B2-1, VERSION_BOUND_MONETARY_RESOLUTION_REQUIRED):
    // the bound financial_proxy_versions row is the SOLE monetary source for
    // a deterministic run. financial_proxies stays the governance/discovery
    // surface (and part of the double-assertion guard in the loader) but is
    // NEVER read for value here — that is what makes "historical runs keep
    // their exact version" true rather than decorative. A missing binding,
    // or an approved bound version with no value_usd, aborts the whole run
    // with a named error: it must NOT degrade to '?? 0' and be reported as a
    // non_positive_proxy_value skip, which would silently drop a line the
    // engine was required to monetise.
    if (!proxyVersion) {
      throw new Error(
        `Cannot calculate: assignment ${assignment.id} (proxy ${proxy.id}) has no bound proxy version (FIBC-012 — eligibility binds to the exact approved version)`
      )
    }
    if (proxyVersion.valueUsd === null || proxyVersion.valueUsd === undefined) {
      throw new Error(
        `Cannot calculate: bound proxy version ${proxyVersion.id} (proxy ${proxy.id}) carries no USD value — refusing to substitute zero (AG-B2-1 FAIL CLOSED)`
      )
    }
    const proxyValue = dec(proxyVersion.valueUsd) // USD-normalized proxy value, from the BOUND version
    if (quantity.lte(0) || proxyValue.lte(0)) {
      // Report — never silently drop — a line the engine cannot monetise.
      skippedAssignments.push({
        outcomeId: assignment.outcomeId,
        reason: quantity.lte(0) ? 'non_positive_quantity' : 'non_positive_proxy_value',
      })
      continue
    }

    const deadweightPct = clamp(resolveFilter('deadweight', filterSet.deadweightPct, assignment.id, assignment.outcomeId, 0), 0, 100)
    const attributionPct = clamp(resolveFilter('attribution', filterSet.attributionPct, assignment.id, assignment.outcomeId, 0), 0, 100)
    const displacementPct = clamp(resolveFilter('displacement', filterSet.displacementPct, assignment.id, assignment.outcomeId, 0), 0, 100)
    const dropoffPct = clamp(resolveFilter('dropoff', filterSet.dropoffPct, assignment.id, assignment.outcomeId, 0), 0, 100)
    const durationYears = Math.min(Math.max(resolveFilter('duration', filterSet.durationYears, assignment.id, assignment.outcomeId, 1), 1), 50)

    const baseGrossValue = quantity.mul(proxyValue)
    const baseAdjustmentFactor = new Decimal(1).minus(dec(deadweightPct).div(100))
      .mul(new Decimal(1).minus(dec(attributionPct).div(100)))
      .mul(new Decimal(1).minus(dec(displacementPct).div(100)))

    const dropoffBase = new Decimal(1).minus(dec(dropoffPct).div(100))
    let adjustedValue = new Decimal(0)
    for (let yr = 1; yr <= durationYears; yr++) {
      const dropoffFactor = dropoffBase.pow(yr - 1)
      const discountFactor = new Decimal(1).div(onePlusDiscount.pow(yr - 1))
      adjustedValue = adjustedValue.plus(baseGrossValue.mul(baseAdjustmentFactor).mul(dropoffFactor).mul(discountFactor))
    }

    const grossValue = baseGrossValue.mul(durationYears)

    grossSocialValue = grossSocialValue.plus(grossValue)
    netSocialValue = netSocialValue.plus(adjustedValue)
    outcomeNsv.set(assignment.outcomeId, (outcomeNsv.get(assignment.outcomeId) ?? new Decimal(0)).plus(adjustedValue))

    lineItems.push({
      assignmentId: assignment.id,
      outcomeId: assignment.outcomeId,
      proxyId: proxy.id,
      quantity: quantity.toNumber(),
      proxyValue: proxyValue.toNumber(),
      currency,
      grossValue: grossValue.toNumber(),
      adjustedValue: adjustedValue.toNumber(),
      quantityExact: quantity.toString(),
      proxyValueExact: proxyValue.toString(),
      grossValueExact: grossValue.toFixed(MONEY_DP),
      adjustedValueExact: adjustedValue.toFixed(MONEY_DP),
      deadweightPct,
      attributionPct,
      displacementPct,
      dropoffPct,
      durationYears,
    })
  }

  const monetizedOutcomeIds = [...new Set(lineItems.map((li) => li.outcomeId))]

  // W2-B3 completeness (AG-B3-2, FIBC-016) — "if no outcome has defensible
  // monetization, no SROI ratio is emitted": zero line items means the
  // division below would only ever produce a fabricated 0.000000. The ratio
  // is ABSENT (null), the per-funder ratios are not fabricated either, and
  // the totals/skips stay reported so results reporting remains available.
  if (lineItems.length === 0) {
    return {
      currency,
      totalInvestment: totalInvestment.toNumber(),
      grossSocialValue: grossSocialValue.toNumber(),
      netSocialValue: netSocialValue.toNumber(),
      sroiRatio: null,
      totalInvestmentExact: totalInvestment.toFixed(MONEY_DP),
      grossSocialValueExact: grossSocialValue.toFixed(MONEY_DP),
      netSocialValueExact: netSocialValue.toFixed(MONEY_DP),
      sroiRatioExact: null,
      noRatioReason: NO_RATIO_REASON,
      lineItems,
      fundersBreakdown: [],
      unattributedNsvUsd: new Decimal(0).toFixed(MONEY_DP),
      skippedAssignments,
      monetizedOutcomeIds,
      materialityUnclassifiedOutcomeIds: materiality.materialityUnclassifiedOutcomeIds,
      preliminaryFilterAssumptions,
    }
  }

  const sroiRatio = netSocialValue.div(totalInvestment)

  // Per-funder attribution (all in USD, 4dp — consistent with the money model).
  const outcomeNsvUsd: Record<string, string> = {}
  for (const [oid, v] of outcomeNsv) outcomeNsvUsd[oid] = v.toFixed(MONEY_DP)
  const { fundersBreakdown, unattributedNsvUsd } = computeFundersBreakdown({
    netSocialValueUsd: netSocialValue.toFixed(MONEY_DP),
    outcomeNsvUsd,
    investments: investments.map(i => ({ funderId: i.funderId, amountUsd: dec(i.amountUsd).toFixed(MONEY_DP) })),
    allocations: allocations.map(a => ({ outcomeId: a.outcomeId, funderId: a.funderId, allocationPct: String(a.allocationPct ?? '0') })),
    funders: fundersList.map(f => ({ id: f.id, name: f.name, funderType: f.funderType })),
  })

  return {
    currency,
    totalInvestment: totalInvestment.toNumber(),
    grossSocialValue: grossSocialValue.toNumber(),
    netSocialValue: netSocialValue.toNumber(),
    sroiRatio: sroiRatio.toNumber(),
    totalInvestmentExact: totalInvestment.toFixed(MONEY_DP),
    grossSocialValueExact: grossSocialValue.toFixed(MONEY_DP),
    netSocialValueExact: netSocialValue.toFixed(MONEY_DP),
    sroiRatioExact: sroiRatio.toFixed(RATIO_DP),
    lineItems,
    fundersBreakdown,
    unattributedNsvUsd,
    skippedAssignments,
    monetizedOutcomeIds,
    materialityUnclassifiedOutcomeIds: materiality.materialityUnclassifiedOutcomeIds,
    preliminaryFilterAssumptions,
  }
}

// ─── Preview (non-persisted) ─────────────────────────────────────────────────

export async function calculateSroiPreview(projectId: string) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)

  if (!readiness.canCalculate) {
    return { canCalculate: false, readiness, result: null }
  }

  const { investments, assignmentData, allocations, fundersList, discountRatePct, loadSkipped } = await loadCalculationData(projectId, ctx.organization.id, true)
  if (investments.length === 0) throw new Error('Investment disappeared after readiness check')

  // AG-B3-4 — the preview is the product's labelled "Cálculo preliminar":
  // unknown filters are coerced AND itemized (preliminaryFilterAssumptions).
  const result = runDeterministicCalc(investments, assignmentData, allocations, fundersList, discountRatePct, { filterSemantics: 'preliminary' })

  return {
    canCalculate: true,
    readiness,
    result: {
      currency: result.currency,
      totalInvestment: result.totalInvestment,
      grossSocialValue: result.grossSocialValue,
      netSocialValue: result.netSocialValue,
      // AG-B3-2 — null when nothing is defensibly monetized; never 0.
      sroiRatio: result.sroiRatio,
      noRatioReason: result.noRatioReason ?? null,
      hasDefensibleMonetization: result.sroiRatio !== null,
      monetizedOutcomeIds: result.monetizedOutcomeIds,
      // AG-B3-1 — unclassified contributions are visible, never silent.
      materialityUnclassifiedOutcomeIds: result.materialityUnclassifiedOutcomeIds,
      preliminaryFilterAssumptions: result.preliminaryFilterAssumptions,
      lineItems: result.lineItems,
      fundersBreakdown: result.fundersBreakdown,
      unattributedNsvUsd: result.unattributedNsvUsd,
      // FIBIU-12 (FIBC-016) — loadSkipped (upstream, missing input/filter/
      // proxy/outcome) merged with the engine's own non-positive-value skips,
      // so the preview surfaces every excluded assignment, not just some.
      skippedAssignments: [...loadSkipped, ...result.skippedAssignments],
      discountRatePct: discountRatePct,
      formulaNotes: discountRatePct && parseNum(discountRatePct) > 0
        ? `Values normalized to USD; multi-year outcomes present-valued at ${discountRatePct}% annual discount rate.`
        : 'Values normalized to USD. No discount rate applied.',
    },
  }
}

// ─── Sensitivity: conservative / base / optimistic scenarios ──────────────────

export interface SroiScenarioResult {
  scenario: Scenario
  currency: string
  netSocialValue: number
  netSocialValueExact: string
  // AG-B3-2 — null in the no-ratio state (same engine, same rule).
  sroiRatio: number | null
  sroiRatioExact: string | null
}

// Non-persisted sensitivity band: re-runs the deterministic engine with every
// SROI filter shifted uniformly by ±deltaPp (conservative up, optimistic down),
// leaving the audited persist path untouched. Reuses the same runDeterministicCalc
// so the scenarios can never drift from the real formula.
export async function calculateSroiScenarios(projectId: string, deltaPp: number = SCENARIO_DELTA_PP) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)
  if (!readiness.canCalculate) {
    return { canCalculate: false as const, readiness, scenarios: null, deltaPp }
  }

  const { investments, assignmentData, allocations, fundersList, discountRatePct } = await loadCalculationData(projectId, ctx.organization.id, true)
  if (investments.length === 0) throw new Error('Investment disappeared after readiness check')

  // AG-B3-4 — an unknown (NULL) filter stays unknown through the shift so the
  // preliminary engine path itemizes it, instead of being silently read as 0
  // here and shifted from that invented zero.
  const shift = (raw: string | null, sc: Scenario) => (raw === null || raw === '' ? raw : String(scenarioFilterPct(parseNum(raw), sc, deltaPp)))
  const scenarios: SroiScenarioResult[] = (['conservative', 'base', 'optimistic'] as const).map((sc) => {
    const adjusted: AssignmentData[] = assignmentData.map((d) => ({
      ...d,
      filterSet: {
        ...d.filterSet,
        deadweightPct: shift(d.filterSet.deadweightPct, sc),
        attributionPct: shift(d.filterSet.attributionPct, sc),
        displacementPct: shift(d.filterSet.displacementPct, sc),
        dropoffPct: shift(d.filterSet.dropoffPct, sc),
      },
    }))
    const result = runDeterministicCalc(investments, adjusted, allocations, fundersList, discountRatePct, { filterSemantics: 'preliminary' })
    return {
      scenario: sc,
      currency: result.currency,
      netSocialValue: result.netSocialValue,
      netSocialValueExact: result.netSocialValueExact,
      sroiRatio: result.sroiRatio,
      sroiRatioExact: result.sroiRatioExact,
    }
  })

  return { canCalculate: true as const, readiness, scenarios, deltaPp }
}

// ─── Input version fingerprint (FIBIU-03 / FIBC-002 / FIBC-045) ────────────

/**
 * One entry of a run's frozen input-version fingerprint (FIBIU-03). Recorded
 * once, at calculation time, into snapshotJson.inputVersions — never
 * persisted as a separate column or table (FIBC-023: eligibility-relevant
 * facts are computed, not persisted as new state).
 */
export interface RunInputVersionFingerprintEntry {
  objectType: string
  objectId: string
  /** null for a legacy object that has never been versioned through FIBIU-03 — never a synthesized v1. */
  versionId: string | null
  ordinal: number | null
  contentHash: string | null
}

/**
 * Resolves the CURRENT domain_object_versions row for each distinct
 * (objectType, objectId) pair that actually participates in a run's inputs,
 * sorted deterministically by (objectType, objectId) so the fingerprint is
 * stable regardless of call-site ordering.
 */
async function buildRunInputVersionFingerprint(
  objects: { objectType: string; objectId: string }[]
): Promise<RunInputVersionFingerprintEntry[]> {
  const uniqueByKey = new Map<string, { objectType: string; objectId: string }>()
  for (const o of objects) uniqueByKey.set(`${o.objectType}:${o.objectId}`, o)
  const sorted = Array.from(uniqueByKey.values()).sort((a, b) =>
    a.objectType === b.objectType ? a.objectId.localeCompare(b.objectId) : a.objectType.localeCompare(b.objectType)
  )
  return Promise.all(
    sorted.map(async (o) => {
      const version = await getLatestDomainObjectVersion(o.objectType, o.objectId)
      return {
        objectType: o.objectType,
        objectId: o.objectId,
        versionId: version?.id ?? null,
        ordinal: version?.ordinal ?? null,
        contentHash: version?.contentHash ?? null,
      }
    })
  )
}

/**
 * FIBC-023: "computed from live governed state without mutating the
 * immutable run" — this reads the run's OWN frozen fingerprint (never
 * recomputes it) and compares each entry against the object's CURRENT
 * governed version. An object created after the run was calculated was
 * never in that fingerprint, so it can never itself cause drift — only a
 * NEW version of an object the run actually depended on can. No eligibility
 * reason set is assigned here (FIBIU-19, Wave 3, owns INPUTS_CHANGED_SINCE_RUN);
 * this is the detection primitive that reason will consume.
 */
export async function detectRunInputDrift(run: {
  snapshotJson: unknown
}): Promise<{ hasDrift: boolean; driftedObjects: { objectType: string; objectId: string }[] }> {
  const snapshot = run.snapshotJson as { inputVersions?: RunInputVersionFingerprintEntry[] } | null | undefined
  const inputVersions = snapshot?.inputVersions
  if (!inputVersions || inputVersions.length === 0) {
    // A run predating this fingerprint (or one with no versioned inputs at
    // all) has nothing recorded to compare against — never fabricated as
    // drift, and never as "clean" beyond what is actually knowable.
    return { hasDrift: false, driftedObjects: [] }
  }

  const driftedObjects: { objectType: string; objectId: string }[] = []
  for (const entry of inputVersions) {
    const current = await getLatestDomainObjectVersion(entry.objectType, entry.objectId)
    const currentVersionId = current?.id ?? null
    if (currentVersionId !== entry.versionId) {
      driftedObjects.push({ objectType: entry.objectType, objectId: entry.objectId })
    }
  }
  return { hasDrift: driftedObjects.length > 0, driftedObjects }
}

// ─── Persist calculation run ──────────────────────────────────────────────────

export async function calculateAndPersistSroiRun(projectId: string) {
  const ctx = await authorize(projectId)
  const readiness = await getSroiCalculationReadiness(projectId)

  if (!readiness.canCalculate) {
    throw new Error(`Cannot calculate: ${readiness.blockingReasons.join('; ')}`)
  }

  // FIBIU-02 (FIBC-001) — resolved before any DB write: refuse to persist a
  // run if any of the three run version identities cannot be resolved.
  const runVersionIdentity = await resolveRunVersionIdentity()

  const { investments, assignmentData, allocations, fundersList, discountRatePct, loadSkipped } = await loadCalculationData(projectId, ctx.organization.id, true)
  if (investments.length === 0) throw new Error('Investment disappeared after readiness check')

  // AG-B3-4 — THE authoritative persisted path (FIBDB-010): an unknown filter
  // throws FILTER_VALUE_UNKNOWN here, before any DB write. AG-B3-1/AG-B3-2:
  // not_material is excluded and itemized; zero defensibly monetized lines
  // persist sroi_ratio NULL — never a fabricated 0.
  const result = runDeterministicCalc(investments, assignmentData, allocations, fundersList, discountRatePct, { filterSemantics: 'authoritative' })
  // FIBIU-12 (FIBC-016) — merged once here; every downstream use (snapshot,
  // audit log) reads this single itemized list.
  const allSkippedAssignments = [...loadSkipped, ...result.skippedAssignments]

  // FIBIU-03 (FIBC-002/FIBC-045) — the frozen input-version fingerprint,
  // resolved before any DB write, same as the FIBIU-02 identity triple above.
  // Only the objects that actually fed this calculation: investments,
  // outcomes and assignment inputs reached through the loaded assignments.
  // Indicators and stakeholder_groups are versioned by FIBIU-03 but are not
  // themselves calculation inputs, so they carry no fingerprint entry here.
  const inputVersions = await buildRunInputVersionFingerprint([
    ...investments.map((inv) => ({ objectType: 'project_investment', objectId: inv.id })),
    ...assignmentData.map((d) => ({ objectType: 'outcome', objectId: d.outcome.id })),
    ...assignmentData.map((d) => ({ objectType: 'sroi_assignment_input', objectId: d.input.id })),
  ])

  const calculatedAt = new Date()

  // Atomicity: version assignment, run row and all line items are persisted in
  // a single transaction. Previously these were separate awaits, so a line-item
  // failure could leave an orphaned run marked 'calculated' with no items.
  const { run, lineItems: lineItemRows } = await db.transaction(async (tx) => {
    // Compute the next version inside the transaction to shrink the race window.
    // The authoritative guard is the (project_id, version) unique index added in
    // the accompanying migration; without it, two concurrent runs could still
    // collide — the unique index turns that collision into a clean retryable
    // error instead of a duplicate version.
    const maxRow = await tx
      .select({ maxV: sql<number>`coalesce(max(${sroiCalculationRuns.version}), 0)` })
      .from(sroiCalculationRuns)
      .where(eq(sroiCalculationRuns.projectId, projectId))
    const version = (Number(maxRow[0]?.maxV) || 0) + 1

    const snapshotJson = {
      version,
      // FIBIU-02 (FIBC-001) — the run version identity triple, mirrored from
      // the run row into the snapshot.
      methodologyVersion: runVersionIdentity.methodologyVersion,
      calculationEngineVersion: runVersionIdentity.calculationEngineVersion,
      buildIdentity: runVersionIdentity.buildIdentity,
      // FIBIU-03 (FIBC-002/FIBC-045) — the frozen input-version fingerprint.
      // Read back by detectRunInputDrift; never mutated after this write.
      inputVersions,
      currency: result.currency,
      totalInvestment: result.totalInvestmentExact,
      grossSocialValue: result.grossSocialValueExact,
      netSocialValue: result.netSocialValueExact,
      // AG-B3-2 — null (not '0.000000') when no outcome has defensible
      // monetization; the reason travels with it.
      sroiRatio: result.sroiRatioExact,
      noRatioReason: result.noRatioReason ?? null,
      monetizedOutcomeIds: result.monetizedOutcomeIds,
      // AG-B3-1 — unclassified contributions are recorded in the immutable
      // snapshot so they are visible in methodology state, never silent.
      materialityUnclassifiedOutcomeIds: result.materialityUnclassifiedOutcomeIds,
      investments: investments.map(inv => ({
        id: inv.id,
        funderId: inv.funderId,
        contributionType: inv.contributionType,
        amount: inv.amount,
        currency: inv.currency,
        amountUsd: inv.amountUsd,
        fxRateId: inv.fxRateId,
        year: inv.year,
      })),
      fundersBreakdown: result.fundersBreakdown,
      unattributedNsvUsd: result.unattributedNsvUsd,
      // U3 (WS4) / FIBIU-12 (FIBC-016) — audit trail of lines the engine
      // excluded, upstream (missing input/filter/proxy/outcome) and
      // engine-level (non-positive quantity/value) alike.
      skippedAssignments: allSkippedAssignments,
      assignments: result.lineItems.map(li => ({
        assignmentId: li.assignmentId,
        outcomeId: li.outcomeId,
        proxyId: li.proxyId,
        quantity: li.quantityExact,
        proxyValue: li.proxyValueExact,
        grossValue: li.grossValueExact,
        adjustedValue: li.adjustedValueExact,
        filters: {
          deadweightPct: li.deadweightPct,
          attributionPct: li.attributionPct,
          displacementPct: li.displacementPct,
          dropoffPct: li.dropoffPct,
          durationYears: li.durationYears,
        },
      })),
      discountRatePct: discountRatePct,
      formulaNotes: discountRatePct && parseNum(discountRatePct) > 0
        ? `Values normalized to USD; multi-year outcomes present-valued at ${discountRatePct}% annual discount rate.`
        : 'Values normalized to USD. No discount rate applied.',
      calculatedBy: ctx.user.id,
      calculatedAt: calculatedAt.toISOString(),
      readiness,
    }

    const runInsert = await tx
      .insert(sroiCalculationRuns)
      .values({
        projectId,
        organizationId: ctx.organization.id,
        version,
        currency: result.currency,
        totalInvestment: result.totalInvestmentExact,
        grossSocialValue: result.grossSocialValueExact,
        netSocialValue: result.netSocialValueExact,
        sroiRatio: result.sroiRatioExact,
        snapshotJson,
        status: 'calculated',
        methodologyVersion: runVersionIdentity.methodologyVersion,
        calculationEngineVersion: runVersionIdentity.calculationEngineVersion,
        buildIdentity: runVersionIdentity.buildIdentity,
        calculatedBy: ctx.user.id,
        calculatedAt,
      })
      .returning()

    const insertedRun = runInsert[0]

    // Persist real line items – one per calculable assignment
    const lineItemInserts = result.lineItems.map(li => ({
      runId: insertedRun.id,
      assignmentId: li.assignmentId,
      organizationId: ctx.organization.id,
      outcomeId: li.outcomeId,
      proxyId: li.proxyId,
      quantity: li.quantityExact,
      proxyValue: li.proxyValueExact,
      currency: li.currency,
      grossValue: li.grossValueExact,
      adjustedValue: li.adjustedValueExact,
      deadweightPct: li.deadweightPct.toString(),
      attributionPct: li.attributionPct.toString(),
      displacementPct: li.displacementPct.toString(),
      dropoffPct: li.dropoffPct.toString(),
      durationYears: li.durationYears,
    }))

    const insertedItems = lineItemInserts.length > 0
      ? await tx.insert(sroiCalculationLineItems).values(lineItemInserts).returning()
      : []

    return { run: insertedRun, lineItems: insertedItems }
  })

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    // W1-05-RM2 (HPO-DEC-3): 'sroi_calculation_run' — singular, matching the
    // AUDIT_ACTIONS verb's own object prefix.
    entityType: 'sroi_calculation_run',
    entityId: run.id,
    action: AUDIT_ACTIONS.SROI_CALCULATION_RUN_CALCULATED,
    afterJson: { runId: run.id, version: run.version, sroiRatio: result.sroiRatio, noRatioReason: result.noRatioReason ?? null } as Record<string, unknown>,
  })

  return { run, lineItems: lineItemRows }
}

// ─── List / Get runs ─────────────────────────────────────────────────────────

export async function listSroiCalculationRuns(projectId: string) {
  await authorize(projectId)
  return db.select().from(sroiCalculationRuns).where(eq(sroiCalculationRuns.projectId, projectId))
}

export async function getSroiCalculationRun(projectId: string, runId: string) {
  await authorize(projectId)
  const run = await db
    .select()
    .from(sroiCalculationRuns)
    .where(and(eq(sroiCalculationRuns.id, runId), eq(sroiCalculationRuns.projectId, projectId)))
  if (run.length === 0) throw new Error('Run not found')
  const items = await db.select().from(sroiCalculationLineItems).where(eq(sroiCalculationLineItems.runId, runId))
  return { run: run[0], items }
}
