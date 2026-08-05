// db/grounding/grounding-ingestion-repository.ts
// INTEGRATION (Stella parallel train 4) — the persisted side of
// GroundingIngestionRepository, over the GOVERNED SQL surface of
// grounding_0002 + grounding_0003.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
// ---------------------------------------------------------------------------
// `lib/grounding/ingest/persistence.ts` defines WHAT must be persisted and in
// what order, and imports nothing from `db/**`. This module is the other half:
// it lives in `db/**`, knows the SQL, and implements that port so
// `orchestrateDocumentIngestion` can be handed a real sink without
// `lib/grounding/**` learning where chunks live.
//
// It is the write-side twin of `grounding-chunk-repository.ts`, and it obeys
// the same four rules:
//
//   * the governed client (`db/client.ts`, role `uellix_app`) inside whatever
//     identity context the CALLER opened — never `service_role`, never the
//     owner, never a second credential;
//   * FOUR statements and no others. Every one is a call to one of the four
//     SECURITY DEFINER functions the packages expose. There is no direct
//     INSERT, no direct SELECT over `evidence_chunks`, and no statement that
//     could answer "what may this session write" a second, ungoverned way;
//   * scope is DERIVED server-side and never forwarded. See below;
//   * failures are SANITIZED — no driver text, no SQLSTATE, no table name
//     crosses this boundary. The typed `GroundingPersistenceError` carries the
//     distinction the caller needs and nothing that maps the schema.
//
// There is NO fallback. No in-memory branch, no "if the package is missing,
// pretend it worked". A half-written chunk index that reports success is the
// exact failure `finalize_document_ingestion` exists to prevent, and an
// adapter that swallowed a write failure would reintroduce it above the
// database.
//
// ---------------------------------------------------------------------------
// SCOPE IS AN EXPECTATION HERE, NEVER AN ARGUMENT THERE
// ---------------------------------------------------------------------------
// `register_document_version` takes eight arguments and NONE of them is an
// organization or a project: it DERIVES both from the evidence row and refuses
// to accept them (grounding_0002 §8a). A caller that could state its own scope
// could file a version of another tenant's document under its own
// organization, and no predicate over the arguments could tell that apart from
// a legitimate call.
//
// So `RegisterDocumentVersionRequest.scope` is what the CALLER BELIEVES it is
// writing into, and this adapter re-imposes that belief LOCALLY — it checks
// the evidence item is inside the scope the repository was built for before it
// calls, so a mismatch is named here instead of surfacing as a `U0102` whose
// message deliberately cannot distinguish "not yours" from "absent". The scope
// is never appended to the governed call.
//
// ---------------------------------------------------------------------------
// TRANSACTIONS
// ---------------------------------------------------------------------------
// `finalize_document_ingestion` compares the STORED canonical count against
// the count the pipeline produced and raises `U0103` when they differ. That
// assertion is only worth anything if the insert it is checking can still be
// rolled back — in a different transaction it would report a mismatch over a
// write that is already permanent.
//
// So the constructor takes an EXECUTOR. Pass `db` and each call is its own
// implicit transaction (fine for `claimActiveDocumentVersion`, which is a
// read); pass a `db.transaction` handle and the whole
// register -> insert -> finalize sequence shares one, which is the shape the
// contract requires and the one the local runtime journey uses:
//
//   await db.transaction(async (tx) =>
//     orchestrateDocumentIngestion(
//       createPersistedGroundingIngestionRepository(scope, tx), ...))
//
// The executor is a parameter rather than an ambient lookup because "am I in a
// transaction?" must be answerable by reading the call site.

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  GroundingPersistenceError,
  parseDocumentVersionRef,
  type ActiveDocumentVersionState,
  type DocumentVersionRef,
  type FinalizeDocumentIngestionRequest,
  type GroundingIngestionRepository,
  type GroundingPersistenceOperation,
  type InsertEvidenceChunksRequest,
  type RegisterDocumentVersionRequest,
} from '@/lib/grounding/ingest'
import { assertValidScope, isSameScope, type ContentHash, type GroundingScope } from '@/lib/grounding/contracts'

/** Versioned identity, recorded in the ingestion record. */
export const PERSISTED_GROUNDING_INGESTION_REPOSITORY_ID = 'db-grounding-ingestion-v1'

/**
 * The minimum of `db` this module uses.
 *
 * Structural, so a `db.transaction` handle satisfies it without this file
 * importing drizzle's transaction type — which changes shape between versions
 * and would couple an adapter to an ORM internal for no benefit.
 */
export interface GroundingSqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>
}

