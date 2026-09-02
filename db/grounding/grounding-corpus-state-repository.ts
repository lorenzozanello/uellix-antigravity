// db/grounding/grounding-corpus-state-repository.ts
// G-01 (product path) — the READ side of "what does the corpus hold for this
// project?", over the same governed surface the retrieval adapter uses.
//
// ---------------------------------------------------------------------------
// TWO STATEMENTS, AND WHY NEITHER OF THEM IS A SELECT OVER `evidence_chunks`
// ---------------------------------------------------------------------------
// `grounding-chunk-repository.ts` states the rule this module obeys: chunks are
// read through `uellix_grounding.chunks_in_scope_attested` and through no other
// statement, because a direct SELECT over `evidence_chunks` would be a second,
// ungoverned answer to "what may this session read".
//
// A count is not an exception to that. So the chunk COUNT here is
// `count(*)` OVER the governed function — the rows are produced and consumed
// inside PostgreSQL and no passage crosses the wire. That is the whole reason
// the count is computed in SQL rather than by fetching chunks and taking
// `.length`: a status column must not become a way to stream the corpus into a
// page render.
//
// ---------------------------------------------------------------------------
// SCOPE IS STATED, TWICE, ON PURPOSE
// ---------------------------------------------------------------------------
// `evidence_document_versions_select` is ORG-scoped, not project-scoped (the
// same asymmetry INT-GR-001 and INT-GR-004 name). Every statement below
// therefore states `project_id` explicitly alongside `organization_id`, and the
// evidence-id set it is given is itself resolved from a project-scoped query by
// the caller — never from a request.
//
// `audit_logs` has no usable project column at all: `logAuditAction` is handed
// one and does not persist it. The project boundary on that read is the
// evidence-id set, and that is why the function REFUSES an empty set instead of
// widening to "every indexing attempt in the organization".

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { assertValidScope, type GroundingScope } from '@/lib/grounding/contracts'
import type { ActiveVersionFact, IndexingAttemptFact } from '@/lib/grounding/corpus-state'
import type { GroundingSqlExecutor } from '@/db/grounding/grounding-ingestion-repository'

/** Versioned identity, so an operator can tell readers apart in a trail. */
export const PERSISTED_GROUNDING_CORPUS_STATE_REPOSITORY_ID = 'db-grounding-corpus-state-v1'

/** The audit action `ingestProjectEvidenceForProject` records one attempt under. */
const INDEXING_AUDIT_ACTION = 'evidence_item.indexed'

function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as readonly Record<string, unknown>[]
  const rows = (result as { rows?: unknown })?.rows
  return Array.isArray(rows) ? (rows as readonly Record<string, unknown>[]) : []
}

/**
 * The ACTIVE version of each named evidence item, with its canonical chunk
 * count.
 *
 * "Active" is `ORDER BY ordinal DESC NULLS LAST`, which is
 * `claim_active_document_version`'s own definition and the one
 * `grounding-chunk-repository.ts` already mirrors — so the status a reviewer
 * reads and the version a citation resolves against cannot disagree.
 *
 * The count is computed in a SECOND stage, over the already-narrowed set, so
 * the governed function is called once per ACTIVE version rather than once per
 * row of history.
 */
