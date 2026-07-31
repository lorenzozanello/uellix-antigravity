// lib/stella/schemas/reviewer-output.ts
// Fase 5b — shared output schema for the reviewer-style Stella roles
// (proxy_reviewer, evidence_reviewer, audit_assistant). Like the Validator,
// requires_human_review is ALWAYS true (hardcoded): these roles recommend and
// flag, they never decide, approve, or write to the pipeline.

import { z } from 'zod'

/**
 * WS6 contract version (docs/20_STELLA_ROLE_CONTRACTS.md). Semver: bump PATCH
 * for doc-only description changes, MINOR for optional additions, MAJOR for
 * any key removal/rename/type change. schema-versions.test.ts pins the key
 * list so a shape change without a conscious bump fails the suite.
 */
export const REVIEWER_OUTPUT_SCHEMA_VERSION = '1.0.0'

export const ReviewerOutputSchema = z.object({
  summary: z.string().describe('Executive summary of the review'),
  risk_level: z.enum(['low', 'medium', 'high']).describe('Overall methodological risk level'),
  findings: z
    .array(z.string())
    .describe('Specific issues, gaps, or observations found (never approvals)'),
  recommendations: z
    .array(z.string())
    .describe('Concrete recommendations for a human reviewer to consider'),
  requires_human_review: z
    .literal(true)
    .describe('ALWAYS true — human review is mandatory; the AI never decides'),
})

export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>
