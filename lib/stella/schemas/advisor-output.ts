// lib/stella/schemas/advisor-output.ts
// Sprint 9B: Stella Advisor output schema

import { z } from 'zod'

export const AdvisorOutputSchema = z.object({
  step: z.string().describe('Pipeline step name (narrative, outcomes, indicators, etc.)'),
  what_to_do: z.string().describe('What the user should do at this step'),
  why_it_matters: z
    .string()
    .describe('Why this step is methodologically important for SROI rigor'),
  how_to_do_it: z.string().describe('How to do it correctly and thoroughly'),
  common_mistakes: z.array(z.string()).describe('Common mistakes to avoid'),
  suggested_next_actions: z.array(z.string()).describe('Suggested next steps'),
})

export type AdvisorOutput = z.infer<typeof AdvisorOutputSchema>
