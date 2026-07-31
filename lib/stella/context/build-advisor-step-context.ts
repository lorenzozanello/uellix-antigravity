import { assertAdvisorPipelineStep, type AdvisorPipelineStep, UnsupportedAdvisorPipelineStepError } from '../advisor/steps'
import type { ContextualAdvisorContext, ContextualEvidenceMetadata } from './types'

export { UnsupportedAdvisorPipelineStepError }

export interface ContextualAdvisorStepContext {
  step: AdvisorPipelineStep
  context: ContextualAdvisorContext
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
 * It accepts already available data only and does not query, calculate, or mutate.
 */
export function buildAdvisorStepContext(step: string, input: ContextualAdvisorContext): ContextualAdvisorStepContext {
  assertAdvisorPipelineStep(step)

  return {
    step,
    context: {
      ...input,
      ...(input.evidenceMetadata !== undefined ? { evidenceMetadata: input.evidenceMetadata.map(evidenceMetadataOnly) } : {}),
    },
  }
}
