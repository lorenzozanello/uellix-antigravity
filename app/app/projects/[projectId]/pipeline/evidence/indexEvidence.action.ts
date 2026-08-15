// app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action.ts

'use server'

import {
  ingestProjectEvidenceForProject,
  type EvidenceIngestionResult,
} from '@/app/actions/grounding/ingest-evidence'

/**
 * Index ONE evidence row on demand — the manual retry behind the evidence list.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FORWARDS INSTEAD OF DOING THE WORK
 * ---------------------------------------------------------------------------
 * Everything a retry must re-establish is already established by
 * `ingestProjectEvidenceForProject`, on every call, from the session:
 *
 *   organization  <- `requireOrganizationAccess()`
 *   role          <- `canUploadEvidence(membership.role)`
 *   the row       <- a SELECT scoped by (evidence id, project id, organization
 *                    id); a pair that does not satisfy all three returns
 *                    `unauthorized`, the same answer a missing row gets
 *
 * So a forged `(projectId, evidenceId)` pair from the form is not trusted here
 * and does not need to be: it is re-verified inside, against the session, on
 * the row itself. Re-checking it in this file would create a second copy of the
 * evidence policy — free to drift from the first the day the threshold moves —
 * for no boundary the first does not already hold.
 *
 * ---------------------------------------------------------------------------
 * WHY NO IDENTITY CONTEXT HERE
 * ---------------------------------------------------------------------------
 * The action it calls owns three: a short one for the scoped lookup, ONE that
 * carries register -> insert -> finalize as a single transaction (M-7), and a
 * short one for the audit row. An outer context would be reused by all three
 * and would put the storage round trip back inside a transaction — the same
 * reason `createFileEvidence.action.ts` opens none.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE
 * ---------------------------------------------------------------------------
 * Retrying an already-indexed row is safe by construction rather than by a
 * guard here: identical bytes derive the same content-addressed `version_id`,
 * `register_document_version` is idempotent on it, `insert_evidence_chunks` is
 * `ON CONFLICT DO NOTHING` on `chunk_id`, and `finalize_document_ingestion`
 * re-asserts the count. The orchestrator reports that as `identical_replay`,
 * which is deliberately NOT a no-op: it is the repair path for an ingestion
 * that died between the chunk write and the finalize.
 */
export async function indexEvidenceAction(
  projectId: string,
  evidenceId: string,
): Promise<EvidenceIngestionResult> {
  return ingestProjectEvidenceForProject(projectId, { evidenceId })
}
