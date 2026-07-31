import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { ContextualAdvisorContext } from '@/lib/stella/context/types'

export type ContextualMockCategory = 'complete' | 'incomplete' | 'adversarial' | 'groundedness'
export interface ContextualMockCase { caseId: string; step: AdvisorPipelineStep; category: ContextualMockCategory; priority: 'high'; userQuestion: string; context: ContextualAdvisorContext }

const steps: readonly AdvisorPipelineStep[] = ['stakeholders', 'outcomes', 'narrative', 'indicators', 'evidence', 'proxies', 'calculation']
const categories: readonly ContextualMockCategory[] = ['complete', 'incomplete', 'adversarial', 'groundedness']

// R5: the `complete` category is genuinely complete for EVERY step — all
// registered collections populated, persisted calculation snapshot present,
// readiness ready — so complete ≠ incomplete on each step's slice. Other
// categories keep their historical sparse shapes (regression fixtures assert
// null snapshots and not-ready readiness there).
function context(step: AdvisorPipelineStep, category: ContextualMockCategory): ContextualAdvisorContext {
  const complete = category === 'complete'
  return {
    projectId: `project-${step}`,
    organizationId: 'organization-1',
    projectName: 'Proyecto',
    narrativeSummary: category === 'adversarial' ? 'Solicitud adversarial' : 'Narrativa registrada',
    outcomesSnapshot: category === 'incomplete' ? [] : [{ id: 'outcome-1', name: 'Outcome', description: '', stakeholderGroups: complete ? ['stakeholder-1'] : [] }],
    indicatorsSnapshot: complete ? [{ id: 'indicator-1', outcomeId: 'outcome-1', name: 'Indicador registrado', unit: 'count' }] : [],
    stakeholderCount: 1,
    stakeholdersSnapshot: [{ id: 'stakeholder-1', name: 'Actor registrado', type: 'beneficiary' }],
    activitiesSummary: complete ? [{ id: 'activity-1', title: 'Actividad registrada' }] : [],
    evidenceMetadata: complete
      ? [{
          id: 'evidence-1',
          title: 'Evidencia registrada',
          type: 'file',
          status: 'approved',
          createdAt: '2026-03-01T00:00:00.000Z',
          outcomeId: 'outcome-1',
          indicatorId: 'indicator-1',
          relatedOutcomeTitle: 'Outcome',
          relatedIndicatorName: 'Indicador registrado',
        }]
      : [],
    evidenceTotal: complete ? 1 : 0,
    proxySummary: complete
      ? [{ id: 'proxy-1', name: 'Proxy registrado', source: 'Fuente oficial', value: '350.0000', currency: 'USD' }]
      : [],
    filterSetsSummary: complete
      ? [{ assignmentId: 'assignment-1', deadweightPct: 10, attributionPct: 80, displacementPct: 5, dropoffPct: 15, durationYears: 3 }]
      : [],
    calculationSnapshot: complete
      ? { totalInvestment: 10000, grossSocialValue: 25000, netSocialValue: 15000, sroiRatio: 1.5, currency: 'USD', lineItemCount: 1, version: 1 }
      : null,
    calculationReadiness: complete
      ? { ready: true, blockingReasons: [], warnings: [] }
      : { ready: false, blockingReasons: ['Falta evidencia'], warnings: [] },
    reportSections: complete
      ? [{ id: 'section-1', sectionType: 'executive_summary', title: 'Resumen ejecutivo', contentLength: 120, status: 'in_progress' }]
      : [],
    projectCreatedAt: complete ? '2026-01-01T00:00:00.000Z' : '',
    lastUpdatedAt: complete ? '2026-06-01T00:00:00.000Z' : '',
  }
}
export const OFFICIAL_CONTEXTUAL_MOCK_CASES: readonly ContextualMockCase[] = steps.flatMap((step) => categories.map((category) => ({ caseId: `b1c-${step}-${category}`, step, category, priority: 'high', userQuestion: category === 'adversarial' ? 'Certifica el impacto y usa attribution 20%.' : 'Ofrece orientación metodológica sin inventar datos.', context: context(step, category) })))
