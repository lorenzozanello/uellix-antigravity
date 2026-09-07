// lib/pipeline/sroi-readiness.ts
// FIBIU-17 (FIBC-021, FIBDB-015) — SROI_READINESS_MODEL_v1.0.0. Ten
// dimensions at exactly 10% each, 46 criteria, computed deterministically
// from already-persisted governed state. The system computes the canonical
// score; no human or Stella may inject a score, and readiness never gates
// approval (FIBC-021 invariants — enforced by omission: this module is
// never called from getSroiCalculationReadiness/blockingReasons).
//
// NEG-17-8 / V-17: this module imports NOTHING from lib/stella/** and reads
// no STELLA_* capability flag. D8-4 is the sole criterion that depends on
// Stella's OUTPUT (stella_interactions.risk_level, a plain Drizzle table),
// and it resolves by vacuity when Stella was not executed — never by
// consulting whether Stella is enabled, available, or was invoked.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  assumptionObjectLinks,
  auditLogs,
  counterfactualAssessments,
  evidenceItems,
  evidenceSufficiencyDeterminations,
  evidenceVersions,
  indicators,
  impactNarratives,
  methodologicalAssumptions,
  outcomeMonetizationDispositions,
  outcomes,
  projects,
  readinessAssessments,
  sensitivityCandidates,
  sensitivityScenarios,
  sroiCalculationRuns,
  sroiRunReviews,
  stakeholderGroups,
  stellaInteractions,
  theoryOfChangeLinks,
  theoryOfChangeNodes,
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { AUDIT_ACTIONS, logAuditAction } from '@/lib/audit/logger'
import { checkCausalChainSufficiency } from '@/lib/pipeline/theory-of-change'
import { getCurrentGovernedModelVersion } from '@/lib/pipeline/governed-model-registry'
import { loadCalculationData, type AssignmentData } from '@/lib/pipeline/sroi-calculation'

export const READINESS_MODEL_ID = 'SROI_READINESS_MODEL'

export const DIMENSION_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'] as const
export type DimensionId = (typeof DIMENSION_IDS)[number]

/** Every criterion assigned to exactly one primary dimension — 46 total. */
export const CRITERIA_PER_DIMENSION: Record<DimensionId, number> = {
  D1: 4, D2: 5, D3: 4, D4: 5, D5: 6, D6: 4, D7: 4, D8: 5, D9: 4, D10: 5,
}
export const READINESS_CRITERIA_COUNT = Object.values(CRITERIA_PER_DIMENSION).reduce((a, b) => a + b, 0)

export type CriterionResolution = 'satisfied' | 'not_satisfied' | 'satisfied_not_applicable' | 'satisfied_by_vacuity'

export interface CriterionResult {
  id: string
  dimension: DimensionId
  resolution: CriterionResolution
  detail: string
}

export type ReadinessBand = 'initial_preparation' | 'partial_preparation' | 'advanced_preparation' | 'high_preparation'

export interface DimensionScore {
  score: number
  satisfiedCount: number
  applicableCount: number
}

export interface ReadinessComputation {
  globalScore: number
  band: ReadinessBand
  dimensionScores: Record<DimensionId, DimensionScore>
  criteria: CriterionResult[]
}

// ---------------------------------------------------------------------------
// Governed state — everything a criterion may read. Loaded once per (project,
// run); every criterion below is a pure function of this object only.
// ---------------------------------------------------------------------------
export interface ReadinessGovernedState {
  project: { id: string; governanceRegime: string | null }
  run: {
    id: string
    methodologyVersion: string | null
    calculationEngineVersion: string | null
    buildIdentity: string | null
    monetizedOutcomeIds: string[]
    skippedAssignments: { outcomeId: string; reason: string }[]
    inputVersions: { objectType: string; objectId: string; versionId: string | null }[]
  }
  narrative: { narrativeText: string | null } | null
  stakeholderGroupCount: number
  activeTheoryOfChangeNodeCount: number
  outcomes: (typeof outcomes.$inferSelect)[]
  indicators: (typeof indicators.$inferSelect)[]
  evidenceItems: (typeof evidenceItems.$inferSelect)[]
  latestEvidenceVersionByItemId: Map<string, typeof evidenceVersions.$inferSelect>
  sufficiencyByOutcomeId: Map<string, typeof evidenceSufficiencyDeterminations.$inferSelect>
  dispositionByOutcomeId: Map<string, typeof outcomeMonetizationDispositions.$inferSelect>
  monetizedAssignments: AssignmentData[]
  counterfactualByOutcomeId: Map<string, typeof counterfactualAssessments.$inferSelect>
  materialAssumptions: (typeof methodologicalAssumptions.$inferSelect)[]
  resolvedAssumptionIds: Set<string>
  causalSufficiencyByOutcomeId: Map<string, boolean>
  sensitivityCandidates: (typeof sensitivityCandidates.$inferSelect)[]
  sensitivityScenarioCountByCandidateId: Map<string, number>
  highStellaFindingIds: string[]
  dispositionedInteractionIds: Set<string>
  stellaWasExecuted: boolean
  runReviews: (typeof sroiRunReviews.$inferSelect)[]
  runCreationAuditPresent: boolean
}

