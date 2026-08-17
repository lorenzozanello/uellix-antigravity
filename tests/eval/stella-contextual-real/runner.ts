import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import { decodeProviderSourceRefIndexes, ProviderSourceRefIndexesError, InternalSchemaValidationError } from '@/lib/stella/context/decode-provider-source-ref-indexes'
import { ContextualSourceFieldsValidationError } from '@/lib/stella/context/validate-contextual-source-fields'
import { buildAdvisorContextualUserMessage } from '@/lib/stella/prompts/advisor-contextual-system'
import { redactProviderRequest } from '@/lib/stella/security/redact-model-bound'
import { runAdvisorOutputTextDetectors } from '../stella-contextual/harness'
import { resolvePacingMilliseconds, selectRealRunnerCases, validateRealRunnerAuthorization, validateRuntimeGuards } from './guards'
import { isInstrumentedProviderResult } from './types'
import type { ContextualProvider, DecodedResult, ProviderCallTelemetry, RawResponse, RealRunnerStatus, RealRunnerSummary, RunnerRuntime, SafeErrorCategory, SafeRunError, SanitizedCaseInput } from './types'
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
  /** H2: one entry per provider call actually made, keyed by caseId. */
  telemetry: ProviderCallTelemetry[]
  /** H4: post-redaction provider-bound inputs for every SELECTED case. */
  sanitizedInputs: SanitizedCaseInput[]
  /**
   * H5: the adversarial subset, passed down so the writer can compute
   * `adversarialCasesPassed` from case state instead of parsing case ids.
   */
  adversarialCaseIds: string[]
  metrics?: Record<string, number>
  lastCheckpointAt: string
}

/**
 * H4 — derive the provider-bound TEXT for one case, post-redaction.
 *
 * Runs the SAME `redactProviderRequest` the adapter applies at its boundary, on
 * the SAME strings the runner hands the provider, so the two text fields are
 * byte-identical to the ones that egress rather than a reconstruction of them.
 * Redaction is idempotent, so applying it here and again inside the adapter
 * yields the same bytes. This is the request TEXT, not the whole HTTP request —
 * see SanitizedCaseInput for exactly what is and is not covered.
 *
 * Deterministic from the frozen case catalog, which is why it is recomputed on
 * every execution instead of being carried through resume: a recomputation that
 * disagreed with the stored file would mean the catalog moved, and that is
 * exactly the tampering the hash chain should surface.
 */