/* -------------------------------------------------------------------------- */
/* SQLSTATE -> typed failure                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The adapter's half of the mapping table `persistence.ts` documents.
 *
 * Kept as data rather than a switch so the two halves can be compared by
 * reading, and so an unmapped code cannot fall through to a default that would
 * silently call a chunk-identity rejection a connection problem.
 */
const SQLSTATE_TO_FAILURE = {
  U0100: 'invalid_request',
  U0101: 'pipeline_version_conflict',
  U0102: 'evidence_not_found',
  U0103: 'incomplete_ingestion',
  U0104: 'chunk_identity_rejected',
} as const

/**
 * Read the SQLSTATE off a driver error without depending on a driver type.
 *
 * `postgres`, `pg` and drizzle all surface it as a `code` property on the
 * error; none of them share a class this file could `instanceof`. Reading one
 * string defensively is the smaller coupling.
 */
function sqlStateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * Turn any thrown value into a typed, SANITIZED persistence failure.
 *
 * The error NAME and the SQLSTATE are logged server-side (same discipline as
 * `sanitizeRepositoryFailure` and `buildGeminiErrorLog`); what crosses the
 * boundary is the failure KIND plus the operation that failed. A driver error
 * quotes the failing statement, and a statement here carries organization ids,
 * project ids, evidence ids and — for a chunk insert — passage text.
 *
 * An UNMAPPED SQLSTATE becomes `unavailable`, which is the only kind
 * `isRetryablePersistenceFailure` calls retryable. That is the right default
 * in exactly one direction: an unknown database condition is more likely to be
 * operational than to be a statement about the caller's request, and calling a
 * request problem retryable costs one wasted retry, while calling an
 * operational problem permanent costs a document that never gets indexed.
 */
function sanitizePersistenceFailure(
  operation: GroundingPersistenceOperation,
  error: unknown,
): GroundingPersistenceError {
  const state = sqlStateOf(error)
  console.error(
    `[stella-grounding] ingestion ${operation} failed:`,
    error instanceof Error ? error.name : 'unknown',
    state ?? 'no-sqlstate',
  )
  const kind = (state !== null && state in SQLSTATE_TO_FAILURE
    ? SQLSTATE_TO_FAILURE[state as keyof typeof SQLSTATE_TO_FAILURE]
    : 'unavailable') as GroundingPersistenceError['kind']

  return new GroundingPersistenceError(kind, operation, `grounding ingestion ${operation} failed`)
}

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                */
/* -------------------------------------------------------------------------- */

function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as readonly Record<string, unknown>[]
  // Some drivers wrap the set in `{ rows }`. Neither shape is assumed; an
  // unrecognized one yields no rows, and every caller below treats "no rows"
  // as a named failure rather than as a success with defaults.
  const rows = (result as { rows?: unknown })?.rows
  return Array.isArray(rows) ? (rows as readonly Record<string, unknown>[]) : []
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the persisted ingestion repository for ONE scope.
 *
 * The scope is fixed at construction, exactly as it is for the read adapter: a
 * repository object that can be re-pointed at a second tenant after it is
 * built is one refactor away from being pointed at the wrong one.
 */
