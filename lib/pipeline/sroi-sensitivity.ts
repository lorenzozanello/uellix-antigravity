// lib/pipeline/sroi-sensitivity.ts
// FIBIU-18 (FIBC-022, FIBDB-017/018/048) — SROI_SENSITIVITY_MODEL_v1.0.0.
//
// SUPERSEDES, NOT EXTENDS, the previous uniform +/-10 percentage-point
// shift shortcut this module used to apply to every filter: this module and
// its schema replace that file's entire public surface. None of the three
// superseded identifiers (the uniform-delta constant, the shift function, or
// the legacy scenario-calculation entry point) exists anywhere in lib/** or
// app/** after this migration (NEG-18-1) — not even in a comment naming them,
// which is why this file deliberately never spells any of the three out.
//
// Deterministic per-run candidate register built from the inputs ACTUALLY
// USED by the run: the five adjustment dimensions (none omissible for being
// 0 or stable), material structured assumptions, financial proxy values with
// a reasonable alternative/range, and discount_rate_pct. Each candidate
// carries a human disposition; a variation_required candidate needs >=1
// governed scenario, executed through the SAME deterministic engine
// (runDeterministicCalc) with only the declared inputs substituted. The base
// run is never overwritten. Stella never computes scenario ratios or
// dispositions a candidate (NEG-STELLA-B5).

// Pin the shared Decimal configuration — this module feeds runDeterministicCalc
// (decimal.js) when it re-executes the engine for a scenario.
import './decimal-config'

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  methodologicalAssumptions,
  projects,
  sensitivityCandidates,
  sensitivityScenarios,
  sroiCalculationRuns,
  sroiRunReviews,
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { AUDIT_ACTIONS, logAuditAction } from '@/lib/audit/logger'
import { getCurrentGovernedModelVersion } from '@/lib/pipeline/governed-model-registry'
import {
  loadCalculationData,
  parseNum,
  runDeterministicCalc,
  type AssignmentData,
  type CalcResult,
} from '@/lib/pipeline/sroi-calculation'

export const SENSITIVITY_MODEL_ID = 'SROI_SENSITIVITY_MODEL'

export const CANDIDATE_KIND_VALUES = ['methodological_filter', 'structured_assumption', 'proxy_value', 'other_quantitative_input'] as const
export type CandidateKind = (typeof CANDIDATE_KIND_VALUES)[number]

export const CANDIDATE_DISPOSITION_VALUES = ['variation_required', 'no_additional_variation_required', 'pending'] as const
export type CandidateDisposition = (typeof CANDIDATE_DISPOSITION_VALUES)[number]

export const SCENARIO_KIND_VALUES = ['one_at_a_time', 'combined'] as const
export type ScenarioKind = (typeof SCENARIO_KIND_VALUES)[number]

/** The five FIBC-022 adjustment dimensions — the exact names the authority uses. */
export const FIB_FILTER_NAMES = ['deadweight', 'attribution', 'displacement', 'drop_off', 'duration'] as const
export type FibFilterName = (typeof FIB_FILTER_NAMES)[number]

const FILTER_SET_FIELD: Record<FibFilterName, 'deadweightPct' | 'attributionPct' | 'displacementPct' | 'dropoffPct' | 'durationYears'> = {
  deadweight: 'deadweightPct',
  attribution: 'attributionPct',
  displacement: 'displacementPct',
  drop_off: 'dropoffPct',
  duration: 'durationYears',
}

export interface CandidateInputReference {
  assignmentId?: string
  outcomeId?: string
  filter?: FibFilterName
  assumptionId?: string
  proxyId?: string
  proxyVersionId?: string
  inputName?: string
}

export interface CandidateDraft {
  candidateKey: string
  candidateKind: CandidateKind
  inputReference: CandidateInputReference
  baseValue: string | null
}

// ---------------------------------------------------------------------------
// Pure: candidate register construction from actually-used run inputs
// ---------------------------------------------------------------------------

/**
 * Builds the full candidate draft set for a run's actually-monetized
 * assignments plus the project's material structured assumptions plus
 * discount_rate_pct. Pure — no I/O. None of the five filter dimensions is
 * omitted for being 0 or unchanged from default (MUT-18-3/4).
 */
