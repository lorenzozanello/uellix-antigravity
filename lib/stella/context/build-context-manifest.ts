// lib/stella/context/build-context-manifest.ts
// Etapa A1 (STL-A1-004) — structural, auditable manifest of what was consulted
// to build a Stella prompt. Replaces "store the raw payload" (explicitly
// rejected — see STELLA_DECISION_REGISTER.md#DR-006) with something safe by
// construction to persist.
//
// SAFETY INVARIANT, load-bearing: every `fieldsIncluded` / `sensitiveFieldsExcluded`
// entry below is a STRING LITERAL written by hand in this file — never a value
// read from the context object at runtime. That is what makes it structurally
// impossible for this manifest to leak actual field content (narrative text,
// titles, etc.), even if a future edit to StellaProjectContext added a
// sensitive field: the manifest would need a matching hand-written literal
// added here before it could ever appear, which is a visible, reviewable diff.
//
// This module reuses `buildContextHash` (unchanged) rather than recomputing a
// hash, so the manifest's hash always matches the existing `context_hash`
// column.

import { CONTEXT_SCHEMA_VERSION } from './schema-version'
import { buildContextHash } from './build-context-hash'
import { collectContextStrings } from './context-guardrails'
import { detectCommonPii } from './pii-detection'
import { assessSensitiveData } from './sensitive-population'
import type { StellaRole } from '../adapter/types'
import type { StellaProjectContext } from './types'

export type StellaManifestEntityType =
  | 'project'
  | 'outcome'
  | 'indicator'
  | 'evidence'
  | 'proxy'
  | 'filter_set'
  | 'calculation_run'
  | 'report_section'

export interface StellaContextManifestEntity {
  type: StellaManifestEntityType
  id: string
  /** Field NAMES only — never values. See the safety invariant above. */
  fieldsIncluded: string[]
  /** Documents what a naive implementation might have sent but this one deliberately omits. */
  sensitiveFieldsExcluded?: string[]
}

export interface StellaContextManifest {
  role: StellaRole
  projectId: string
  organizationId: string
  contextSchemaVersion: number
  entities: StellaContextManifestEntity[]
  counts: Record<string, number>
  /** Fixed vocabulary only — never free text. */
  sensitivityFlags: string[]
  contextHash: string
  generatedAt: string
}

/** Fixed vocabulary for `sensitivityFlags` — do not put free text in this array. */
const SENSITIVITY_FLAG = {
  narrativeTextPresent: 'narrative_text_present',
  stakeholderCountPresent: 'stakeholder_count_present',
  // Etapa A2 (STL-A2-008, DR-001): common-tier PII is flagged, never
  // blocked, and only the category name is recorded — never the matched
  // value. High-risk PII never reaches this point: it is blocked earlier by
  // assertContextHasNoForbiddenData (context-guardrails.ts).
  possiblePiiEmail: 'possible_pii_email',
  possiblePiiPhone: 'possible_pii_phone',
  possiblePiiGenericId: 'possible_pii_generic_id',
  possiblePiiAddress: 'possible_pii_address',
  // Etapa A2.3 (STL-A23-008, DR-002/DR-003): by the time buildContextManifest
  // runs, assertContextHasNoForbiddenData has already thrown for any BLOCKED
  // sensitive-population content — so this flag can only ever appear for the
  // ALLOWED, aggregate-with-verified-group-size case. It records that fact
  // for audit visibility, never the matched text or the group size itself.
  sensitivePopulationAggregatePresent: 'sensitive_population_aggregate_present',
} as const

const COMMON_PII_FLAG_BY_CATEGORY: Record<string, string> = {
  email: SENSITIVITY_FLAG.possiblePiiEmail,
  phone: SENSITIVITY_FLAG.possiblePiiPhone,
  genericId: SENSITIVITY_FLAG.possiblePiiGenericId,
  preciseAddress: SENSITIVITY_FLAG.possiblePiiAddress,
}

export function buildContextManifest(
  context: StellaProjectContext,
  role: StellaRole,
): StellaContextManifest {
  const entities: StellaContextManifestEntity[] = []

  entities.push({
    type: 'project',
    id: context.projectId,
    fieldsIncluded: ['projectId', 'organizationId', 'projectCreatedAt', 'lastUpdatedAt', 'narrativeSummary'],
  })

  for (const o of context.outcomesSnapshot) {
    entities.push({ type: 'outcome', id: o.id, fieldsIncluded: ['name', 'description'] })
  }

  for (const i of context.indicatorsSnapshot) {
    entities.push({ type: 'indicator', id: i.id, fieldsIncluded: ['name', 'unit', 'outcomeId'] })
  }

  for (const e of context.evidenceMetadata) {
    entities.push({
      type: 'evidence',
      id: e.id,
      fieldsIncluded: ['title', 'type', 'status', 'contentHashTruncated', 'createdAt'],
      sensitiveFieldsExcluded: ['filePath', 'fullContentHash', 'rawFileContent'],
    })
  }

  for (const p of context.proxySummary) {
    entities.push({
      type: 'proxy',
      id: p.id,
      fieldsIncluded: ['name', 'source', 'confidenceLevel', 'methodologicalRisk'],
      sensitiveFieldsExcluded: ['value', 'currency'],
    })
  }

  for (const f of context.filterSetsSummary) {
    entities.push({
      type: 'filter_set',
      id: f.assignmentId,
      fieldsIncluded: ['deadweightPct', 'attributionPct', 'displacementPct', 'dropoffPct', 'durationYears'],
    })
  }

  if (context.calculationSnapshot) {
    entities.push({
      type: 'calculation_run',
      id: `run-v${context.calculationSnapshot.version}`,
      fieldsIncluded: ['totalInvestment', 'grossSocialValue', 'netSocialValue', 'sroiRatio', 'currency', 'lineItemCount', 'version'],
      sensitiveFieldsExcluded: ['snapshotJson (full)'],
    })
  }

  for (const s of context.reportSections) {
    entities.push({ type: 'report_section', id: s.id, fieldsIncluded: ['sectionType', 'title', 'contentLength', 'status'] })
  }

  const sensitivityFlags: string[] = []
  if (context.narrativeSummary.trim().length > 0) sensitivityFlags.push(SENSITIVITY_FLAG.narrativeTextPresent)
  if (context.stakeholderCount > 0) sensitivityFlags.push(SENSITIVITY_FLAG.stakeholderCountPresent)

  const commonPiiCategoriesFound = new Set<string>()
  for (const value of collectContextStrings(context)) {
    for (const match of detectCommonPii(value)) commonPiiCategoriesFound.add(match.category)
  }
  for (const category of commonPiiCategoriesFound) {
    const flag = COMMON_PII_FLAG_BY_CATEGORY[category]
    if (flag) sensitivityFlags.push(flag)
  }

  const hasAllowedSensitivePopulationData = collectContextStrings(context).some(
    (value) => assessSensitiveData(value).category !== 'none',
  )
  if (hasAllowedSensitivePopulationData) {
    sensitivityFlags.push(SENSITIVITY_FLAG.sensitivePopulationAggregatePresent)
  }

  return {
    role,
    projectId: context.projectId,
    organizationId: context.organizationId,
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    entities,
    counts: {
      outcomes: context.outcomesSnapshot.length,
      indicators: context.indicatorsSnapshot.length,
      evidence: context.evidenceMetadata.length,
      proxies: context.proxySummary.length,
      filterSets: context.filterSetsSummary.length,
      reportSections: context.reportSections.length,
    },
    sensitivityFlags,
    contextHash: buildContextHash(context),
    generatedAt: new Date().toISOString(),
  }
}
