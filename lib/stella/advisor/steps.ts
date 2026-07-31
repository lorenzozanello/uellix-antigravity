export const advisorPipelineSteps = [
  'stakeholders',
  'outcomes',
  'narrative',
  'indicators',
  'evidence',
  'proxies',
  'calculation',
] as const

export type AdvisorPipelineStep = (typeof advisorPipelineSteps)[number]

export const ADVISOR_STEP_LABELS: Record<AdvisorPipelineStep, string> = {
  stakeholders: 'Grupos de interés',
  outcomes: 'Resultados',
  narrative: 'Narrativa',
  indicators: 'Indicadores',
  evidence: 'Evidencia',
  proxies: 'Proxies',
  calculation: 'Cálculo',
}

export class UnsupportedAdvisorPipelineStepError extends Error {
  constructor(step: string) {
    super(`Unsupported contextual advisor step: ${step}`)
    this.name = 'UnsupportedAdvisorPipelineStepError'
  }
}

export function isAdvisorPipelineStep(step: string): step is AdvisorPipelineStep {
  return (advisorPipelineSteps as readonly string[]).includes(step)
}

export function assertAdvisorPipelineStep(step: string): asserts step is AdvisorPipelineStep {
  if (!isAdvisorPipelineStep(step)) throw new UnsupportedAdvisorPipelineStepError(step)
}