export async function readActiveDocumentVersions(
  scope: GroundingScope,
  evidenceIds: readonly string[],
  executor: GroundingSqlExecutor = db,
): Promise<readonly ActiveVersionFact[]> {
  assertValidScope(scope)
  // Drizzle renders an empty array as an empty parenthesised list, and `IN ()`
  // is a syntax error rather than an empty result. Refusing here also keeps the
  // "the id set IS the project boundary" claim above true by construction.
  if (evidenceIds.length === 0) return []

  const ids = [...evidenceIds]
  const result = await executor.execute(sql`
    WITH active AS (
      SELECT DISTINCT ON (v.evidence_id)
             v.evidence_id,
             v.id,
             v.ordinal,
             v.created_at,
             v.normalization_version,
             v.extractor_version,
             v.chunker_version
      FROM public.evidence_document_versions v
      WHERE v.organization_id = ${scope.organizationId}::uuid
        AND v.project_id      = ${scope.projectId}::uuid
        AND v.evidence_id     IN ${ids}
      ORDER BY v.evidence_id, v.ordinal DESC NULLS LAST
    )
    SELECT a.evidence_id,
           a.ordinal,
           a.created_at,
           a.normalization_version,
           a.extractor_version,
           a.chunker_version,
           (
             SELECT count(*)
             FROM uellix_grounding.chunks_in_scope_attested(
               ${scope.organizationId}::uuid,
               ${scope.projectId}::uuid,
               a.id
             )
           ) AS chunk_count
    FROM active a
  `)

  return rowsOf(result).map((row) => ({
    evidenceId: String(row.evidence_id),
    // `ordinal` is NOT NULL in the table; the null branch mirrors the retrieval
    // adapter's own tolerance rather than asserting a column definition here.
    ordinal: row.ordinal === null || row.ordinal === undefined ? null : Number(row.ordinal),
    // `count(*)` is bigint, which the driver surfaces as a string.
    chunkCount: Number(row.chunk_count ?? 0),
    createdAt: toIso(row.created_at),
    normalizationVersion: String(row.normalization_version),
    extractorVersion: String(row.extractor_version),
    chunkerVersion: String(row.chunker_version),
  }))
}

/**
 * The LAST indexing attempt recorded for each named evidence item.
 *
 * The audit trail is the only durable record of an ingestion that wrote
 * nothing: a reported failure re-throws so the version and its chunks unwind,
 * while `audit()` runs in a separate short transaction and survives. It is also
 * the WEAKEST of the three facts the read model uses — fire-and-forget, never
 * awaited — which is why the derivation consults it last and treats an
 * unreadable payload as "nothing known".
 */
export async function readLastIndexingAttempts(
  scope: GroundingScope,
  evidenceIds: readonly string[],
  executor: GroundingSqlExecutor = db,
): Promise<readonly IndexingAttemptFact[]> {
  assertValidScope(scope)
  if (evidenceIds.length === 0) return []

  const ids = [...evidenceIds]
  const result = await executor.execute(sql`
    SELECT DISTINCT ON (a.entity_id)
           a.entity_id,
           a.created_at,
           a.after_json
    FROM public.audit_logs a
    WHERE a.organization_id = ${scope.organizationId}::uuid
      AND a.entity_type     = 'evidence_item'
      AND a.action          = ${INDEXING_AUDIT_ACTION}
      AND a.entity_id       IN ${ids}
    ORDER BY a.entity_id, a.created_at DESC
  `)

  return rowsOf(result).map((row) => toAttempt(row))
}

/**
 * Flatten one audit payload.
 *
 * EVERY field is read defensively. The trail is append-only and outlives the
 * code that wrote it, so a payload from an older build must degrade to "nothing
 * known" rather than throw inside a page render — which is what a cast would
 * do the first time `after_json` is null.
 */
function toAttempt(row: Record<string, unknown>): IndexingAttemptFact {
  const payload =
    typeof row.after_json === 'object' && row.after_json !== null
      ? (row.after_json as Record<string, unknown>)
      : {}

  return {
    evidenceId: String(row.entity_id),
    at: toIso(row.created_at),
    stage: typeof payload.stage === 'string' ? payload.stage : 'unknown',
    refusalReason: typeof payload.refusalReason === 'string' ? payload.refusalReason : null,
    notIndexedReason: typeof payload.notIndexedReason === 'string' ? payload.notIndexedReason : null,
    rolledBack: payload.rolledBack === true,
  }
}

/** `timestamptz` arrives as a Date from the driver and as a string from JSON. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString()
}
