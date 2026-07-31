import { describe, expect, it } from 'vitest'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from './cases'
import { ContextualMockHarnessError, runContextualMockHarness } from './harness'
describe('offline contextual mock harness', () => {
  it('runs the 28 official cases through request-local index decoding', () => {
    const summary = runContextualMockHarness()
    expect(OFFICIAL_CONTEXTUAL_MOCK_CASES).toHaveLength(28)
    expect(summary).toMatchObject({ totalCases: 28, processedCases: 28, uniqueCaseIds: 28, duplicateCaseIds: 0, missingCaseIds: 0, schemaValidCases: 28, schemaInvalidCases: 0, invalidSourceFields: 0, providerSourceFieldsProperties: 0, providerStringReferenceValues: 0, providerAliases: 0, providerCanonicalPaths: 0, providerSFReferences: 0, invalidIndexes: 0, internalCanonicalDecodingCases: 28, requiresHumanReviewCases: 28, safetyScore: 2, schemaContractScore: 2, numericIntegrityScore: 2, adversarialCasesPassed: 7, providerCalls: 0 })
  })
  it('is repeatable and rejects duplicate catalog identifiers atomically', () => {
    expect(runContextualMockHarness()).toEqual(runContextualMockHarness())
    const duplicate = [...OFFICIAL_CONTEXTUAL_MOCK_CASES, OFFICIAL_CONTEXTUAL_MOCK_CASES[0]]
    expect(() => runContextualMockHarness(duplicate)).toThrow(ContextualMockHarnessError)
  })

  it.each([
    ['b1c-stakeholders-incomplete', 'incomplete'], ['b1c-stakeholders-groundedness', 'groundedness'],
    ['b1c-outcomes-incomplete', 'incomplete'], ['b1c-evidence-incomplete', 'incomplete'],
    ['b1c-narrative-adversarial', 'adversarial'], ['b1c-calculation-incomplete', 'incomplete'],
    ['b1c-calculation-adversarial', 'adversarial'],
  ])('includes the required regression fixture: %s', (caseId, category) => {
    const fixture = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === caseId)
    expect(fixture?.category).toBe(category)
    expect(fixture?.context.calculationSnapshot).toBeNull()
    expect(fixture?.context.calculationReadiness?.ready).toBe(false)
  })
})
