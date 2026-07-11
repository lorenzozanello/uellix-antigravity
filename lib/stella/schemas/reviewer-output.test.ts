// lib/stella/schemas/reviewer-output.test.ts
// The new Fase 5b reviewer roles (proxy_reviewer, evidence_reviewer,
// audit_assistant) must inherit the same hard invariant as the Validator:
// requires_human_review is ALWAYS true. The AI recommends; humans decide.
import { describe, it, expect } from 'vitest'
import { ReviewerOutputSchema } from './reviewer-output'

const valid = {
  summary: 'Resumen de revisión',
  risk_level: 'medium' as const,
  findings: ['Hallazgo 1'],
  recommendations: ['Recomendación 1'],
  requires_human_review: true as const,
}

describe('ReviewerOutputSchema', () => {
  it('accepts a well-formed reviewer output', () => {
    const parsed = ReviewerOutputSchema.parse(valid)
    expect(parsed.requires_human_review).toBe(true)
    expect(parsed.risk_level).toBe('medium')
  })

  it('rejects requires_human_review: false (invariant)', () => {
    expect(() => ReviewerOutputSchema.parse({ ...valid, requires_human_review: false })).toThrow()
  })

  it('rejects a missing requires_human_review', () => {
    const { requires_human_review, ...withoutFlag } = valid
    void requires_human_review
    expect(() => ReviewerOutputSchema.parse(withoutFlag)).toThrow()
  })

  it('rejects an invalid risk_level', () => {
    expect(() => ReviewerOutputSchema.parse({ ...valid, risk_level: 'critical' })).toThrow()
  })
})
