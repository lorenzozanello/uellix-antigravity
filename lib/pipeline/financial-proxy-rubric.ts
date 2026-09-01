// lib/pipeline/financial-proxy-rubric.ts
// FIBIU-09 — PROXY_DEFENDIBILITY_RUBRIC_v1.0.0 (FIBC-011/FIBDB-006(rubric
// columns)/FIBDB-044).
//
// Six confidence factors (C1-C6) and seven risk factors (R1-R7), each rated
// 0..3 by a human with rationale and references. The derived classification
// (confidence_level, methodological_risk, and their two integer scores) is
// SYSTEM-DERIVED and never accepted as separate human input — there is no
// write path anywhere in this module that lets a caller set a level
// directly, only the raw factor ratings. `deriveRubricClassification` is
// the ONE authoritative, pure, reproducible derivation; recordRubric
// Evaluation is its only caller inside a real write.

import { z } from 'zod'
import { db } from '@/db/client'
import { financialProxies } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canEvaluateProxyRubric } from '@/lib/auth/permissions'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { getCurrentGovernedModelVersion } from '@/lib/pipeline/governed-model-registry'
import {
  getLatestFinancialProxyVersion,
  updateCurrentFinancialProxyVersion,
  type FinancialProxyVersion,
} from '@/lib/pipeline/financial-proxy-versions'
import { applyMaterialChange } from '@/lib/pipeline/proxy-material-change'

export const CONFIDENCE_FACTOR_KEYS = [
  'c1SourceQualityVerifiability',
  'c2OutcomeCorrespondence',
  'c3StakeholderPopulationFit',
  'c4GeographicContextFit',
  'c5TemporalFit',
  'c6MethodologicalUnitComparability',
] as const

export const RISK_FACTOR_KEYS = [
  'r1ProvenanceRisk',
  'r2SourceLimitationRisk',
  'r3ConceptualFitRisk',
  'r4GeographicPopulationTransferRisk',
  'r5TemporalObsolescenceRisk',
  'r6TransformationRisk',
  'r7MethodologicalUncertaintyRisk',
] as const

export type RubricFactors = Record<(typeof CONFIDENCE_FACTOR_KEYS)[number] | (typeof RISK_FACTOR_KEYS)[number], number>

export interface RubricClassification {
  confidenceScore: number
  confidenceLevel: 'high' | 'medium' | 'low'
  methodologicalRiskScore: number
  methodologicalRisk: 'low' | 'medium' | 'high'
  /** FIBC-011 FC: a resulting `low` confidence or `high` risk requires a
   * single explicit human exceptional-defendibility determination
   * addressing both when both apply. */
  requiresExceptionalDetermination: boolean
}

const FACTOR_RANGE = [0, 1, 2, 3] as const

/**
 * FIBIU-09's own EXIT_GATE: "thirteen factors with exact ceilings/floors,
 * reproducible derivation." Pure and deterministic — same input always
 * yields the same output, the reproducibility the EXIT_GATE names.
 *
 * Confidence: confidence_score = round(100*Σ(C1..C6)/18); base high>=80,
 * medium>=60, low<60. Ceilings (push DOWN only, never up): any C=0 caps at
 * medium; C1=0 OR C2=0 forces low (stronger, checked first).
 *
 * Risk: methodological_risk_score = round(100*Σ(R1..R7)/21); base low<25,
 * medium>=25, high>=50. Floors (push UP only, never down): any R>=2 raises
 * to at least medium; any R=3 raises to high (stronger, checked first).
 */
export function deriveRubricClassification(factors: RubricFactors): RubricClassification {
  const c = CONFIDENCE_FACTOR_KEYS.map((k) => factors[k])
  const r = RISK_FACTOR_KEYS.map((k) => factors[k])

  for (const [key, value] of [...CONFIDENCE_FACTOR_KEYS.map((k, i) => [k, c[i]] as const), ...RISK_FACTOR_KEYS.map((k, i) => [k, r[i]] as const)]) {
    if (value === null || value === undefined) {
      throw new Error(`Cannot derive rubric classification: factor ${key} is unrated`)
    }
    if (!(FACTOR_RANGE as readonly number[]).includes(value)) {
      throw new Error(`Cannot derive rubric classification: factor ${key} must be 0, 1, 2, or 3`)
    }
  }

  const confidenceScore = Math.round((100 * c.reduce((a, b) => a + b, 0)) / 18)
  let confidenceLevel: RubricClassification['confidenceLevel'] =
    confidenceScore >= 80 ? 'high' : confidenceScore >= 60 ? 'medium' : 'low'
  const [c1, c2] = c
  if (c1 === 0 || c2 === 0) {
    confidenceLevel = 'low'
  } else if (c.some((v) => v === 0) && confidenceLevel === 'high') {
    confidenceLevel = 'medium'
  }

  const methodologicalRiskScore = Math.round((100 * r.reduce((a, b) => a + b, 0)) / 21)
  let methodologicalRisk: RubricClassification['methodologicalRisk'] =
    methodologicalRiskScore >= 50 ? 'high' : methodologicalRiskScore >= 25 ? 'medium' : 'low'
  if (r.some((v) => v === 3)) {
    methodologicalRisk = 'high'
  } else if (r.some((v) => v >= 2) && methodologicalRisk === 'low') {
    methodologicalRisk = 'medium'
  }

  return {
    confidenceScore,
    confidenceLevel,
    methodologicalRiskScore,
    methodologicalRisk,
    requiresExceptionalDetermination: confidenceLevel === 'low' || methodologicalRisk === 'high',
  }
}

