import { describe, expect, it } from 'vitest'
import { ContextualSourceFieldsValidationError, validateContextualSourceFields } from './validate-contextual-source-fields'

const allowed = ['narrativeSummary', 'outcomesSnapshot[0].id', 'calculationReadiness.blockingReasons[0]']
const output = (sourceFields: unknown, target: 'findings' | 'suggestions' = 'findings') => ({
  findings: target === 'findings' ? [{ sourceFields }] : [],
  suggestions: target === 'suggestions' ? [{ sourceFields }] : [],
})

describe('validateContextualSourceFields', () => {
  it('accepts exact paths, bracket indexes, and empty arrays in findings and suggestions', () => {
    expect(() => validateContextualSourceFields(allowed, {
      findings: [{ sourceFields: ['narrativeSummary', 'outcomesSnapshot[0].id'] }],
      suggestions: [{ sourceFields: [] }, { sourceFields: ['calculationReadiness.blockingReasons[0]'] }],
    })).not.toThrow()
  })

  it.each([
    'stakeholders', 'outcomes', 'evidence', 'outcomesSnapshot[1].id', 'outcomesSnapshot.0.id', 'outcomesSnapshot[].id',
    'outcomesSnapshot', 'outcomesSnapshot[0]', 'outcomesSnapshot[0].id.extra', ' outcomesSnapshot[0].id', 'OutcomesSnapshot[0].id',
  ])('rejects %s exactly and atomically', (sourceField) => {
    expect(() => validateContextualSourceFields(allowed, output(['narrativeSummary', sourceField]))).toThrow(ContextualSourceFieldsValidationError)
  })

  it('rejects non-string values and reports the field location without leaking context', () => {
    try {
      validateContextualSourceFields(['secretField'], output([0]))
      throw new Error('expected validation failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ContextualSourceFieldsValidationError)
      expect((error as Error).message).toContain('findings[0].sourceFields[0]')
      expect((error as Error).message).toContain('must be a string')
      expect((error as Error).message).not.toContain('secretField')
    }
  })
})
