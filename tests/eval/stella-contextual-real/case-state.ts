export type CasePhase = 'PENDING' | 'IN_FLIGHT' | 'RAW_RECEIVED' | 'DECODED' | 'SUCCEEDED' | 'FAILED'
export interface TransactionalCaseState { phases: Record<string, CasePhase>; providerCalls: number; expectedCalls: number; currentCaseId: string | null; checkpointSequence: number }
export function createCaseState(caseIds: readonly string[]): TransactionalCaseState { return { phases: Object.fromEntries(caseIds.map((id) => [id, 'PENDING'])), providerCalls: 0, expectedCalls: caseIds.length, currentCaseId: null, checkpointSequence: 0 } }

const ACTIVE_PHASES: readonly CasePhase[] = ['IN_FLIGHT', 'RAW_RECEIVED', 'DECODED']
const ALLOWED_TRANSITIONS: Record<CasePhase, readonly CasePhase[]> = {
  PENDING: ['IN_FLIGHT'],
  IN_FLIGHT: ['RAW_RECEIVED', 'FAILED'],
  RAW_RECEIVED: ['DECODED', 'FAILED'],
  DECODED: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
}

export function assertCaseStateInvariants(state: TransactionalCaseState, selectedCaseIds: readonly string[]): void {
  const selected = new Set(selectedCaseIds)
  const stateIds = Object.keys(state.phases)
  if (selected.size !== selectedCaseIds.length || stateIds.length !== selected.size || stateIds.some((id) => !selected.has(id))) throw new Error('CASE_SELECTION_ERROR')
  if (state.expectedCalls !== selectedCaseIds.length || !Number.isInteger(state.providerCalls) || state.providerCalls < 0 || state.providerCalls > state.expectedCalls) throw new Error('CALL_LIMIT_ERROR')
  if (stateIds.some((id) => !Object.hasOwn(ALLOWED_TRANSITIONS, state.phases[id]))) throw new Error('CASE_STATE_INVARIANT_ERROR')
  if (state.currentCaseId !== null && (!selected.has(state.currentCaseId) || !ACTIVE_PHASES.includes(state.phases[state.currentCaseId]))) throw new Error('CASE_STATE_INVARIANT_ERROR')
}

export function transitionCase(state: TransactionalCaseState, caseId: string, phase: CasePhase): TransactionalCaseState {
  if (!(caseId in state.phases)) throw new Error('CASE_SELECTION_ERROR')
  const currentPhase = state.phases[caseId]
  if (!ALLOWED_TRANSITIONS[currentPhase].includes(phase)) {
    if (phase === 'IN_FLIGHT') throw new Error('CALL_LIMIT_ERROR')
    throw new Error('CASE_STATE_TRANSITION_ERROR')
  }
  if (phase === 'IN_FLIGHT' && state.providerCalls >= state.expectedCalls) throw new Error('CALL_LIMIT_ERROR')
  const providerCalls = phase === 'IN_FLIGHT' ? state.providerCalls + 1 : state.providerCalls
  const currentCaseId = ACTIVE_PHASES.includes(phase) ? caseId : state.currentCaseId === caseId ? null : state.currentCaseId
  const next = { ...state, phases: { ...state.phases, [caseId]: phase }, providerCalls, currentCaseId, checkpointSequence: state.checkpointSequence + 1 }
  assertCaseStateInvariants(next, Object.keys(state.phases))
  return next
}
export function classifyInterruptedInFlight(state: TransactionalCaseState): TransactionalCaseState { const id = state.currentCaseId; if (!id || state.phases[id] !== 'IN_FLIGHT') return state; return transitionCase(state, id, 'FAILED') }
export function deriveCaseState(state: TransactionalCaseState) {
  const ids = Object.keys(state.phases)
  return {
    pendingCaseIds: ids.filter((id) => state.phases[id] === 'PENDING'),
    inFlightCaseIds: ids.filter((id) => state.phases[id] === 'IN_FLIGHT'),
    rawReceivedCaseIds: ids.filter((id) => state.phases[id] === 'RAW_RECEIVED'),
    decodedCaseIds: ids.filter((id) => state.phases[id] === 'DECODED'),
    processedCaseIds: ids.filter((id) => state.phases[id] === 'SUCCEEDED'),
    failedCaseIds: ids.filter((id) => state.phases[id] === 'FAILED'),
  }
}
