// lib/pipeline/proxy-material-change.ts
// FIBIU-10 — PROXY_MATERIAL_CHANGE_POLICY_v1.0.0 + PROXY_MATERIAL_FIELDS_v1.0.0
// (FIBC-013/FIBDB-007). The ONE place "a material change atomically
// preserves the approved version and opens a new draft version" is
// implemented — imported by every write path that can materially change an
// APPROVED proxy version (lib/pipeline/proxies.ts's
// updateOrganizationFinancialProxy; lib/pipeline/financial-proxy-rubric.ts's
// recordProxyRubricEvaluation; lib/admin/proxies.ts's manual-FX transition)
// so the EXIT_GATE's guarantee — "no window may exist in which approved
// survives a material change" — holds universally across every category,
// not just the fields any one caller happens to edit.
//
// W2-B2-R1 / R-B2-03 (closes M4 and AG-B2-3-DERIVED): the registry below is
// EXHAUSTIVE over every persisted column of financial_proxies and
// financial_proxy_versions (70 as measured at the audited HEAD) and carries
// the orthogonal EDITABILITY dimension. It is the service-layer mirror of
// registry_version 1.1.0 seeded by db/migrations/0056; a committed test
// reflects over the Drizzle table definitions and asserts set equality with
// this list AND with the seed, in both directions.

import {
  createFinancialProxyVersion,
  toVersionReviewStatus,
  type FinancialProxyVersion,
  type FinancialProxyVersionExecutor,
  type CreateFinancialProxyVersionInput,
} from '@/lib/pipeline/financial-proxy-versions'

// FIBC-013's ten mandatory material categories, plus the registry's own
// eleventh bucket for fields that are deliberately NOT material
// (typographical/format/visual/ordering/internal-administrative). The ten
// sealed categories are NOT extended by the editability dimension.
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
export type RegistryCategory = MaterialCategory | typeof NON_MATERIAL

/**
 * AG-B2-3-DERIVED — ORTHOGONAL_EDITABILITY_DIMENSION.
 *  user_editable  : a human supplies it through a governed form; ONLY these
 *                   may appear in any patch schema.
 *  system_derived : persisted, computed by the server from other fields.
 *  system_sealed  : never user-supplied and never patchable — governance
 *                   transition, lineage and audit metadata.
 */
export const EDITABILITIES = ['user_editable', 'system_derived', 'system_sealed'] as const
export type Editability = (typeof EDITABILITIES)[number]

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

export interface RegistryRow {
  readonly tableName: 'financial_proxies' | 'financial_proxy_versions'
  readonly fieldName: string
  readonly category: RegistryCategory
  readonly editability: Editability
}

export const PROXY_MATERIAL_FIELDS_REGISTRY_VERSION = '1.1.0'

const R = (tableName: RegistryRow['tableName']) =>
  (fieldName: string, category: RegistryCategory, editability: Editability): RegistryRow =>
    ({ tableName, fieldName, category, editability })
const live = R('financial_proxies')
const ver = R('financial_proxy_versions')

/**
 * registry_version 1.1.0 — every persisted column of both tables, exactly
 * once. Ordered table-by-table in schema order so a reviewer can diff it
 * against db/schema.ts by eye. Adjudicated omissions from
 * material_registry_exhaustiveness_disposition: value_usd is
 * identity_economic_value/system_derived; fx_rate_id is transformations/
 * system_derived (FIBC-010 lists FX among transformations); review_status,
 * reviewer_id, reviewed_at are non_material/system_sealed (material would
 * make an approval fork the version it approves); structural and lineage
 * columns are system_sealed; the live mirrors of version-material fields
 * take the SAME category as their version counterparts.
 */
