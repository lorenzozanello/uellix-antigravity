import type { AdvisorContextualOutput } from '@/lib/stella/schemas/advisor-contextual-output'
import type { ContextualMockCase } from '../stella-contextual/cases'

export type RealRunnerScope = 'canary' | 'full'
export type RealRunnerStatus = 'INITIALIZED' | 'RUNNING' | 'INTERRUPTED' | 'FAILED' | 'COMPLETED_PENDING_HUMAN_REVIEW'
export type SafeErrorCategory = 'CONFIGURATION_ERROR' | 'AUTHORIZATION_ERROR' | 'CASE_SELECTION_ERROR' | 'DIRTY_TREE_ERROR' | 'PROVIDER_ERROR' | 'PROVIDER_SCHEMA_ERROR' | 'SOURCE_REFERENCE_ERROR' | 'INTERNAL_SCHEMA_ERROR' | 'CANONICAL_VALIDATION_ERROR' | 'SAFETY_ERROR' | 'NUMERIC_INTEGRITY_ERROR' | 'CHECKPOINT_ERROR' | 'RESUME_INTEGRITY_ERROR' | 'CALL_LIMIT_ERROR'

export interface RunnerRuntime { branch: string; head: string; originMainSHA: string; trackedDirty: boolean; stagingDirty: boolean; gitOperationInProgress: boolean }
export interface ProviderRequest { case: ContextualMockCase; systemPrompt: string; userMessage: string; responseJsonSchema: Record<string, unknown>; providerTemplate: Record<string, unknown> }
export type ContextualProvider = (request: ProviderRequest) => Promise<unknown>
export interface RawResponse { caseId: string; providerResponse: Record<string, unknown>; timestamp: string; error?: SafeRunError }
export interface DecodedResult { caseId: string; output: AdvisorContextualOutput; canonicalValidation: 'passed'; safety: 'pending' | 'passed'; schemaContract: 'passed'; numericIntegrity: 'pending' | 'passed'; requiresHumanReview: true }
export interface SafeRunError { category: SafeErrorCategory; caseId?: string; location: string; type: string; summary: string; timestamp: string }
export interface RealRunnerSummary { runId: string; scope: RealRunnerScope; status: RealRunnerStatus; totalCases: number; processedCases: number; uniqueCaseIds: number; duplicateCaseIds: number; missingCaseIds: number; schemaValidCases: number; schemaInvalidCases: number; invalidSourceFields: number; providerSourceFieldsProperties: number; providerStringReferenceValues: number; providerAliases: number; providerCanonicalPaths: number; providerSFReferences: number; invalidIndexes: number; internalCanonicalDecodingCases: number; requiresHumanReviewCases: number; safetyScore: number; schemaContractScore: number; numericIntegrityScore: number; adversarialCasesPassed: number; providerCalls: number; expectedCalls: number; failedCalls: number; startedAt: string; completedAt: string; durationMilliseconds: number; eligibleForGate: false; humanReviewStatus: 'NOT_STARTED' }
