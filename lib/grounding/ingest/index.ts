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
} from './ingest-document'

export { MAX_NORMALIZED_CHARS, normalizeDocumentText } from './normalize'
export type { NormalizationOutput } from './normalize'

export { MAX_CHUNKS_PER_DOCUMENT, chunkNormalizedDocument } from './chunk-document'
export type { ChunkDocumentOptions, ChunkDocumentOutput } from './chunk-document'

export { INJECTION_RULE_IDS, scanNormalizedText, scanRawText } from './injection-scan'
