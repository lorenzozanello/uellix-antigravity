import { ADVISOR_STEP_LABELS, type AdvisorPipelineStep } from './steps'

export type AdvisorCapability = 'EXPLAIN' | 'REVIEW' | 'REFORMULATE' | 'IDENTIFY_GAPS' | 'ASK_CLARIFYING_QUESTIONS'

export interface AdvisorStepContract {
  step: AdvisorPipelineStep
  displayLabel: string
  purpose: string
  allowedCapabilities: readonly AdvisorCapability[]
  prohibitedCapabilities: readonly string[]
}

const allowedCapabilities: readonly AdvisorCapability[] = ['EXPLAIN', 'REVIEW', 'REFORMULATE', 'IDENTIFY_GAPS', 'ASK_CLARIFYING_QUESTIONS']
const prohibitedCapabilities = ['AUTO_WRITE', 'AUTO_SAVE', 'APPROVE', 'CERTIFY', 'INVENT', 'CALCULATE', 'MAKE_DECISION', 'READ_FILES', 'VERIFY_AUTHENTICITY', 'SEARCH_EXTERNAL'] as const

function contract(step: AdvisorPipelineStep, purpose: string): AdvisorStepContract {
  return { step, displayLabel: ADVISOR_STEP_LABELS[step], purpose, allowedCapabilities, prohibitedCapabilities }
}

export const ADVISOR_STEP_CONTRACTS: Record<AdvisorPipelineStep, AdvisorStepContract> = {
  stakeholders: contract('stakeholders', 'Review registered stakeholder information without inventing or approving stakeholders.'),
  outcomes: contract('outcomes', 'Review registered outcomes without inventing causal claims or approving the theory of change.'),
  narrative: contract('narrative', 'Review registered narrative information without certifying claims or inventing evidence.'),
  indicators: contract('indicators', 'Review registered indicator definitions without calculating compliance or inventing measurements.'),
  evidence: contract('evidence', 'Review evidence metadata only; never read, verify, or claim knowledge of file contents.'),
  proxies: contract('proxies', 'Review registered proxy information without selecting, converting, approving, or searching for proxies.'),
  calculation: contract('calculation', 'Explain registered calculation values and readiness without deriving, recalculating, converting, approving, or certifying them.'),
}
