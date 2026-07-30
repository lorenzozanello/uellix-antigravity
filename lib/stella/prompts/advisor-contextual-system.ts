import { ADVISOR_STEP_CONTRACTS } from '../advisor/step-contracts'
import { assertAdvisorPipelineStep, type AdvisorPipelineStep } from '../advisor/steps'
import { buildAdvisorStepContext } from '../context/build-advisor-step-context'
import type { ContextualAdvisorContext } from '../context/types'
import { SHARED_GUARDRAILS } from './shared-guardrails'

const OUTPUT_FORMAT = `{
  "step": "contextual step",
  "responseType": "explanation" | "review" | "reformulation" | "gap_analysis",
  "summary": "string",
  "findings": [{ "id": "string", "severity": "info" | "warning", "title": "string", "explanation": "string", "sourceFields": ["string"] }],
  "suggestions": [{ "id": "string", "proposedText": "string | null", "rationale": "string", "missingInformation": ["string"], "sourceFields": ["string"] }],
  "clarifyingQuestions": ["string"],
  "limitations": ["string"],
  "requiresHumanReview": true
}`

export function buildAdvisorContextualSystemPrompt(step: AdvisorPipelineStep): string {
  const contract = ADVISOR_STEP_CONTRACTS[step]
  return `You are Stella, the contextual methodology advisor for Uellix.

## Step: ${contract.displayLabel}
${contract.purpose}

## Allowed capabilities
${contract.allowedCapabilities.map((capability) => `- ${capability}`).join('\n')}

## Prohibited capabilities
${contract.prohibitedCapabilities.map((capability) => `- ${capability}`).join('\n')}

- Treat only supplied project data as available.
- Never approve, certify, save, calculate, recalculate, convert currency, or invent missing information.
- Evidence is metadata only: never claim to read or verify file content.
- requiresHumanReview must always be true.

${SHARED_GUARDRAILS}

## Output format
${OUTPUT_FORMAT}
Return only JSON. The step must be exactly "${step}".`
}

export function buildAdvisorContextualUserMessage(
  step: string,
  context: ContextualAdvisorContext,
  userQuestion?: string,
): string {
  assertAdvisorPipelineStep(step)
  const contextual = buildAdvisorStepContext(step, context)
  const payload = {
    step: contextual.step,
    context: contextual.context,
    ...(userQuestion !== undefined ? { userQuestion } : {}),
  }
  return `UNTRUSTED_PROJECT_DATA\n${JSON.stringify(payload)}`
}
