// lib/grounding/retrieve/index.ts
// GROUNDING line — the retrieval surface published to other workstreams.
//
// As with lib/grounding/contracts/index.ts, this barrel is the boundary:
// consumers import from here, not from the individual files.

export {
  DEFAULT_CANDIDATE_LIMIT,
  InMemoryChunkRepository,
  RepositoryContractViolationError,
  assertChunkSatisfiesQuery,
  buildChunkQuery,
  enforceRepositoryScope,
} from './repository'
export type { ChunkQuery, GroundingChunkRepository } from './repository'

export { LexicalChunkScorer, TF_SATURATION_K, normalizeQueryText } from './scorer'
export type { ChunkScorer, NormalizedQuery } from './scorer'

export {
  DEFAULT_MAX_PER_DOCUMENT,
  DEFAULT_MIN_DISTINCT_SOURCES,
  retrieveGroundedChunks,
} from './retrieve'
export type {
  RetrievalExclusion,
  RetrievalExclusionReason,
  ScopedRetrievalOptions,
  ScopedRetrievalResult,
} from './retrieve'

export {
  RELEVANCE_THRESHOLDS,
  RELEVANCE_THRESHOLDS_VERSION,
  presentRelevance,
  relevanceBucket,
} from './calibration'
export type { PresentedRelevance, RelevanceBucket } from './calibration'

export { orchestrateGroundedResponse } from './orchestrate'
export type {
  AnswerDraftProvider,
  AnswerDraftRequest,
  GroundingOrchestrationClassification,
  GroundingOrchestrationResult,
  OrchestrateGroundedResponseOptions,
} from './orchestrate'

export { buildGroundedAnswer, providerUnavailableOutcome } from './grounded-answer'
export type {
  AnswerDraft,
  ClaimRejectionReason,
  DraftClaim,
  DraftContradiction,
  DraftContradictionSide,
  GroundedOutcome,
  GroundedOutcomeKind,
  ProviderUnavailableOutcome,
  RejectedClaim,
  RejectedContradiction,
} from './grounded-answer'
