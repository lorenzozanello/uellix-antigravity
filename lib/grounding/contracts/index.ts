// lib/grounding/contracts/index.ts
// GROUNDING line — the published surface other workstreams build against.
//
// PRODUCT consumes these types; it must not import from lib/grounding/ingest/**
// (implementation) nor reach into individual contract files. CAPABILITIES uses
// them as the source shape for the persistence contract requests recorded in
// docs/ops/contracts/.
//
// Nothing here performs I/O, touches the database, or calls a provider.

export {
  CONTENT_HASH_ALGORITHM,
  CONTENT_HASH_HEX_LENGTH,
  CHUNKER_VERSION,
  INJECTION_SCANNER_VERSION,
  NORMALIZATION_VERSION,
  PIPELINE_VERSIONS,
  GroundingScopeViolationError,
  assertSameScope,
  assertValidScope,
  contentHashEquals,
  hashBytes,
  hashContent,
  isNonEmpty,
  isSameScope,
  parseContentHash,
  requireNonEmpty,
  scopeContains,
  spanLength,
  textSpan,
} from './core'
export type {
  ContentHash,
  GroundingScope,
  NonEmptyReadonlyArray,
  PipelineVersions,
  TextSpan,
} from './core'

export { highestSeverity, mustQuarantine, renderSignalExcerpt } from './safety'
export type {
  PromptInjectionSeverity,
  PromptInjectionSignal,
  PromptInjectionSignalKind,
  ScannedStage,
} from './safety'

export { deriveVersionId } from './documents'
export type {
  DocumentSection,
  DocumentVersion,
  NormalizationStep,
  NormalizationStepId,
  NormalizedDocument,
  SourceDocument,
  SourceDocumentKind,
} from './documents'

export { deriveChunkId, lineRangeForSpan } from './chunks'
export type {
  ChunkLocation,
  DeduplicationRecord,
  GroundingChunk,
  ProvenanceRecord,
} from './chunks'

export {
  DEFAULT_RETRIEVAL_MIN_SCORE,
  DEFAULT_RETRIEVAL_TOP_K,
  buildRetrievalQuery,
} from './retrieval'
export type {
  RetrievalCandidate,
  RetrievalQuery,
  RetrievalResult,
  RetrievalStrategy,
} from './retrieval'

export { citationsOf, toCitableChunkRecord, validateAnswerCitations } from './answer'
export type {
  AbsenceAssertion,
  AbstainedAnswerState,
  AbstentionReason,
  AbstentionReasonCode,
  AnswerValidationIssue,
  CitableChunkRecord,
  CitationReference,
  ContradictionMarker,
  EvidenceAssertion,
  GroundedAnswerState,
  GroundingAnswerState,
  GroundingAnswerStatus,
  GroundingAssertion,
  GroundingAssertionKind,
  InferenceAssertion,
  RecommendationAssertion,
} from './answer'
