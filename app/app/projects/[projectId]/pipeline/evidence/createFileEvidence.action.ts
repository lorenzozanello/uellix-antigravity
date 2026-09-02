// app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action.ts

'use server'

import {
  createFileEvidenceForProject,
  ALLOWED_EVIDENCE_MIME_TYPES,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
} from '@/lib/pipeline/evidence'
import {
  ingestProjectEvidenceForProject,
  type EvidenceIngestionResult,
} from '@/app/actions/grounding/ingest-evidence'
import { z } from 'zod'

const InputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  file: z.object({
    name: z.string().min(1),
    mimeType: z.enum(ALLOWED_EVIDENCE_MIME_TYPES),
    size: z.number().int().positive().max(MAX_EVIDENCE_FILE_SIZE_BYTES),
    buffer: z.instanceof(Buffer),
  }),
})

export interface CreateFileEvidenceOutcome {
  /** The `evidence_items` row, exactly as the service returned it. */
  readonly evidence: Awaited<ReturnType<typeof createFileEvidenceForProject>>
  /**
   * What the governed grounding path did with it, or `null` when it was never
   * consulted.
   *
   * SEPARATE FROM `evidence` ON PURPOSE. The upload either happened or threw;
   * indexing is a second, weaker outcome over the same row, and collapsing the
   * two would make an unindexable PDF look like a failed upload.
   */
  readonly indexing: EvidenceIngestionResult | null
}

/**
 * Create one file evidence item and, IF IT COMMITTED, index it.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE CONTRACT
 * ---------------------------------------------------------------------------
 * `createFileEvidenceForProject` returns only after its three phases have run:
 * the row is reserved, the object is uploaded with no transaction open, and the
 * row is finalized with its `file_path`. Until that return there is no evidence
 * identity to index — before phase 3 there is a row whose object may still be
 * compensated away, and the resolver would refuse it for the correct reason
 * (`missing_bytes`) while polluting the trail with a failure nobody caused.
 *
 * So indexing is invoked HERE, after the await, and never from inside
 * `lib/pipeline/evidence.ts`. Moving it in would also put a grounding failure
 * inside the finalize transaction, where it could roll back an evidence upload
 * for the sake of an index that is derived and regenerable.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROW'S OWN PROJECT AND NOT THE ARGUMENT
 * ---------------------------------------------------------------------------
 * The governed surface derives scope from the evidence row, so the project that
 * matters is `evidence.projectId` — the value that was actually committed, not
 * the one that was requested. They are equal today because the service writes
 * the argument; naming the row keeps them equal if that ever stops being true.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAILURE HERE IS NEVER RE-THROWN
 * ---------------------------------------------------------------------------
 * The uploaded file and its SHA-256 are the chain of custody. The grounding
 * index is derived from them and can be rebuilt at any time from the same
 * bytes. Throwing would tell the reviewer their evidence was not stored, which
 * is false, and would cost them the upload for a failure they can retry from
 * the evidence screen.
 */
export async function createFileEvidenceAction(
  projectId: string,
  rawInput: unknown,
): Promise<CreateFileEvidenceOutcome> {
  const input = InputSchema.parse(rawInput)
  // NOT wrapped here on purpose. createFileEvidenceForProject owns three
  // contexts with a storage upload between them; an outer context would be
  // reused by all three and put the upload back inside a transaction.
  const evidence = await createFileEvidenceForProject(projectId, input)

  // Everything below this line runs against a COMMITTED evidence identity.
  const indexing = await indexCommittedEvidence(evidence)

  return { evidence, indexing }
}

/**
 * Index one committed row, converting every failure into a reported status.
 *
 * `ingestProjectEvidenceForProject` is written to return statuses rather than
 * throw, and it owns its own identity contexts. The catch is for the `await`
 * itself: it sits one call away from a driver and a storage client, and an
 * unexpected throw must not turn a successful upload into a rejected action.
 */
async function indexCommittedEvidence(evidence: {
  id: string
  projectId: string
}): Promise<EvidenceIngestionResult> {
  try {
    return await ingestProjectEvidenceForProject(evidence.projectId, { evidenceId: evidence.id })
  } catch (error) {
    // The error is NOT carried out: it may quote a statement or a storage path.
    // The stage names where the boundary broke and nothing else.
    console.error(
      '[evidence-auto-index] ingestion invocation threw:',
      error instanceof Error ? error.name : 'unknown',
    )
    return { status: 'error', stage: 'ingest_invocation' }
  }
}
