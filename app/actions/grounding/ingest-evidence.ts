'use server'
// app/actions/grounding/ingest-evidence.ts
// G-01 — the ONE application path that writes into the governed grounding
// corpus.
//
// Until this module existed, `ingestEvidenceDocument` had no production caller:
// the READ side of grounding was wired end to end and proved against a real
// database, while the WRITE side existed, was tested, and was reachable by
// nothing. The disposable E2E hid it by seeding
// `evidence_document_versions` / `evidence_chunks` through a privileged
// `supabase_admin` connection — which proves retrieval and proves nothing about
// whether the application can index anything at all.
//
// ---------------------------------------------------------------------------
// WHAT THE CLIENT CANNOT SEND
// ---------------------------------------------------------------------------
//   organization   <- `requireOrganizationAccess()`, the session
//   project        <- the BOUND argument, re-verified against the session's org
//   storage path   <- read off the evidence ROW, never off the request
//   mime type      <- the row
//   byte size      <- measured from the bytes, not claimed
//   content hash   <- the row, and the bytes must reproduce it
//   principal      <- `uellix_app`; there is no parameter for a role anywhere
//
// The request has ONE field. A payload carrying `organizationId`, `filePath` or
// `bytes` is not rejected with a message that would confirm the field name — it
// simply has no reader.
//
// ---------------------------------------------------------------------------
// WHY THE GATE IS `grounded_query` AND NOT AN INGESTION FLAG OF ITS OWN
// ---------------------------------------------------------------------------
// The corpus this writes into has exactly one consumer, and it is the grounded
// query. A second flag would let the two disagree — a corpus filling up for a
// capability that is off, or a capability on with no way to fill it. It also
// keeps this path dark by the same switch that keeps the reader dark, which is
// what makes it safe to ship before the first staging execution.
//
// ---------------------------------------------------------------------------
// WHY THE PERMISSION IS `canUploadEvidence` AND NOT `canUseStella`
// ---------------------------------------------------------------------------
// Indexing a document the caller may already upload, delete and archive is an
// EVIDENCE-MANAGEMENT act, not an AI-consumption act. Gating it on
// `canUseStella` would mean a reviewer's ability to change what the corpus
// contains tracked an AI feature flag rather than the evidence policy — and the
// invariant we want is
//
//     CAN_MANAGE_PROJECT_EVIDENCE  ->  may request indexing
//
// `canUploadEvidence` is the canonical primitive for that threshold and is
// reused rather than re-derived: writing `hasRole(role, 'analyst')` here would
// create a second copy of the evidence policy, free to drift from the first the
// day the threshold moves.
//
// ---------------------------------------------------------------------------
// M-7 — WHY THE FAILURE PATH THROWS
// ---------------------------------------------------------------------------
// `finalize_document_ingestion` VERIFIES the chunk count and raises U0103; it
// activates nothing. `claim_active_document_version` selects the highest
// ordinal with NO finalized-state predicate. So a version row that registered
// and then failed to fill becomes the ACTIVE version and hides the last good
// one — the document silently loses its content while still looking indexed.
//
// The whole sequence therefore runs inside ONE identity context, and a reported
// failure is RE-THROWN so drizzle unwinds it. Returning the failure normally
// would let the context commit, and the empty version would survive.
//
// This is closed in the application because closing it in SQL would mean
// changing a governed package: `CREATE OR REPLACE` cannot alter
// `claim_active_document_version`'s return type (42P13), so a state predicate
// needs a new CAPABILITIES package. Out of scope here, and named rather than
// silently worked around.

import { and, eq } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUploadEvidence } from '@/lib/auth/permissions'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { isStellaCapabilityReady } from '@/lib/stella/capability-readiness'
import { db } from '@/db/client'
import { evidenceItems } from '@/db/schema'
import { AUDIT_ACTIONS, logAuditAction } from '@/lib/audit/logger'
import { createEvidenceObjectReader } from '@/lib/supabase/evidence-object-reader'
import { createPersistedGroundingIngestionRepository } from '@/db/grounding/grounding-ingestion-repository'
import {
  ingestEvidenceDocument,
  resolveEvidenceSource,
  type EvidenceSourceRecord,
  type EvidenceSourceRefusal,
} from '@/lib/grounding/ingest'
import type { GroundingScope } from '@/lib/grounding/contracts'