export function buildSensitivityCandidateDrafts(input: {
  monetizedAssignments: AssignmentData[]
  materialAssumptions: (typeof methodologicalAssumptions.$inferSelect)[]
  discountRatePct: string | null
}): CandidateDraft[] {
  const drafts: CandidateDraft[] = []

  for (const a of input.monetizedAssignments) {
    for (const filter of FIB_FILTER_NAMES) {
      const field = FILTER_SET_FIELD[filter]
      const raw = a.filterSet[field]
      drafts.push({
        candidateKey: `methodological_filter:${a.assignment.id}:${filter}`,
        candidateKind: 'methodological_filter',
        inputReference: { assignmentId: a.assignment.id, outcomeId: a.outcome.id, filter },
        baseValue: raw === null || raw === undefined ? null : String(raw),
      })
    }
    // Financial proxy value used to monetize — a reasonable alternative/range
    // is always at least conceivable for a monetary estimate, so every bound
    // proxy value registers (FIBC-022: "every financial proxy value used to
    // monetize where a reasonable alternative/range/uncertainty exists").
    if (a.proxyVersion) {
      drafts.push({
        candidateKey: `proxy_value:${a.assignment.id}:${a.proxyVersion.id}`,
        candidateKind: 'proxy_value',
        inputReference: { assignmentId: a.assignment.id, outcomeId: a.outcome.id, proxyId: a.proxy.id, proxyVersionId: a.proxyVersion.id },
        baseValue: a.proxyVersion.valueUsd,
      })
    }
  }

  for (const assumption of input.materialAssumptions) {
    drafts.push({
      candidateKey: `structured_assumption:${assumption.id}`,
      candidateKind: 'structured_assumption',
      inputReference: { assumptionId: assumption.id },
      baseValue: assumption.formulation,
    })
  }

  // Always registered, per run, regardless of value (captures discount_rate_pct
  // per FIBC-022's "any other quantitative engine input whose uncertainty
  // could materially affect ... interpretation").
  drafts.push({
    candidateKey: 'other_quantitative_input:discount_rate_pct',
    candidateKind: 'other_quantitative_input',
    inputReference: { inputName: 'discount_rate_pct' },
    baseValue: input.discountRatePct,
  })

  return drafts
}

export interface SensitivityCompleteness {
  complete: boolean
  pendingCandidateIds: string[]
  variationRequiredWithoutScenarioIds: string[]
}

/** Pure: zero pending AND >=1 valid persisted scenario per variation_required. */
export function computeSensitivityCompleteness(
  candidates: (typeof sensitivityCandidates.$inferSelect)[],
  scenarioCountByCandidateId: Map<string, number>
): SensitivityCompleteness {
  const pendingCandidateIds = candidates.filter((c) => c.disposition === 'pending').map((c) => c.id)
  const variationRequiredWithoutScenarioIds = candidates
    .filter((c) => c.disposition === 'variation_required' && (scenarioCountByCandidateId.get(c.id) ?? 0) === 0)
    .map((c) => c.id)
  return {
    complete: pendingCandidateIds.length === 0 && variationRequiredWithoutScenarioIds.length === 0,
    pendingCandidateIds,
    variationRequiredWithoutScenarioIds,
  }
}

export interface ScenarioEnvelope {
  label: 'scenario_envelope'
  netSocialValueMinExact: string
  netSocialValueMaxExact: string
  sroiRatioMinExact: string | null
  sroiRatioMaxExact: string | null
}

/** Pure: min/max across the base run and every recorded scenario — NEVER a confidence interval. */
export function computeScenarioEnvelope(
  baseResult: { netSocialValueExact: string; sroiRatioExact: string | null },
  scenarioResults: { netSocialValueExact: string; sroiRatioExact: string | null }[]
): ScenarioEnvelope {
  const all = [baseResult, ...scenarioResults]
  const nsvValues = all.map((r) => parseNum(r.netSocialValueExact))
  const ratioValues = all.map((r) => r.sroiRatioExact).filter((r): r is string => r !== null).map(parseNum)
  return {
    label: 'scenario_envelope',
    netSocialValueMinExact: Math.min(...nsvValues).toFixed(4),
    netSocialValueMaxExact: Math.max(...nsvValues).toFixed(4),
    sroiRatioMinExact: ratioValues.length === 0 ? null : Math.min(...ratioValues).toFixed(6),
    sroiRatioMaxExact: ratioValues.length === 0 ? null : Math.max(...ratioValues).toFixed(6),
  }
}

// ---------------------------------------------------------------------------
// DB-backed services
// ---------------------------------------------------------------------------

