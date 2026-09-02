// lib/grounding/corpus-state.ts
// G-01 (product path) — the READ MODEL of the governed grounding corpus,
// expressed as a pure function of durable facts.
//
// ---------------------------------------------------------------------------
// NO NEW COLUMN, AND WHY THAT IS NOT A COMPROMISE
// ---------------------------------------------------------------------------
// The obvious way to show indexing state is a status column on
// `evidence_items`. It would also be the wrong one, twice over:
//
//   * it would be a SECOND answer to "is this indexed?", free to disagree with
//     the corpus it claims to describe — a row marked `indexed` whose chunks
//     were rolled back is exactly the state `finalize_document_ingestion`
//     exists to make impossible, reintroduced one table away from it;
//   * `evidence_document_versions` is chain of custody. It already answers the
//     question, positively and transactionally: the version row and its chunks
//     are written in ONE transaction, so a committed row IS proof the chunks
//     committed with it.
//
// So the state is DERIVED, and the derivation is pure — no database, no clock,
// no session — which is what lets the whole precedence table be pinned by
// ordinary unit tests.
//
// ---------------------------------------------------------------------------
// THE THREE FACTS
// ---------------------------------------------------------------------------
//   ROW      -> can this ever be indexed?      (`classifyEvidenceIndexability`)
//   VERSION  -> did content actually land?     (`evidence_document_versions`)
//   ATTEMPT  -> what happened the last time?   (`audit_logs`, action `indexed`)
//
// The ATTEMPT is the audit row, and it is the ONLY durable trace of an
// ingestion that wrote nothing: a reported failure re-throws so drizzle unwinds
// the version and the chunks, while the audit write runs in its own short
// transaction and survives. That is why the audit row is consulted here and why
// it is consulted LAST — it is the weakest of the three, being best-effort and
// never awaited by the action that emits it.

import { classifyEvidenceIndexability, type GroundingIndexBlocker } from './indexability'
import type { EvidenceIndexabilityInput } from './indexability'
import { currentPipelineIdentity } from './ingest/persistence'

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

/** The evidence row, plus the one platform column the offer depends on. */
export interface EvidenceRowFact extends EvidenceIndexabilityInput {
  readonly id: string
  /** `evidence_items.status`. Archived evidence is excluded from every answer. */
  readonly status: string
}

/** The head of a document's version history, and what it actually holds. */
export interface ActiveVersionFact {
  readonly evidenceId: string
  readonly ordinal: number | null
  /** CANONICAL chunks only — deduplicated occurrences are not corpus content. */
  readonly chunkCount: number
  readonly createdAt: string
  readonly normalizationVersion: string
  readonly extractorVersion: string
  readonly chunkerVersion: string
}

/**
 * The last `evidence_item.indexed` audit row, flattened.
 *
 * Every field is optional in the payload and therefore nullable here: the trail
 * is written by a fire-and-forget call, so a row that is missing, truncated or
 * older than the code that reads it must degrade rather than throw.
 */
