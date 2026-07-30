import { z } from 'zod'
import { advisorPipelineSteps } from '../advisor/steps'

export const AdvisorResponseTypeSchema = z.enum(['explanation', 'review', 'reformulation', 'gap_analysis'])

const SourceFieldsSchema = z.array(z.string())

export const AdvisorContextualOutputSchema = z.object({
  step: z.enum(advisorPipelineSteps),
  responseType: AdvisorResponseTypeSchema,
  summary: z.string(),
  findings: z.array(z.object({
    id: z.string(),
    severity: z.enum(['info', 'warning']),
    title: z.string(),
    explanation: z.string(),
    sourceFields: SourceFieldsSchema,
  }).strict()),
  suggestions: z.array(z.object({
    id: z.string(),
    proposedText: z.string().nullable(),
    rationale: z.string(),
    missingInformation: z.array(z.string()),
    sourceFields: SourceFieldsSchema,
  }).strict()),
  clarifyingQuestions: z.array(z.string()),
  limitations: z.array(z.string()),
  requiresHumanReview: z.literal(true),
}).strict()

export type AdvisorContextualOutput = z.infer<typeof AdvisorContextualOutputSchema>
