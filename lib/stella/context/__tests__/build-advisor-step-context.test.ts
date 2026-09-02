import { describe, expect, it } from 'vitest'
import {
  ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS,
  ADVISOR_STEP_CONTEXT_FIELDS,
  buildAdvisorStepContext,
  UnsupportedAdvisorPipelineStepError,
} from '../build-advisor-step-context'
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
  })

  it('keeps a null calculation snapshot as null on the calculation step', () => {
    expect(buildAdvisorStepContext('calculation', input).context.calculationSnapshot).toBeNull()
  })

  it('does not mutate the input and preserves false, zero, null, empty strings, and empty arrays', () => {
    const before = structuredClone(input)

    const result = buildAdvisorStepContext('calculation', input)

    expect(input).toEqual(before)
    expect(result.context.projectName).toBe('')
    expect(result.context.proxySummary?.[0]?.value).toBe(0)
    expect(result.context.proxySummary?.[0]?.isGlobalCatalog).toBe(false)
    expect(result.context.calculationSnapshot).toBeNull()
    expect(result.context.outcomesSnapshot).toEqual([])
    expect(result.context.calculationReadiness).toEqual({ ready: false, blockingReasons: [], warnings: [] })
  })

  it('keeps evidence as metadata only, preserving linkage ids but never raw content', () => {
    const result = buildAdvisorStepContext('evidence', {
      ...input,
      evidenceMetadata: [{
        id: 'evidence-1',
        title: '',
        type: 'file',
        status: 'draft',
        createdAt: '',
        outcomeId: 'outcome-1',
        indicatorId: 'indicator-1',
        relatedOutcomeTitle: 'Outcome',
        relatedIndicatorName: 'Indicator',
        content: 'must never reach the contextual context',
        filePath: '/secret/path',
      } as unknown as ContextualEvidenceMetadata],
    })

    expect(result.context.evidenceMetadata?.[0]).toEqual({
      id: 'evidence-1',
      title: '',
      type: 'file',
      status: 'draft',
      createdAt: '',
      outcomeId: 'outcome-1',
      indicatorId: 'indicator-1',
      relatedOutcomeTitle: 'Outcome',
      relatedIndicatorName: 'Indicator',
    })
    expect(result.context.evidenceMetadata?.[0]).not.toHaveProperty('content')
    expect(result.context.evidenceMetadata?.[0]).not.toHaveProperty('filePath')
  })

  it('preserves proxy and calculation values without conversion or recalculation on their own steps', () => {
    const enriched = {
      ...input,
      calculationSnapshot: { totalInvestment: 125, grossSocialValue: 250, netSocialValue: 100, sroiRatio: 0, currency: 'COP', lineItemCount: 0, version: 0 },
      calculationReadiness: { ready: false, blockingReasons: ['missing evidence'], warnings: ['currency check'] },
    }

    const proxies = buildAdvisorStepContext('proxies', enriched)
    expect(proxies.context.proxySummary?.[0]).toMatchObject({ value: 0, currency: '', isGlobalCatalog: false })

    const calculation = buildAdvisorStepContext('calculation', enriched)
    expect(calculation.context.calculationSnapshot).toEqual({ totalInvestment: 125, grossSocialValue: 250, netSocialValue: 100, sroiRatio: 0, currency: 'COP', lineItemCount: 0, version: 0 })
    expect(calculation.context.calculationReadiness).toEqual({ ready: false, blockingReasons: ['missing evidence'], warnings: ['currency check'] })
  })

  it('rejects an unknown step before producing a partial context', () => {
    expect(() => buildAdvisorStepContext('unknown' as AdvisorPipelineStep, input)).toThrow(UnsupportedAdvisorPipelineStepError)
  })
})

