import { describe, expect, it } from 'vitest'
import { AdvisorContextualOutputSchema } from './advisor-contextual-output'

const valid = {
  step: 'calculation',
  responseType: 'review',
  summary: 'El cálculo requiere revisión humana.',
  findings: [{ id: 'finding-1', severity: 'warning', title: 'Dato faltante', explanation: 'Falta evidencia.', sourceFields: [] }],
  suggestions: [{ id: 'suggestion-1', proposedText: null, rationale: 'Registrar evidencia.', missingInformation: ['evidence'], sourceFields: [] }],
  clarifyingQuestions: [],
  limitations: [],
  requiresHumanReview: true,
}

describe('AdvisorContextualOutputSchema', () => {
  it('accepts the internal sourceFields contract and requires human review', () => {
    expect(AdvisorContextualOutputSchema.parse(valid).requiresHumanReview).toBe(true)
  })

  it('rejects a response that disables required human review', () => {
    expect(() => AdvisorContextualOutputSchema.parse({ ...valid, requiresHumanReview: false })).toThrow()
  })
})
