// lib/stella/schemas/validator-output.ts
// Sprint 9B: Stella Validator output schema
// CRITICAL: requires_human_review is ALWAYS true (hardcoded)

import { z } from 'zod'

export const ValidatorOutputSchema = z.object({
  summary: z.string().describe('Executive summary of validation'),
  risk_level: z.enum(['low', 'medium', 'high']).describe('Methodological risk level'),
  evidence_gaps: z
    .array(z.string())
    .describe('Outcomes/indicators lacking sufficient evidence'),
  proxy_risks: z.array(z.string()).describe('Proxies with weak sources or low confidence'),
  attribution_risks: z.array(z.string()).describe('Potential attribution challenges'),
  claim_risks: z
    .array(z.string())
    .describe('Overclaiming or non-audit-ready language detected'),
  recommendations: z
    .array(z.string())
    .describe('Recommendations to strengthen the analysis'),
  requires_human_review: z
    .literal(true)
    .describe('ALWAYS true - human review is mandatory before external use'),
})

export type ValidatorOutput = z.infer<typeof ValidatorOutputSchema>
