import { assertAdvisorPipelineStep, type AdvisorPipelineStep, UnsupportedAdvisorPipelineStepError } from '../advisor/steps'
import type { ContextualAdvisorContext, ContextualEvidenceMetadata } from './types'

export { UnsupportedAdvisorPipelineStepError }

export interface ContextualAdvisorStepContext {
  step: AdvisorPipelineStep
  context: ContextualAdvisorContext
}

/**
 * Identity/timestamp fields present in every step's slice.
 */
export const ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS = [
  'projectId',
  'organizationId',
  'projectName',
  'projectCreatedAt',
  'lastUpdatedAt',
] as const satisfies readonly (keyof ContextualAdvisorContext)[]

/**
 * R3: explicit per-step field map. Each of the 7 advisor steps receives only
 * the slice of the contextual data relevant to that step, so its request-local
 * citation catalog cannot contain paths into unrelated data.
 */
export const ADVISOR_STEP_CONTEXT_FIELDS: Record<AdvisorPipelineStep, readonly (keyof ContextualAdvisorContext)[]> = {
  stakeholders: ['narrativeSummary', 'stakeholderCount', 'stakeholdersSnapshot', 'activitiesSummary', 'outcomesSnapshot'],
  outcomes: ['narrativeSummary', 'stakeholderCount', 'stakeholdersSnapshot', 'activitiesSummary', 'outcomesSnapshot', 'indicatorsSnapshot'],
  narrative: ['narrativeSummary', 'stakeholderCount', 'stakeholdersSnapshot', 'activitiesSummary', 'outcomesSnapshot', 'reportSections'],
  indicators: ['narrativeSummary', 'outcomesSnapshot', 'indicatorsSnapshot', 'evidenceMetadata', 'evidenceTotal'],
  evidence: ['outcomesSnapshot', 'indicatorsSnapshot', 'evidenceMetadata', 'evidenceTotal'],
  proxies: ['outcomesSnapshot', 'stakeholdersSnapshot', 'proxySummary', 'filterSetsSummary'],
  calculation: ['outcomesSnapshot', 'indicatorsSnapshot', 'proxySummary', 'filterSetsSummary', 'calculationSnapshot', 'calculationReadiness', 'evidenceTotal', 'reportSections'],
}

function evidenceMetadataOnly(evidence: ContextualEvidenceMetadata): ContextualEvidenceMetadata {
  return {
    id: evidence.id,
    title: evidence.title,
    type: evidence.type,
    status: evidence.status,
    createdAt: evidence.createdAt,
    ...(evidence.description !== undefined ? { description: evidence.description } : {}),
    // Evidence ↔ outcome/indicator linkage is metadata and is preserved.
    // Anything else (filePath, raw content, full hashes) never passes through.
    ...(evidence.outcomeId !== undefined ? { outcomeId: evidence.outcomeId } : {}),
    ...(evidence.indicatorId !== undefined ? { indicatorId: evidence.indicatorId } : {}),
    ...(evidence.relatedOutcomeTitle !== undefined ? { relatedOutcomeTitle: evidence.relatedOutcomeTitle } : {}),
    ...(evidence.relatedIndicatorName !== undefined ? { relatedIndicatorName: evidence.relatedIndicatorName } : {}),
    ...(evidence.mimeTypeGeneral !== undefined ? { mimeTypeGeneral: evidence.mimeTypeGeneral } : {}),
  }
}

/**
 * Builds a deterministic, provider-independent contextual request value.
 * It accepts already available data only and does not query, calculate, or
 * mutate. The output contains exactly the per-step slice: always-included
 * identity fields plus the step's mapped fields, in stable declaration order.
 * Fields absent (undefined) on the input stay absent — never invented.
 */
export function buildAdvisorStepContext(step: string, input: ContextualAdvisorContext): ContextualAdvisorStepContext {
  assertAdvisorPipelineStep(step)

  const context: Partial<Record<keyof ContextualAdvisorContext, unknown>> = {}
  const includedFields: readonly (keyof ContextualAdvisorContext)[] = [
    ...ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS,
    ...ADVISOR_STEP_CONTEXT_FIELDS[step],
  ]

  for (const field of includedFields) {
    const value = input[field]
    if (value === undefined) continue
    if (field === 'evidenceMetadata') {
      context[field] = (value as readonly ContextualEvidenceMetadata[]).map(evidenceMetadataOnly)
      continue
    }
    context[field] = value
  }

  return {
    step,
    context: context as ContextualAdvisorContext,
  }
}