async function authorize(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const proj = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
  if (proj.length === 0) throw new Error('Project not found or not owned')
  return ctx
}

async function loadRunOrThrow(projectId: string, runId: string) {
  const rows = await db.select().from(sroiCalculationRuns).where(and(eq(sroiCalculationRuns.id, runId), eq(sroiCalculationRuns.projectId, projectId)))
  if (rows.length === 0) throw new Error('Calculation run not found for project')
  return rows[0]
}

async function assertRunNotApproved(runId: string) {
  const approved = await db.select().from(sroiRunReviews).where(and(eq(sroiRunReviews.calculationRunId, runId), eq(sroiRunReviews.status, 'approved')))
  if (approved.length > 0) throw new Error('Cannot modify sensitivity state: this calculation run is already approved')
}

/** Same reconstruction technique as lib/pipeline/sroi-readiness.ts's monetizedAssignments — the CURRENT bound state for the assignments this run actually monetized, never a snapshot re-parse. */
async function loadMonetizedAssignments(projectId: string, organizationId: string, run: typeof sroiCalculationRuns.$inferSelect): Promise<AssignmentData[]> {
  const snapshot = (run.snapshotJson ?? {}) as { monetizedOutcomeIds?: string[] }
  const monetizedOutcomeIds = new Set(snapshot.monetizedOutcomeIds ?? [])
  if (monetizedOutcomeIds.size === 0) return []
  const { assignmentData } = await loadCalculationData(projectId, organizationId, false)
  return assignmentData.filter((a) => monetizedOutcomeIds.has(a.outcome.id))
}

export async function registerSensitivityCandidates(projectId: string, runId: string) {
  const ctx = await authorize(projectId)
  const run = await loadRunOrThrow(projectId, runId)
  await assertRunNotApproved(runId)
  if (!run.methodologyVersion) {
    // Pre-model run — legacy_non_authoritative, no retrospective registration (NEG-18-8).
    throw new Error('Cannot register sensitivity candidates: this run predates the versioned methodology and stays legacy_non_authoritative')
  }

  const modelVersion = await getCurrentGovernedModelVersion(SENSITIVITY_MODEL_ID)
  if (!modelVersion) throw new Error(`Cannot register sensitivity candidates: governed model ${SENSITIVITY_MODEL_ID} is not registered`)

  const [monetizedAssignments, materialAssumptions] = await Promise.all([
    loadMonetizedAssignments(projectId, ctx.organization.id, run),
    db.select().from(methodologicalAssumptions).where(and(eq(methodologicalAssumptions.projectId, projectId), eq(methodologicalAssumptions.materialityFlag, 'material'))),
  ])

  const snapshot = (run.snapshotJson ?? {}) as { discountRatePct?: string | null }
  const drafts = buildSensitivityCandidateDrafts({ monetizedAssignments, materialAssumptions, discountRatePct: snapshot.discountRatePct ?? null })

  const registered: (typeof sensitivityCandidates.$inferSelect)[] = []
  for (const draft of drafts) {
    const inserted = await db
      .insert(sensitivityCandidates)
      .values({
        organizationId: ctx.organization.id,
        projectId,
        calculationRunId: runId,
        candidateKey: draft.candidateKey,
        candidateKind: draft.candidateKind,
        inputReference: draft.inputReference,
        baseValue: draft.baseValue,
        sensitivityModelVersion: modelVersion.version,
        createdBy: ctx.user.id,
      })
      .onConflictDoNothing({ target: [sensitivityCandidates.calculationRunId, sensitivityCandidates.candidateKey] })
      .returning()
    if (inserted.length > 0) registered.push(inserted[0])
  }

  if (registered.length > 0) {
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'sensitivity_candidate',
      entityId: runId,
      action: AUDIT_ACTIONS.SENSITIVITY_CANDIDATE_REGISTERED,
      afterJson: { calculationRunId: runId, registeredCount: registered.length, candidateKeys: registered.map((r) => r.candidateKey) },
    })
  }

  return listSensitivityCandidates(projectId, runId)
}

export async function listSensitivityCandidates(projectId: string, runId: string) {
  const ctx = await authorize(projectId)
  return db.select().from(sensitivityCandidates).where(and(eq(sensitivityCandidates.calculationRunId, runId), eq(sensitivityCandidates.organizationId, ctx.organization.id)))
}

