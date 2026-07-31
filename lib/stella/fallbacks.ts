// lib/stella/fallbacks.ts
// Sprint 9B: Fallback responses when Stella is unavailable or disabled
// FABLE MOONSHOT WS1 / U8: contextual-shape fallback for citation failures

import type { AdvisorOutput, ValidatorOutput, ComposerOutput } from './schemas'
import type { AdvisorContextualOutput } from './schemas/advisor-contextual-output'
import type { AdvisorPipelineStep } from './advisor/steps'

/**
 * Safe contextual-shape fallback used when the provider's response fails
 * citation validation at PARSE level (invalid sourceRefIndexes, non-catalog
 * citations, or index-token leaks in free text). It makes no claims, cites
 * nothing, and always requires human review. Structural/schema failures do
 * NOT use this fallback — those stay fail-closed.
 */
export function buildContextualAdvisorFallback(step: AdvisorPipelineStep): AdvisorContextualOutput {
  return {
    step,
    responseType: 'explanation',
    summary:
      'Stella no pudo generar una respuesta verificable para este paso: la respuesta del modelo no superó la validación de citas. No se registran hallazgos ni sugerencias. Consultá la documentación metodológica SROI y volvé a intentarlo.',
    findings: [],
    suggestions: [],
    clarifyingQuestions: [],
    limitations: [
      'Respuesta de contingencia sin citas a datos registrados.',
      'Este paso requiere revisión humana antes de cualquier uso.',
    ],
    requiresHumanReview: true,
  }
}

export const ADVISOR_FALLBACK: AdvisorOutput = {
  step: 'unknown',
  what_to_do:
    'Stella AI guidance is temporarily unavailable. Please refer to the SROI methodology documentation.',
  why_it_matters: 'This step is part of the SROI pipeline structure.',
  how_to_do_it:
    'Follow the step-by-step guidance in the SROI documentation. Focus on gathering evidence and maintaining methodological rigor.',
  common_mistakes: [
    'Not documenting assumptions',
    'Overestimating impact without evidence',
    'Confusing activities with outcomes',
  ],
  suggested_next_actions: ['Review the SROI methodology guide', 'Check the audit-ready language guidelines'],
}

export const VALIDATOR_FALLBACK: ValidatorOutput = {
  summary:
    'Stella validation is temporarily unavailable. Your deterministic SROI calculation and data remain unaffected.',
  risk_level: 'medium',
  evidence_gaps: [],
  proxy_risks: [],
  attribution_risks: [],
  claim_risks: ['Manual validation needed before external use'],
  recommendations: [
    'Have a human expert review this analysis before sharing externally',
    'Verify all proxies have official sources',
    'Check that evidence fully supports claimed outcomes',
  ],
  requires_human_review: true,
}

export const COMPOSER_FALLBACK: ComposerOutput = {
  section_key: 'placeholder',
  draft_title: 'Section Draft [AI Assistance Unavailable]',
  draft_content: `# Section Content

Stella composition assistance is temporarily unavailable. Please write this section manually or refer to the SROI report template in the documentation.

**Remember:**
- Cite evidence explicitly
- State assumptions clearly
- Acknowledge limitations
- Use conditional language ("may suggest," "appears to")
- Mark what requires human review

This section must be reviewed and approved by a human expert before publication.
`,
  assumptions: ['AI composition tool is temporarily offline'],
  limitations: [
    'Manual composition required',
    'No automated evidence/proxy reference generation',
  ],
  evidence_references: [],
  proxy_references: [],
}

export const UNAVAILABLE_MESSAGE =
  'Stella is temporarily unavailable. Your SROI analysis, calculation, and data integrity are unaffected. Please proceed with the analysis and try again later.'
