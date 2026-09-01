// lib/pipeline/proxy-material-change.ts
// FIBIU-10 — PROXY_MATERIAL_CHANGE_POLICY_v1.0.0 + PROXY_MATERIAL_FIELDS_v1.0.0
// (FIBC-013/FIBDB-007). The ONE place "a material change atomically
// preserves the approved version and opens a new draft version" is
// implemented — imported by every write path that can materially change an
// APPROVED proxy version (lib/pipeline/proxies.ts's
// updateOrganizationFinancialProxy; lib/pipeline/financial-proxy-rubric.ts's
// recordProxyRubricEvaluation) so the EXIT_GATE's guarantee — "no window
// may exist in which approved survives a material change" — holds
// universally across every category, not just the fields any one caller
// happens to edit.

import {
  createFinancialProxyVersion,
  toVersionReviewStatus,
  type FinancialProxyVersion,
  type FinancialProxyVersionExecutor,
  type CreateFinancialProxyVersionInput,
} from '@/lib/pipeline/financial-proxy-versions'

// FIBC-013's ten mandatory material categories, plus the registry's own
// eleventh bucket for fields that are deliberately NOT material
// (typographical/format/visual/ordering/internal-administrative). A field
// missing from MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY (below) is never
// silently treated as non-material — see assertFieldClassified.
export const MATERIAL_CATEGORIES = [
  'identity_economic_value',
  'source_provenance',
  'outcome_stakeholder_correspondence',
  'geographic_institutional_context',
  'temporal_context',
  'methodology_comparability',
  'transformations',
  'provenance_rationale',
  'rubric_ratings_derivations',
  'exceptional_defendibility_determination',
] as const
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number]
export const NON_MATERIAL = 'non_material' as const

export const MATERIAL_CATEGORY_LABELS: Record<MaterialCategory, string> = {
  identity_economic_value: 'Identidad / valor económico',
  source_provenance: 'Fuente y procedencia',
  outcome_stakeholder_correspondence: 'Correspondencia con el resultado y los stakeholders',
  geographic_institutional_context: 'Contexto geográfico e institucional',
  temporal_context: 'Contexto temporal',
  methodology_comparability: 'Metodología y comparabilidad',
  transformations: 'Transformaciones documentadas',
  provenance_rationale: 'Justificación de procedencia',
  rubric_ratings_derivations: 'Calificaciones y derivaciones de la rúbrica',
  exceptional_defendibility_determination: 'Determinación excepcional de defendibilidad',
}

// FIBDB-007's field->category map for the fields editable through
// updateOrganizationFinancialProxy's FinancialProxyInput (the sealed unit's
// own FILES_OR_DOMAINS: lib/pipeline/proxies.ts). Ambiguous fields resolve
// to a real category (fail-closed => material), never left unclassified;
// `name`/`description` are the two fields deliberately classified
// non-material — pure display labels with no methodological content. This
// map is the SERVICE-LAYER mirror of the DB-seeded
// proxy_material_fields_registry rows (0055 migration) — kept in sync by
// hand since the registry is versioned/immutable reference data, not a
// runtime lookup on the hot path.
export const MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY: Record<string, MaterialCategory | typeof NON_MATERIAL> = {
  name: NON_MATERIAL,
  description: NON_MATERIAL,
  sourceId: 'source_provenance',
  proxyType: 'identity_economic_value',
  value: 'identity_economic_value',
  currency: 'identity_economic_value',
  unit: 'identity_economic_value',
  referenceYear: 'identity_economic_value',
  country: 'geographic_institutional_context',
  territory: 'geographic_institutional_context',
  geographicContextualScope: 'geographic_institutional_context',
  thematicArea: 'outcome_stakeholder_correspondence',
  linkedOutcomeContext: 'outcome_stakeholder_correspondence',
  consultationDate: 'temporal_context',
  methodology: 'methodology_comparability',
  documentedTransformations: 'transformations',
  relevanceJustification: 'provenance_rationale',
  recoverableReference: 'source_provenance',
  confidenceLevel: 'rubric_ratings_derivations',
  methodologicalRisk: 'rubric_ratings_derivations',
}

/** Every input key present in FinancialProxyInput must resolve to a real category — an omission is a bug, not a silent non-material default. */
export function classifyMaterialField(inputKey: string): MaterialCategory | typeof NON_MATERIAL {
  const category = MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY[inputKey]
  if (!category) {
    throw new Error(
      `Unclassified proxy field "${inputKey}": every field must be classified in MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY before it can be edited (FIBC-013 — ambiguous ⇒ material; unclassified is not the same as non-material).`
    )
  }
  return category
}

