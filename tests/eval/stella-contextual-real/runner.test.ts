import { describe, expect, it } from 'vitest'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import { parseRealRunnerArgs, selectRealRunnerCases, validateRealRunnerAuthorization } from './guards'
import { runGuardedContextualEvaluation } from './runner'

const env = { STELLA_PROVIDER_MODE: 'paid_gemini', GEMINI_API_KEY: 'test-key', STELLA_REAL_EVAL_ACK: 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL', STELLA_REAL_EVAL_SUBSET_ACK: 'B1C_CURRENT_ARCHITECTURE_CANARY', STELLA_REAL_EVAL_FULL_ACK: 'B1C_CURRENT_ARCHITECTURE_FULL_28' }

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
    [['--unknown'], 'error'], [['--resume', 'run', '--case-id', 'b1c-stakeholders-complete'], 'error'],
  ])('parses CLI safely: %o', (args, key) => {
    if (key === 'error') expect(() => parseRealRunnerArgs(args)).toThrow()
    else expect(parseRealRunnerArgs(args)).toHaveProperty(key)
  })

  it('runs dry-run without key or provider calls', async () => {
    const result = await runGuardedContextualEvaluation({ cases: OFFICIAL_CONTEXTUAL_MOCK_CASES, caseIds: ['b1c-stakeholders-complete'], dryRun: true, env: {}, runtime: { branch: 'branch', head: 'head', originMainSHA: 'base', trackedDirty: false, stagingDirty: false, gitOperationInProgress: false } })
    expect(result.summary).toMatchObject({ processedCases: 1, expectedCalls: 1, providerCalls: 0, scope: 'canary' })
  })

  it('executes injected provider exactly once and preserves raw indexes', async () => {
    let calls = 0
    const result = await runGuardedContextualEvaluation({ cases: OFFICIAL_CONTEXTUAL_MOCK_CASES, caseIds: ['b1c-stakeholders-complete'], env, runtime: { branch: 'branch', head: 'head', originMainSHA: 'base', trackedDirty: false, stagingDirty: false, gitOperationInProgress: false }, provider: async (request) => { calls += 1; const template = request.providerTemplate as { findings: Array<Record<string, unknown>>; suggestions: Array<Record<string, unknown>> }; return { ...template, findings: [{ ...template.findings[0], sourceRefIndexes: [0] }], suggestions: [{ ...template.suggestions[0], sourceRefIndexes: [0] }] } } })
    expect(calls).toBe(1)
    expect(result.summary.providerCalls).toBe(1)
    expect((result.rawResponses[0].providerResponse.findings as Array<Record<string, unknown>>)[0].sourceRefIndexes).toEqual([0])
    expect(result.decodedResults[0].output.findings[0].sourceFields).toHaveLength(1)
  })
})