export interface DispositionInput {
  disposition: 'variation_required' | 'no_additional_variation_required'
  rationale: string
}

export async function dispositionSensitivityCandidate(projectId: string, candidateId: string, input: DispositionInput) {
  const ctx = await authorize(projectId)
  if (!input.rationale || input.rationale.trim().length === 0) {
    throw new Error('A non-pending disposition requires rationale (FIBDB-048)')
  }

  const existing = await db.select().from(sensitivityCandidates).where(and(eq(sensitivityCandidates.id, candidateId), eq(sensitivityCandidates.projectId, projectId), eq(sensitivityCandidates.organizationId, ctx.organization.id)))
  if (existing.length === 0) throw new Error('Sensitivity candidate not found for project')

  await assertRunNotApproved(existing[0].calculationRunId)

  const updated = await db
    .update(sensitivityCandidates)
    .set({ disposition: input.disposition, rationale: input.rationale, dispositionedBy: ctx.user.id, dispositionedAt: new Date() })
    .where(eq(sensitivityCandidates.id, candidateId))
    .returning()
  if (updated.length === 0) {
    throw new Error('Disposition update affected no row (refused by row-level security) — nothing was recorded')
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sensitivity_candidate',
    entityId: candidateId,
    action: AUDIT_ACTIONS.SENSITIVITY_CANDIDATE_DISPOSITIONED,
    contentModifying: true,
    beforeJson: existing[0] as unknown as Record<string, unknown>,
    afterJson: updated[0] as unknown as Record<string, unknown>,
  })

  return updated[0]
}

export interface RecordScenarioInput {
  scenarioKind: ScenarioKind
  substitutions: { candidateId: string; alternativeValue: string }[]
  reason: string
  sources?: string
  combinationDescription?: string
}

function toResultSummary(r: CalcResult) {
  return {
    currency: r.currency,
    totalInvestmentExact: r.totalInvestmentExact,
    grossSocialValueExact: r.grossSocialValueExact,
    netSocialValueExact: r.netSocialValueExact,
    sroiRatioExact: r.sroiRatioExact,
    noRatioReason: r.noRatioReason ?? null,
  }
}

