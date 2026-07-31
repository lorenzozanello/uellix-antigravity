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

export function buildContextualResponseJsonSchema(step: string, paths: readonly string[]): Record<string, unknown> {
  const sourceRefIndexes = paths.length ? { type: 'array', items: { type: 'integer', minimum: 0, maximum: paths.length - 1 } } : { type: 'array', maxItems: 0 }
  const finding = { type: 'object', additionalProperties: false, required: ['id', 'severity', 'title', 'explanation', 'sourceRefIndexes'], properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning'] }, title: { type: 'string' }, explanation: { type: 'string' }, sourceRefIndexes } }
  const suggestion = { type: 'object', additionalProperties: false, required: ['id', 'proposedText', 'rationale', 'missingInformation', 'sourceRefIndexes'], properties: { id: { type: 'string' }, proposedText: { type: ['string', 'null'] }, rationale: { type: 'string' }, missingInformation: { type: 'array', items: { type: 'string' } }, sourceRefIndexes } }
  return { type: 'object', additionalProperties: false, required: ['step', 'responseType', 'summary', 'findings', 'suggestions', 'clarifyingQuestions', 'limitations', 'requiresHumanReview'], properties: { step: { const: step }, responseType: { type: 'string', enum: AdvisorResponseTypeSchema.options }, summary: { type: 'string' }, findings: { type: 'array', items: finding }, suggestions: { type: 'array', items: suggestion }, clarifyingQuestions: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } }, requiresHumanReview: { const: true } } }
}
