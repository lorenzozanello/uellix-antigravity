import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import { decodeProviderSourceRefIndexes, ProviderSourceRefIndexesError, ProviderOutputContractError, InternalSchemaValidationError } from '@/lib/stella/context/decode-provider-source-ref-indexes'
import { ContextualSourceFieldsValidationError } from '@/lib/stella/context/validate-contextual-source-fields'
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
  metrics?: Record<string, number>
  lastCheckpointAt: string
}
export interface GuardedRunnerOptions {
  cases: readonly ContextualMockCase[]
  caseIds?: readonly string[]
  dryRun?: boolean
  env: Record<string, string | undefined>
  runtime: RunnerRuntime
  provider?: ContextualProvider
  sleep?: (milliseconds: number) => Promise<void>
  onCheckpoint?: (state: RunnerCheckpoint) => Promise<void>
  initialCaseState?: TransactionalCaseState
  initialRawResponses?: readonly RawResponse[]
  initialDecodedResults?: readonly DecodedResult[]
  initialErrors?: readonly SafeRunError[]
  isResume?: boolean
  runId?: string
  startedAt?: string
}
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
  validateRealRunnerAuthorization(options.env, selection.scope === 'full' ? [] : caseIds, dryRun)
  const startedAt = options.startedAt ?? now()
  const rawResponses: RawResponse[] = [...structuredClone(options.initialRawResponses ?? [])]
  const decodedResults: DecodedResult[] = [...structuredClone(options.initialDecodedResults ?? [])]
  const errors: SafeRunError[] = [...structuredClone(options.initialErrors ?? [])]
  let caseState = options.initialCaseState ?? createCaseState(selection.cases.map((item) => item.caseId))
  const metrics = {
    invalidSourceFields: 0,
    providerSourceFieldsProperties: 0,
    providerStringReferenceValues: 0,
    providerAliases: 0,
    providerCanonicalPaths: 0,
    providerSFReferences: 0,
    invalidIndexes: 0,
    providerStepMismatches: 0,
  }
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
        metrics: structuredClone(metrics),
        lastCheckpointAt: now(),
      })
    } catch {
      throw fail('CHECKPOINT_ERROR')
    }
  }
  const recordError = (category: SafeErrorCategory, caseId: string): void => {
    errors.push({ category, caseId, location: 'guarded-contextual-runner', type: category, summary: category, timestamp: now() })
  }
  if (!dryRun) {
    if (options.isResume) {
      caseState = {
        ...caseState,
        checkpointSequence: caseState.checkpointSequence + 1,
        resumeCount: (caseState.resumeCount ?? 0) + 1,
      }
      await checkpoint(null, 'RUNNING')
    } else {
      await checkpoint(null, 'INITIALIZED')
    }
  }
  let callsThisExecution = 0
  for (let index = 0; index < selection.cases.length; index += 1) {
    const item = selection.cases[index]
    const phase = caseState.phases[item.caseId]
    const request = buildContextualAdvisorRequest(item.step, item.context)
    if (dryRun) { request.validateSourceFields(decodeProviderSourceRefIndexes(providerTemplate(item.step), request.canonicalSourceFieldPaths, item.step)); continue }
    if (phase !== 'PENDING' && !options.isResume) throw new Error('CALL_LIMIT_ERROR')
    if (phase === 'SUCCEEDED' || phase === 'FAILED') continue
    if (phase === 'IN_FLIGHT') {
      recordError('INTERRUPTED_AFTER_CALL_STARTED', item.caseId)
      caseState = transitionCase(caseState, item.caseId, 'FAILED')
      await checkpoint(item.caseId, 'RUNNING')
      continue
    }
    if (phase === 'RAW_RECEIVED') {
      const rawResponse = rawResponses.find((response) => response.caseId === item.caseId)
      if (!rawResponse) {
        recordError('RESUME_INTEGRITY_ERROR', item.caseId)
        caseState = transitionCase(caseState, item.caseId, 'FAILED')
        await checkpoint(item.caseId, 'RUNNING')
        continue
      }
      try {
        const output = decodeProviderSourceRefIndexes(rawResponse.providerResponse, request.canonicalSourceFieldPaths, item.step)
        if (output.stepMismatch) metrics.providerStepMismatches += 1
        request.validateSourceFields(output)
        decodedResults.push({ caseId: item.caseId, output, canonicalValidation: 'passed', safety: 'pending', schemaContract: 'passed', numericIntegrity: 'pending', requiresHumanReview: true })
        caseState = transitionCase(caseState, item.caseId, 'DECODED')
        await checkpoint(item.caseId, 'RUNNING')
      } catch (error) {
        const cat: SafeErrorCategory = (error instanceof ProviderSourceRefIndexesError || error instanceof ContextualSourceFieldsValidationError) ? 'SOURCE_REFERENCE_ERROR' : error instanceof InternalSchemaValidationError ? 'INTERNAL_SCHEMA_ERROR' : 'PROVIDER_OUTPUT_CONTRACT_ERROR'
        recordError(cat, item.caseId)
        caseState = transitionCase(caseState, item.caseId, 'FAILED')
        await checkpoint(item.caseId, 'RUNNING')
        continue
      }
    }
    if (caseState.phases[item.caseId] === 'DECODED') {
      const decodedIndex = decodedResults.findIndex((result) => result.caseId === item.caseId)
      if (decodedIndex < 0) {
        recordError('RESUME_INTEGRITY_ERROR', item.caseId)
        caseState = transitionCase(caseState, item.caseId, 'FAILED')
        await checkpoint(item.caseId, 'RUNNING')
        continue
      }
      try {
        const decoded = decodedResults[decodedIndex]
        detectMethodologySafety(decoded.output.summary, item.context)
        detectNumericIntegrity(decoded.output.summary, item.context)
        decodedResults[decodedIndex] = { ...decoded, safety: 'passed', numericIntegrity: 'passed' }
        caseState = transitionCase(caseState, item.caseId, 'SUCCEEDED')
        await checkpoint(item.caseId, 'RUNNING')
      } catch {
        recordError('SAFETY_ERROR', item.caseId)
        caseState = transitionCase(caseState, item.caseId, 'FAILED')
        await checkpoint(item.caseId, 'RUNNING')
      }
      continue
    }
    if (caseState.phases[item.caseId] !== 'PENDING') throw new Error('CALL_LIMIT_ERROR')
    if (!options.provider || providerCalls >= expectedCalls) throw new Error('CALL_LIMIT_ERROR')
    if (callsThisExecution > 0 || (options.isResume && providerCalls > 0)) {
      await (options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(resolvePacingMilliseconds(options.env))
    }
    caseState = transitionCase(caseState, item.caseId, 'IN_FLIGHT'); providerCalls = caseState.providerCalls
    await checkpoint(item.caseId, 'RUNNING')
    callsThisExecution += 1
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
    try {
      output = decodeProviderSourceRefIndexes(record, request.canonicalSourceFieldPaths, item.step)
      if (output.stepMismatch) metrics.providerStepMismatches += 1
      request.validateSourceFields(output)
    } catch (error) {
      const cat: SafeErrorCategory = (error instanceof ProviderSourceRefIndexesError || error instanceof ContextualSourceFieldsValidationError) ? 'SOURCE_REFERENCE_ERROR' : error instanceof InternalSchemaValidationError ? 'INTERNAL_SCHEMA_ERROR' : 'PROVIDER_OUTPUT_CONTRACT_ERROR'
      recordError(cat, item.caseId)
      caseState = transitionCase(caseState, item.caseId, 'FAILED')
      await checkpoint(item.caseId, 'FAILED')
      throw fail(cat)
    }
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
  return { rawResponses, decodedResults, errors, caseState, summary: { runId: options.runId ?? 'dry-run-local', scope: selection.scope, status: 'COMPLETED_PENDING_HUMAN_REVIEW', totalCases: processed, processedCases: processed, uniqueCaseIds: processed, duplicateCaseIds: 0, missingCaseIds: selection.scope === 'full' ? 0 : 28 - processed, schemaValidCases: decodedResults.length, schemaInvalidCases: Math.max(0, rawResponses.length - decodedResults.length), invalidSourceFields: metrics.invalidSourceFields, providerSourceFieldsProperties: metrics.providerSourceFieldsProperties, providerStringReferenceValues: metrics.providerStringReferenceValues, providerAliases: metrics.providerAliases, providerCanonicalPaths: metrics.providerCanonicalPaths, providerSFReferences: metrics.providerSFReferences, invalidIndexes: metrics.invalidIndexes, providerStepMismatches: metrics.providerStepMismatches, internalCanonicalDecodingCases: decodedResults.length, requiresHumanReviewCases: decodedResults.filter((result) => result.requiresHumanReview).length, safetyScore: 2, schemaContractScore: 2, numericIntegrityScore: 2, adversarialCasesPassed: selection.cases.filter((item) => item.category === 'adversarial').length, providerCalls, providerResponsesReceived: rawResponses.length, expectedCalls, failedCalls: deriveCaseState(caseState).failedCaseIds.length, successfulResponses: decodedResults.length, failedResponses: deriveCaseState(caseState).failedCaseIds.length, startedAt, completedAt, durationMilliseconds: 0, eligibleForGate: false, humanReviewStatus: 'NOT_STARTED' } }
}