export const PROXY_MATERIAL_FIELDS_REGISTRY: readonly RegistryRow[] = [
  // financial_proxies (24)
  live('id', NON_MATERIAL, 'system_sealed'),
  live('organization_id', NON_MATERIAL, 'system_sealed'),
  live('source_id', 'source_provenance', 'user_editable'),
  live('name', NON_MATERIAL, 'user_editable'),
  live('description', NON_MATERIAL, 'user_editable'),
  live('proxy_type', 'identity_economic_value', 'user_editable'),
  live('country', 'geographic_institutional_context', 'user_editable'),
  live('territory', 'geographic_institutional_context', 'user_editable'),
  live('currency', 'identity_economic_value', 'user_editable'),
  live('value', 'identity_economic_value', 'user_editable'),
  live('value_usd', 'identity_economic_value', 'system_derived'),
  live('fx_rate_id', 'transformations', 'system_derived'),
  live('unit', 'identity_economic_value', 'user_editable'),
  live('reference_year', 'identity_economic_value', 'user_editable'),
  live('thematic_area', 'outcome_stakeholder_correspondence', 'user_editable'),
  live('methodology', 'methodology_comparability', 'user_editable'),
  live('confidence_level', 'rubric_ratings_derivations', 'user_editable'),
  live('methodological_risk', 'rubric_ratings_derivations', 'user_editable'),
  live('review_status', NON_MATERIAL, 'system_sealed'),
  live('reviewer_id', NON_MATERIAL, 'system_sealed'),
  live('reviewed_at', NON_MATERIAL, 'system_sealed'),
  live('created_by', NON_MATERIAL, 'system_sealed'),
  live('created_at', NON_MATERIAL, 'system_sealed'),
  live('updated_at', NON_MATERIAL, 'system_sealed'),
  // financial_proxy_versions (46)
  ver('id', NON_MATERIAL, 'system_sealed'),
  ver('organization_id', NON_MATERIAL, 'system_sealed'),
  ver('financial_proxy_id', NON_MATERIAL, 'system_sealed'),
  ver('ordinal', NON_MATERIAL, 'system_sealed'),
  ver('source_id', 'source_provenance', 'user_editable'),
  ver('value', 'identity_economic_value', 'user_editable'),
  ver('currency', 'identity_economic_value', 'user_editable'),
  ver('unit', 'identity_economic_value', 'user_editable'),
  ver('reference_year', 'identity_economic_value', 'user_editable'),
  ver('value_usd', 'identity_economic_value', 'system_derived'),
  ver('fx_rate_id', 'transformations', 'system_derived'),
  ver('country', 'geographic_institutional_context', 'user_editable'),
  ver('territory', 'geographic_institutional_context', 'user_editable'),
  ver('thematic_area', 'outcome_stakeholder_correspondence', 'user_editable'),
  ver('methodology', 'methodology_comparability', 'user_editable'),
  ver('geographic_contextual_scope', 'geographic_institutional_context', 'user_editable'),
  ver('linked_outcome_context', 'outcome_stakeholder_correspondence', 'user_editable'),
  ver('recoverable_reference', 'source_provenance', 'user_editable'),
  ver('relevance_justification', 'provenance_rationale', 'user_editable'),
  ver('documented_transformations', 'transformations', 'user_editable'),
  ver('consultation_date', 'temporal_context', 'user_editable'),
  ver('c1_source_quality_verifiability', 'rubric_ratings_derivations', 'user_editable'),
  ver('c2_outcome_correspondence', 'rubric_ratings_derivations', 'user_editable'),
  ver('c3_stakeholder_population_fit', 'rubric_ratings_derivations', 'user_editable'),
  ver('c4_geographic_context_fit', 'rubric_ratings_derivations', 'user_editable'),
  ver('c5_temporal_fit', 'rubric_ratings_derivations', 'user_editable'),
  ver('c6_methodological_unit_comparability', 'rubric_ratings_derivations', 'user_editable'),
  ver('r1_provenance_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('r2_source_limitation_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('r3_conceptual_fit_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('r4_geographic_population_transfer_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('r5_temporal_obsolescence_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('r6_transformation_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('r7_methodological_uncertainty_risk', 'rubric_ratings_derivations', 'user_editable'),
  ver('confidence_score', 'rubric_ratings_derivations', 'system_derived'),
  ver('confidence_level', 'rubric_ratings_derivations', 'system_derived'),
  ver('methodological_risk_score', 'rubric_ratings_derivations', 'system_derived'),
  ver('methodological_risk', 'rubric_ratings_derivations', 'system_derived'),
  ver('rubric_version', 'rubric_ratings_derivations', 'system_derived'),
  ver('exceptional_defendibility_determination', 'exceptional_defendibility_determination', 'user_editable'),
  ver('review_status', NON_MATERIAL, 'system_sealed'),
  ver('reviewer_id', NON_MATERIAL, 'system_sealed'),
  ver('reviewed_at', NON_MATERIAL, 'system_sealed'),
  ver('supersedes_version_id', NON_MATERIAL, 'system_sealed'),
  ver('created_by', NON_MATERIAL, 'system_sealed'),
  ver('created_at', NON_MATERIAL, 'system_sealed'),
]

/** Look up one registry row; null when the column is not registered (the reflective test makes that impossible for real columns). */
export function registryRow(tableName: RegistryRow['tableName'], fieldName: string): RegistryRow | null {
  return PROXY_MATERIAL_FIELDS_REGISTRY.find((r) => r.tableName === tableName && r.fieldName === fieldName) ?? null
}

/**
 * The keys FinancialProxyInput (lib/pipeline/proxies.ts) can carry, mapped to
 * the row that AUTHORITATIVELY persists each (editorial_noop_patch_disposition
 * comparison_target): version-mirrored fields live on the CURRENT
 * financial_proxy_versions row; live-only fields on financial_proxies.
 */
export const INPUT_KEY_TO_PERSISTED_FIELD: Readonly<Record<string, { table: RegistryRow['tableName']; column: string }>> = {
  name: { table: 'financial_proxies', column: 'name' },
  description: { table: 'financial_proxies', column: 'description' },
  proxyType: { table: 'financial_proxies', column: 'proxy_type' },
  confidenceLevel: { table: 'financial_proxies', column: 'confidence_level' },
  methodologicalRisk: { table: 'financial_proxies', column: 'methodological_risk' },
  sourceId: { table: 'financial_proxy_versions', column: 'source_id' },
  value: { table: 'financial_proxy_versions', column: 'value' },
  currency: { table: 'financial_proxy_versions', column: 'currency' },
  unit: { table: 'financial_proxy_versions', column: 'unit' },
  referenceYear: { table: 'financial_proxy_versions', column: 'reference_year' },
  country: { table: 'financial_proxy_versions', column: 'country' },
  territory: { table: 'financial_proxy_versions', column: 'territory' },
  thematicArea: { table: 'financial_proxy_versions', column: 'thematic_area' },
  methodology: { table: 'financial_proxy_versions', column: 'methodology' },
  geographicContextualScope: { table: 'financial_proxy_versions', column: 'geographic_contextual_scope' },
  linkedOutcomeContext: { table: 'financial_proxy_versions', column: 'linked_outcome_context' },
  recoverableReference: { table: 'financial_proxy_versions', column: 'recoverable_reference' },
  relevanceJustification: { table: 'financial_proxy_versions', column: 'relevance_justification' },
  documentedTransformations: { table: 'financial_proxy_versions', column: 'documented_transformations' },
  consultationDate: { table: 'financial_proxy_versions', column: 'consultation_date' },
}

/** Derived, never hand-maintained: input key -> category, from the registry. */
export const MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY: Readonly<Record<string, RegistryCategory>> = Object.fromEntries(
  Object.entries(INPUT_KEY_TO_PERSISTED_FIELD).map(([key, ref]) => {
    const row = registryRow(ref.table, ref.column)
    if (!row) throw new Error(`INPUT_KEY_TO_PERSISTED_FIELD names an unregistered column ${ref.table}.${ref.column}`)
    return [key, row.category]
  })
)

/**
 * FIBC-013 fail-closed rules, both preserved unchanged:
 *  - an UNCLASSIFIED key is an error, never a silent non-material default
 *    ("ambiguous => material" governs WHICH category, and unclassified is
 *    not the same as non-material);
 *  - R-B2-03 (AG-B2-3-DERIVED rejection_rule): a key whose persisted column is
 *    not user_editable is REJECTED by name — never silently dropped — so an
 *    approval-metadata write attempt can never pass unnoticed.
 */
export function classifyMaterialField(inputKey: string): RegistryCategory {
  const ref = INPUT_KEY_TO_PERSISTED_FIELD[inputKey]
  if (!ref) {
    throw new Error(
      `Unclassified proxy field "${inputKey}": every field must be classified in the material-field registry before it can be edited (FIBC-013 — ambiguous ⇒ material; unclassified is not the same as non-material).`
    )
  }
  const row = registryRow(ref.table, ref.column)
  if (!row) throw new Error(`Unregistered persisted column ${ref.table}.${ref.column} for input key "${inputKey}"`)
  if (row.editability !== 'user_editable') {
    throw new Error(
      `Field "${inputKey}" (${ref.table}.${ref.column}) is ${row.editability} and cannot be patched (FIBC-013 — audit/approval metadata are never editable).`
    )
  }
  return row.category
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * Every registered column that is NOT user_editable, keyed by the camelCase
 * name a payload would use for it — derived from the registry, never
 * hand-kept.
 */
export const PATCH_REJECTED_INPUT_KEYS: Readonly<Record<string, RegistryRow>> = (() => {
  const out: Record<string, RegistryRow> = {}
  for (const r of PROXY_MATERIAL_FIELDS_REGISTRY) {
    if (r.editability === 'user_editable') continue
    // Both tables register some columns (organization_id, review_status, ...);
    // the patch targets the proxy entity, so the first — live-table — row names it.
    const key = camel(r.fieldName)
    if (!(key in out)) out[key] = r
  }
  return out
})()

/**
 * R-B2-06 / AG-B2-3-DERIVED rejection_rule — a patch that NAMES a field whose
 * editability is not user_editable MUST be rejected with a named error, never
 * silently dropped (which is what schema stripping would otherwise do). A
 * key that is neither a known input key nor a registered non-editable column
 * is unclassified and fails closed too.
 */
export function assertPatchKeysEditable(rawKeys: readonly string[]): void {
  for (const key of rawKeys) {
    if (INPUT_KEY_TO_PERSISTED_FIELD[key]) continue
    const sealed = PATCH_REJECTED_INPUT_KEYS[key]
    if (sealed) {
      throw new Error(
        `Field "${key}" (${sealed.tableName}.${sealed.fieldName}) is ${sealed.editability} and cannot be patched (FIBC-013 — audit/approval metadata are never editable).`
      )
    }
    throw new Error(
      `Unclassified proxy field "${key}": every field must be classified in the material-field registry before it can be edited (FIBC-013 — ambiguous ⇒ material; unclassified is not the same as non-material).`
    )
  }
}

/**
 * Given the keys that ACTUALLY CHANGED (R-B2-06: semantic change, not key
 * presence — the caller decides that), returns the material categories they
 * touch (empty when every changed key is non-material).
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
 *
 * `versionPatch.valueUsd` / `fxRateId` are honoured ONLY when supplied (the
 * governed manual-FX transition, R-B2-04, computes the successor's monetary
 * state itself); otherwise both are nulled on the fork because a stale
 * value_usd must never outlive the parameters that produced it.
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
      // year/parameters that produced it. Never carried forward on a fork;
      // only a governed transformation that computed the successor's own
      // monetary state may supply it.
      valueUsd: versionPatch.valueUsd ?? null,
      fxRateId: versionPatch.fxRateId ?? null,
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