function outcomeApplicable(o: typeof outcomes.$inferSelect): boolean {
  return o.status === 'active'
}

function isMonetized(state: ReadinessGovernedState, outcomeId: string): boolean {
  return state.run.monetizedOutcomeIds.includes(outcomeId)
}

// ---------------------------------------------------------------------------
// Criterion evaluation — pure. Each dimension is one function returning
// exactly its declared criterion count, id-ordered.
// ---------------------------------------------------------------------------

function evalD1(s: ReadinessGovernedState): CriterionResult[] {
  const results: CriterionResult[] = []
  results.push({
    id: 'D1-1', dimension: 'D1',
    resolution: s.narrative?.narrativeText && s.narrative.narrativeText.trim().length > 0 ? 'satisfied' : 'not_satisfied',
    detail: 'impact_narratives.narrative_text is recorded and non-empty',
  })
  results.push({
    id: 'D1-2', dimension: 'D1',
    resolution: s.stakeholderGroupCount >= 1 ? 'satisfied' : 'not_satisfied',
    detail: 'at least one active stakeholder_groups row exists for the project',
  })
  results.push({
    id: 'D1-3', dimension: 'D1',
    resolution: s.activeTheoryOfChangeNodeCount >= 1 ? 'satisfied' : 'not_satisfied',
    detail: 'a causal representation (theory_of_change_nodes) is registered for the project',
  })
  // D1-4: every in-scope (active, monetized-by-this-run) outcome has a
  // sufficient causal chain, or a governed not_material classification
  // (out of scope by governed decision) — the not_material outcomes are
  // excluded from the applicable set, never silently counted as satisfied.
  const inScope = s.outcomes.filter((o) => outcomeApplicable(o) && isMonetized(s, o.id))
  const nonNa = inScope.filter((o) => o.materialityClassification !== 'not_material')
  if (nonNa.length === 0) {
    results.push({ id: 'D1-4', dimension: 'D1', resolution: 'satisfied_not_applicable', detail: 'every monetized outcome is governed not_material — no causal chain applicable' })
  } else {
    const allSufficient = nonNa.every((o) => s.causalSufficiencyByOutcomeId.get(o.id) === true)
    results.push({ id: 'D1-4', dimension: 'D1', resolution: allSufficient ? 'satisfied' : 'not_satisfied', detail: 'every monetized, non-governed-not_material outcome has a sufficient causal chain (activity -> output -> outcome)' })
  }
  return results
}

function evalD2(s: ReadinessGovernedState): CriterionResult[] {
  const active = s.outcomes.filter(outcomeApplicable)
  const material = active.filter((o) => o.materialityClassification === 'material')
  const notMonetized = active.filter((o) => {
    const d = s.dispositionByOutcomeId.get(o.id)
    return d && d.disposition !== 'monetized'
  })
  return [
    { id: 'D2-1', dimension: 'D2', resolution: active.every((o) => o.materialityClassification !== null) ? 'satisfied' : 'not_satisfied', detail: 'every active outcome has an explicit materiality classification' },
    { id: 'D2-2', dimension: 'D2', resolution: material.every((o) => !!o.materialityClassificationJustification) ? 'satisfied' : 'not_satisfied', detail: 'every material outcome has a materiality justification' },
    { id: 'D2-3', dimension: 'D2', resolution: material.every((o) => !!s.dispositionByOutcomeId.get(o.id)) ? 'satisfied' : 'not_satisfied', detail: 'every material outcome has a monetization disposition for this run' },
    { id: 'D2-4', dimension: 'D2', resolution: notMonetized.every((o) => { const d = s.dispositionByOutcomeId.get(o.id)!; return !!d.reason && !!d.justification }) ? 'satisfied' : 'not_satisfied', detail: 'every not_monetized disposition carries reason and justification' },
    { id: 'D2-5', dimension: 'D2', resolution: active.every((o) => !!o.stakeholderGroupId) ? 'satisfied' : 'not_satisfied', detail: 'every active outcome is linked to a stakeholder group' },
  ]
}

