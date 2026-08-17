import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import type { ContextualMockCase } from '../stella-contextual/cases'

export type RealRunnerScope = 'canary' | 'full'
export type RealRunnerStatus = 'INITIALIZED' | 'RUNNING' | 'INTERRUPTED' | 'FAILED' | 'COMPLETED_PENDING_HUMAN_REVIEW'
export const SAFE_ERROR_CATEGORIES = ['CONFIGURATION_ERROR', 'AUTHORIZATION_ERROR', 'CASE_SELECTION_ERROR', 'DIRTY_TREE_ERROR', 'PROVIDER_ERROR', 'PROVIDER_SCHEMA_ERROR', 'PROVIDER_OUTPUT_CONTRACT_ERROR', 'SOURCE_REFERENCE_ERROR', 'INTERNAL_SCHEMA_ERROR', 'CANONICAL_VALIDATION_ERROR', 'SAFETY_ERROR', 'NUMERIC_INTEGRITY_ERROR', 'CHECKPOINT_ERROR', 'RESUME_INTEGRITY_ERROR', 'CALL_LIMIT_ERROR', 'INTERRUPTED_AFTER_CALL_STARTED'] as const
export type SafeErrorCategory = (typeof SAFE_ERROR_CATEGORIES)[number]

export interface RunnerRuntime { branch: string; head: string; originMainSHA: string; trackedDirty: boolean; stagingDirty: boolean; gitOperationInProgress: boolean }
export interface ProviderRequest { case: ContextualMockCase; systemPrompt: string; userMessage: string; responseJsonSchema: Record<string, unknown>; providerTemplate: Record<string, unknown> }

/**
 * H2 — what ONE provider call cost and how it ended, in numbers.
 *
 * `usageAvailable` is carried up from the adapter rather than inferred from the
 * presence of keys: an absent `thoughtsTokenCount` with `usageAvailable: true`
 * means the provider reported usage and no thinking; the same absence with
 * `usageAvailable: false` means it reported nothing. Collapsing those two into
 * "0" would let a run claim it measured thinking when it did not.
 *
 * `latencyMs` is wall clock around the adapter call, so it includes redaction
 * and JSON parsing. That is deliberate: it is the latency the PRODUCT would
 * experience, which is the number the 15 s production budget has to survive.
 */
export interface ProviderCallTelemetry {
  caseId: string
  requestedModel: string
  providerModelVersion?: string
  responseId?: string
  requestStartedAt: string
  responseReceivedAt: string
  latencyMs: number
  usage: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
  usageAvailable: boolean
  finishReason?: string
  outputChars: number
}

/**
 * H4 — the provider-bound TEXT of the eval request, post-redaction.
 *
 * SCOPE, STATED PRECISELY, because the loose version of this claim ("the exact
 * request Google saw") is wrong and would mislead an auditor:
 *
 *   This file contains, character for character, the two provider-bound TEXT
 *   FIELDS — `systemInstruction` and `contents` — produced by the same
 *   redaction boundary the adapter applies to the eval's request, plus
 *   `responseJsonSchema`.
 *
 *   It does NOT represent the complete HTTP request. `model` is bound through
 *   run-manifest.json instead. `responseMimeType` and `maxOutputTokens` belong
 *   to the adapter's request and are deliberately NOT part of this artifact.
 *   The API key, headers and raw HTTP body are never persisted anywhere.
 *
 * What it IS good for is the thing it was added for: a human auditing a finding
 * can check every factual claim and every citation against the actual text the
 * model was given, without rebuilding the repository at the right commit.
 *
 * `canonicalSourceFieldPaths` is the citation catalog the system prompt
 * advertised for that case, so `sourceFields` in a decoded result can be
 * resolved without re-deriving it.
 */
export interface SanitizedCaseInput {
  caseId: string
  step: string
  category: string
  systemPrompt: string
  userMessage: string
  responseJsonSchema: Record<string, unknown>
  canonicalSourceFieldPaths: readonly string[]
  redaction: 'post-redaction'
}

export type ContextualProviderResult = { response: unknown; telemetry: Omit<ProviderCallTelemetry, 'caseId'> }

/**
 * H2 — a provider may or may not be instrumented.
 *
 * The LIVE provider (run.ts) always returns the telemetry-carrying shape. Test
 * doubles return a bare response, and that is not a gap to be typed away: a
 * stub genuinely has no latency, no token counts and no finishReason, and
 * forcing it to fabricate them would put invented numbers in the same field the
 * evidence package reads.
 *
 * So the type admits both, the runner narrows at runtime, and the guarantee
 * that a REAL run is fully instrumented is enforced where it actually matters —
 * `writeTransactionalCheckpoint` refuses to emit a FINAL bundle whose telemetry
 * does not cover every provider call. A compile-time requirement here would
 * have been weaker, not stronger: it would be satisfiable with zeros.
 */
export type ContextualProviderOutcome = ContextualProviderResult | Record<string, unknown>
export type ContextualProvider = (request: ProviderRequest) => Promise<ContextualProviderOutcome>

/**
 * Narrow a provider outcome to the instrumented shape.
 *
 * Keyed on a NUMERIC `telemetry.latencyMs` rather than on the mere presence of
 * a `telemetry` key, so a model response that happened to contain one would
 * still be treated as a response. In practice a decoded advisor response can
 * carry neither key — `decodeProviderSourceRefIndexes` rejects any property
 * outside its exact allowlist — so this is belt and braces.
 */
export function isInstrumentedProviderResult(value: unknown): value is ContextualProviderResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!('response' in value) || !('telemetry' in value)) return false
  const telemetry = (value as { telemetry: unknown }).telemetry
  return Boolean(telemetry)
    && typeof telemetry === 'object'
    && typeof (telemetry as { latencyMs?: unknown }).latencyMs === 'number'
}
export interface RawResponse { caseId: string; providerResponse: Record<string, unknown>; timestamp: string; error?: SafeRunError }
export interface DecodedResult { caseId: string; output: AdvisorContextualOutput; canonicalValidation: 'passed'; safety: 'pending' | 'passed'; schemaContract: 'passed'; numericIntegrity: 'pending' | 'passed'; requiresHumanReview: true }
export interface SafeRunError { category: SafeErrorCategory; caseId?: string; location: string; type: string; summary: string; timestamp: string }
export interface RealRunnerSummary { runId: string; scope: RealRunnerScope; status: RealRunnerStatus; totalCases: number; processedCases: number; uniqueCaseIds: number; duplicateCaseIds: number; missingCaseIds: number; schemaValidCases: number; schemaInvalidCases: number; invalidSourceFields: number; providerSourceFieldsProperties: number; providerStringReferenceValues: number; providerAliases: number; providerCanonicalPaths: number; providerSFReferences: number; invalidIndexes: number; providerStepMismatches: number; internalCanonicalDecodingCases: number; requiresHumanReviewCases: number; safetyScore: number; schemaContractScore: number; numericIntegrityScore: number; adversarialCasesPassed: number; providerCalls: number; providerResponsesReceived: number; expectedCalls: number; failedCalls: number; successfulResponses: number; failedResponses: number; startedAt: string; completedAt: string; durationMilliseconds: number; eligibleForGate: false; humanReviewStatus: 'NOT_STARTED' }

