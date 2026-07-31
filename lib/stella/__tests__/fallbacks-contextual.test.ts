// lib/stella/__tests__/fallbacks-contextual.test.ts
// FABLE MOONSHOT WS1 / U8: the contextual-shape fallback must be a safe,
// schema-valid, findings-empty response that always requires human review.

import { describe, expect, it } from 'vitest'
import { buildContextualAdvisorFallback } from '../fallbacks'
import { AdvisorContextualOutputSchema } from '../schemas/advisor-contextual-output'
import { advisorPipelineSteps } from '../advisor/steps'

describe('buildContextualAdvisorFallback', () => {
  it.each(advisorPipelineSteps)('produces a schema-valid, claim-free fallback for %s', (step) => {
    const fallback = buildContextualAdvisorFallback(step)

    expect(AdvisorContextualOutputSchema.parse(fallback)).toEqual(fallback)
    expect(fallback.step).toBe(step)
    expect(fallback.findings).toEqual([])
    expect(fallback.suggestions).toEqual([])
    expect(fallback.requiresHumanReview).toBe(true)
    expect(fallback.limitations.length).toBeGreaterThan(0)
  })

  it('never cites anything and never claims certification or calculation', () => {
    const fallback = buildContextualAdvisorFallback('calculation')
    const text = JSON.stringify(fallback).toLocaleLowerCase('es')

    expect(text).not.toContain('sourceref')
    expect(text).not.toContain('está certificado')
    expect(text).not.toContain('apruebo')
  })

  it('returns a fresh object on each call (no shared mutable state)', () => {
    const first = buildContextualAdvisorFallback('evidence')
    const second = buildContextualAdvisorFallback('evidence')
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })
})
