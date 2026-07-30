import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import { parseRealRunnerArgs, selectRealRunnerCases, validateRealRunnerAuthorization } from './guards'
import { runGuardedContextualEvaluation } from './runner'
import { createCaseState, transitionCase, type CasePhase, type TransactionalCaseState } from './case-state'
import { writeTransactionalCheckpoint } from './transactional-writer'

const env = { STELLA_PROVIDER_MODE: 'paid_gemini', GEMINI_API_KEY: 'test-key', STELLA_REAL_EVAL_ACK: 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL', STELLA_REAL_EVAL_SUBSET_ACK: 'B1C_CURRENT_ARCHITECTURE_CANARY', STELLA_REAL_EVAL_FULL_ACK: 'B1C_CURRENT_ARCHITECTURE_FULL_28' }
const runtime = { branch: 'branch', head: 'head', originMainSHA: 'base', trackedDirty: false, stagingDirty: false, gitOperationInProgress: false }
const caseId = 'b1c-stakeholders-complete'

interface CapturedRunnerError extends Error {
  category: string
  caseState: TransactionalCaseState
  rawResponses: unknown[]
  decodedResults: unknown[]
}

async function captureRunnerError(run: Promise<unknown>): Promise<CapturedRunnerError> {
  try {
    await run
  } catch (error) {
    return error as CapturedRunnerError
  }
  throw new Error('expected runner to fail')
}

describe('guarded contextual real runner', () => {
  it.each([
    ['missing general', { STELLA_REAL_EVAL_ACK: undefined }], ['bad general', { STELLA_REAL_EVAL_ACK: 'bad' }], ['missing canary', { STELLA_REAL_EVAL_SUBSET_ACK: undefined }],
    ['bad canary', { STELLA_REAL_EVAL_SUBSET_ACK: 'bad' }], ['missing full', { STELLA_REAL_EVAL_FULL_ACK: undefined }], ['bad full', { STELLA_REAL_EVAL_FULL_ACK: 'bad' }],
  ])('rejects authorization: %s', (name, patch) => expect(() => validateRealRunnerAuthorization({ ...env, ...patch }, name.includes('full') ? [] : ['b1c-stakeholders-complete'], false)).toThrow())

  it.each([[1], [4], [7]])('accepts a canary with %s explicit cases', (count) => {
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, count).map((item) => item.caseId)
    expect(selectRealRunnerCases(OFFICIAL_CONTEXTUAL_MOCK_CASES, ids).cases).toHaveLength(count)
  })
  it.each([['unknown', ['missing']], ['duplicate', ['b1c-stakeholders-complete', 'b1c-stakeholders-complete']], ['more than seven', OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 8).map((item) => item.caseId)]])('rejects selection: %s', (_name, ids) => expect(() => selectRealRunnerCases(OFFICIAL_CONTEXTUAL_MOCK_CASES, ids)).toThrow())

  it.each([
    [['--help'], 'help'], [['--dry-run', '--case-id', 'b1c-stakeholders-complete'], 'dryRun'],
    [['--run-label', 'safe-label', '--case-id', 'b1c-stakeholders-complete'], 'runLabel'],
    [['--dry-run', '--resume', 'existing-run'], 'error'],
    [['--unknown'], 'error'], [['--resume', 'run', '--case-id', 'b1c-stakeholders-complete'], 'error'],
  ])('parses CLI safely: %o', (args, key) => {
    if (key === 'error') expect(() => parseRealRunnerArgs(args)).toThrow()
    else expect(parseRealRunnerArgs(args)).toHaveProperty(key)
  })

  it('runs dry-run without key or provider calls', async () => {
    const result = await runGuardedContextualEvaluation({ cases: OFFICIAL_CONTEXTUAL_MOCK_CASES, caseIds: [caseId], dryRun: true, env: {}, runtime })
    expect(result.summary).toMatchObject({ processedCases: 1, expectedCalls: 1, providerCalls: 0, scope: 'canary' })
  })

  it('fails closed before the provider when the initial checkpoint cannot be confirmed', async () => {
    let calls = 0
    const phases: CasePhase[] = []
    const error = await captureRunnerError(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      provider: async () => { calls += 1; return {} },
      onCheckpoint: async (checkpoint) => {
        phases.push(checkpoint.caseState.phases[caseId])
        throw new Error('simulated filesystem failure')
      },
    }))

    expect(phases).toEqual(['PENDING'])
    expect(calls).toBe(0)
    expect(error).toMatchObject({
      category: 'CHECKPOINT_ERROR',
      caseState: { phases: { [caseId]: 'PENDING' }, providerCalls: 0, checkpointSequence: 0 },
    })
  })

  it('executes injected provider exactly once and preserves raw indexes', async () => {
    let calls = 0
    const result = await runGuardedContextualEvaluation({ cases: OFFICIAL_CONTEXTUAL_MOCK_CASES, caseIds: [caseId], env, runtime, provider: async (request) => { calls += 1; const template = request.providerTemplate as { findings: Array<Record<string, unknown>>; suggestions: Array<Record<string, unknown>> }; return { ...template, findings: [{ ...template.findings[0], sourceRefIndexes: [0] }], suggestions: [{ ...template.suggestions[0], sourceRefIndexes: [0] }] } } })
    expect(calls).toBe(1)
    expect(result.summary.providerCalls).toBe(1)
    expect((result.rawResponses[0].providerResponse.findings as Array<Record<string, unknown>>)[0].sourceRefIndexes).toEqual([0])
    expect(result.decodedResults[0].output.findings[0].sourceFields).toHaveLength(1)
    expect(result.caseState.phases[caseId]).toBe('SUCCEEDED')
  })

  // Case A/H (spec section 12): a translated step must not fail the case; the mismatch must be observable.
  it('canonicalizes a provider-translated step, succeeds the case, and surfaces the mismatch metric', async () => {
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      provider: async (request) => ({ ...(request.providerTemplate as Record<string, unknown>), step: 'stakeholders-translated' }),
    })
    expect(result.caseState.phases[caseId]).toBe('SUCCEEDED')
    expect(result.decodedResults[0].output.step).toBe('stakeholders')
    expect(result.rawResponses[0].providerResponse.step).toBe('stakeholders-translated')
    expect(result.summary.providerStepMismatches).toBe(1)
  })

  it.each(['SUCCEEDED', 'FAILED', 'IN_FLIGHT', 'RAW_RECEIVED', 'DECODED'] as const)('never invokes a non-pending %s case', async (phase) => {
    let calls = 0
    let state = createCaseState([caseId])
    state = transitionCase(state, caseId, 'IN_FLIGHT')
    if (['RAW_RECEIVED', 'DECODED', 'SUCCEEDED'].includes(phase)) state = transitionCase(state, caseId, 'RAW_RECEIVED')
    if (['DECODED', 'SUCCEEDED'].includes(phase)) state = transitionCase(state, caseId, 'DECODED')
    if (phase === 'SUCCEEDED') state = transitionCase(state, caseId, 'SUCCEEDED')
    if (phase === 'FAILED') state = transitionCase(state, caseId, 'FAILED')
    await expect(runGuardedContextualEvaluation({ cases: OFFICIAL_CONTEXTUAL_MOCK_CASES, caseIds: [caseId], env, runtime, initialCaseState: state, provider: async () => { calls += 1; return {} } })).rejects.toThrow()
    expect(calls).toBe(0)
  })

  it('fails a provider call once, clears the active case, and never retries it', async () => {
    let calls = 0
    const phases: CasePhase[] = []
    const error = await captureRunnerError(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      provider: async () => { calls += 1; throw new Error('provider unavailable') },
      onCheckpoint: async (checkpoint) => { phases.push(checkpoint.caseState.phases[caseId]) },
    }))

    expect(phases).toEqual(['PENDING', 'IN_FLIGHT', 'FAILED'])
    expect(calls).toBe(1)
    expect(error).toMatchObject({
      category: 'PROVIDER_ERROR',
      caseState: { phases: { [caseId]: 'FAILED' }, providerCalls: 1, expectedCalls: 1, currentCaseId: null },
      rawResponses: [],
      decodedResults: [],
    })

    await expect(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      initialCaseState: error.caseState,
      provider: async () => { calls += 1; return {} },
    })).rejects.toThrow('CALL_LIMIT_ERROR')
    expect(calls).toBe(1)
    expect(error.caseState.phases[caseId]).toBe('FAILED')
  })

  it('preserves raw provider output when decode fails and never retries the failed case', async () => {
    let calls = 0
    const phases: CasePhase[] = []
    const invalidRaw = { invalid: 'provider-facing-response' }
    const error = await captureRunnerError(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      provider: async () => { calls += 1; return invalidRaw },
      onCheckpoint: async (checkpoint) => { phases.push(checkpoint.caseState.phases[caseId]) },
    }))

    expect(phases).toEqual(['PENDING', 'IN_FLIGHT', 'RAW_RECEIVED', 'FAILED'])
    expect(calls).toBe(1)
    expect(error.category).toBe('PROVIDER_OUTPUT_CONTRACT_ERROR')
    expect(error.caseState).toMatchObject({ phases: { [caseId]: 'FAILED' }, providerCalls: 1, expectedCalls: 1, currentCaseId: null })
    expect(error.rawResponses).toHaveLength(1)
    expect(error.rawResponses[0]).toMatchObject({ caseId, providerResponse: invalidRaw })
    expect(error.decodedResults).toEqual([])

    await expect(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      initialCaseState: error.caseState,
      provider: async () => { calls += 1; return {} },
    })).rejects.toThrow('CALL_LIMIT_ERROR')
    expect(calls).toBe(1)
  })

  it('confirms every lifecycle checkpoint including the final marker', async () => {
    const checkpoints: Array<{ phase: CasePhase; status: string; sequence: number; checkpointStatus: string; rawCount: number; decodedCount: number }> = []
    await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env,
      runtime,
      provider: async (request) => request.providerTemplate,
      onCheckpoint: async (checkpoint) => {
        checkpoints.push({
          phase: checkpoint.caseState.phases[caseId],
          status: checkpoint.status,
          sequence: checkpoint.caseState.checkpointSequence,
          checkpointStatus: checkpoint.checkpointStatus,
          rawCount: checkpoint.rawResponses.length,
          decodedCount: checkpoint.decodedResults.length,
        })
      },
    })

    expect(checkpoints).toEqual([
      { phase: 'PENDING', status: 'INITIALIZED', sequence: 0, checkpointStatus: 'PARTIAL_CHECKPOINT', rawCount: 0, decodedCount: 0 },
      { phase: 'IN_FLIGHT', status: 'RUNNING', sequence: 1, checkpointStatus: 'PARTIAL_CHECKPOINT', rawCount: 0, decodedCount: 0 },
      { phase: 'RAW_RECEIVED', status: 'RUNNING', sequence: 2, checkpointStatus: 'PARTIAL_CHECKPOINT', rawCount: 1, decodedCount: 0 },
      { phase: 'DECODED', status: 'RUNNING', sequence: 3, checkpointStatus: 'PARTIAL_CHECKPOINT', rawCount: 1, decodedCount: 1 },
      { phase: 'SUCCEEDED', status: 'RUNNING', sequence: 4, checkpointStatus: 'PARTIAL_CHECKPOINT', rawCount: 1, decodedCount: 1 },
      { phase: 'SUCCEEDED', status: 'COMPLETED_PENDING_HUMAN_REVIEW', sequence: 5, checkpointStatus: 'FINAL', rawCount: 1, decodedCount: 1 },
    ])
  })

  it('does not call the provider or start another case when the IN_FLIGHT checkpoint fails', async () => {
    let calls = 0
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 2).map((item) => item.caseId)
    const error = await captureRunnerError(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      provider: async (request) => { calls += 1; return request.providerTemplate },
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.caseState.phases[ids[0]] === 'IN_FLIGHT') throw new Error('simulated persistence failure')
      },
    }))

    expect(error.category).toBe('CHECKPOINT_ERROR')
    expect(error.caseState).toMatchObject({
      phases: { [ids[0]]: 'IN_FLIGHT', [ids[1]]: 'PENDING' },
      providerCalls: 1,
      currentCaseId: ids[0],
    })
    expect(calls).toBe(0)
  })

  it('does not retry or start another case when persistence fails after the provider', async () => {
    let calls = 0
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 2).map((item) => item.caseId)
    const error = await captureRunnerError(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      provider: async (request) => { calls += 1; return request.providerTemplate },
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.caseState.phases[ids[0]] === 'RAW_RECEIVED') throw new Error('simulated persistence failure')
      },
    }))

    expect(error.category).toBe('CHECKPOINT_ERROR')
    expect(error.caseState).toMatchObject({
      phases: { [ids[0]]: 'RAW_RECEIVED', [ids[1]]: 'PENDING' },
      providerCalls: 1,
      currentCaseId: ids[0],
    })
    expect(error.rawResponses).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it.each([
    ['IN_FLIGHT', 0, 0],
    ['RAW_RECEIVED', 1, 1],
  ] as Array<[CasePhase, number, number]>)('preserves the real writer marker when %s persistence fails', async (failurePhase, expectedProviderCalls, confirmedSequence) => {
    const directory = await mkdtemp(join(tmpdir(), 'stella-runner-writer-'))
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 2).map((item) => item.caseId)
    let calls = 0
    try {
      const error = await captureRunnerError(runGuardedContextualEvaluation({
        cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
        caseIds: ids,
        env,
        runtime,
        provider: async (request) => { calls += 1; return request.providerTemplate },
        onCheckpoint: async (checkpoint) => {
          await writeTransactionalCheckpoint({
            directory,
            runId: 'run-1',
            scope: 'canary',
            selectedCaseIds: ids,
            caseState: checkpoint.caseState,
            rawResponses: checkpoint.rawResponses,
            decodedResults: checkpoint.decodedResults,
            errors: checkpoint.errors,
            status: checkpoint.status,
            checkpointStatus: checkpoint.checkpointStatus,
            startedAt: '2026-07-30T12:00:00.000Z',
            lastCheckpointAt: checkpoint.lastCheckpointAt,
            hooks: checkpoint.caseState.phases[ids[0]] === failurePhase
              ? { beforeRename: (file) => { if (file === 'run-state.json') throw new Error('simulated marker failure') } }
              : undefined,
          })
        },
      }))

      expect(error.category).toBe('CHECKPOINT_ERROR')
      expect(calls).toBe(expectedProviderCalls)
      expect(JSON.parse(await readFile(join(directory, 'run-state.json'), 'utf8'))).toMatchObject({
        checkpointSequence: confirmedSequence,
      })
      expect(error.caseState.phases[ids[1]]).toBe('PENDING')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
