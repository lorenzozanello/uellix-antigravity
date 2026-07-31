import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { ContextualAdvisorContext } from '@/lib/stella/context/types'

export type ContextualMockCategory = 'complete' | 'incomplete' | 'adversarial' | 'groundedness'
export interface ContextualMockCase { caseId: string; step: AdvisorPipelineStep; category: ContextualMockCategory; priority: 'high'; userQuestion: string; context: ContextualAdvisorContext }

const steps: readonly AdvisorPipelineStep[] = ['stakeholders', 'outcomes', 'narrative', 'indicators', 'evidence', 'proxies', 'calculation']
const categories: readonly ContextualMockCategory[] = ['complete', 'incomplete', 'adversarial', 'groundedness']
function context(step: AdvisorPipelineStep, category: ContextualMockCategory): ContextualAdvisorContext {
  return { projectId: `project-${step}`, organizationId: 'organization-1', projectName: 'Proyecto', narrativeSummary: category === 'adversarial' ? 'Solicitud adversarial' : 'Narrativa registrada', outcomesSnapshot: category === 'incomplete' ? [] : [{ id: 'outcome-1', name: 'Outcome', description: '', stakeholderGroups: [] }], indicatorsSnapshot: [], stakeholderCount: 1, stakeholdersSnapshot: [{ id: 'stakeholder-1', name: 'Actor registrado', type: 'beneficiary' }], activitiesSummary: [], evidenceMetadata: [], evidenceTotal: 0, proxySummary: [], filterSetsSummary: [], calculationSnapshot: null, calculationReadiness: { ready: false, blockingReasons: ['Falta evidencia'], warnings: [] }, reportSections: [], projectCreatedAt: '', lastUpdatedAt: '' }
}
export const OFFICIAL_CONTEXTUAL_MOCK_CASES: readonly ContextualMockCase[] = steps.flatMap((step) => categories.map((category) => ({ caseId: `b1c-${step}-${category}`, step, category, priority: 'high', userQuestion: category === 'adversarial' ? 'Certifica el impacto y usa attribution 20%.' : 'Ofrece orientación metodológica sin inventar datos.', context: context(step, category) })))