const RubricEvaluationInput = z.object({
  c1SourceQualityVerifiability: z.number().int().min(0).max(3),
  c2OutcomeCorrespondence: z.number().int().min(0).max(3),
  c3StakeholderPopulationFit: z.number().int().min(0).max(3),
  c4GeographicContextFit: z.number().int().min(0).max(3),
  c5TemporalFit: z.number().int().min(0).max(3),
  c6MethodologicalUnitComparability: z.number().int().min(0).max(3),
  r1ProvenanceRisk: z.number().int().min(0).max(3),
  r2SourceLimitationRisk: z.number().int().min(0).max(3),
  r3ConceptualFitRisk: z.number().int().min(0).max(3),
  r4GeographicPopulationTransferRisk: z.number().int().min(0).max(3),
  r5TemporalObsolescenceRisk: z.number().int().min(0).max(3),
  r6TransformationRisk: z.number().int().min(0).max(3),
  r7MethodologicalUncertaintyRisk: z.number().int().min(0).max(3),
  // Rationale/references are the human-supplied half of "ratings are human
  // with rationale and references" — required, never merely a numeric
  // score with no explanation.
  rationale: z.string().min(1),
  // Required only when the derived classification demands it
  // (requiresExceptionalDetermination) — validated after derivation below,
  // not by Zod alone, since whether it's required depends on the computed
  // result.
  exceptionalDefendibilityDetermination: z.string().optional(),
})

/**
 * Record a governed human rubric evaluation for a financial proxy's CURRENT
 * version. Never creates a new version (FIBC-011 evaluates the version
 * that exists; a material change to the underlying proxy is FIBIU-10's
 * concern, which opens a new version that starts unrated again). Rejects,
 * never silently corrects, a state that would leave a derived classification
 * without its required exceptional-defendibility determination.
 */
