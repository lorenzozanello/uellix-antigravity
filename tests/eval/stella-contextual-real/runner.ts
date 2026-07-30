import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import { decodeProviderSourceRefIndexes } from '@/lib/stella/context/decode-provider-source-ref-indexes'
import { buildAdvisorContextualUserMessage } from '@/lib/stella/prompts/advisor-contextual-system'
import { detectMethodologySafety, detectNumericIntegrity } from '../stella-contextual/harness'
import { resolvePacingMilliseconds, selectRealRunnerCases, validateRealRunnerAuthorization, validateRuntimeGuards } from './guards'
import type { ContextualProvider, DecodedResult, RawResponse, RealRunnerStatus, RealRunnerSummary, RunnerRuntime, SafeErrorCategory, SafeRunError } from './types'
import type { ContextualMockCase } from '../stella-contextual/cases'
import { assertCaseStateInvariants, createCaseState, deriveCaseState, transitionCase, type TransactionalCaseState } from './case-state'
import type { CheckpointCommitStatus } from './transactional-writer'

const now = () => new Date().toISOString()
const providerTemplate = (step: string) => ({ step, responseType: 'review', summary: 'Requiere revisión humana.', findings: [{ id: 'finding-1', severity: 'warning', title: 'Revisión', explanation: 'Datos registrados.', sourceRefIndexes: [] }], suggestions: [{ id: 'suggestion-1', proposedText: null, rationale: 'Orientación metodológica.', missingInformation: [], sourceRefIndexes: [] }], clarifyingQuestions: [], limitations: [], requiresHumanReview: true })

export interface RunnerCheckpoint {
  caseId: string | null
  providerCalls: number
  failed: boolean
  status: RealRunnerStatus
  checkpointStatus: CheckpointCommitStatus
  caseState: TransactionalCaseState
  rawResponses: RawResponse[]
  decodedResults: DecodedResult[]
  errors: SafeRunError[]
  lastCheckpointAt: string
}
export interface GuardedRunnerOptions { cases: readonly ContextualMockCase[]; caseIds?: readonly string[]; dryRun?: boolean; env: Record<string, string | undefined>; runtime: RunnerRuntime; provider?: ContextualProvider; sleep?: (milliseconds: number) => Promise<void>; onCheckpoint?: (state: RunnerCheckpoint) => Promise<void>; initialCaseState?: TransactionalCaseState }
export interface GuardedRunnerResult { summary: RealRunnerSummary; rawResponses: RawResponse[]; decodedResults: DecodedResult[]; errors: SafeRunError[]; caseState: TransactionalCaseState }

export class GuardedRunnerExecutionError extends Error {
  constructor(
    readonly category: SafeErrorCategory,
    readonly caseState: TransactionalCaseState,
    readonly rawResponses: RawResponse[],
    readonly decodedResults: DecodedResult[],
    readonly errors: SafeRunError[],
  ) {
    super(category)
    this.name = 'GuardedRunnerExecutionError'
  }
}

