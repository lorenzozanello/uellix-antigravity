// db/grounding/grounding-chunk-repository.ts
// INTEGRATION (Stella parallel train 3) — the persisted side of
// GroundingChunkRepository, over the GOVERNED SQL surface of grounding_0003.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ---------------------------------------------------------------------------
// `lib/grounding/retrieve/repository.ts` defines HOW chunks are asked for and
// imports nothing from `db/**` — that is the whole point of the interface. This
// module is the other half: it lives in `db/**`, knows the SQL, and implements
// that interface so `orchestrateGroundedResponse` can be handed a real source
// without `lib/grounding/**` learning where chunks live.
//
// It is NOT a fallback and NOT a fixture. There is no in-memory branch here,
// no seeded data, and no "if the package is missing, pretend". The prepared
// packages grounding_0002 / grounding_0003 are applied to NO database as of
// this train, so every call below fails — and it fails as a typed,
// SANITIZED unavailability, which the caller reports as `provider_unavailable`.
// Falling back to fabricated chunks would put unverifiable text behind a
// citation UI whose entire purpose is that its text is verifiable.
//
// ---------------------------------------------------------------------------
// IDENTITY
// ---------------------------------------------------------------------------
// The shared application client (`db/client.ts`, role `uellix_app`), inside
// whatever identity context the CALLER has already opened
// (`withOrganizationDatabaseContext`). Not `service_role`, not a second
// credential, not the owner:
//
//   - `uellix_grounding.chunks_in_scope` is GRANTed to `uellix_app` and to
//     nobody else outside the definer (grounding_0003 §GRANTS);
//   - it is SECURITY DEFINER with `search_path = ''`, and it RE-CHECKS the
//     caller's organization membership through `public.current_user_org_ids()`
//     before returning a row — so the identity on the connection is what
//     bounds the read, exactly as it is for every other application query.
//
// A `service_role` connection would bypass RLS and make that re-check
// meaningless; there is no code path here that can reach one.
//
// ---------------------------------------------------------------------------
// WHY THE VERSION LOOKUP IS A SCOPED SELECT AND NOT `claim_active_document_version`
// ---------------------------------------------------------------------------
// `uellix_grounding.claim_active_document_version(evidence_id)` returns exactly
// the (uuid, version_id) pair this module needs — but it takes `FOR UPDATE` on
// the evidence row. It is the INGESTION path's claim, and using it to answer a
// read would take a row lock per evidence item on every question asked. So the
// version is read directly from `public.evidence_document_versions`, on which
// `uellix_app` holds SELECT under an org-scoped RLS policy.
//
// THAT POLICY IS ORG-SCOPED, NOT PROJECT-SCOPED. `evidence_document_versions_select`
// tests `organization_id = ANY(current_user_org_ids())` and nothing more; the
// RESTRICTIVE `_scope_consistency` policy only binds a row to its own evidence
// item. Project isolation on this read is therefore NOT delegated to RLS — the
// WHERE clause below states `project_id` explicitly, and the governed
// `chunks_in_scope` call states it a second time. Two independent statements of
// the same boundary, because the known-open finding A-F1 (GROUNDING:
// `validateAnswerCitations` compares only `organizationId`) means the layer
// downstream cannot be relied on to catch a cross-project chunk.

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  assertValidScope,
  deriveChunkId,
  isSameScope,
  textSpan,
  type ContentHash,
  type GroundingChunk,
  type GroundingScope,
  type PromptInjectionSignal,
} from '@/lib/grounding/contracts'
import { RepositoryContractViolationError } from '@/lib/grounding/retrieve/repository'
import type { ChunkQuery, GroundingChunkRepository } from '@/lib/grounding/retrieve/repository'

/** Versioned identity, recorded in retrieval provenance (see `ChunkScorer.id`). */
export const PERSISTED_GROUNDING_REPOSITORY_ID = 'db-grounding-chunks-v1'

/**
 * The read could not be performed. Carries NO driver text, NO SQLSTATE, NO
 * table name and NO connection string — see {@link sanitizeRepositoryFailure}.
 * The orchestrator turns this into `provider_unavailable`, which is a claim
 * about the SYSTEM, distinct from "your evidence does not answer this".
 */
export class GroundingRepositoryUnavailableError extends Error {
  readonly name = 'GroundingRepositoryUnavailableError'
}

