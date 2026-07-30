import type { AdvisorPipelineStep } from '../advisor/steps'
import { buildAdvisorContextualSystemPrompt } from '../prompts/advisor-contextual-system'
import { AdvisorContextualOutputSchema } from '../schemas/advisor-contextual-output'
import { collectCanonicalSourceFieldPaths } from './canonical-source-field-paths'
import { buildAdvisorStepContext, type ContextualAdvisorStepContext } from './build-advisor-step-context'
import type { ContextualAdvisorContext } from './types'
import { validateContextualSourceFields } from './validate-contextual-source-fields'

export type ContextualAdvisorRequest = Readonly<{
  step: AdvisorPipelineStep
  contextualData: ContextualAdvisorStepContext
  serializedContext: ContextualAdvisorContext
  canonicalSourceFieldPaths: readonly string[]
  systemPrompt: string
  internalResponseSchema: typeof AdvisorContextualOutputSchema
  validateSourceFields: (output: unknown) => void
}>

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/**
 * Creates one deep-cloned, deeply frozen snapshot. `structuredClone` retains
 * undefined, null, primitive values, and array shape; JSON serialization would not.
 */
export function buildContextualAdvisorRequest(
  step: string,
  context: ContextualAdvisorContext,
): ContextualAdvisorRequest {
  const contextualData = deepFreeze(buildAdvisorStepContext(step, structuredClone(context)))
  const serializedContext = contextualData.context
  const canonicalSourceFieldPaths = deepFreeze(collectCanonicalSourceFieldPaths(serializedContext))

  return Object.freeze({
    step: contextualData.step,
    contextualData,
    serializedContext,
    canonicalSourceFieldPaths,
    systemPrompt: buildAdvisorContextualSystemPrompt(contextualData.step),
    internalResponseSchema: AdvisorContextualOutputSchema,
    validateSourceFields: (output) => validateContextualSourceFields(canonicalSourceFieldPaths, output as { findings: unknown; suggestions: unknown }),
  })
}
