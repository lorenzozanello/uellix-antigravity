import { describe, expect, it } from 'vitest'
import { assertCaseStateInvariants, classifyInterruptedInFlight, createCaseState, deriveCaseState, transitionCase, type CasePhase } from './case-state'

describe('transactional provider case state', () => {
  it('allows call one of one and blocks an additional attempt at the exact limit', () => {
    const started = transitionCase(createCaseState(['case']), 'case', 'IN_FLIGHT')
    expect(started.providerCalls).toBe(1)
    expect(started.expectedCalls).toBe(1)
    expect(() => transitionCase(started, 'case', 'IN_FLIGHT')).toThrow('CALL_LIMIT_ERROR')
    expect(started.providerCalls).toBeLessThanOrEqual(started.expectedCalls)
  })

  it('consumes a failed provider call before classifying it and never retries', () => {
    const started = transitionCase(createCaseState(['case']), 'case', 'IN_FLIGHT')
    const recovered = classifyInterruptedInFlight(started)
    expect(recovered).toMatchObject({ providerCalls: 1, expectedCalls: 1, currentCaseId: null, phases: { case: 'FAILED' } })
    expect(deriveCaseState(recovered).failedCaseIds).toEqual(['case'])
    expect(() => transitionCase(recovered, 'case', 'IN_FLIGHT')).toThrow('CALL_LIMIT_ERROR')
  })

  it.each(['SUCCEEDED', 'FAILED'] as const)('keeps %s terminal', (terminal) => {
    let state = transitionCase(createCaseState(['case']), 'case', 'IN_FLIGHT')
    if (terminal === 'SUCCEEDED') {
      state = transitionCase(state, 'case', 'RAW_RECEIVED')
      state = transitionCase(state, 'case', 'DECODED')
    }
    state = transitionCase(state, 'case', terminal)
    expect(() => transitionCase(state, 'case', 'PENDING')).toThrow('CASE_STATE_TRANSITION_ERROR')
    expect(() => transitionCase(state, 'case', 'IN_FLIGHT')).toThrow()
  })

  it('rejects unknown IDs and malformed selected-state maps', () => {
    const state = createCaseState(['case-a', 'case-b'])
    expect(Object.keys(state.phases)).toEqual(['case-a', 'case-b'])
    expect(() => transitionCase(state, 'unknown', 'IN_FLIGHT')).toThrow('CASE_SELECTION_ERROR')
    expect(() => assertCaseStateInvariants(state, ['case-a', 'unknown'])).toThrow('CASE_SELECTION_ERROR')
    expect(() => assertCaseStateInvariants({ ...state, phases: { 'case-a': 'PENDING' } }, ['case-a', 'case-b'])).toThrow('CASE_SELECTION_ERROR')
  })

  it.each([
    ['PENDING', null],
    ['IN_FLIGHT', 'case'],
    ['RAW_RECEIVED', 'case'],
    ['DECODED', 'case'],
    ['SUCCEEDED', null],
    ['FAILED', null],
  ] as Array<[CasePhase, string | null]>)('accepts currentCaseId only for active phase %s', (phase, currentCaseId) => {
    const state = { phases: { case: phase }, providerCalls: phase === 'PENDING' ? 0 : 1, expectedCalls: 1, currentCaseId, checkpointSequence: 0 }
    expect(() => assertCaseStateInvariants(state, ['case'])).not.toThrow()
    if (currentCaseId === null && ['IN_FLIGHT', 'RAW_RECEIVED', 'DECODED'].includes(phase)) {
      expect(() => assertCaseStateInvariants({ ...state, currentCaseId: 'case' }, ['case'])).not.toThrow()
    }
  })

  it('rejects invalid active cases and provider call bounds', () => {
    const state = createCaseState(['case'])
    expect(() => assertCaseStateInvariants({ ...state, currentCaseId: 'case' }, ['case'])).toThrow('CASE_STATE_INVARIANT_ERROR')
    expect(() => assertCaseStateInvariants({ ...state, providerCalls: -1 }, ['case'])).toThrow('CALL_LIMIT_ERROR')
    expect(() => assertCaseStateInvariants({ ...state, providerCalls: 2 }, ['case'])).toThrow('CALL_LIMIT_ERROR')
  })

  it('derives every phase list exactly from the state map', () => {
    const phases: Record<string, CasePhase> = {
      pending: 'PENDING',
      active: 'IN_FLIGHT',
      raw: 'RAW_RECEIVED',
      decoded: 'DECODED',
      succeeded: 'SUCCEEDED',
      failed: 'FAILED',
    }
    const state = { phases, providerCalls: 5, expectedCalls: 6, currentCaseId: 'decoded', checkpointSequence: 5 }
    assertCaseStateInvariants(state, Object.keys(phases))
    expect(deriveCaseState(state)).toEqual({
      pendingCaseIds: ['pending'],
      inFlightCaseIds: ['active'],
      rawReceivedCaseIds: ['raw'],
      decodedCaseIds: ['decoded'],
      processedCaseIds: ['succeeded'],
      failedCaseIds: ['failed'],
    })
  })
})