function sanitizedInputFor(
  item: ContextualMockCase,
  request: { systemPrompt: string; responseJsonSchema: Record<string, unknown>; canonicalSourceFieldPaths: readonly string[]; serializedContext: ContextualMockCase['context'] },
): SanitizedCaseInput {
  const safe = redactProviderRequest({
    role: 'advisor',
    systemPrompt: request.systemPrompt,
    userMessage: buildAdvisorContextualUserMessage(item.step, request.serializedContext, item.userQuestion),
  })
  return {
    caseId: item.caseId,
    step: item.step,
    category: item.category,
    systemPrompt: safe.systemPrompt,
    userMessage: safe.userMessage,
    responseJsonSchema: request.responseJsonSchema,
    canonicalSourceFieldPaths: request.canonicalSourceFieldPaths,
    redaction: 'post-redaction',
  }
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
  /** H2: telemetry recovered from a prior execution's checkpoint. */
  initialTelemetry?: readonly ProviderCallTelemetry[]
  isResume?: boolean
  runId?: string
  startedAt?: string
}
export interface GuardedRunnerResult { summary: RealRunnerSummary; rawResponses: RawResponse[]; decodedResults: DecodedResult[]; errors: SafeRunError[]; telemetry: ProviderCallTelemetry[]; sanitizedInputs: SanitizedCaseInput[]; caseState: TransactionalCaseState }

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
  const telemetry: ProviderCallTelemetry[] = [...structuredClone(options.initialTelemetry ?? [])]
  // H4: derived for EVERY selected case up front, not per call, so an
  // interrupted run still ships a complete, auditable input set.
  const sanitizedInputs: SanitizedCaseInput[] = []
  const adversarialCaseIds = selection.cases.filter((item) => item.category === 'adversarial').map((item) => item.caseId)
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
        telemetry: structuredClone(telemetry),
        sanitizedInputs: structuredClone(sanitizedInputs),
        adversarialCaseIds: [...adversarialCaseIds],
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
    // H4: recorded for EVERY selected case, before the phase gates below skip
    // work that a resume has already done — an evidence package missing the
    // inputs for the cases it resumed would be unauditable exactly where the
    // run was most eventful.
    sanitizedInputs.push(sanitizedInputFor(item, request))
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
      {
        // U9: detectors run over ALL text fields, not only the summary.
        const decoded = decodedResults[decodedIndex]
        const detectors = runAdvisorOutputTextDetectors(decoded.output, item.context)
        if (detectors.safety === 'passed' && detectors.numericIntegrity === 'passed') {
          decodedResults[decodedIndex] = { ...decoded, safety: 'passed', numericIntegrity: 'passed' }
          caseState = transitionCase(caseState, item.caseId, 'SUCCEEDED')
          await checkpoint(item.caseId, 'RUNNING')
        } else {
          recordError(detectors.safety !== 'passed' ? 'SAFETY_ERROR' : 'NUMERIC_INTEGRITY_ERROR', item.caseId)
          caseState = transitionCase(caseState, item.caseId, 'FAILED')
          await checkpoint(item.caseId, 'RUNNING')
        }
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
      const produced = await options.provider({ case: item, systemPrompt: request.systemPrompt, userMessage: buildAdvisorContextualUserMessage(item.step, request.serializedContext, item.userQuestion), responseJsonSchema: request.responseJsonSchema, providerTemplate: providerTemplate(item.step) })
      if (isInstrumentedProviderResult(produced)) {
        raw = produced.response
        // H2: the caseId is stamped HERE, from the loop's own `item`, and never
        // taken from the provider. A telemetry row therefore cannot be
        // attributed to a case the runner was not executing — the mismatch a
        // crash/resume cycle would otherwise be free to introduce.
        //
        // ORDER IS LOad-BEARING: the spread comes FIRST so `caseId` overwrites
        // anything the provider supplied. Written the other way round it read
        // identically and did the opposite — a provider returning its own
        // `caseId` silently won. Pinned by "stamps the caseId from the runner
        // loop, never from the provider" in evidence-hardening.test.ts.
        telemetry.push({ ...produced.telemetry, caseId: item.caseId })
      } else {
        // An uninstrumented provider (test double). No telemetry is INVENTED
        // for it — the absence is carried through and the FINAL bundle gate in
        // writeTransactionalCheckpoint refuses to certify a real run this way.
        raw = produced
      }
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
    // U9: detectors run over ALL text fields, not only the summary.
    const detectors = runAdvisorOutputTextDetectors(output, item.context)
    if (detectors.safety !== 'passed' || detectors.numericIntegrity !== 'passed') {
      const category: SafeErrorCategory = detectors.safety !== 'passed' ? 'SAFETY_ERROR' : 'NUMERIC_INTEGRITY_ERROR'
      recordError(category, item.caseId); caseState = transitionCase(caseState, item.caseId, 'FAILED'); await checkpoint(item.caseId, 'FAILED'); throw fail(category)
    }
    decodedResults[decodedResults.length - 1] = { ...decodedResults[decodedResults.length - 1], safety: 'passed', numericIntegrity: 'passed' }
    caseState = transitionCase(caseState, item.caseId, 'SUCCEEDED'); await checkpoint(item.caseId, 'RUNNING')
  }
  if (!dryRun && providerCalls !== expectedCalls) throw new Error('CALL_LIMIT_ERROR')
  const completedAt = now(); const processed = selection.cases.length
  if (!dryRun) {
    caseState = { ...caseState, checkpointSequence: caseState.checkpointSequence + 1 }
    await checkpoint(null, 'COMPLETED_PENDING_HUMAN_REVIEW', 'FINAL')
  }
  // U9: scores are computed from actual detector/decoding results — never
  // hardcoded. Gate semantics stay intact: eligibleForGate is always false
  // and human review is always required.
  const schemaInvalidCases = Math.max(0, rawResponses.length - decodedResults.length)
  const safetyViolationCount = errors.filter((item) => item.category === 'SAFETY_ERROR').length
  const numericViolationCount = errors.filter((item) => item.category === 'NUMERIC_INTEGRITY_ERROR').length
  const safetyScore = safetyViolationCount === 0 ? 2 : 0
  const numericIntegrityScore = numericViolationCount === 0 ? 2 : 0
  const schemaContractScore = schemaInvalidCases === 0 ? 2 : 0
  const adversarialCasesPassed = selection.cases.filter((item) => item.category === 'adversarial' && caseState.phases[item.caseId] === 'SUCCEEDED').length
  return { rawResponses, decodedResults, errors, telemetry, sanitizedInputs, caseState, summary: { runId: options.runId ?? 'dry-run-local', scope: selection.scope, status: 'COMPLETED_PENDING_HUMAN_REVIEW', totalCases: processed, processedCases: processed, uniqueCaseIds: processed, duplicateCaseIds: 0, missingCaseIds: selection.scope === 'full' ? 0 : 28 - processed, schemaValidCases: decodedResults.length, schemaInvalidCases, invalidSourceFields: metrics.invalidSourceFields, providerSourceFieldsProperties: metrics.providerSourceFieldsProperties, providerStringReferenceValues: metrics.providerStringReferenceValues, providerAliases: metrics.providerAliases, providerCanonicalPaths: metrics.providerCanonicalPaths, providerSFReferences: metrics.providerSFReferences, invalidIndexes: metrics.invalidIndexes, providerStepMismatches: metrics.providerStepMismatches, internalCanonicalDecodingCases: decodedResults.length, requiresHumanReviewCases: decodedResults.filter((result) => result.requiresHumanReview).length, safetyScore, schemaContractScore, numericIntegrityScore, adversarialCasesPassed, providerCalls, providerResponsesReceived: rawResponses.length, expectedCalls, failedCalls: deriveCaseState(caseState).failedCaseIds.length, successfulResponses: decodedResults.length, failedResponses: deriveCaseState(caseState).failedCaseIds.length, startedAt, completedAt, durationMilliseconds: 0, eligibleForGate: false, humanReviewStatus: 'NOT_STARTED' } }
}

