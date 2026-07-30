import { describe, expect, it } from 'vitest'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import {
  createCaseState,
  transitionCase,
  type TransactionalCaseState,
} from './case-state'
import { runGuardedContextualEvaluation } from './runner'
import type { DecodedResult, RawResponse, SafeRunError } from './types'

const env = {
  STELLA_PROVIDER_MODE: 'paid_gemini',
  GEMINI_API_KEY: 'test-key',
  STELLA_REAL_EVAL_ACK: 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL',
  STELLA_REAL_EVAL_SUBSET_ACK: 'B1C_CURRENT_ARCHITECTURE_CANARY',
}
const runtime = {
  branch: 'branch',
  head: 'head',
  originMainSHA: 'base',
  trackedDirty: false,
  stagingDirty: false,
  gitOperationInProgress: false,
}
const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 2).map((item) => item.caseId)
const timestamp = '2026-07-30T12:00:00.000Z'

async function completedArtifact(caseId: string): Promise<{ raw: RawResponse; decoded: DecodedResult }> {
  const result = await runGuardedContextualEvaluation({
    cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
    caseIds: [caseId],
    env,
    runtime,
    provider: async (request) => request.providerTemplate,
  })
  return { raw: result.rawResponses[0], decoded: result.decodedResults[0] }
}

function phaseState(firstPhase: 'IN_FLIGHT' | 'RAW_RECEIVED' | 'DECODED' | 'SUCCEEDED' | 'FAILED'): TransactionalCaseState {
  let state = transitionCase(createCaseState(ids), ids[0], 'IN_FLIGHT')
  if (['RAW_RECEIVED', 'DECODED', 'SUCCEEDED'].includes(firstPhase)) state = transitionCase(state, ids[0], 'RAW_RECEIVED')
  if (['DECODED', 'SUCCEEDED'].includes(firstPhase)) state = transitionCase(state, ids[0], 'DECODED')
  if (firstPhase === 'SUCCEEDED') state = transitionCase(state, ids[0], 'SUCCEEDED')
  if (firstPhase === 'FAILED') state = transitionCase(state, ids[0], 'FAILED')
  return state
}

function priorError(caseId: string): SafeRunError {
  return {
    category: 'PROVIDER_ERROR',
    caseId,
    location: 'guarded-contextual-runner',
    type: 'PROVIDER_ERROR',
    summary: 'PROVIDER_ERROR',
    timestamp,
  }
}