/* -------------------------------------------------------------------------- */
/* The contract                                                               */
/* -------------------------------------------------------------------------- */

export interface IngestProjectEvidenceRequest {
  readonly evidenceId: string
}

export type EvidenceIngestionResult =
  /** One version written and finalized. `versionId` is `evidence_document_versions.id`. */
  | {
      readonly status: 'indexed'
      readonly versionId: string
      readonly chunkCount: number
      readonly reingestion: string
    }
  /** The resolver would not produce authorized bytes. Nothing was written. */
  | { readonly status: 'refused'; readonly reason: EvidenceSourceRefusal }
  /** The bytes were read but the pipeline cannot index them. Nothing was written. */
  | { readonly status: 'not_indexed'; readonly reason: string }
  /** A write failed and the transaction unwound. */
  | { readonly status: 'error'; readonly stage: string }
  /**
   * Not authenticated, not entitled, OR the evidence is not in this scope.
   *
   * ONE answer for all three, deliberately. Telling "your role is too low" apart
   * from "that evidence is not yours" apart from "that evidence does not exist"
   * would let a caller enumerate evidence ids across projects — the same
   * tenancy-oracle reasoning `U0102` states in SQL, where "not yours" and "never
   * existed" are indistinguishable on purpose.
   */
  | { readonly status: 'unauthorized' }
  /** The capability is off. Costs no authentication and no read. */
  | { readonly status: 'disabled' }

/**
 * A failure the orchestrator REPORTED, raised so the transaction unwinds.
 *
 * Carries the stage and nothing else: it is caught by the frame that opened the
 * context, one call below, and never escapes this module.
 */
