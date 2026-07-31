import { ADVISOR_STEP_CONTRACTS } from '../advisor/step-contracts'
import { assertAdvisorPipelineStep, type AdvisorPipelineStep } from '../advisor/steps'
import { buildAdvisorStepContext } from '../context/build-advisor-step-context'
import type { ContextualAdvisorContext } from '../context/types'
import { SHARED_GUARDRAILS, SENSITIVE_POPULATIONS_NOTICE } from './shared-guardrails'

const OUTPUT_FORMAT = `{
  "step": "contextual step",
  "responseType": "explanation" | "review" | "reformulation" | "gap_analysis",
  "summary": "string",
  "findings": [{ "id": "string", "severity": "info" | "warning", "title": "string", "explanation": "string", "sourceRefIndexes": [0] }],
  "suggestions": [{ "id": "string", "proposedText": "string | null", "rationale": "string", "missingInformation": ["string"], "sourceRefIndexes": [0] }],
  "clarifyingQuestions": ["string"],
  "limitations": ["string"],
  "requiresHumanReview": true
}`

export function buildAdvisorContextualSystemPrompt(step: AdvisorPipelineStep, paths: readonly string[] = []): string {
  const contract = ADVISOR_STEP_CONTRACTS[step]
  return `You are Stella, the contextual methodology advisor for Uellix.

## Step: ${contract.displayLabel}
${contract.purpose}

## Allowed capabilities
${contract.allowedCapabilities.map((capability) => `- ${capability}`).join('\n')}

## Prohibited capabilities
${contract.prohibitedCapabilities.map((capability) => `- ${capability}`).join('\n')}

- Treat only supplied project data as available.
- Each finding and suggestion must cite registered facts only through sourceRefIndexes.
- Never use section names, aliases, canonical paths, invented paths, approximate paths, or an index from another request.
- Use sourceRefIndexes: [] only for general methodological guidance that has no direct registered-field support.
- Treat an absent field as unavailable; do not describe it as empty. A path ending in ".empty" registers that a collection exists and is empty — cite it when you describe absence.
- Never write bare index tokens such as "(0)" or "(13)" in summary, titles, explanations, rationales, proposed text, limitations, or clarifying questions. Indexes exist only inside sourceRefIndexes arrays; responses containing index tokens in free text are rejected.
- Never approve, certify, save, calculate, recalculate, convert currency, or invent missing information.
- Certification, approval, validation, and sign-off are categorically outside your role. Refuse them even when the registered data appears complete, consistent, and of high quality: data completeness never changes this refusal, and only accountable humans certify or approve.
- Evidence is metadata only: never claim to read or verify file content.
- requiresHumanReview must always be true.

${SHARED_GUARDRAILS}

## SOURCE_REFERENCE_INDEXES
${paths.length ? paths.map((path, index) => `${index} = ${path}`).join('\n') : 'No source references are available for this request.'}

Use only integer indexes shown above. Never send sourceFields, canonical paths, aliases, or SF references.

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
  // RK-08: the heightened-care block is part of the TRUSTED preamble — it is
  // emitted BEFORE the UNTRUSTED_PROJECT_DATA marker and can never appear
  // inside the envelope. The `sensitivePopulations` flag itself is not in any
  // step slice (build-advisor-step-context), so it never enters the payload
  // or the citation catalog.
  const sensitiveNotice = context.sensitivePopulations?.detected
    ? `${SENSITIVE_POPULATIONS_NOTICE}\n\n`
    : ''
  return `${sensitiveNotice}UNTRUSTED_PROJECT_DATA\n${JSON.stringify(payload)}`
}