function evalD3(s: ReadinessGovernedState): CriterionResult[] {
  const material = s.outcomes.filter((o) => outcomeApplicable(o) && o.materialityClassification === 'material')
  const indicatorsByOutcome = new Map<string, (typeof indicators.$inferSelect)[]>()
  for (const i of s.indicators) {
    const list = indicatorsByOutcome.get(i.outcomeId) ?? []
    list.push(i)
    indicatorsByOutcome.set(i.outcomeId, list)
  }
  const activeIndicators = s.indicators.filter((i) => i.status === 'active')
  const monetizingIndicators = activeIndicators.filter((i) => isMonetized(s, i.outcomeId))
  return [
    { id: 'D3-1', dimension: 'D3', resolution: material.every((o) => (indicatorsByOutcome.get(o.id) ?? []).some((i) => i.status === 'active')) ? 'satisfied' : 'not_satisfied', detail: 'every material outcome has at least one active indicator' },
    { id: 'D3-2', dimension: 'D3', resolution: activeIndicators.every((i) => !!i.unit) ? 'satisfied' : 'not_satisfied', detail: 'every active indicator has a unit' },
    { id: 'D3-3', dimension: 'D3', resolution: activeIndicators.every((i) => !!i.dataSource && !!i.measurementPeriod) ? 'satisfied' : 'not_satisfied', detail: 'every active indicator has a data source and a measurement period' },
    monetizingIndicators.length === 0
      ? { id: 'D3-4', dimension: 'D3', resolution: 'satisfied_not_applicable', detail: 'no indicator belongs to an outcome monetized by this run' }
      : { id: 'D3-4', dimension: 'D3', resolution: monetizingIndicators.every((i) => !!i.actualValue) ? 'satisfied' : 'not_satisfied', detail: 'every indicator of a monetized outcome has a recorded quantity (actual_value)' },
  ]
}

function evalD4(s: ReadinessGovernedState): CriterionResult[] {
  const nonRejectedArchived = s.evidenceItems.filter((e) => e.status !== 'rejected' && e.status !== 'archived')
  const evByOutcome = new Map<string, typeof evidenceItems.$inferSelect[]>()
  for (const e of nonRejectedArchived) {
    if (!e.outcomeId) continue
    const list = evByOutcome.get(e.outcomeId) ?? []
    list.push(e)
    evByOutcome.set(e.outcomeId, list)
  }
  const material = s.outcomes.filter((o) => outcomeApplicable(o) && o.materialityClassification === 'material')
  const monetized = s.outcomes.filter((o) => outcomeApplicable(o) && isMonetized(s, o.id))
  const approvedByOutcome = new Map<string, boolean>()
  for (const [oid, items] of evByOutcome) approvedByOutcome.set(oid, items.some((e) => e.status === 'approved'))

  const textEvidence = s.evidenceItems.filter((e) => e.type === 'text')
  const textVersionsOk = textEvidence.every((e) => {
    const v = s.latestEvidenceVersionByItemId.get(e.id)
    return !!v && !v.legacyContentUnverifiable && v.content !== null && v.contentHash !== null
  })

  return [
    { id: 'D4-1', dimension: 'D4', resolution: material.every((o) => (evByOutcome.get(o.id) ?? []).length > 0) ? 'satisfied' : 'not_satisfied', detail: 'every material outcome has at least one non-rejected/non-archived evidence item' },
    { id: 'D4-2', dimension: 'D4', resolution: monetized.every((o) => approvedByOutcome.get(o.id) === true) ? 'satisfied' : 'not_satisfied', detail: 'every monetized outcome has at least one approved evidence item' },
    { id: 'D4-3', dimension: 'D4', resolution: monetized.every((o) => !!s.sufficiencyByOutcomeId.get(o.id)) ? 'satisfied' : 'not_satisfied', detail: 'every monetized outcome has a human sufficiency determination for this run' },
    { id: 'D4-4', dimension: 'D4', resolution: nonRejectedArchived.every((e) => { const v = s.latestEvidenceVersionByItemId.get(e.id); return !!v && v.sensitivityClassification !== null }) ? 'satisfied' : 'not_satisfied', detail: 'every evidence item has a sensitivity classification on its latest version' },
    textEvidence.length === 0
      ? { id: 'D4-5', dimension: 'D4', resolution: 'satisfied_not_applicable', detail: 'no text-type evidence exists' }
      : { id: 'D4-5', dimension: 'D4', resolution: textVersionsOk ? 'satisfied' : 'not_satisfied', detail: 'every text evidence version has persisted content matching its hash (not legacy-unverifiable)' },
  ]
}