/**
 * The caller asked for something this repository is not authorized to answer.
 * Distinct from unavailability on purpose: this is a PROGRAMMING DEFECT or a
 * boundary break, and it must be RETHROWN rather than reported as an answer.
 *
 * It EXTENDS `RepositoryContractViolationError` for exactly that reason.
 * `orchestrateGroundedResponse` rethrows only `GroundingScopeViolationError`
 * and `RepositoryContractViolationError` and degrades everything else to
 * `provider_unavailable` — so a plain `Error` subclass here would have been
 * silently swallowed into "we could not look", turning a boundary break into
 * a status a caller might just retry. Inheriting puts it in the rethrown
 * family by construction rather than by a second list someone has to remember
 * to update.
 */
export class GroundingRepositoryContractError extends RepositoryContractViolationError {
  readonly name = 'GroundingRepositoryContractError'
}

/** One authorized evidence item, and the version of it that may be read. */
interface ResolvedVersion {
  readonly evidenceId: string
  /** `evidence_document_versions.id` — the uuid `chunks_in_scope` takes. */
  readonly documentVersionUuid: string
  /** `evidence_document_versions.version_id` — the char(64) the contract uses. */
  readonly versionId: ContentHash
  readonly rawContentHash: ContentHash
  readonly normalizedContentHash: ContentHash
  readonly normalizationVersion: string
  readonly chunkerVersion: string
  readonly sourceLabel: string
  readonly mimeType: string
}

/**
 * Build the persisted repository for ONE scope.
 *
 * The scope is fixed at construction and re-compared against every query
 * (below). A repository object that can be pointed at a second tenant after it
 * is built is one refactor away from being pointed at the wrong one.
 */
