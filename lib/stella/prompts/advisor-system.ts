// lib/stella/prompts/advisor-system.ts
// Sprint 9B: Stella Advisor system prompt builder

import { SHARED_GUARDRAILS } from './shared-guardrails'
import { buildStellaUserMessage } from './build-runtime-message'
import type { StellaProjectContext } from '../context/types'

export function buildAdvisorSystemPrompt(step: string): string {
  return `You are Stella, the AI methodology advisor for Uellix.

## Your Role

You are an expert in SROI (Social Return on Investment) methodology. Your job is to guide users through the SROI pipeline step by step, explaining concepts clearly and helping them make methodologically sound decisions.

## Current Step: ${step}

The user is working on the "${step}" step of their SROI analysis. Explain:
- What to do at this step
- Why it's methodologically important
- How to do it rigorously
- Common mistakes to avoid
- Suggested next actions

${SHARED_GUARDRAILS}

## Output Format

You MUST respond with a JSON object matching this schema:
{
  "step": "string",
  "what_to_do": "string",
  "why_it_matters": "string",
  "how_to_do_it": "string",
  "common_mistakes": ["string"],
  "suggested_next_actions": ["string"]
}

IMPORTANT: Return ONLY the JSON object. No markdown, no explanation outside the JSON.
`
}

export function buildAdvisorUserMessage(step: string, context: StellaProjectContext): string {
  // Etapa A1.5 (STL-A15-001): same fields as before (projectId, step, the 3
  // counts, readiness score, narrative truncated to 500 chars), now sent
  // through the structural TASK/UNTRUSTED_PROJECT_DATA/RESPONSE_REQUIREMENTS
  // envelope instead of concatenated prose. No field added or removed.
  return buildStellaUserMessage({
    task: `Please provide guidance for the "${step}" step of our SROI analysis.`,
    untrustedData: {
      projectId: context.projectId,
      currentStep: step,
      outcomesDefined: context.outcomesSnapshot.length,
      indicatorsCount: context.indicatorsSnapshot.length,
      evidenceItems: context.evidenceTotal,
      readinessScore: context.readinessScore ?? 'Not yet calculated',
      currentAnalysisSummary: context.narrativeSummary.substring(0, 500) + '...',
    },
    responseRequirements: 'Generate clear, actionable advice for completing this step methodologically sound.',
  })
}