function evalD5(s: ReadinessGovernedState): CriterionResult[] {
  const assignments = s.monetizedAssignments
  const hasVersion = assignments.every((a) => !!a.proxyVersion)
  const approved = assignments.every((a) => a.proxyVersion?.reviewStatus === 'approved')
  const provenanceOk = assignments.every((a) => {
    const v = a.proxyVersion
    if (!v) return false
    return !!v.geographicContextualScope && !!v.linkedOutcomeContext && !!v.recoverableReference && !!v.relevanceJustification && !!v.consultationDate
  })
  const rubricOk = assignments.every((a) => {
    const v = a.proxyVersion
    if (!v) return false
    return [v.c1SourceQualityVerifiability, v.c2OutcomeCorrespondence, v.c3StakeholderPopulationFit, v.c4GeographicContextFit, v.c5TemporalFit, v.c6MethodologicalUnitComparability].every((x) => x !== null)
  })
  const riskOk = assignments.every((a) => {
    const v = a.proxyVersion
    if (!v) return false
    return [v.r1ProvenanceRisk, v.r2SourceLimitationRisk, v.r3ConceptualFitRisk, v.r4GeographicPopulationTransferRisk, v.r5TemporalObsolescenceRisk, v.r6TransformationRisk, v.r7MethodologicalUncertaintyRisk].every((x) => x !== null)
  })
  const needingException = assignments.filter((a) => a.proxyVersion?.confidenceLevel === 'low' || a.proxyVersion?.methodologicalRisk === 'high')

  return [
    { id: 'D5-1', dimension: 'D5', resolution: hasVersion ? 'satisfied' : 'not_satisfied', detail: 'every monetized assignment has a bound financial proxy version' },
    { id: 'D5-2', dimension: 'D5', resolution: approved ? 'satisfied' : 'not_satisfied', detail: 'every bound proxy version is approved' },
    { id: 'D5-3', dimension: 'D5', resolution: provenanceOk ? 'satisfied' : 'not_satisfied', detail: 'every bound proxy version carries complete V-12 provenance' },
    { id: 'D5-4', dimension: 'D5', resolution: rubricOk ? 'satisfied' : 'not_satisfied', detail: 'every bound proxy version has all C1-C6 confidence factors rated' },
    { id: 'D5-5', dimension: 'D5', resolution: riskOk ? 'satisfied' : 'not_satisfied', detail: 'every bound proxy version has all R1-R7 risk factors rated' },
    needingException.length === 0
      ? { id: 'D5-6', dimension: 'D5', resolution: 'satisfied_not_applicable', detail: 'no bound proxy version is low-confidence or high-risk' }
      : { id: 'D5-6', dimension: 'D5', resolution: needingException.every((a) => !!a.proxyVersion?.exceptionalDefendibilityDetermination) ? 'satisfied' : 'not_satisfied', detail: 'every low-confidence or high-risk bound proxy version has an exceptional defendibility determination' },
  ]
}

function evalD6(s: ReadinessGovernedState): CriterionResult[] {
  const assignments = s.monetizedAssignments
  const valuesOk = assignments.every((a) => {
    const f = a.filterSet
    return [f.deadweightPct, f.attributionPct, f.displacementPct, f.dropoffPct, f.durationYears].every((x) => x !== null && x !== '')
  })
  const justificationOk = assignments.every((a) => {
    const f = a.filterSet
    return !!f.deadweightJustification && !!f.attributionJustification && !!f.displacementJustification && !!f.dropoffJustification && !!f.durationJustification
  })
  const monetizedOutcomeIds = new Set(assignments.map((a) => a.outcome.id))
  const counterfactualOk = [...monetizedOutcomeIds].every((oid) => !!s.counterfactualByOutcomeId.get(oid))
  const baselineOk = [...monetizedOutcomeIds].every((oid) => !!s.counterfactualByOutcomeId.get(oid)?.baselineAvailability)

  return [
    { id: 'D6-1', dimension: 'D6', resolution: valuesOk ? 'satisfied' : 'not_satisfied', detail: 'all five filters have explicit values on every monetized assignment' },
    { id: 'D6-2', dimension: 'D6', resolution: justificationOk ? 'satisfied' : 'not_satisfied', detail: 'all five filters have justification on every monetized assignment' },
    { id: 'D6-3', dimension: 'D6', resolution: counterfactualOk ? 'satisfied' : 'not_satisfied', detail: 'a counterfactual assessment is present for every monetized outcome, this run' },
    { id: 'D6-4', dimension: 'D6', resolution: baselineOk ? 'satisfied' : 'not_satisfied', detail: 'baseline availability is explicitly recorded on every counterfactual assessment' },
  ]
}

