import { describe, expect, it } from 'vitest'
import { buildAdvisorStepContext, UnsupportedAdvisorPipelineStepError } from '../build-advisor-step-context'
import { advisorPipelineSteps, type AdvisorPipelineStep } from '../../advisor/steps'
import type { ContextualAdvisorContext, ContextualEvidenceMetadata } from '../types'

const input: ContextualAdvisorContext = {
  projectId: 'project-1',
  organizationId: 'organization-1',
  projectName: '',
  narrativeSummary: '',
  outcomesSnapshot: [],
  indicatorsSnapshot: [],
  stakeholderCount: 0,
  stakeholdersSnapshot: [],
  activitiesSummary: [],
  evidenceMetadata: [{
    id: 'evidence-1',
    title: '',
    type: 'file',
    status: 'draft',
    createdAt: '',
    content: 'must never reach the contextual context',
  } as unknown as ContextualEvidenceMetadata],
  evidenceTotal: 0,
  proxySummary: [{ id: 'proxy-1', name: '', source: '', value: 0, currency: '', isGlobalCatalog: false }],
  filterSetsSummary: [],
  calculationSnapshot: null,
  calculationReadiness: { ready: false, blockingReasons: [], warnings: [] },
  reportSections: [],
  projectCreatedAt: '',
  lastUpdatedAt: '',
}

describe('buildAdvisorStepContext', () => {
  it.each(advisorPipelineSteps)('builds a deterministic contextual context for %s', (step) => {
    const result = buildAdvisorStepContext(step, input)

    expect(result.step).toBe(step)
    expect(result.context.projectId).toBe('project-1')
    expect(result.context.calculationSnapshot).toBeNull()
  })

  it('does not mutate the input and preserves false, zero, null, empty strings, and empty arrays', () => {
    const before = structuredClone(input)

    const result = buildAdvisorStepContext('calculation', input)

    expect(input).toEqual(before)
    expect(result.context.projectName).toBe('')
    expect(result.context.stakeholderCount).toBe(0)
    expect(result.context.proxySummary?.[0]?.value).toBe(0)
    expect(result.context.proxySummary?.[0]?.isGlobalCatalog).toBe(false)
    expect(result.context.calculationSnapshot).toBeNull()
    expect(result.context.outcomesSnapshot).toEqual([])
    expect(result.context.calculationReadiness).toEqual({ ready: false, blockingReasons: [], warnings: [] })
  })

  it('keeps evidence as metadata only and preserves proxy and calculation values without conversion or recalculation', () => {
    const result = buildAdvisorStepContext('evidence', {
      ...input,
      calculationSnapshot: { totalInvestment: 125, grossSocialValue: 250, netSocialValue: 100, sroiRatio: 0, currency: 'COP', lineItemCount: 0, version: 0 },
      calculationReadiness: { ready: false, blockingReasons: ['missing evidence'], warnings: ['currency check'] },
    })

    expect(result.context.evidenceMetadata?.[0]).toEqual({ id: 'evidence-1', title: '', type: 'file', status: 'draft', createdAt: '' })
    expect(result.context.evidenceMetadata?.[0]).not.toHaveProperty('content')
    expect(result.context.proxySummary?.[0]).toMatchObject({ value: 0, currency: '', isGlobalCatalog: false })
    expect(result.context.calculationSnapshot).toEqual({ totalInvestment: 125, grossSocialValue: 250, netSocialValue: 100, sroiRatio: 0, currency: 'COP', lineItemCount: 0, version: 0 })
    expect(result.context.calculationReadiness).toEqual({ ready: false, blockingReasons: ['missing evidence'], warnings: ['currency check'] })
  })

  it('rejects an unknown step before producing a partial context', () => {
    expect(() => buildAdvisorStepContext('unknown' as AdvisorPipelineStep, input)).toThrow(UnsupportedAdvisorPipelineStepError)
  })
})
