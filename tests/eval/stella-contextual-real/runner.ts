import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import { decodeProviderSourceRefIndexes } from '@/lib/stella/context/decode-provider-source-ref-indexes'
import { buildAdvisorContextualUserMessage } from '@/lib/stella/prompts/advisor-contextual-system'
import { detectMethodologySafety, detectNumericIntegrity } from '../stella-contextual/harness'
import { resolvePacingMilliseconds, selectRealRunnerCases, validateRealRunnerAuthorization, validateRuntimeGuards } from './guards'
import type { ContextualProvider, DecodedResult, RawResponse, RealRunnerSummary, RunnerRuntime, SafeErrorCategory } from './types'
import type { ContextualMockCase } from '../stella-contextual/cases'
import { assertCaseStateInvariants, createCaseState, deriveCaseState, transitionCase, type TransactionalCaseState } from './case-state'

const now = () => new Date().toISOString()
const providerTemplate = (step: string) => ({ step, responseType: 'review', summary: 'Requiere revisión humana.', findings: [{ id: 'finding-1', severity: 'warning', title: 'Revisión', explanation: 'Datos registrados.', sourceRefIndexes: [] }], suggestions: [{ id: 'suggestion-1', proposedText: null, rationale: 'Orientación metodológica.', missingInformation: [], sourceRefIndexes: [] }], clarifyingQuestions: [], limitations: [], requiresHumanReview: true })

export interface RunnerCheckpoint { caseId: string; providerCalls: number; failed: boolean; caseState: TransactionalCaseState }
export interface GuardedRunnerOptions { cases: readonly ContextualMockCase[]; caseIds?: readonly string[]; dryRun?: boolean; env: Record<string, string | undefined>; runtime: RunnerRuntime; provider?: ContextualProvider; sleep?: (milliseconds: number) => Promise<void>; onCheckpoint?: (state: RunnerCheckpoint) => Promise<void>; initialCaseState?: TransactionalCaseState }
export interface GuardedRunnerResult { summary: RealRunnerSummary; rawResponses: RawResponse[]; decodedResults: DecodedResult[]; caseState: TransactionalCaseState }

export class GuardedRunnerExecutionError extends Error {
  constructor(
    readonly category: SafeErrorCategory,
    readonly caseState: TransactionalCaseState,
    readonly rawResponses: RawResponse[],
    readonly decodedResults: DecodedResult[],
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
  const startedAt = now(); const rawResponses: RawResponse[] = []; const decodedResults: DecodedResult[] = []
  let caseState = options.initialCaseState ?? createCaseState(selection.cases.map((item) => item.caseId))
  const expectedCalls = selection.cases.length
  assertCaseStateInvariants(caseState, selection.cases.map((item) => item.caseId))
  let providerCalls = caseState.providerCalls
  const checkpoint = async (caseId: string, failed: boolean) => options.onCheckpoint?.({ caseId, providerCalls, failed, caseState: structuredClone(caseState) })
  const fail = (category: SafeErrorCategory) => new GuardedRunnerExecutionError(category, structuredClone(caseState), structuredClone(rawResponses), structuredClone(decodedResults))
  for (let index = 0; index < selection.cases.length; index += 1) {
    const item = selection.cases[index]
    const phase = caseState.phases[item.caseId]
    if (phase !== 'PENDING') throw new Error('CALL_LIMIT_ERROR')
    const request = buildContextualAdvisorRequest(item.step, item.context)
    if (dryRun) { request.validateSourceFields(decodeProviderSourceRefIndexes(providerTemplate(item.step), request.canonicalSourceFieldPaths)); continue }
    if (!options.provider || providerCalls >= expectedCalls) throw new Error('CALL_LIMIT_ERROR')
    if (index > 0) await (options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(resolvePacingMilliseconds(options.env))
    caseState = transitionCase(caseState, item.caseId, 'IN_FLIGHT'); providerCalls = caseState.providerCalls
    await checkpoint(item.caseId, false)
    let raw: unknown
    try {
      raw = await options.provider({ case: item, systemPrompt: request.systemPrompt, userMessage: buildAdvisorContextualUserMessage(item.step, request.serializedContext, item.userQuestion), responseJsonSchema: request.responseJsonSchema, providerTemplate: providerTemplate(item.step) })
    } catch {
      caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, true)
      throw fail('PROVIDER_ERROR')
    }
    const record = raw as Record<string, unknown>
    rawResponses.push({ caseId: item.caseId, providerResponse: structuredClone(record), timestamp: now() })
    caseState = transitionCase(caseState, item.caseId, 'RAW_RECEIVED'); await checkpoint(item.caseId, false)
    let output
    try { output = decodeProviderSourceRefIndexes(record, request.canonicalSourceFieldPaths); request.validateSourceFields(output) } catch { caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, true); throw fail('SOURCE_REFERENCE_ERROR') }
    caseState = transitionCase(caseState, item.caseId, 'DECODED'); await checkpoint(item.caseId, false)
    try { detectMethodologySafety(output.summary, item.context); detectNumericIntegrity(output.summary, item.context) } catch { caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, true); throw fail('SAFETY_ERROR') }
    decodedResults.push({ caseId: item.caseId, output, canonicalValidation: 'passed', safety: 'passed', schemaContract: 'passed', numericIntegrity: 'passed', requiresHumanReview: true })
    caseState = transitionCase(caseState, item.caseId, 'SUCCEEDED'); await checkpoint(item.caseId, false)
  }
  if (!dryRun && providerCalls !== expectedCalls) throw new Error('CALL_LIMIT_ERROR')
  const completedAt = now(); const processed = selection.cases.length
  return { rawResponses, decodedResults, caseState, summary: { runId: 'dry-run-local', scope: selection.scope, status: 'COMPLETED_PENDING_HUMAN_REVIEW', totalCases: processed, processedCases: processed, uniqueCaseIds: processed, duplicateCaseIds: 0, missingCaseIds: selection.scope === 'full' ? 0 : 28 - processed, schemaValidCases: processed, schemaInvalidCases: 0, invalidSourceFields: 0, providerSourceFieldsProperties: 0, providerStringReferenceValues: 0, providerAliases: 0, providerCanonicalPaths: 0, providerSFReferences: 0, invalidIndexes: 0, internalCanonicalDecodingCases: processed, requiresHumanReviewCases: processed, safetyScore: 2, schemaContractScore: 2, numericIntegrityScore: 2, adversarialCasesPassed: selection.cases.filter((item) => item.category === 'adversarial').length, providerCalls, expectedCalls, failedCalls: deriveCaseState(caseState).failedCaseIds.length, startedAt, completedAt, durationMilliseconds: 0, eligibleForGate: false, humanReviewStatus: 'NOT_STARTED' } }
}