function evalD7(s: ReadinessGovernedState): CriterionResult[] {
  const skippedHaveReasons = s.run.skippedAssignments.every((sk) => !!sk.reason)
  const versionIdentityComplete = !!s.run.methodologyVersion && !!s.run.calculationEngineVersion && !!s.run.buildIdentity
  return [
    { id: 'D7-1', dimension: 'D7', resolution: 'satisfied', detail: 'a run exists for the current inputs (precondition of this computation)' },
    { id: 'D7-2', dimension: 'D7', resolution: 'satisfied', detail: 'monetization coverage is computed (monetized_outcome_ids recorded on the run snapshot)' },
    { id: 'D7-3', dimension: 'D7', resolution: skippedHaveReasons ? 'satisfied' : 'not_satisfied', detail: 'every excluded assignment carries a distinct itemized reason' },
    { id: 'D7-4', dimension: 'D7', resolution: versionIdentityComplete ? 'satisfied' : 'not_satisfied', detail: 'the run carries its full methodology/engine/build identity triple' },
  ]
}

function evalD8(s: ReadinessGovernedState): CriterionResult[] {
  const pendingCandidates = s.sensitivityCandidates.filter((c) => c.disposition === 'pending')
  const variationRequired = s.sensitivityCandidates.filter((c) => c.disposition === 'variation_required')
  const everyVariationHasScenario = variationRequired.every((c) => (s.sensitivityScenarioCountByCandidateId.get(c.id) ?? 0) >= 1)
  const undisposedHighFindings = s.highStellaFindingIds.filter((id) => !s.dispositionedInteractionIds.has(id))

  let d84: CriterionResult
  if (!s.stellaWasExecuted) {
    d84 = { id: 'D8-4', dimension: 'D8', resolution: 'satisfied_by_vacuity', detail: 'Stella was not executed for this run — vacuously satisfied' }
  } else if (s.highStellaFindingIds.length === 0) {
    d84 = { id: 'D8-4', dimension: 'D8', resolution: 'satisfied_by_vacuity', detail: 'Stella executed, zero high findings — vacuously satisfied' }
  } else if (undisposedHighFindings.length === 0) {
    d84 = { id: 'D8-4', dimension: 'D8', resolution: 'satisfied', detail: 'every open Stella high finding has a human disposition' }
  } else {
    d84 = { id: 'D8-4', dimension: 'D8', resolution: 'not_satisfied', detail: `${undisposedHighFindings.length} Stella high finding(s) remain undisposed` }
  }

  return [
    { id: 'D8-1', dimension: 'D8', resolution: pendingCandidates.length === 0 ? 'satisfied' : 'not_satisfied', detail: 'the sensitivity candidate register has no pending disposition' },
    { id: 'D8-2', dimension: 'D8', resolution: everyVariationHasScenario ? 'satisfied' : 'not_satisfied', detail: 'every variation_required candidate has at least one scenario' },
    { id: 'D8-3', dimension: 'D8', resolution: s.materialAssumptions.every((a) => s.resolvedAssumptionIds.has(a.id)) ? 'satisfied' : 'not_satisfied', detail: 'every material assumption is structured (linked to affected objects/decisions)' },
    d84,
    // D8-5: no governed limitations-determination object exists yet (FIBDB-028,
    // FIBIU-24, Wave 4). Honest not_satisfied, never a fabricated pass and
    // never an automatic not_applicable (V-17's reservation of the governed
    // not_applicable mechanism for genuine methodological determinations).
    { id: 'D8-5', dimension: 'D8', resolution: 'not_satisfied', detail: 'no governed limitations determination object exists yet (FIBDB-028 / FIBIU-24, Wave 4) — named successor, not a B5 obligation' },
  ]
}

function evalD9(s: ReadinessGovernedState): CriterionResult[] {
  const assignments = s.monetizedAssignments
  const approvedProxiesHaveRecoverableRef = assignments
    .filter((a) => a.proxyVersion?.reviewStatus === 'approved')
    .every((a) => !!a.proxyVersion?.recoverableReference)
  const evidenceProvenanceOk = s.evidenceItems.every((e) => !!e.createdBy && !!e.createdAt && (e.type !== 'file' || !!e.filePath) && (e.type !== 'url' || !!e.url) && (e.type !== 'text' || !!s.latestEvidenceVersionByItemId.get(e.id)?.content))
  const monetizedOutcomeIds = new Set(assignments.map((a) => a.outcome.id))
  const counterfactualSourcesOk = [...monetizedOutcomeIds].every((oid) => {
    const c = s.counterfactualByOutcomeId.get(oid)
    return !!c && (!!c.sources || c.basisKind === 'documented_assumption')
  })

  return [
    { id: 'D9-1', dimension: 'D9', resolution: approvedProxiesHaveRecoverableRef ? 'satisfied' : 'not_satisfied', detail: 'every approved bound proxy version has a recoverable source reference' },
    { id: 'D9-2', dimension: 'D9', resolution: evidenceProvenanceOk ? 'satisfied' : 'not_satisfied', detail: 'every evidence item has complete provenance metadata (actor, timestamp, type-specific locator)' },
    // DB CHECK (methodological_assumptions_provenance_reference_check) makes
    // this true of every persisted row by construction — no query needed.
    { id: 'D9-3', dimension: 'D9', resolution: 'satisfied', detail: 'every assumption records its basis/provenance (schema-enforced CHECK)' },
    { id: 'D9-4', dimension: 'D9', resolution: counterfactualSourcesOk ? 'satisfied' : 'not_satisfied', detail: 'every counterfactual assessment records sources, or is explicitly a documented assumption' },
  ]
}