/**
 * Given a set of changed FinancialProxyInput keys, returns the material
 * categories they touch (empty when every changed key is non-material).
 */
export function materialCategoriesTouched(changedKeys: readonly string[]): MaterialCategory[] {
  const categories = new Set<MaterialCategory>()
  for (const key of changedKeys) {
    const category = classifyMaterialField(key)
    if (category !== NON_MATERIAL) categories.add(category)
  }
  return [...categories]
}

export interface MaterialChangeResult {
  /** The version now current for subsequent writes/reads within this transaction. */
  version: FinancialProxyVersion
  /** True when a NEW version was opened (the prior one was approved and is now sealed, untouched). */
  forked: boolean
  /** The version that was superseded, only when forked === true. */
  supersededVersion: FinancialProxyVersion | null
}

/**
 * FIBC-013's core atomic operation. If `currentVersion.reviewStatus` is
 * `approved`, that version is NEVER written to — a new version (ordinal+1,
 * supersedesVersionId = currentVersion.id) is opened instead, seeded from
 * the current version's full field set with `versionPatch` layered on top,
 * and inheriting NEITHER approval, reviewer, timestamp, rubric ratings, nor
 * the exceptional determination (all start unrated/null on the fork —
 * createFinancialProxyVersion defaults every omitted field to null).
 *
 * If `currentVersion` is NOT approved, no fork happens — there is no
 * approval to protect, so the caller edits that same version in place via
 * its own updateCurrentFinancialProxyVersion call; `forked: false` signals
 * this.
 *
 * MUST be called with `executor` bound to the SAME transaction the caller
 * uses for the rest of the material change (the live financial_proxies row
 * update, the valueUsd/fxRateId null-out) — this is what makes "no window
 * may exist in which approved survives" true: the seal-old/open-new/update-
 * live-row triad commits as one unit or not at all.
 */
export async function applyMaterialChange(
  financialProxyId: string,
  organizationId: string | null,
  currentVersion: FinancialProxyVersion,
  versionPatch: Partial<CreateFinancialProxyVersionInput>,
  actorId: string,
  executor: FinancialProxyVersionExecutor,
): Promise<MaterialChangeResult> {
  if (currentVersion.reviewStatus !== 'approved') {
    return { version: currentVersion, forked: false, supersededVersion: null }
  }

  const forked = await createFinancialProxyVersion(
    {
      organizationId,
      financialProxyId,
      sourceId: versionPatch.sourceId ?? currentVersion.sourceId,
      value: versionPatch.value ?? currentVersion.value,
      currency: versionPatch.currency ?? currentVersion.currency,
      unit: versionPatch.unit ?? currentVersion.unit,
      referenceYear: versionPatch.referenceYear ?? currentVersion.referenceYear,
      // FIBC-013 — a stale value_usd must never outlive the value/currency/
      // year/parameters that produced it. Never carried forward on a fork.
      valueUsd: null,
      fxRateId: null,
      country: versionPatch.country ?? currentVersion.country,
      territory: versionPatch.territory ?? currentVersion.territory,
      thematicArea: versionPatch.thematicArea ?? currentVersion.thematicArea,
      methodology: versionPatch.methodology ?? currentVersion.methodology,
      geographicContextualScope: versionPatch.geographicContextualScope ?? currentVersion.geographicContextualScope,
      linkedOutcomeContext: versionPatch.linkedOutcomeContext ?? currentVersion.linkedOutcomeContext,
      recoverableReference: versionPatch.recoverableReference ?? currentVersion.recoverableReference,
      relevanceJustification: versionPatch.relevanceJustification ?? currentVersion.relevanceJustification,
      documentedTransformations: versionPatch.documentedTransformations ?? currentVersion.documentedTransformations,
      consultationDate: versionPatch.consultationDate ?? currentVersion.consultationDate,
      // R-B2-01 (LIVE_VERSION_STATUS_COUPLING consequence_for_fork) — every
      // fork site sets the live row back into the review queue
      // ('pending_review'), so the successor opens as that token's image,
      // 'under_review'. FIBC-013/FIBIU-10 permit either 'draft' or
      // 'under_review'; 'under_review' is the one the coupling invariant
      // admits, derived through the mapping, never a literal.
      reviewStatus: toVersionReviewStatus('pending_review'),
      createdBy: actorId,
    },
    executor,
  )

  return { version: forked, forked: true, supersededVersion: currentVersion }
}