describe('guarded runner resume execution', () => {
  it('resumes after zero calls, increments resumeCount, and calls only pending cases', async () => {
    const called: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      runId: 'run-preserved',
      startedAt: timestamp,
      initialCaseState: createCaseState(ids),
      initialRawResponses: [],
      initialDecodedResults: [],
      initialErrors: [],
      provider: async (request) => {
        called.push(request.case.caseId)
        return request.providerTemplate
      },
      sleep: async () => undefined,
    })

    expect(called).toEqual(ids)
    expect(result.caseState).toMatchObject({ providerCalls: 2, resumeCount: 1 })
    expect(result.summary).toMatchObject({ runId: 'run-preserved', providerCalls: 2, expectedCalls: 2 })
  })

  it.each([
    ['SUCCEEDED', false],
    ['FAILED', true],
  ] as const)('preserves a prior %s case and executes only the remaining pending case', async (phase, hasError) => {
    const artifact = await completedArtifact(ids[0])
    const called: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      runId: 'run-preserved',
      startedAt: timestamp,
      initialCaseState: phaseState(phase),
      initialRawResponses: phase === 'SUCCEEDED' ? [artifact.raw] : [],
      initialDecodedResults: phase === 'SUCCEEDED' ? [artifact.decoded] : [],
      initialErrors: hasError ? [priorError(ids[0])] : [],
      provider: async (request) => {
        called.push(request.case.caseId)
        return request.providerTemplate
      },
      sleep: async () => undefined,
    })

    expect(called).toEqual([ids[1]])
    expect(result.caseState.phases).toEqual({ [ids[0]]: phase, [ids[1]]: 'SUCCEEDED' })
    expect(result.caseState.providerCalls).toBe(2)
    expect(result.rawResponses).toEqual(phase === 'SUCCEEDED' ? [artifact.raw, expect.any(Object)] : [expect.any(Object)])
    expect(result.decodedResults).toEqual(phase === 'SUCCEEDED' ? [artifact.decoded, expect.any(Object)] : [expect.any(Object)])
    expect(result.errors).toEqual(hasError ? [priorError(ids[0])] : [])
  })

  it('classifies a recovered IN_FLIGHT case without another call and preserves providerCalls', async () => {
    const called: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      initialCaseState: phaseState('IN_FLIGHT'),
      initialRawResponses: [],
      initialDecodedResults: [],
      initialErrors: [],
      provider: async (request) => {
        called.push(request.case.caseId)
        return request.providerTemplate
      },
      sleep: async () => undefined,
    })

    expect(called).toEqual([ids[1]])
    expect(result.caseState).toMatchObject({
      phases: { [ids[0]]: 'FAILED', [ids[1]]: 'SUCCEEDED' },
      providerCalls: 2,
    })
    expect(result.errors).toContainEqual(expect.objectContaining({
      caseId: ids[0],
      category: 'INTERRUPTED_AFTER_CALL_STARTED',
      type: 'INTERRUPTED_AFTER_CALL_STARTED',
      summary: 'INTERRUPTED_AFTER_CALL_STARTED',
    }))
  })

  it('paces the first new provider call after prior calls in a resumed run', async () => {
    const delays: number[] = []
    await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      initialCaseState: phaseState('FAILED'),
      initialRawResponses: [],
      initialDecodedResults: [],
      initialErrors: [priorError(ids[0])],
      provider: async (request) => request.providerTemplate,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    expect(delays).toEqual([10_000])
  })

  it('completes RAW_RECEIVED locally and never calls its provider again', async () => {
    const artifact = await completedArtifact(ids[0])
    const called: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      initialCaseState: phaseState('RAW_RECEIVED'),
      initialRawResponses: [artifact.raw],
      initialDecodedResults: [],
      initialErrors: [],
      provider: async (request) => {
        called.push(request.case.caseId)
        return request.providerTemplate
      },
      sleep: async () => undefined,
    })

    expect(called).toEqual([ids[1]])
    expect(result.caseState.phases).toEqual({ [ids[0]]: 'SUCCEEDED', [ids[1]]: 'SUCCEEDED' })
    expect(result.rawResponses[0]).toEqual(artifact.raw)
    expect(result.decodedResults[0]).toMatchObject({ caseId: ids[0] })
  })

  it('completes DECODED locally and never calls its provider again', async () => {
    const artifact = await completedArtifact(ids[0])
    const called: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      initialCaseState: phaseState('DECODED'),
      initialRawResponses: [artifact.raw],
      initialDecodedResults: [{ ...artifact.decoded, safety: 'pending', numericIntegrity: 'pending' }],
      initialErrors: [],
      provider: async (request) => {
        called.push(request.case.caseId)
        return request.providerTemplate
      },
      sleep: async () => undefined,
    })

    expect(called).toEqual([ids[1]])
    expect(result.caseState.phases).toEqual({ [ids[0]]: 'SUCCEEDED', [ids[1]]: 'SUCCEEDED' })
    expect(result.decodedResults[0]).toMatchObject({
      caseId: ids[0],
      safety: 'passed',
      numericIntegrity: 'passed',
    })
  })

  it.each([
    ['RAW_RECEIVED', [] as RawResponse[], [] as DecodedResult[]],
    ['DECODED', [] as RawResponse[], [] as DecodedResult[]],
  ] as const)('fails an incomplete recovered %s case without calling its provider again', async (phase, rawResponses, decodedResults) => {
    const called: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      initialCaseState: phaseState(phase),
      initialRawResponses: rawResponses,
      initialDecodedResults: decodedResults,
      initialErrors: [],
      provider: async (request) => {
        called.push(request.case.caseId)
        return request.providerTemplate
      },
      sleep: async () => undefined,
    })

    expect(called).toEqual([ids[1]])
    expect(result.caseState.phases).toEqual({ [ids[0]]: 'FAILED', [ids[1]]: 'SUCCEEDED' })
    expect(result.caseState.providerCalls).toBe(2)
    expect(result.errors).toContainEqual(expect.objectContaining({
      caseId: ids[0],
      category: 'RESUME_INTEGRITY_ERROR',
    }))
  })

  it('rebuilds the final checkpoint for terminal cases without provider calls', async () => {
    const artifact = await completedArtifact(ids[0])
    let state = phaseState('SUCCEEDED')
    state = transitionCase(state, ids[1], 'IN_FLIGHT')
    state = transitionCase(state, ids[1], 'FAILED')
    const checkpoints: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      isResume: true,
      initialCaseState: state,
      initialRawResponses: [artifact.raw],
      initialDecodedResults: [artifact.decoded],
      initialErrors: [priorError(ids[1])],
      provider: async () => {
        throw new Error('provider must not be called')
      },
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint.checkpointStatus)
      },
    })

    expect(result.caseState.phases).toEqual({ [ids[0]]: 'SUCCEEDED', [ids[1]]: 'FAILED' })
    expect(result.caseState.providerCalls).toBe(2)
    expect(checkpoints.at(-1)).toBe('FINAL')
    expect(result.rawResponses).toEqual([artifact.raw])
    expect(result.decodedResults).toEqual([artifact.decoded])
    expect(result.errors).toEqual([priorError(ids[1])])
  })
})