export function createPersistedGroundingIngestionRepository(
  scope: GroundingScope,
  executor: GroundingSqlExecutor = db,
): GroundingIngestionRepository {
  assertValidScope(scope)

  return {
    id: PERSISTED_GROUNDING_INGESTION_REPOSITORY_ID,

    /**
     * The head of a document's version history, or `null` when it has none.
     *
     * `null` is NOT a failure — it is the ordinary state of a first ingestion,
     * and the orchestrator branches on it to decide `first_ingestion` vs
     * `new_version`. Collapsing it into an error would make every document's
     * first ingestion look broken.
     *
     * KNOWN GAP, INT-GR-001: `claim_active_document_version` re-imposes the
     * ORGANIZATION boundary (`current_user_org_ids()`) and does NOT filter
     * `project_id` — its final predicate is `v.evidence_id = p_evidence_id`
     * alone. An evidence id belonging to another PROJECT of the caller's own
     * organization is therefore answered. It also returns seven columns, none
     * of which is a scope, so the disagreement is not detectable from the
     * result either — the ingestion-path twin of INT-GR-004.
     *
     * This adapter cannot close that from here (fixing it changes the
     * function's return type, which `CREATE OR REPLACE` forbids — 42P13 — so
     * it needs a new CAPABILITIES package). What it CAN do is refuse to be the
     * caller that makes it exploitable: `assertEvidenceInScope` below checks
     * the evidence item against this repository's project with an ordinary
     * scoped SELECT before any governed call names it.
     */
    async claimActiveDocumentVersion(evidenceId: string): Promise<ActiveDocumentVersionState | null> {
      await assertEvidenceInScope(executor, scope, evidenceId, 'claim_active_document_version')

      let result: unknown
      try {
        result = await executor.execute(sql`
          SELECT id, version_id, ordinal, normalized_content_hash,
                 normalization_version, extractor_version, chunker_version
          FROM uellix_grounding.claim_active_document_version(${evidenceId}::uuid)
        `)
      } catch (error) {
        throw sanitizePersistenceFailure('claim_active_document_version', error)
      }

      const rows = rowsOf(result)
      if (rows.length === 0) return null

      const row = rows[0]
      return {
        ref: parseDocumentVersionRef(String(row.id)),
        versionId: String(row.version_id) as ContentHash,
        ordinal: row.ordinal === null || row.ordinal === undefined ? null : Number(row.ordinal),
        normalizedContentHash: String(row.normalized_content_hash) as ContentHash,
        normalizationVersion: String(row.normalization_version),
        extractorVersion: String(row.extractor_version),
        chunkerVersion: String(row.chunker_version),
      }
    },

    /**
     * Persist one version. EIGHT arguments, and not one of them is a scope —
     * see the module header for why adding one would undo the derivation.
     */
    async registerDocumentVersion(request: RegisterDocumentVersionRequest): Promise<DocumentVersionRef> {
      if (!isSameScope(request.scope, scope)) {
        throw new GroundingPersistenceError(
          'invalid_request',
          'register_document_version',
          'this repository was built for a different scope than the version it was asked to register',
        )
      }
      await assertEvidenceInScope(executor, scope, request.evidenceId, 'register_document_version')

      let result: unknown
      try {
        result = await executor.execute(sql`
          SELECT uellix_grounding.register_document_version(
            ${request.evidenceId}::uuid,
            ${request.versionId}::bpchar,
            ${request.rawContentHash}::bpchar,
            ${request.normalizedContentHash}::bpchar,
            ${request.normalizationVersion}::varchar,
            ${request.extractorVersion}::varchar,
            ${request.chunkerVersion}::varchar,
            ${request.mimeType}::varchar
          ) AS ref
        `)
      } catch (error) {
        throw sanitizePersistenceFailure('register_document_version', error)
      }

      const rows = rowsOf(result)
      const ref = rows.length > 0 ? rows[0].ref : null
      if (ref === null || ref === undefined) {
        // A function that returns `uuid` returning nothing is not a state this
        // adapter can interpret, and guessing would mean writing chunks
        // against an unknown row.
        throw new GroundingPersistenceError(
          'unavailable',
          'register_document_version',
          'the governed function returned no document version reference',
        )
      }
      return parseDocumentVersionRef(String(ref))
    },

    /**
     * Offer the chunk batch. Returns how many rows were ACTUALLY inserted,
     * which is 0 on a complete replay — the function is `ON CONFLICT DO
     * NOTHING` on `chunk_id`, so a re-offer of an identical batch is a no-op
     * and must not be reported as a failure.
     *
     * The payload crosses as ONE `jsonb` argument, serialized here. It is not
     * interpolated into the statement: `sql` parameterizes it, so passage text
     * containing a quote is data, not syntax.
     */
    async insertEvidenceChunks(request: InsertEvidenceChunksRequest): Promise<number> {
      await assertVersionInScope(executor, scope, request.ref, 'insert_evidence_chunks')

      let result: unknown
      try {
        result = await executor.execute(sql`
          SELECT uellix_grounding.insert_evidence_chunks(
            ${request.ref}::uuid,
            ${JSON.stringify(request.chunks)}::jsonb
          ) AS inserted
        `)
      } catch (error) {
        throw sanitizePersistenceFailure('insert_evidence_chunks', error)
      }

      const rows = rowsOf(result)
      const inserted = rows.length > 0 ? rows[0].inserted : null
      if (inserted === null || inserted === undefined) {
        throw new GroundingPersistenceError(
          'unavailable',
          'insert_evidence_chunks',
          'the governed function returned no inserted-row count',
        )
      }
      return Number(inserted)
    },

    /**
     * Assert the stored canonical count equals what the pipeline produced.
     *
     * This is the statement that makes "no silent partial persistence" true,
     * and it is the reason the executor exists: raising `U0103` aborts the
     * CALLER's transaction, so an insert that lost its tail is rolled back
     * rather than left behind a version that looks complete. Called with `db`
     * instead of a transaction handle, it still detects the mismatch — it just
     * cannot undo it, which is why the local runtime journey wraps the three
     * write operations in one.
     */
    async finalizeDocumentIngestion(request: FinalizeDocumentIngestionRequest): Promise<void> {
      await assertVersionInScope(executor, scope, request.ref, 'finalize_document_ingestion')

      try {
        await executor.execute(sql`
          SELECT uellix_grounding.finalize_document_ingestion(
            ${request.ref}::uuid,
            ${request.expectedChunkCount}::integer
          )
        `)
      } catch (error) {
        throw sanitizePersistenceFailure('finalize_document_ingestion', error)
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Local scope re-imposition                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to name an evidence item that is not in THIS repository's scope.
 *
 * A scoped SELECT over `evidence_items`, on which `uellix_app` holds SELECT
 * under an org-scoped RLS policy, with `project_id` stated explicitly because
 * that policy does not state it.
 *
 * It is NOT a substitute for the governed functions' own checks and does not
 * pretend to be — they re-impose the organization boundary themselves, from
 * the caller's own claims, and this adapter could not weaken that if it tried.
 * What it adds is the PROJECT half on the ingestion path, which
 * `claim_active_document_version` genuinely does not check (INT-GR-001), and
 * an error that names the boundary instead of the deliberately ambiguous
 * `U0102`.
 */
async function assertEvidenceInScope(
  executor: GroundingSqlExecutor,
  scope: GroundingScope,
  evidenceId: string,
  operation: GroundingPersistenceOperation,
): Promise<void> {
  let result: unknown
  try {
    result = await executor.execute(sql`
      SELECT id
      FROM public.evidence_items
      WHERE id              = ${evidenceId}::uuid
        AND organization_id = ${scope.organizationId}::uuid
        AND project_id      = ${scope.projectId}::uuid
      LIMIT 1
    `)
  } catch (error) {
    throw sanitizePersistenceFailure(operation, error)
  }

  if (rowsOf(result).length === 0) {
    // Same wording as the governed functions use for both cases, and for the
    // same reason: distinguishing "not yours" from "does not exist" is a
    // tenancy oracle.
    throw new GroundingPersistenceError('evidence_not_found', operation, 'evidence item not found')
  }
}

/**
 * Refuse a document-version reference that is not in THIS repository's scope.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OTHER TWO OPERATIONS NEEDED THIS TOO — adversarial review A, train 4
 * ---------------------------------------------------------------------------
 * `claimActiveDocumentVersion` and `registerDocumentVersion` name an EVIDENCE
 * ITEM, so `assertEvidenceInScope` covers them. `insertEvidenceChunks` and
 * `finalizeDocumentIngestion` name a DOCUMENT VERSION — an opaque uuid — and
 * were passing it through unchecked.
 *
 * That was not symmetric, and the asymmetry was reachable. In SQL,
 * `insert_evidence_chunks` re-imposes only the ORGANIZATION boundary against
 * the version row (grounding_0003 §"insert"): the project is DERIVED from that
 * row and never compared with the caller. So a repository built for
 * (org A, project P1), handed the version uuid of a document in P2 of the same
 * organization, would write chunks into P2's index — where they become citable
 * by P2's queries.
 *
 * The adversary is server-side code (a bug, a bad refactor, a compromised
 * caller), so this is defence in depth rather than a tenancy boundary. But it
 * is the same class this repository already raised to a contract in
 * INT-GR-001, on the WRITE path, and the module header claims all four
 * operations obey the same rules. Two of four is not "the same rules".
 *
 * Reads `evidence_document_versions`, which carries both scope columns and on
 * which `uellix_app` holds SELECT under an org-scoped RLS policy — the project
 * half is stated explicitly here because that policy does not state it.
 */
async function assertVersionInScope(
  executor: GroundingSqlExecutor,
  scope: GroundingScope,
  ref: DocumentVersionRef,
  operation: GroundingPersistenceOperation,
): Promise<void> {
  let result: unknown
  try {
    result = await executor.execute(sql`
      SELECT id
      FROM public.evidence_document_versions
      WHERE id              = ${ref}::uuid
        AND organization_id = ${scope.organizationId}::uuid
        AND project_id      = ${scope.projectId}::uuid
      LIMIT 1
    `)
  } catch (error) {
    throw sanitizePersistenceFailure(operation, error)
  }

  if (rowsOf(result).length === 0) {
    // `evidence_not_found` rather than a new kind: from the caller's side this
    // IS "the thing you named is not available to you", and the governed
    // functions answer the same situation with the same deliberately
    // ambiguous U0102.
    throw new GroundingPersistenceError('evidence_not_found', operation, 'document version not found')
  }
}