export interface IndexingAttemptFact {
  readonly evidenceId: string
  readonly at: string
  /** `resolve`, `not_indexed`, or an `IngestionStage`. */
  readonly stage: string
  /** `EvidenceSourceRefusal`, when the attempt stopped at the resolver. */
  readonly refusalReason: string | null
  /** `IngestionSkipReason | IngestionRejectReason`, when the pipeline declined. */
  readonly notIndexedReason: string | null
  /** True when the ingestion transaction unwound. */
  readonly rolledBack: boolean
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type EvidenceIndexPhase =
  /** Stored evidence that can never be corpus content. */
  | 'not_indexable'
  /** Supported, and nothing has been written for it yet. */
  | 'ready_to_index'
  /** A version row with canonical chunks, under the current pipeline. */
  | 'indexed'
  /** Indexed, but under a pipeline whose offsets no longer address this text. */
  | 'indexed_stale'
  /** A version row that holds no canonical chunks — content is hidden. */
  | 'incomplete'
  /** The last attempt failed for a cause a retry can plausibly clear. */
  | 'failed_retryable'
  /** The last attempt failed for a cause a retry cannot clear. */
  | 'failed_terminal'

/**
 * Why the phase is what it is.
 *
 * Reuses the ingestion vocabularies verbatim — `GroundingIndexBlocker`,
 * `EvidenceSourceRefusal`, `IngestionSkipReason`, `IngestionRejectReason` —
 * rather than inventing display names, so the screen and the operator trail
 * name the same condition with the same word. The two additions are conditions
 * only this layer can observe.
 */
export type EvidenceIndexReason =
  | GroundingIndexBlocker
  | 'empty_document'
  | 'extraction_failed'
  | 'scope_mismatch'
  /** A version row exists and holds nothing. */
  | 'no_chunks'
  /** The stored version predates a pipeline version bump. */
  | 'pipeline_drift'
  /** The last attempt reached the database and unwound. */
  | 'write_failed'

export interface EvidenceCorpusState {
  readonly evidenceId: string
  readonly phase: EvidenceIndexPhase
  readonly reason: EvidenceIndexReason | null
  /** Human-readable, and free of paths, hashes and passages. */
  readonly detail: string | null
  /** Canonical chunks in the active version, or null when there is none. */
  readonly chunkCount: number | null
  readonly versionOrdinal: number | null
  readonly indexedAt: string | null
  /** Whether THIS caller may request indexing for THIS row right now. */
  readonly canRetry: boolean
}

export interface CorpusStateOptions {
  /** `canUploadEvidence(role)` — the evidence-management threshold. */
  readonly mayManage: boolean
}

/**
 * The phases whose cause a retry can plausibly clear.
 *
 * A set rather than a condition at each construction site: "which states offer
 * the action?" is one product decision and belongs in one place, where the
 * server action's own refusal can be compared against it.
 */
const RETRYABLE_PHASES: ReadonlySet<EvidenceIndexPhase> = new Set([
  'ready_to_index',
  'failed_retryable',
  'incomplete',
  'indexed_stale',
])

/**
 * The refusals a retry can plausibly clear.
 *
 * `missing_bytes` alone. Every other refusal is a statement about the row or
 * its content that re-reading the same object reproduces exactly — offering a
 * retry for one would be offering to fail again.
 */
const RETRYABLE_REFUSALS: ReadonlySet<string> = new Set(['missing_bytes'])

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Derive one row's corpus state.
 *
 * PRECEDENCE, strongest evidence first:
 *
 *   1. the VERSION row — the only positive proof, and it outranks a later
 *      failure because the corpus really does hold citable content;
 *   2. the ROW verdict — a document with no extractor stays unindexable
 *      whatever an attempt once reported;
 *   3. the ATTEMPT — consulted only when the two facts above say nothing.
 */
export function deriveEvidenceCorpusState(
  evidence: EvidenceRowFact,
  version: ActiveVersionFact | null,
  attempt: IndexingAttemptFact | null,
  options: CorpusStateOptions,
): EvidenceCorpusState {
  const base = {
    evidenceId: evidence.id,
    chunkCount: version === null ? null : version.chunkCount,
    versionOrdinal: version === null ? null : version.ordinal,
    indexedAt: version === null ? null : version.createdAt,
  }

  const decided = decide(evidence, version, attempt)

  return {
    ...base,
    ...decided,
    canRetry:
      options.mayManage && evidence.status !== 'archived' && RETRYABLE_PHASES.has(decided.phase),
  }
}

type Decision = Pick<EvidenceCorpusState, 'phase' | 'reason' | 'detail'>

function decide(
  evidence: EvidenceRowFact,
  version: ActiveVersionFact | null,
  attempt: IndexingAttemptFact | null,
): Decision {
  if (version !== null) return decideFromVersion(version)

  const indexability = classifyEvidenceIndexability(evidence)
  if (indexability.kind === 'not_indexable') {
    return {
      phase: 'not_indexable',
      reason: indexability.blocker,
      detail: indexability.detail,
    }
  }

  return attempt === null
    ? { phase: 'ready_to_index', reason: null, detail: null }
    : decideFromAttempt(attempt)
}

function decideFromVersion(version: ActiveVersionFact): Decision {
  // Checked BEFORE drift: an empty version hides the last good content, which
  // is both worse and differently repaired than stale offsets.
  if (version.chunkCount === 0) {
    return {
      phase: 'incomplete',
      reason: 'no_chunks',
      detail:
        'La versión activa del documento no tiene fragmentos: el contenido no es citable y debe reindexarse.',
    }
  }

  const drift = describeDrift(version)
  if (drift !== null) {
    return { phase: 'indexed_stale', reason: 'pipeline_drift', detail: drift }
  }

  return { phase: 'indexed', reason: null, detail: null }
}

/**
 * Which pipeline constants the stored version disagrees with, if any.
 *
 * The comparison mirrors `describePipelineDrift` in the ingestion orchestrator,
 * minus the normalized-hash term: that one needs the freshly normalized text
 * and this layer holds no bytes. Reporting the three version fields it CAN see
 * is a true subset, not an approximation of the fourth.
 */
function describeDrift(version: ActiveVersionFact): string | null {
  const current = currentPipelineIdentity()
  const drifted: string[] = []

  if (version.normalizationVersion !== current.normalizationVersion) drifted.push('normalización')
  if (version.extractorVersion !== current.extractorVersion) drifted.push('extractor')
  if (version.chunkerVersion !== current.chunkerVersion) drifted.push('fragmentador')

  if (drifted.length === 0) return null
  return `Indexado con una versión anterior de ${drifted.join(', ')}; las anclas guardadas ya no corresponden al texto actual.`
}

function decideFromAttempt(attempt: IndexingAttemptFact): Decision {
  if (attempt.rolledBack) {
    return {
      phase: 'failed_retryable',
      reason: 'write_failed',
      // The STAGE is named because it is the one fact that tells an operator
      // where to look, and it names no tenant, no path and no content.
      detail: `El último intento de indexación falló en la etapa «${attempt.stage}» y se revirtió; no se escribió nada.`,
    }
  }

  if (attempt.notIndexedReason !== null) {
    return {
      phase: 'failed_terminal',
      reason: attempt.notIndexedReason as EvidenceIndexReason,
      detail: NOT_INDEXED_DETAIL[attempt.notIndexedReason] ?? 'El documento no pudo indexarse.',
    }
  }

  if (attempt.refusalReason !== null) {
    const retryable = RETRYABLE_REFUSALS.has(attempt.refusalReason)
    return {
      phase: retryable ? 'failed_retryable' : 'failed_terminal',
      reason: attempt.refusalReason as EvidenceIndexReason,
      detail: REFUSAL_DETAIL[attempt.refusalReason] ?? 'La indexación fue rechazada antes de leer el archivo.',
    }
  }

  // An attempt that neither failed nor refused reached `finalize` — and left no
  // version row, or the branch above would have taken it. The audit write is
  // best-effort and never awaited, so "finalize was reached" is not proof the
  // version survived; the absence of the row is the stronger fact and wins.
  return { phase: 'ready_to_index', reason: null, detail: null }
}

const NOT_INDEXED_DETAIL: Record<string, string> = {
  unsupported_format: 'El formato del archivo no tiene extractor; queda almacenado como evidencia sin indexar.',
  empty_document: 'El documento no contiene texto extraíble.',
  extraction_failed: 'La extracción del documento falló; el archivo permanece almacenado.',
  input_too_large: 'El archivo supera el límite de entrada para grounding (25 MB).',
}

const REFUSAL_DETAIL: Record<string, string> = {
  unsupported_kind: 'Este tipo de evidencia no se indexa.',
  missing_bytes: 'No se pudo leer el archivo almacenado; se puede reintentar.',
  malformed_metadata: 'La fila de evidencia no tiene metadatos suficientes para indexarse.',
  input_too_large: 'El archivo supera el límite de entrada para grounding (25 MB).',
  content_hash_mismatch:
    'El contenido almacenado no reproduce el hash registrado al crear la evidencia; no se indexa.',
  scope_mismatch: 'La evidencia no pertenece al proyecto solicitado.',
}