// ---------------------------------------------------------------------------
// R3: per-step context slicing — each step receives only its relevant slice
// of the contextual data, so its citation catalog cannot reference fields
// that are irrelevant to that step.
// ---------------------------------------------------------------------------
describe('buildAdvisorStepContext — per-step slicing (R3)', () => {
  const fullContext: ContextualAdvisorContext = {
    projectId: 'project-1',
    organizationId: 'organization-1',
    projectName: 'Proyecto',
    narrativeSummary: 'Narrativa',
    outcomesSnapshot: [{ id: 'outcome-1', name: 'Outcome', description: '', stakeholderGroups: [] }],
    indicatorsSnapshot: [{ id: 'indicator-1', outcomeId: 'outcome-1', name: 'Indicator', unit: 'count' }],
    stakeholderCount: 1,
    stakeholdersSnapshot: [{ id: 'stakeholder-1', name: 'Actor', type: 'beneficiary' }],
    activitiesSummary: [{ id: 'activity-1', title: 'Actividad' }],
    evidenceMetadata: [{ id: 'evidence-1', title: 'Evidencia', type: 'file', status: 'approved', createdAt: '2026-01-01T00:00:00.000Z' }],
    evidenceTotal: 1,
    proxySummary: [{ id: 'proxy-1', name: 'Proxy', source: 'Fuente', value: '100', currency: 'USD' }],
    filterSetsSummary: [{ assignmentId: 'assignment-1', deadweightPct: 10 }],
    calculationSnapshot: { totalInvestment: 1, grossSocialValue: 2, netSocialValue: 1, sroiRatio: 1, lineItemCount: 1, version: 1, currency: 'USD' },
    calculationReadiness: { ready: true, blockingReasons: [], warnings: [] },
    reportSections: [{ id: 'section-1', sectionType: 'executive_summary', title: 'Resumen', contentLength: 10, status: 'draft' }],
    projectCreatedAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-06-01T00:00:00.000Z',
  }

  it.each(advisorPipelineSteps)('%s receives exactly its mapped slice plus the always-included identity fields', (step) => {
    const result = buildAdvisorStepContext(step, fullContext)
    const expectedKeys = new Set<string>([
      ...ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS,
      ...ADVISOR_STEP_CONTEXT_FIELDS[step],
    ])

    expect(new Set(Object.keys(result.context))).toEqual(expectedKeys)
  })

  it('defines an explicit slice for all 7 steps', () => {
    expect(Object.keys(ADVISOR_STEP_CONTEXT_FIELDS).sort()).toEqual([...advisorPipelineSteps].sort())
  })

  it('keeps calculation data out of non-calculation steps', () => {
    for (const step of advisorPipelineSteps.filter((s) => s !== 'calculation')) {
      const result = buildAdvisorStepContext(step, fullContext)
      expect(result.context).not.toHaveProperty('calculationSnapshot')
      expect(result.context).not.toHaveProperty('calculationReadiness')
    }
    const calculation = buildAdvisorStepContext('calculation', fullContext)
    expect(calculation.context.calculationSnapshot).not.toBeUndefined()
    expect(calculation.context.calculationReadiness).not.toBeUndefined()
  })

  it('keeps proxy financial data only on proxies and calculation steps', () => {
    for (const step of advisorPipelineSteps) {
      const result = buildAdvisorStepContext(step, fullContext)
      if (step === 'proxies' || step === 'calculation') {
        expect(result.context.proxySummary).toHaveLength(1)
      } else {
        expect(result.context).not.toHaveProperty('proxySummary')
      }
    }
  })

  it('keeps evidence metadata only on evidence-relevant steps', () => {
    for (const step of advisorPipelineSteps) {
      const result = buildAdvisorStepContext(step, fullContext)
      if (step === 'indicators' || step === 'evidence') {
        expect(result.context.evidenceMetadata).toHaveLength(1)
      } else {
        expect(result.context).not.toHaveProperty('evidenceMetadata')
      }
    }
  })

  it('omits mapped fields that are absent from the input instead of inventing them', () => {
    const sparse: ContextualAdvisorContext = { projectId: 'project-1', organizationId: 'organization-1' }
    const result = buildAdvisorStepContext('calculation', sparse)

    expect(Object.keys(result.context).sort()).toEqual(['organizationId', 'projectId'])
  })
})