export function createPersistedGroundingChunkRepository(
  scope: GroundingScope,
): GroundingChunkRepository {
  assertValidScope(scope)

  return {
    id: PERSISTED_GROUNDING_REPOSITORY_ID,
    async fetchCandidates(query: ChunkQuery): Promise<readonly GroundingChunk[]> {
      assertValidScope(query.scope)

      // The construction scope is the authority. `enforceRepositoryScope`
      // (GROUNDING) verifies the RESULT against the query; this verifies the
      // QUERY against what this object was authorized for, which that guard
      // cannot see.
      if (!isSameScope(query.scope, scope)) {
        throw new GroundingRepositoryContractError(
          'this repository was built for a different scope than the query it was given',
        )
      }

      // "Empty means anything within scope" (ChunkQuery.evidenceIds) is NOT
      // expressible here, and the honest answer is to refuse rather than to
      // approximate. The governed surface has no "enumerate the evidence of a
      // project" function, and writing one as a broad SELECT over
      // evidence_chunks here would be a second, ungoverned answer to "what may
      // this session read" — precisely what the prepared package exists to
      // prevent. The caller (the server action) resolves the authorized
      // evidence set and names it.
      if (query.evidenceIds.length === 0) {
        throw new GroundingRepositoryContractError(
          'evidenceIds must be non-empty: the governed SQL surface cannot enumerate evidence in scope',
        )
      }

      const versions = await resolveVersions(scope, query)
      if (versions.length === 0) return []

      const chunks: GroundingChunk[] = []
      for (const version of versions) {
        if (chunks.length >= query.limit) break
        const rows = await readChunksInScope(scope, version)
        for (const row of rows) {
          if (chunks.length >= query.limit) break
          chunks.push(toGroundingChunk(scope, version, row))
        }
      }
      return chunks
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Version resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The active version of each NAMED evidence item, within this exact scope.
 *
 * `ORDER BY ordinal DESC NULLS LAST` mirrors `claim_active_document_version`'s
 * own definition of "active" so the read path and the ingestion path cannot
 * disagree about which version a citation refers to.
 *
 * When `query.versionIds` is non-empty it is an AUTHORIZATION filter, not a
 * preference (see `ChunkQuery`), so it is applied as a predicate: the result
 * may contain nothing else.
 */
async function resolveVersions(scope: GroundingScope, query: ChunkQuery): Promise<ResolvedVersion[]> {
  const evidenceIds = [...query.evidenceIds]
  const versionIds = [...query.versionIds]
  const restrictVersions = versionIds.length > 0

  try {
    // `source_label` is NOT a column of evidence_document_versions — that table
    // has exactly 14 columns and deliberately does not store a display label
    // (grounding_0002 §"columns", and its own self-verification hard-asserts
    // the count). `ProvenanceRecord.sourceLabel` is "an UNTRUSTED display label
    // of the source — never a path", and the place this product already keeps
    // that is `evidence_items.title`. So it is joined, under the SAME
    // organization/project predicates, rather than invented or left blank:
    // a citation that cannot name its source is a citation a reviewer cannot
    // check.
    const rows = (await db.execute(sql`
      SELECT DISTINCT ON (v.evidence_id)
             v.evidence_id,
             v.id                       AS document_version_uuid,
             v.version_id,
             v.raw_content_hash,
             v.normalized_content_hash,
             v.normalization_version,
             v.chunker_version,
             v.mime_type,
             e.title                    AS source_label
      FROM public.evidence_document_versions v
      JOIN public.evidence_items e
        ON e.id              = v.evidence_id
       AND e.organization_id = v.organization_id
       AND e.project_id      = v.project_id
      WHERE v.organization_id = ${scope.organizationId}::uuid
        AND v.project_id      = ${scope.projectId}::uuid
        AND v.evidence_id     = ANY(${evidenceIds}::uuid[])
        AND (${restrictVersions} = false OR v.version_id = ANY(${versionIds}::bpchar[]))
      ORDER BY v.evidence_id, v.ordinal DESC NULLS LAST
    `)) as unknown as readonly Record<string, unknown>[]

    return rows.map((row) => ({
      evidenceId: String(row.evidence_id),
      documentVersionUuid: String(row.document_version_uuid),
      versionId: String(row.version_id) as ContentHash,
      rawContentHash: String(row.raw_content_hash) as ContentHash,
      normalizedContentHash: String(row.normalized_content_hash) as ContentHash,
      normalizationVersion: String(row.normalization_version),
      chunkerVersion: String(row.chunker_version),
      sourceLabel: String(row.source_label ?? ''),
      mimeType: String(row.mime_type ?? ''),
    }))
  } catch (error) {
    throw sanitizeRepositoryFailure('document version lookup', error)
  }
}

/* -------------------------------------------------------------------------- */
/* Chunk read — the governed function, and nothing else                       */
/* -------------------------------------------------------------------------- */

/**
 * Chunks come from `uellix_grounding.chunks_in_scope` and from no other
 * statement. It is SECURITY DEFINER, re-checks organization membership, and
 * already filters `canonical_chunk_id IS NULL` — so a deduplicated duplicate
 * can never be cited as if it were the passage.
 *
 * The three scope arguments are the SERVER-DERIVED ones (see the server
 * action). No value here originates in a client payload.
 */
async function readChunksInScope(
  scope: GroundingScope,
  version: ResolvedVersion,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return (await db.execute(sql`
      SELECT chunk_id, chunk_index, content, content_hash, char_start, char_end,
             page, section_index, normalized_content_hash, normalization_version,
             chunker_version, injection_scanner_version, signals
      FROM uellix_grounding.chunks_in_scope(
        ${scope.organizationId}::uuid,
        ${scope.projectId}::uuid,
        ${version.documentVersionUuid}::uuid
      )
    `)) as unknown as readonly Record<string, unknown>[]
  } catch (error) {
    throw sanitizeRepositoryFailure('chunk read', error)
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `ChunkLocation.lineStart` / `lineEnd` are NOT PERSISTED.
 *
 * `evidence_chunks` stores `char_start` / `char_end` (the authoritative span),
 * `page` and `section_index` — it has no `line_start`, no `line_end` and no
 * `section_label`. The contract calls the line range "derived, not
 * authoritative — the span is the authority", and deriving it needs the
 * normalized document text, which a chunk read does not load.
 *
 * So this sentinel, `0`, is used, and it is deliberately OUTSIDE the
 * documented 1-based domain: a reader can tell "not recoverable from
 * persistence" from a plausible-looking wrong line number, which is what any
 * in-domain guess would be. Registered as an open contract request
 * (INT-GR-003) rather than papered over. `sectionLabel` is `null`, which the
 * contract already admits.
 */
const LINE_RANGE_NOT_PERSISTED = 0

/**
 * WHERE SCOPE IS ACTUALLY ENFORCED FOR THIS REPOSITORY — read this before
 * trusting `enforceRepositoryScope`.
 *
 * `uellix_grounding.chunks_in_scope` RETURNS 13 columns and `organization_id`
 * / `project_id` are NOT among them. So `toGroundingChunk` below cannot read a
 * chunk's scope off the row; it stamps the SCOPE THE QUERY ASKED FOR onto
 * `chunk.scope` and `chunk.provenance.scope`.
 *
 * The consequence is precise and must not be papered over:
 * `enforceRepositoryScope`'s `isSameScope` / `scopeContains` checks are
 * TAUTOLOGICAL against this repository — they compare the query's scope with
 * itself and can never fail. Its `evidenceId` / `versionId` checks remain
 * real, because those DO derive from the row.
 *
 * Scope enforcement for this repository therefore rests entirely on SQL, in
 * three independent places:
 *
 *   1. `chunks_in_scope` re-checks `current_user_org_ids()` before returning
 *      any row (SECURITY DEFINER, `search_path = ''`);
 *   2. its WHERE clause filters `organization_id` AND `project_id`;
 *   3. the version lookup above filters both a second time, and the composite
 *      FK `evidence_chunks_version_scope_fk` makes a chunk whose scope
 *      disagrees with its version unrepresentable at rest.
 *
 * That is three statements of the boundary and zero in TypeScript. It is
 * enough, but it is not what a reader of `enforceRepositoryScope` would
 * assume, so: contract request INT-GR-004 asks GROUNDING/CAPABILITIES to have
 * `chunks_in_scope` return `organization_id` and `project_id`, which would
 * make the guard load-bearing instead of decorative. Until then, DO NOT add a
 * fourth TypeScript check that reads these fabricated fields — it would look
 * like verification and verify nothing.
 */

function toGroundingChunk(
  scope: GroundingScope,
  version: ResolvedVersion,
  row: Record<string, unknown>,
): GroundingChunk {
  const chunkIndex = Number(row.chunk_index)
  const contentHash = String(row.content_hash) as ContentHash
  const storedChunkId = String(row.chunk_id) as ContentHash

  // The database derives chunk_id server-side (grounding_0003 train 3, risk
  // #3) using the SAME preimage as deriveChunkId. Re-deriving it here and
  // comparing is not redundancy for its own sake: it is the one place where
  // the SQL formula and the TypeScript formula are checked against each other
  // at runtime, and a divergence would mean a citation quoting an id that
  // resolves to nothing.
  const derived = deriveChunkId(version.versionId, chunkIndex, contentHash)
  if (derived !== storedChunkId) {
    throw new GroundingRepositoryContractError(
      'stored chunk_id does not match deriveChunkId(versionId, chunkIndex, contentHash)',
    )
  }

  return {
    chunkId: storedChunkId,
    scope,
    evidenceId: version.evidenceId,
    versionId: version.versionId,
    chunkIndex,
    text: String(row.content ?? ''),
    contentHash,
    location: {
      span: textSpan(Number(row.char_start), Number(row.char_end)),
      coordinateSpace: version.normalizedContentHash,
      page: row.page === null || row.page === undefined ? null : Number(row.page),
      sectionIndex:
        row.section_index === null || row.section_index === undefined ? null : Number(row.section_index),
      sectionLabel: null,
      lineStart: LINE_RANGE_NOT_PERSISTED,
      lineEnd: LINE_RANGE_NOT_PERSISTED,
    },
    provenance: {
      evidenceId: version.evidenceId,
      scope,
      versionId: version.versionId,
      rawContentHash: version.rawContentHash,
      normalizedContentHash: version.normalizedContentHash,
      normalizationVersion: version.normalizationVersion,
      chunkerVersion: version.chunkerVersion,
      injectionScannerVersion: String(row.injection_scanner_version ?? ''),
      sourceLabel: version.sourceLabel,
      mimeType: version.mimeType,
    },
    signals: parseSignals(row.signals),
  }
}

/**
 * `signals` is `jsonb` with a `jsonb_typeof(signals) = 'array'` CHECK, so the
 * array shape is a database guarantee. Anything that is not an array is
 * returned as EMPTY rather than as "unknown", because the contract states
 * signals are "always present (possibly empty) so a consumer cannot mistake
 * 'not scanned' for 'clean'" — and a chunk that reached this table was scanned
 * (`injection_scanner_version` is NOT NULL).
 */
function parseSignals(raw: unknown): readonly PromptInjectionSignal[] {
  if (!Array.isArray(raw)) return []
  return raw as readonly PromptInjectionSignal[]
}

/* -------------------------------------------------------------------------- */
/* Error sanitization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Driver errors quote the failing statement, and a statement here carries an
 * organization id, a project id and evidence ids. They also quote SQLSTATEs
 * and table names, which map a schema for anyone reading a client response.
 *
 * So: the ERROR NAME is logged server-side (the same discipline as
 * `buildGeminiErrorLog` and the marketing-lead route), and what crosses the
 * boundary is a fixed string naming only the STAGE that failed.
 */
function sanitizeRepositoryFailure(stage: string, error: unknown): GroundingRepositoryUnavailableError {
  console.error(
    `[stella-grounding] ${stage} failed:`,
    error instanceof Error ? error.name : 'unknown',
  )
  return new GroundingRepositoryUnavailableError(`grounding ${stage} unavailable`)
}