class IngestionRolledBack extends Error {
  constructor(readonly stage: string) {
    super('grounding ingestion rolled back')
    this.name = 'IngestionRolledBack'
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function ingestProjectEvidence(
  boundProjectId: string,
  request: IngestProjectEvidenceRequest,
): Promise<EvidenceIngestionResult> {
  // 1. CAPABILITY — first, before authentication, before any read, before any
  //    audit row. "Off" therefore costs zero database work and leaks nothing.
  if (!isStellaCapabilityReady('grounded_query')) {
    return { status: 'disabled' }
  }

  // Read exactly one property.
  const evidenceId = typeof request?.evidenceId === 'string' ? request.evidenceId.trim() : ''
  const projectId = typeof boundProjectId === 'string' ? boundProjectId.trim() : ''
  if (evidenceId === '' || projectId === '') {
    return { status: 'unauthorized' }
  }

  // 2. AUTHENTICATE.
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { status: 'unauthorized' }
  }

  // 3/4. SCOPE — derived, never received.
  const scope: GroundingScope = { organizationId: ctx.organization.id, projectId }

  // 5. PERMISSION — the evidence-management threshold, through its canonical
  //    primitive. Last check that costs no I/O.
  if (!canUploadEvidence(ctx.membership.role)) {
    return { status: 'unauthorized' }
  }

  // 6. EVIDENCE LOOKUP — the FIRST read, scoped by all three identifiers. Its
  //    own short transaction: the storage round trip below must not run with a
  //    transaction open.
  const rows = await withOrganizationDatabaseContext(() =>
    db
      .select({
        id: evidenceItems.id,
        organizationId: evidenceItems.organizationId,
        projectId: evidenceItems.projectId,
        type: evidenceItems.type,
        title: evidenceItems.title,
        description: evidenceItems.description,
        filePath: evidenceItems.filePath,
        fileSize: evidenceItems.fileSize,
        mimeType: evidenceItems.mimeType,
        contentHash: evidenceItems.contentHash,
      })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.id, evidenceId),
          eq(evidenceItems.projectId, projectId),
          eq(evidenceItems.organizationId, scope.organizationId),
        ),
      )
      .limit(1),
  ).catch(() => null)

  if (rows === null) return { status: 'error', stage: 'evidence_lookup' }
  if (rows.length === 0) {
    // No audit row: writing one keyed to an evidence id the caller may not see
    // would make the trail the oracle the response refuses to be.
    return { status: 'unauthorized' }
  }

  const record = rows[0] as EvidenceSourceRecord

  // 7. BYTES — OUTSIDE any transaction. The reader runs under the caller's own
  //    session client; holding a database transaction across a storage round
  //    trip would serialise other writers behind one download.
  const resolution = await resolveEvidenceSource(record, scope, createEvidenceObjectReader())

  if (resolution.kind === 'refused') {
    void audit(ctx, evidenceId, { stage: 'resolve', refusalReason: resolution.reason })
    return { status: 'refused', reason: resolution.reason }
  }

  // 8. INGEST — register, insert and finalize share ONE transaction, because
  //    `db` inside an identity context resolves to that transaction's handle.
  //    See the M-7 note in the header for why a reported failure re-throws.
  try {
    const outcome = await withOrganizationDatabaseContext(() =>
      ingestEvidenceDocument(
        createPersistedGroundingIngestionRepository(scope),
        resolution.source,
        resolution.bytes,
      ).then((run) => {
        if (run.status === 'failed') throw new IngestionRolledBack(run.stage)
        return run
      }),
    )

    if (outcome.status === 'not_indexed') {
      void audit(ctx, evidenceId, {
        stage: 'not_indexed',
        // The REASON, not just the fact. This row is the only durable record of
        // an attempt that wrote nothing, and the evidence screen has to tell
        // "no extractor for this format" (never worth a retry) from "the
        // document normalized to nothing". A vocabulary word from
        // `IngestionSkipReason` / `IngestionRejectReason` — never a passage,
        // never a path, never a hash.
        notIndexedReason: outcome.ingestion.reason,
        reingestion: null,
        repositoryId: outcome.repositoryId,
      })
      return { status: 'not_indexed', reason: outcome.ingestion.reason }
    }

    void audit(ctx, evidenceId, {
      stage: 'finalize',
      reingestion: outcome.reingestion,
      chunkCount: outcome.insertedChunkCount,
      expectedChunkCount: outcome.expectedChunkCount,
      repositoryId: outcome.repositoryId,
    })

    return {
      status: 'indexed',
      versionId: outcome.ref,
      chunkCount: outcome.insertedChunkCount,
      reingestion: outcome.reingestion,
    }
  } catch (error) {
    const stage = error instanceof IngestionRolledBack ? error.stage : 'ingest'
    void audit(ctx, evidenceId, { stage, rolledBack: true })
    return { status: 'error', stage }
  }
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Metadata-only, in its own short transaction, never awaited by the caller.
 *
 * Ids, stages and counts. Never a passage, never a chunk, never a byte, never a
 * storage path and never a content hash — a hash of a small document is a
 * lookup key for its content, which is why it is absent rather than truncated.
 */
async function audit(
  ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>,
  evidenceId: string,
  afterJson: Record<string, unknown>,
): Promise<void> {
  try {
    await withOrganizationDatabaseContext(() =>
      logAuditAction({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'evidence_item',
        entityId: evidenceId,
        action: AUDIT_ACTIONS.EVIDENCE_INDEXED,
        afterJson: { readerId: 'supabase-evidence-storage-v1', ...afterJson },
      }),
    )
  } catch (error) {
    console.error('[grounding-ingest] audit write failed:', error instanceof Error ? error.name : 'unknown')
  }
}

/* -------------------------------------------------------------------------- */
/* The bindable form                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The mount-site form:
 *
 *   const ingest = ingestProjectEvidenceForProject.bind(null, projectId)
 *
 * `bind` prepends, and the bound value is sealed into the action reference on
 * the SERVER — it travels as an encrypted closure the browser cannot read or
 * forge. That is a convenience, not the boundary: every export of a
 * `'use server'` module is an independently invocable endpoint, so the project
 * is re-verified against the session's organization inside regardless of where
 * it came from.
 */
export async function ingestProjectEvidenceForProject(
  projectId: string,
  request: IngestProjectEvidenceRequest,
): Promise<EvidenceIngestionResult> {
  return ingestProjectEvidence(projectId, request)
}