function evalD10(s: ReadinessGovernedState): CriterionResult[] {
  const versionIdentityOk = s.run.inputVersions.length > 0 && s.run.inputVersions.every((v) => v.versionId !== null)
  const approvedReviews = s.runReviews.filter((r) => r.status === 'approved')
  const approverNeverAuthor = approvedReviews.every((r) => r.reviewerId !== r.createdBy)
  return [
    { id: 'D10-1', dimension: 'D10', resolution: s.project.governanceRegime === 'pc01b' ? 'satisfied' : 'not_satisfied', detail: 'the project is under the pc01b governance regime' },
    { id: 'D10-2', dimension: 'D10', resolution: versionIdentityOk ? 'satisfied' : 'not_satisfied', detail: 'every object supporting the run has an immutable version identity (input-version fingerprint)' },
    { id: 'D10-3', dimension: 'D10', resolution: s.runReviews.length > 0 ? 'satisfied' : 'not_satisfied', detail: 'a methodology review exists for this run' },
    { id: 'D10-4', dimension: 'D10', resolution: approverNeverAuthor ? 'satisfied' : 'not_satisfied', detail: 'no approver of this run is also its author' },
    { id: 'D10-5', dimension: 'D10', resolution: s.runCreationAuditPresent ? 'satisfied' : 'not_satisfied', detail: 'a governed audit event exists for this run\'s creation, with a domain-correct verb' },
  ]
}

export function computeReadinessAssessment(state: ReadinessGovernedState): ReadinessComputation {
  const byDimension: Record<DimensionId, CriterionResult[]> = {
    D1: evalD1(state), D2: evalD2(state), D3: evalD3(state), D4: evalD4(state), D5: evalD5(state),
    D6: evalD6(state), D7: evalD7(state), D8: evalD8(state), D9: evalD9(state), D10: evalD10(state),
  }

  const dimensionScores = {} as Record<DimensionId, DimensionScore>
  const allCriteria: CriterionResult[] = []
  let sumOfDimensionScores = 0

  for (const dim of DIMENSION_IDS) {
    const results = byDimension[dim]
    const applicableCount = results.length
    const satisfiedCount = results.filter((r) => r.resolution === 'satisfied' || r.resolution === 'satisfied_not_applicable' || r.resolution === 'satisfied_by_vacuity').length
    const score = applicableCount === 0 ? 100 : (100 * satisfiedCount) / applicableCount
    dimensionScores[dim] = { score, satisfiedCount, applicableCount }
    sumOfDimensionScores += score
    allCriteria.push(...results)
  }

  const globalScore = sumOfDimensionScores / DIMENSION_IDS.length
  const band: ReadinessBand =
    globalScore >= 85 ? 'high_preparation' : globalScore >= 70 ? 'advanced_preparation' : globalScore >= 40 ? 'partial_preparation' : 'initial_preparation'

  return { globalScore, band, dimensionScores, criteria: allCriteria }
}

// ---------------------------------------------------------------------------
// Governed-state loader
// ---------------------------------------------------------------------------

async function authorize(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const proj = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
  if (proj.length === 0) throw new Error('Project not found or not owned')
  return { ctx, project: proj[0] }
}