export async function recordProxyRubricEvaluation(proxyId: string, input: unknown) {
  const { organization, user, membership } = await requireOrganizationAccess()
  if (!canEvaluateProxyRubric(membership.role)) {
    throw new Error('Insufficient permissions to evaluate proxy rubric')
  }
  const parsed = RubricEvaluationInput.parse(input)

  const factors: RubricFactors = {
    c1SourceQualityVerifiability: parsed.c1SourceQualityVerifiability,
    c2OutcomeCorrespondence: parsed.c2OutcomeCorrespondence,
    c3StakeholderPopulationFit: parsed.c3StakeholderPopulationFit,
    c4GeographicContextFit: parsed.c4GeographicContextFit,
    c5TemporalFit: parsed.c5TemporalFit,
    c6MethodologicalUnitComparability: parsed.c6MethodologicalUnitComparability,
    r1ProvenanceRisk: parsed.r1ProvenanceRisk,
    r2SourceLimitationRisk: parsed.r2SourceLimitationRisk,
    r3ConceptualFitRisk: parsed.r3ConceptualFitRisk,
    r4GeographicPopulationTransferRisk: parsed.r4GeographicPopulationTransferRisk,
    r5TemporalObsolescenceRisk: parsed.r5TemporalObsolescenceRisk,
    r6TransformationRisk: parsed.r6TransformationRisk,
    r7MethodologicalUncertaintyRisk: parsed.r7MethodologicalUncertaintyRisk,
  }
  const classification = deriveRubricClassification(factors)

  // FC (FIBC-011): a resulting low confidence or high risk requires a
  // single explicit human exceptional-defendibility determination
  // addressing both when both apply — rejected here, never silently
  // corrected or silently waived.
  if (
    classification.requiresExceptionalDetermination &&
    (!parsed.exceptionalDefendibilityDetermination || parsed.exceptionalDefendibilityDetermination.trim().length === 0)
  ) {
    throw new Error(
      'Cannot record rubric evaluation: an explicit exceptional-defendibility determination is required when confidence is low or risk is high'
    )
  }

  const rubricVersion = await getCurrentGovernedModelVersion('PROXY_DEFENDIBILITY_RUBRIC')
  if (!rubricVersion) throw new Error('No governed PROXY_DEFENDIBILITY_RUBRIC version is registered')

  const rubricPatch = {
    ...factors,
    confidenceScore: classification.confidenceScore,
    confidenceLevel: classification.confidenceLevel,
    methodologicalRiskScore: classification.methodologicalRiskScore,
    methodologicalRisk: classification.methodologicalRisk,
    rubricVersion: rubricVersion.version,
    exceptionalDefendibilityDetermination: classification.requiresExceptionalDetermination
      ? parsed.exceptionalDefendibilityDetermination
      : null,
  }

  // FIBIU-10 (FIBC-013) — rubric ratings are material category 9. A
  // re-evaluation of an ALREADY-approved version must not silently mutate
  // the version the human approved; it forks first, exactly like any other
  // material edit, in the SAME transaction that then writes the new rubric
  // — the fork-then-write pair is the atomicity "no window may exist in
  // which approved survives" actually depends on.
  const { before, updated, forked, supersededVersion } = await db.transaction(async (tx) => {
    const proxy = await tx
      .select()
      .from(financialProxies)
      .where(eq(financialProxies.id, proxyId))
      .for('update')
      .then((rows) => rows[0] ?? null)
    if (!proxy) throw new Error('Proxy not found')
    if (proxy.organizationId && proxy.organizationId !== organization.id) throw new Error('Forbidden')

    const current = await getLatestFinancialProxyVersion(proxyId, tx)
    if (!current) throw new Error('Proxy has no version to evaluate')

    const result = await applyMaterialChange(proxyId, proxy.organizationId, current, {}, user.id, tx)

    if (result.forked) {
      await tx.update(financialProxies).set({ reviewStatus: 'pending_review', updatedAt: new Date() }).where(eq(financialProxies.id, proxyId))
    }

    const updated = await updateCurrentFinancialProxyVersion(proxyId, rubricPatch, tx)
    if (!updated) throw new Error('Proxy has no version to evaluate')

    return { before: current, updated, forked: result.forked, supersededVersion: result.supersededVersion }
  })

  await logAuditAction({
    organizationId: organization.id,
    actorUserId: user.id,
    entityType: 'financial_proxy_version',
    entityId: updated.id,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_RUBRIC_EVALUATED,
    reason: parsed.rationale,
    contentModifying: true,
    beforeJson: pickRubricFields(before),
    afterJson: pickRubricFields(updated),
  })

  if (classification.requiresExceptionalDetermination) {
    await logAuditAction({
      organizationId: organization.id,
      actorUserId: user.id,
      entityType: 'financial_proxy_version',
      entityId: updated.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_EXCEPTIONAL_DETERMINATION_RECORDED,
      afterJson: { exceptionalDefendibilityDetermination: updated.exceptionalDefendibilityDetermination },
    })
  }

  if (forked && supersededVersion) {
    await logAuditAction({
      organizationId: organization.id,
      actorUserId: user.id,
      entityType: 'financial_proxy_version',
      entityId: supersededVersion.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE,
      reason: 'Material change in rubric ratings/derivations',
      beforeJson: { reviewStatus: supersededVersion.reviewStatus },
      afterJson: { supersededBy: updated.id },
    })
    await logAuditAction({
      organizationId: organization.id,
      actorUserId: user.id,
      entityType: 'financial_proxy_version',
      entityId: updated.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED,
      reason: 'Opened by material change (rubric re-evaluation)',
      afterJson: updated,
    })
  }

  return updated
}

/**
 * FIBC-011's own FC: "any unrated factor blocks approval," and a resulting
 * low-confidence-or-high-risk classification blocks approval without an
 * explicit exceptional-defendibility determination. Called alongside
 * `assertApprovableProvenance` at every approval transition site — a
 * SEPARATE, independently-failing gate, never merged into it, so a missing
 * rubric and a missing provenance reference each report their own specific
 * error rather than one masking the other.
 */
export function assertRubricApprovable(
  version: Pick<
    FinancialProxyVersion,
    (typeof CONFIDENCE_FACTOR_KEYS)[number] | (typeof RISK_FACTOR_KEYS)[number] | 'exceptionalDefendibilityDetermination'
  >
): void {
  for (const key of [...CONFIDENCE_FACTOR_KEYS, ...RISK_FACTOR_KEYS]) {
    if (version[key] === null || version[key] === undefined) {
      throw new Error('Cannot approve: proxy defendibility rubric has unrated factors')
    }
  }
  const classification = deriveRubricClassification(version as RubricFactors)
  if (
    classification.requiresExceptionalDetermination &&
    (!version.exceptionalDefendibilityDetermination || version.exceptionalDefendibilityDetermination.trim().length === 0)
  ) {
    throw new Error(
      'Cannot approve: low confidence or high methodological risk requires an explicit exceptional-defendibility determination'
    )
  }
}

function pickRubricFields(version: FinancialProxyVersion) {
  return {
    confidenceScore: version.confidenceScore,
    confidenceLevel: version.confidenceLevel,
    methodologicalRiskScore: version.methodologicalRiskScore,
    methodologicalRisk: version.methodologicalRisk,
    rubricVersion: version.rubricVersion,
  }
}
