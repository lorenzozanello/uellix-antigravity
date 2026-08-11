// lib/grounding/ingest/index.ts
// GROUNDING line — the ingestion core's public entry points.
//
// Consumers should need only `ingestDocument`; the individual stages are
// exported because they are independently useful for verification (a reviewer
// re-running normalization to check an anchor) and for tests.

export { ingestDocument } from './ingest-document'
export type {
  IngestOptions,
  IngestionIngested,
  IngestionOutcome,
  IngestionRejectReason,
  IngestionRejected,
  IngestionSkipReason,
  IngestionSkipped,
  PreviousVersionRef,
} from './ingest-document'

export {
  GroundingPersistenceError,
  buildEvidenceChunkPayload,
  currentPipelineIdentity,
  isRetryablePersistenceFailure,
  parseDocumentVersionRef,
} from './persistence'
export type {
  ActiveDocumentVersionState,
  DocumentVersionRef,
  EvidenceChunkPayloadRow,
  FinalizeDocumentIngestionRequest,
  GroundingIngestionRepository,
  GroundingPersistenceFailureKind,
  GroundingPersistenceOperation,
  InsertEvidenceChunksRequest,
  RegisterDocumentVersionRequest,
} from './persistence'

export { ingestEvidenceDocument } from './orchestrate-ingestion'
export type {
  IngestEvidenceOptions,
  IngestionRunFailure,
  IngestionRunNotIndexed,
  IngestionRunOutcome,
  IngestionRunPersisted,
  IngestionStage,
  ReingestionKind,
} from './orchestrate-ingestion'

export { resolveEvidenceSource } from './resolve-evidence-source'
export type {
  EvidenceObjectReader,
  EvidenceSourceRecord,
  EvidenceSourceRefusal,
  EvidenceSourceResolution,
} from './resolve-evidence-source'

export { MAX_NORMALIZED_CHARS, normalizeDocumentText } from './normalize'
export type { NormalizationOutput } from './normalize'

export { MAX_CHUNKS_PER_DOCUMENT, chunkNormalizedDocument } from './chunk-document'
export type { ChunkDocumentOptions, ChunkDocumentOutput } from './chunk-document'

export { INJECTION_RULE_IDS, scanNormalizedText, scanRawText } from './injection-scan'