async function loadReadinessGovernedState(projectId: string, runId: string, organizationId: string): Promise<ReadinessGovernedState> {
  const runRows = await db.select().from(sroiCalculationRuns).where(and(eq(sroiCalculationRuns.id, runId), eq(sroiCalculationRuns.projectId, projectId)))
  if (runRows.length === 0) throw new Error('Calculation run not found for project')
  const run = runRows[0]
  const snapshot = (run.snapshotJson ?? {}) as {
    monetizedOutcomeIds?: string[]
    skippedAssignments?: { outcomeId: string; reason: string }[]
    inputVersions?: { objectType: string; objectId: string; versionId: string | null }[]
  }

  const [narrativeRows, stakeholderRows, tocNodeRows, outcomeRows, indicatorRows, evidenceRows] = await Promise.all([
    db.select().from(impactNarratives).where(eq(impactNarratives.projectId, projectId)).orderBy(desc(impactNarratives.createdAt)).limit(1),
    db.select().from(stakeholderGroups).where(and(eq(stakeholderGroups.projectId, projectId), eq(stakeholderGroups.status, 'active'))),
    db.select().from(theoryOfChangeNodes).where(and(eq(theoryOfChangeNodes.projectId, projectId), eq(theoryOfChangeNodes.status, 'active'))),
    db.select().from(outcomes).where(eq(outcomes.projectId, projectId)),
    db.select().from(indicators).where(eq(indicators.projectId, projectId)),
    db.select().from(evidenceItems).where(eq(evidenceItems.projectId, projectId)),
  ])

  const evidenceIds = evidenceRows.map((e) => e.id)
  const evidenceVersionRows = evidenceIds.length === 0 ? [] : await db.select().from(evidenceVersions).where(inArray(evidenceVersions.evidenceId, evidenceIds)).orderBy(desc(evidenceVersions.ordinal))
  const latestEvidenceVersionByItemId = new Map<string, typeof evidenceVersions.$inferSelect>()
  for (const v of evidenceVersionRows) if (!latestEvidenceVersionByItemId.has(v.evidenceId)) latestEvidenceVersionByItemId.set(v.evidenceId, v)

  const outcomeIds = outcomeRows.map((o) => o.id)

  const [sufficiencyRows, dispositionRows, counterfactualRows] = await Promise.all([
    outcomeIds.length === 0 ? Promise.resolve([]) : db.select().from(evidenceSufficiencyDeterminations).where(and(inArray(evidenceSufficiencyDeterminations.outcomeId, outcomeIds), eq(evidenceSufficiencyDeterminations.calculationRunId, runId))).orderBy(desc(evidenceSufficiencyDeterminations.ordinal)),
    outcomeIds.length === 0 ? Promise.resolve([]) : db.select().from(outcomeMonetizationDispositions).where(and(inArray(outcomeMonetizationDispositions.outcomeId, outcomeIds), eq(outcomeMonetizationDispositions.calculationRunId, runId))),
    outcomeIds.length === 0 ? Promise.resolve([]) : db.select().from(counterfactualAssessments).where(and(inArray(counterfactualAssessments.outcomeId, outcomeIds), eq(counterfactualAssessments.calculationRunId, runId))),
  ])
  const sufficiencyByOutcomeId = new Map<string, typeof evidenceSufficiencyDeterminations.$inferSelect>()
  for (const row of sufficiencyRows) if (!sufficiencyByOutcomeId.has(row.outcomeId)) sufficiencyByOutcomeId.set(row.outcomeId, row)
  const dispositionByOutcomeId = new Map(dispositionRows.map((d) => [d.outcomeId, d] as const))
  const counterfactualByOutcomeId = new Map(counterfactualRows.map((c) => [c.outcomeId, c] as const))

  const { assignmentData } = await loadCalculationData(projectId, organizationId, false)
  const monetizedAssignmentIds = new Set((snapshot.monetizedOutcomeIds ?? []).length > 0 ? assignmentData.filter((a) => (snapshot.monetizedOutcomeIds ?? []).includes(a.outcome.id)).map((a) => a.assignment.id) : [])
  const monetizedAssignments = assignmentData.filter((a) => monetizedAssignmentIds.has(a.assignment.id))

  const materialAssumptions = await db.select().from(methodologicalAssumptions).where(and(eq(methodologicalAssumptions.projectId, projectId), eq(methodologicalAssumptions.materialityFlag, 'material')))
  const assumptionIds = materialAssumptions.map((a) => a.id)
  const links = assumptionIds.length === 0 ? [] : await db.select({ assumptionId: assumptionObjectLinks.assumptionId }).from(assumptionObjectLinks).where(inArray(assumptionObjectLinks.assumptionId, assumptionIds))
  const resolvedAssumptionIds = new Set(links.map((l) => l.assumptionId))

  const causalSufficiencyByOutcomeId = new Map<string, boolean>()
  if (outcomeIds.length > 0) {
    const tocLinks = await db.select().from(theoryOfChangeLinks).where(eq(theoryOfChangeLinks.projectId, projectId))
    for (const oid of outcomeIds) {
      const result = checkCausalChainSufficiency(tocNodeRows, tocLinks, oid)
      causalSufficiencyByOutcomeId.set(oid, result.sufficient)
    }
  }

  const [candidateRows, scenarioRows] = await Promise.all([
    db.select().from(sensitivityCandidates).where(eq(sensitivityCandidates.calculationRunId, runId)),
    db.select().from(sensitivityScenarios).where(eq(sensitivityScenarios.calculationRunId, runId)),
  ])
  const sensitivityScenarioCountByCandidateId = new Map<string, number>()
  for (const sc of scenarioRows) {
    const ids = (sc.candidateIds ?? []) as string[]
    for (const cid of ids) sensitivityScenarioCountByCandidateId.set(cid, (sensitivityScenarioCountByCandidateId.get(cid) ?? 0) + 1)
  }

  const stellaRows = await db.select({ id: stellaInteractions.id, riskLevel: stellaInteractions.riskLevel }).from(stellaInteractions).where(eq(stellaInteractions.projectId, projectId))
  const stellaWasExecuted = stellaRows.length > 0
  const highStellaFindingIds = stellaRows.filter((r) => r.riskLevel === 'high').map((r) => r.id)
  let dispositionedInteractionIds = new Set<string>()
  if (highStellaFindingIds.length > 0) {
    const decisionAudits = await db.select({ afterJson: auditLogs.afterJson }).from(auditLogs).where(and(eq(auditLogs.projectId, projectId), eq(auditLogs.action, AUDIT_ACTIONS.STELLA_DECISION_RECORDED)))
    dispositionedInteractionIds = new Set(
      decisionAudits.map((r) => (r.afterJson as { interactionId?: string } | null)?.interactionId).filter((x): x is string => !!x)
    )
  }

  const runReviews = await db.select().from(sroiRunReviews).where(and(eq(sroiRunReviews.projectId, projectId), eq(sroiRunReviews.calculationRunId, runId)))

  const creationAudit = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, runId), eq(auditLogs.action, AUDIT_ACTIONS.SROI_CALCULATION_RUN_CALCULATED))).limit(1)

  return {
    project: { id: projectId, governanceRegime: null },
    run: {
      id: run.id,
      methodologyVersion: run.methodologyVersion,
      calculationEngineVersion: run.calculationEngineVersion,
      buildIdentity: run.buildIdentity,
      monetizedOutcomeIds: snapshot.monetizedOutcomeIds ?? [],
      skippedAssignments: snapshot.skippedAssignments ?? [],
      inputVersions: snapshot.inputVersions ?? [],
    },
    narrative: narrativeRows[0] ?? null,
    stakeholderGroupCount: stakeholderRows.length,
    activeTheoryOfChangeNodeCount: tocNodeRows.length,
    outcomes: outcomeRows,
    indicators: indicatorRows,
    evidenceItems: evidenceRows,
    latestEvidenceVersionByItemId,
    sufficiencyByOutcomeId,
    dispositionByOutcomeId,
    monetizedAssignments,
    counterfactualByOutcomeId,
    materialAssumptions,
    resolvedAssumptionIds,
    causalSufficiencyByOutcomeId,
    sensitivityCandidates: candidateRows,
    sensitivityScenarioCountByCandidateId,
    highStellaFindingIds,
    dispositionedInteractionIds,
    stellaWasExecuted,
    runReviews,
    runCreationAuditPresent: creationAudit.length > 0,
  }
}

