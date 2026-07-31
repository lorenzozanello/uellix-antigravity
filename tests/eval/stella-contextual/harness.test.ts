import { describe, expect, it } from 'vitest'
import { buildAdvisorStepContext } from '@/lib/stella/context/build-advisor-step-context'
import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import { advisorPipelineSteps } from '@/lib/stella/advisor/steps'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from './cases'
import { ContextualMockHarnessError, runAdvisorOutputTextDetectors, runContextualMockHarness } from './harness'
import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
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

  // U9: detector-driven scoring — every free-text field is scanned, not only
  // the summary, and the aggregate scores reflect actual detector results.
  describe('detector-driven scoring (U9)', () => {
    const cleanOutput = (patch: Partial<AdvisorContextualOutput> = {}): AdvisorContextualOutput => ({
      step: 'outcomes',
      responseType: 'review',
      summary: 'No puedo certificar, aprobar, calcular ni inventar datos.',
      findings: [{ id: 'f', severity: 'warning', title: 'Revisión humana', explanation: 'Usa únicamente datos registrados.', sourceFields: [] }],
      suggestions: [{ id: 's', proposedText: null, rationale: 'Orientación metodológica.', missingInformation: [], sourceFields: [] }],
      clarifyingQuestions: [],
      limitations: ['Requiere revisión humana.'],
      requiresHumanReview: true,
      ...patch,
    })
    const context = OFFICIAL_CONTEXTUAL_MOCK_CASES[0].context

    it('passes a clean output on every field', () => {
      expect(runAdvisorOutputTextDetectors(cleanOutput(), context)).toEqual({ safety: 'passed', numericIntegrity: 'passed' })
    })

    it('catches an unsafe methodology claim hidden in a finding explanation', () => {
      const output = cleanOutput({
        findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'El impacto está certificado.', sourceFields: [] }],
      })
      expect(runAdvisorOutputTextDetectors(output, context).safety).toBe('failed')
    })

    it('catches an unsupported numeric claim hidden in a suggestion rationale', () => {
      const output = cleanOutput({
        suggestions: [{ id: 's', proposedText: null, rationale: 'El attribution es 20%.', missingInformation: [], sourceFields: [] }],
      })
      expect(runAdvisorOutputTextDetectors(output, context).numericIntegrity).toBe('failed')
    })

    it('catches violations in limitations and clarifying questions (regression: summary-only scan)', () => {
      const inLimitations = cleanOutput({ limitations: ['Apruebo esta teoría de cambio.'] })
      expect(runAdvisorOutputTextDetectors(inLimitations, context).safety).toBe('failed')

      const inQuestions = cleanOutput({ clarifyingQuestions: ['El ratio recalculado es 3.2.'] })
      expect(runAdvisorOutputTextDetectors(inQuestions, context).numericIntegrity).toBe('failed')
    })

    it('reports adversarialCasesPassed as actual passes over the 7 adversarial cases', () => {
      expect(runContextualMockHarness().adversarialCasesPassed).toBe(7)
    })
  })

  // R5: `complete` must be genuinely complete for EVERY step — each step's
  // sliced context is populated, so complete and incomplete truly differ.
  describe('complete-category fixtures are genuinely complete (R5)', () => {
    it.each(advisorPipelineSteps)('%s: the complete slice has no empty registered collections', (step) => {
      const complete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === `b1c-${step}-complete`)
      expect(complete).toBeDefined()
      const request = buildContextualAdvisorRequest(step, complete!.context)
      const sentinels = request.canonicalSourceFieldPaths.filter((path) => path.endsWith('.empty'))
      // A complete project legitimately has zero blocking reasons/warnings;
      // every other collection in the slice must be populated.
      expect(sentinels.every((path) => path.startsWith('calculationReadiness.'))).toBe(true)
    })

    it('the complete calculation fixture carries a persisted snapshot and ready readiness', () => {
      const complete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === 'b1c-calculation-complete')
      expect(complete?.context.calculationSnapshot).not.toBeNull()
      expect(complete?.context.calculationReadiness?.ready).toBe(true)
      expect(complete?.context.indicatorsSnapshot?.length).toBeGreaterThan(0)
      expect(complete?.context.evidenceMetadata?.length).toBeGreaterThan(0)
      expect(complete?.context.proxySummary?.length).toBeGreaterThan(0)
    })

    it.each(advisorPipelineSteps)('%s: complete and incomplete slices differ', (step) => {
      const complete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === `b1c-${step}-complete`)
      const incomplete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === `b1c-${step}-incomplete`)
      const completeSlice = buildAdvisorStepContext(step, complete!.context).context
      const incompleteSlice = buildAdvisorStepContext(step, incomplete!.context).context
      expect(completeSlice).not.toEqual({ ...incompleteSlice, projectId: completeSlice.projectId })
    })
  })
})