export async function runGuardedContextualEvaluation(options: GuardedRunnerOptions): Promise<GuardedRunnerResult> {
  const caseIds = options.caseIds ?? []
  const selection = selectRealRunnerCases(options.cases, caseIds)
  const dryRun = options.dryRun === true
  validateRuntimeGuards(options.runtime, dryRun)
  validateRealRunnerAuthorization(options.env, caseIds, dryRun)
  const startedAt = now(); const rawResponses: RawResponse[] = []; const decodedResults: DecodedResult[] = []; const errors: SafeRunError[] = []
  let caseState = options.initialCaseState ?? createCaseState(selection.cases.map((item) => item.caseId))
  const expectedCalls = selection.cases.length
  assertCaseStateInvariants(caseState, selection.cases.map((item) => item.caseId))
  let providerCalls = caseState.providerCalls
  const fail = (category: SafeErrorCategory) => new GuardedRunnerExecutionError(category, structuredClone(caseState), structuredClone(rawResponses), structuredClone(decodedResults), structuredClone(errors))
  const checkpoint = async (caseId: string | null, status: RealRunnerStatus, checkpointStatus: CheckpointCommitStatus = 'PARTIAL_CHECKPOINT') => {
    if (!options.onCheckpoint) return
    try {
      await options.onCheckpoint({
        caseId,
        providerCalls,
        failed: status === 'FAILED',
        status,
        checkpointStatus,
        caseState: structuredClone(caseState),
        rawResponses: structuredClone(rawResponses),
        decodedResults: structuredClone(decodedResults),
        errors: structuredClone(errors),
        lastCheckpointAt: now(),
      })
    } catch {
      throw fail('CHECKPOINT_ERROR')
    }
  }
  const recordError = (category: SafeErrorCategory, caseId: string): void => {
    errors.push({ category, caseId, location: 'guarded-contextual-runner', type: category, summary: category, timestamp: now() })
  }
  if (!dryRun) await checkpoint(null, 'INITIALIZED')
  for (let index = 0; index < selection.cases.length; index += 1) {
    const item = selection.cases[index]
    const phase = caseState.phases[item.caseId]
    if (phase !== 'PENDING') throw new Error('CALL_LIMIT_ERROR')
    const request = buildContextualAdvisorRequest(item.step, item.context)
    if (dryRun) { request.validateSourceFields(decodeProviderSourceRefIndexes(providerTemplate(item.step), request.canonicalSourceFieldPaths)); continue }
    if (!options.provider || providerCalls >= expectedCalls) throw new Error('CALL_LIMIT_ERROR')
    if (index > 0) await (options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(resolvePacingMilliseconds(options.env))
    caseState = transitionCase(caseState, item.caseId, 'IN_FLIGHT'); providerCalls = caseState.providerCalls
    await checkpoint(item.caseId, 'RUNNING')
    let raw: unknown
    try {
      raw = await options.provider({ case: item, systemPrompt: request.systemPrompt, userMessage: buildAdvisorContextualUserMessage(item.step, request.serializedContext, item.userQuestion), responseJsonSchema: request.responseJsonSchema, providerTemplate: providerTemplate(item.step) })
    } catch {
      recordError('PROVIDER_ERROR', item.caseId)
      caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, 'FAILED')
      throw fail('PROVIDER_ERROR')
    }
    const record = raw as Record<string, unknown>
    rawResponses.push({ caseId: item.caseId, providerResponse: structuredClone(record), timestamp: now() })
    caseState = transitionCase(caseState, item.caseId, 'RAW_RECEIVED'); await checkpoint(item.caseId, 'RUNNING')
    let output
    try { output = decodeProviderSourceRefIndexes(record, request.canonicalSourceFieldPaths); request.validateSourceFields(output) } catch { recordError('SOURCE_REFERENCE_ERROR', item.caseId); caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, 'FAILED'); throw fail('SOURCE_REFERENCE_ERROR') }
    decodedResults.push({ caseId: item.caseId, output, canonicalValidation: 'passed', safety: 'pending', schemaContract: 'passed', numericIntegrity: 'pending', requiresHumanReview: true })
    caseState = transitionCase(caseState, item.caseId, 'DECODED'); await checkpoint(item.caseId, 'RUNNING')
    try { detectMethodologySafety(output.summary, item.context); detectNumericIntegrity(output.summary, item.context) } catch { recordError('SAFETY_ERROR', item.caseId); caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, 'FAILED'); throw fail('SAFETY_ERROR') }
    decodedResults[decodedResults.length - 1] = { ...decodedResults[decodedResults.length - 1], safety: 'passed', numericIntegrity: 'passed' }
    caseState = transitionCase(caseState, item.caseId, 'SUCCEEDED'); await checkpoint(item.caseId, 'RUNNING')
  }
  if (!dryRun && providerCalls !== expectedCalls) throw new Error('CALL_LIMIT_ERROR')
  const completedAt = now(); const processed = selection.cases.length
  if (!dryRun) {
    caseState = { ...caseState, checkpointSequence: caseState.checkpointSequence + 1 }
    await checkpoint(null, 'COMPLETED_PENDING_HUMAN_REVIEW', 'FINAL')
  }
  return { rawResponses, decodedResults, errors, caseState, summary: { runId: 'dry-run-local', scope: selection.scope, status: 'COMPLETED_PENDING_HUMAN_REVIEW', totalCases: processed, processedCases: processed, uniqueCaseIds: processed, duplicateCaseIds: 0, missingCaseIds: selection.scope === 'full' ? 0 : 28 - processed, schemaValidCases: processed, schemaInvalidCases: 0, invalidSourceFields: 0, providerSourceFieldsProperties: 0, providerStringReferenceValues: 0, providerAliases: 0, providerCanonicalPaths: 0, providerSFReferences: 0, invalidIndexes: 0, internalCanonicalDecodingCases: processed, requiresHumanReviewCases: processed, safetyScore: 2, schemaContractScore: 2, numericIntegrityScore: 2, adversarialCasesPassed: selection.cases.filter((item) => item.category === 'adversarial').length, providerCalls, expectedCalls, failedCalls: deriveCaseState(caseState).failedCaseIds.length, startedAt, completedAt, durationMilliseconds: 0, eligibleForGate: false, humanReviewStatus: 'NOT_STARTED' } }
}