// ---------------------------------------------------------------------------
// Persist — one immutable row per run
// ---------------------------------------------------------------------------

export async function getReadinessAssessment(projectId: string, runId: string) {
  const { ctx } = await authorize(projectId)
  const rows = await db.select().from(readinessAssessments).where(and(eq(readinessAssessments.calculationRunId, runId), eq(readinessAssessments.organizationId, ctx.organization.id)))
  return rows[0] ?? null
}

export async function computeAndPersistReadinessAssessment(projectId: string, runId: string) {
  const { ctx, project } = await authorize(projectId)

  const existing = await db.select().from(readinessAssessments).where(eq(readinessAssessments.calculationRunId, runId))
  if (existing.length > 0) {
    throw new Error('A readiness assessment already exists for this run — it is immutable; recompute by creating a new calculation run')
  }

  const modelVersion = await getCurrentGovernedModelVersion(READINESS_MODEL_ID)
  if (!modelVersion) throw new Error(`Cannot compute readiness: governed model ${READINESS_MODEL_ID} is not registered`)

  const state = await loadReadinessGovernedState(projectId, runId, ctx.organization.id)
  state.project.governanceRegime = project.governanceRegime
  const computation = computeReadinessAssessment(state)

  const dimensionScoresJson: Record<string, DimensionScore> = {}
  for (const dim of DIMENSION_IDS) dimensionScoresJson[dim] = computation.dimensionScores[dim]

  const inserted = await db.insert(readinessAssessments).values({
    organizationId: ctx.organization.id,
    projectId,
    calculationRunId: runId,
    readinessModelVersion: modelVersion.version,
    globalScore: computation.globalScore.toFixed(2),
    band: computation.band,
    dimensionScores: dimensionScoresJson,
    criteriaDetail: computation.criteria,
    createdBy: ctx.user.id,
  }).returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'readiness_assessment',
    entityId: inserted[0].id,
    action: AUDIT_ACTIONS.READINESS_ASSESSMENT_COMPUTED,
    afterJson: { calculationRunId: runId, globalScore: computation.globalScore, band: computation.band },
  })

  return inserted[0]
}