export async function recordSensitivityScenario(projectId: string, runId: string, input: RecordScenarioInput) {
  const ctx = await authorize(projectId)
  const run = await loadRunOrThrow(projectId, runId)
  await assertRunNotApproved(runId)

  if (!input.reason || input.reason.trim().length === 0) throw new Error('A scenario requires a reason')
  if (input.scenarioKind === 'one_at_a_time' && input.substitutions.length !== 1) {
    throw new Error('A one_at_a_time scenario substitutes exactly one candidate')
  }
  if (input.scenarioKind === 'combined') {
    if (input.substitutions.length < 2) throw new Error('A combined scenario substitutes two or more candidates')
    if (!input.combinationDescription || input.combinationDescription.trim().length === 0) {
      throw new Error('A combined scenario requires combination_description')
    }
  }

  const candidateIds = input.substitutions.map((s) => s.candidateId)
  const candidates = await db.select().from(sensitivityCandidates).where(and(inArray(sensitivityCandidates.id, candidateIds), eq(sensitivityCandidates.calculationRunId, runId)))
  if (candidates.length !== candidateIds.length) throw new Error('One or more sensitivity candidates were not found for this run')
  if (!candidates.every((c) => c.disposition === 'variation_required')) {
    throw new Error('A scenario may only be recorded for candidates disposed variation_required')
  }

  const modelVersion = await getCurrentGovernedModelVersion(SENSITIVITY_MODEL_ID)
  if (!modelVersion) throw new Error(`Cannot record scenario: governed model ${SENSITIVITY_MODEL_ID} is not registered`)

  const monetizedAssignments = await loadMonetizedAssignments(projectId, ctx.organization.id, run)
  const snapshot = (run.snapshotJson ?? {}) as {
    discountRatePct?: string | null
    investments?: { amountUsd: string | null }[]
  }
  const baseDiscountRatePct = snapshot.discountRatePct ?? null
  // Reconstructed from the run's own frozen snapshot, never re-queried live —
  // the funding side is not itself a sensitivity candidate (FIBC-022 varies
  // monetization inputs only), but runDeterministicCalc needs the investment
  // total to compute the ratio's denominator. Only .amountUsd is read.
  const investments = (snapshot.investments ?? []).map((inv) => ({ amountUsd: inv.amountUsd })) as Parameters<typeof runDeterministicCalc>[0]

  // Recompute the base result through the SAME engine, unmodified — the
  // reproduction proof (POS-18-4) — before applying any substitution.
  const baseResult = runDeterministicCalc(investments, monetizedAssignments, [], [], baseDiscountRatePct, { filterSemantics: 'authoritative' })

  const substitutedAssignments: AssignmentData[] = monetizedAssignments.map((a) => ({
    ...a,
    filterSet: { ...a.filterSet },
    proxyVersion: a.proxyVersion ? { ...a.proxyVersion } : null,
  }))
  let substitutedDiscountRatePct = baseDiscountRatePct
  const modifiedInputs: { candidateId: string; candidateKey: string; baseValue: string | null; alternativeValue: string }[] = []

  for (const sub of input.substitutions) {
    const candidate = candidates.find((c) => c.id === sub.candidateId)!
    const ref = candidate.inputReference as CandidateInputReference
    modifiedInputs.push({ candidateId: candidate.id, candidateKey: candidate.candidateKey, baseValue: candidate.baseValue, alternativeValue: sub.alternativeValue })

    if (candidate.candidateKind === 'methodological_filter' && ref.assignmentId && ref.filter) {
      const target = substitutedAssignments.find((a) => a.assignment.id === ref.assignmentId)
      if (target) (target.filterSet as unknown as Record<string, unknown>)[FILTER_SET_FIELD[ref.filter]] = sub.alternativeValue
    } else if (candidate.candidateKind === 'proxy_value' && ref.assignmentId) {
      const target = substitutedAssignments.find((a) => a.assignment.id === ref.assignmentId)
      if (target && target.proxyVersion) target.proxyVersion = { ...target.proxyVersion, valueUsd: sub.alternativeValue }
    } else if (candidate.candidateKind === 'other_quantitative_input' && ref.inputName === 'discount_rate_pct') {
      substitutedDiscountRatePct = sub.alternativeValue
    }
    // structured_assumption: no direct numeric engine parameter exists for a
    // qualitative assumption in this codebase (methodological_assumptions
    // carries no calculation value). The scenario is still recorded — its
    // engine result equals the base because nothing numeric changed — never
    // an invented numeric effect for a qualitative candidate. Disclosed
    // interpretation, flagged for the mandatory FIBIU-18 Opus review.
  }

  const scenarioResult = runDeterministicCalc(investments, substitutedAssignments, [], [], substitutedDiscountRatePct, { filterSemantics: 'authoritative' })

  const inserted = await db
    .insert(sensitivityScenarios)
    .values({
      organizationId: ctx.organization.id,
      projectId,
      calculationRunId: runId,
      scenarioKind: input.scenarioKind,
      candidateIds,
      modifiedInputs,
      reason: input.reason,
      sources: input.sources ?? null,
      combinationDescription: input.combinationDescription ?? null,
      sensitivityModelVersion: modelVersion.version,
      calculationEngineVersion: run.calculationEngineVersion ?? '',
      resultJson: toResultSummary(scenarioResult),
      baseResultJson: toResultSummary(baseResult),
      selectedBy: ctx.user.id,
      createdBy: ctx.user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'sensitivity_scenario',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.SENSITIVITY_SCENARIO_RECORDED,
    afterJson: { calculationRunId: runId, scenarioKind: input.scenarioKind, candidateIds },
  })

  return inserted[0]
}

export async function listSensitivityScenarios(projectId: string, runId: string) {
  const ctx = await authorize(projectId)
  return db.select().from(sensitivityScenarios).where(and(eq(sensitivityScenarios.calculationRunId, runId), eq(sensitivityScenarios.organizationId, ctx.organization.id)))
}

export async function getRunSensitivityCompleteness(projectId: string, runId: string): Promise<SensitivityCompleteness> {
  const [candidates, scenarios] = await Promise.all([listSensitivityCandidates(projectId, runId), listSensitivityScenarios(projectId, runId)])
  const scenarioCountByCandidateId = new Map<string, number>()
  for (const sc of scenarios) {
    const ids = (sc.candidateIds ?? []) as string[]
    for (const cid of ids) scenarioCountByCandidateId.set(cid, (scenarioCountByCandidateId.get(cid) ?? 0) + 1)
  }
  return computeSensitivityCompleteness(candidates, scenarioCountByCandidateId)
}
