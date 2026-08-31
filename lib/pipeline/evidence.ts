// lib/pipeline/evidence.ts

import { db } from '@/db/client'
import { evidenceItems, projects, outcomes, indicators } from '@/db/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { createClient } from '@/lib/supabase/server'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { hasRole } from '@/lib/auth/permissions'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { z } from 'zod'
import crypto from 'crypto'
import { recalculateConfidenceScore } from '@/lib/pipeline/confidence-score'

// Types
export type EvidenceStatus = 'draft' | 'under_review' | 'approved' | 'rejected' | 'archived'
export type EvidenceType = 'file' | 'url' | 'text'

// Upload constraints — enforced here so every caller (Server Action wrappers,
// future API routes) inherits the same limits regardless of what checks the
// UI layer happens to run before calling in.
export const MAX_EVIDENCE_FILE_SIZE_BYTES = 25 * 1024 * 1024 // 25 MB
export const ALLOWED_EVIDENCE_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

// Validation schemas
const CreateFileEvidenceSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  file: z.object({
    name: z.string().min(1),
    mimeType: z.enum(ALLOWED_EVIDENCE_MIME_TYPES, {
      message: `File type not allowed. Accepted types: ${ALLOWED_EVIDENCE_MIME_TYPES.join(', ')}`,
    }),
    size: z
      .number()
      .int()
      .positive()
      .max(MAX_EVIDENCE_FILE_SIZE_BYTES, { message: 'File exceeds the 25 MB upload limit' }),
    buffer: z.instanceof(Buffer),
  }),
})

// Strips any path components and dangerous characters from a client-supplied
// filename before it's used as (part of) a Supabase Storage key — prevents
// path traversal via crafted names like "../../other-project/evidence.pdf".
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_')
  const trimmed = cleaned.replace(/^[._-]+/, '') || 'file'
  return trimmed.slice(0, 150)
}

const CreateUrlEvidenceSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  url: z.string().url(),
})

const CreateTextEvidenceSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  text: z.string().min(1),
})

const UpdateReviewStatusSchema = z.object({
  status: z.enum(['under_review', 'approved', 'rejected'] as const),
  reviewNotes: z.string().optional(),
})

// Helpers
async function verifyProjectOwnership(projectId: string, orgId: string) {
  const proj = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!proj.length || proj[0].organizationId !== orgId) {
    throw new Error('Project does not belong to your organization')
  }
  return proj[0]
}

async function verifyOutcomeIndicator(projectId: string, outcomeId?: string, indicatorId?: string) {
  if (outcomeId) {
    const out = await db.select().from(outcomes).where(eq(outcomes.id, outcomeId)).limit(1)
    if (!out.length || out[0].projectId !== projectId) {
      throw new Error('Outcome does not belong to the project')
    }
  }
  if (indicatorId) {
    const ind = await db.select().from(indicators).where(eq(indicators.id, indicatorId)).limit(1)
    if (!ind.length || ind[0].projectId !== projectId) {
      throw new Error('Indicator does not belong to the project')
    }
  }
}

/* -------------------------------------------------------------------------- */
/* M2-COMP-01 — compensating a file upload that stored no bytes               */
/* -------------------------------------------------------------------------- */

/** Where a file upload stopped after its row was already committed. */
export type EvidenceUploadFailureStage = 'upload' | 'finalize'

/**
 * The compensation itself did not take effect.
 *
 * Thrown INSTEAD of the underlying cause, because it is the louder fact: the
 * upload failing is ordinary and recoverable, a row surviving with no file is
 * neither. It names no storage path and no message from the driver.
 */
export class EvidenceUploadCompensationError extends Error {
  readonly name = 'EvidenceUploadCompensationError'
  readonly code = 'EVIDENCE_COMPENSATION_NOT_APPLIED'
  readonly evidenceId: string
  readonly stage: EvidenceUploadFailureStage

  constructor(evidenceId: string, stage: EvidenceUploadFailureStage) {
    super(
      'A file upload failed and its evidence row could not be withdrawn from the working set. ' +
        'A row with no stored bytes may still be readable as evidence and needs manual review.'
    )
    this.evidenceId = evidenceId
    this.stage = stage
  }
}

/**
 * Withdraw the row of an upload that never produced stored bytes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A DELETE — M2-COMP-01
 * ---------------------------------------------------------------------------
 * It used to be. `evidence_items` has RLS enabled, carries SELECT / INSERT /
 * UPDATE policies, and deliberately has NO DELETE policy (db/policies/
 * 001_initial_auth_rls.sql: "DELETE is strictly denied ... Archiving must be
 * performed via UPDATE to status='archived'"). The DELETE privilege is
 * nonetheless granted, through `uellix_writer`, and that combination is the
 * whole defect: PostgreSQL applies RLS as a SCAN FILTER, so with the grant
 * present and the policy absent the statement is legal, matches nothing, and
 * reports zero rows WITHOUT raising. Measured on PG 17.6 as `uellix_app`:
 *
 *     INSERT 0 1   -- the row commits
 *     DELETE 0     -- no error; the transaction COMMITs
 *     SELECT ...   -- the row is still there, status 'draft', file_path NULL
 *
 * The old code awaited that DELETE and inspected nothing, so a compensation
 * that erased nothing was indistinguishable from one that worked.
 *
 * ---------------------------------------------------------------------------
 * WHY `archived` AND NOT A NEW STATE
 * ---------------------------------------------------------------------------
 * `archived` is not a euphemism here, it is the state every consumer already
 * reads as "not part of the evidence set": the SROI evidence gate counts only
 * `draft | under_review | approved` (lib/pipeline/sroi-calculation.ts), the
 * confidence score scores it 0 (lib/pipeline/confidence-score.ts), and the
 * grounding read model withholds the index action for it (lib/grounding/
 * corpus-state.ts). `draft` — what the row is left in today — is counted by all
 * three, which is why the orphan is not merely untidy: it satisfies the SROI
 * gate for an outcome whose supporting file does not exist.
 *
 * A dedicated `failed` state would mean a new value in
 * `evidence_items_status_check`, i.e. a migration, for a condition the schema
 * can already express. What makes the state UNAMBIGUOUS is the pair, not the
 * column: `type='file' AND file_path IS NULL AND status='archived'` is reached
 * by nothing else — a reviewer archiving real evidence archives a row that has
 * a path. The trail names the cause; the row is derivable without it. That is
 * the same "derive it, do not add a column" reasoning lib/grounding/
 * corpus-state.ts applies to indexing state.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PREDICATE IS FOR
 * ---------------------------------------------------------------------------
 * Every term is load-bearing and every value is server-owned — the project was
 * verified in phase 1, the organisation comes from the session, and the id is
 * the row this call just created:
 *
 *   id + project + organisation  a compensation can never reach another
 *                                tenant's row, above what RLS already refuses;
 *   file_path IS NULL            EVIDENCE IMMUTABILITY. A row that has bytes is
 *                                stored evidence and is outside this statement
 *                                by construction, whatever else goes wrong.
 *
 * Measured, same database: `impact_manager` and `organization_admin` compensate
 * (UPDATE 1), `viewer` cannot (UPDATE 0), a member of another organisation
 * cannot (UPDATE 0), and a row that has a `file_path` cannot be touched
 * (UPDATE 0).
 */
async function compensateFailedFileUpload(params: {
  readonly evidenceId: string
  readonly projectId: string
  readonly organizationId: string
  readonly actorUserId: string
  readonly stage: EvidenceUploadFailureStage
}): Promise<void> {
  const { evidenceId, projectId, organizationId, actorUserId, stage } = params

  // Real prior state for the audit record's beforeJson (FIBC-040) — read
  // before the compensation UPDATE runs, never fabricated. Best-effort: a
  // failed read here must not block the compensation itself, so it falls
  // back to null rather than throwing.
  const priorStatus = await withOrganizationDatabaseContext(async () => {
    const rows = await db
      .select({ status: evidenceItems.status })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.id, evidenceId),
          eq(evidenceItems.projectId, projectId),
          eq(evidenceItems.organizationId, organizationId)
        )
      )
      .limit(1)
    return rows[0]?.status ?? null
  }).catch(() => null)

  // RETURNING, not a bare UPDATE: the row count IS the outcome. This is the
  // check whose absence was the defect, so it is read here and nowhere else.
  const compensated = await withOrganizationDatabaseContext(async () => {
    return db
      .update(evidenceItems)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(
        and(
          eq(evidenceItems.id, evidenceId),
          eq(evidenceItems.projectId, projectId),
          eq(evidenceItems.organizationId, organizationId),
          isNull(evidenceItems.filePath)
        )
      )
      .returning({ id: evidenceItems.id })
  })

  const applied = compensated.length === 1

  // A SECOND context on purpose. This row is the only durable trace of an
  // upload that stored nothing, and it matters MOST in the branch where the
  // compensation failed — so it must not be inside the transaction whose
  // outcome it reports, and it must not be able to suppress that outcome.
  try {
    await withOrganizationDatabaseContext(async () => {
      await logAuditAction({
        organizationId,
        projectId,
        actorUserId,
        entityType: 'evidence_item',
        entityId: evidenceId,
        action: AUDIT_ACTIONS.EVIDENCE_UPLOAD_FAILED,
        reason:
          stage === 'upload'
            ? 'The storage upload failed; no bytes were stored for this evidence row.'
            : 'The upload was stored but finalisation failed; the row never recorded its file path.',
        contentModifying: true,
        beforeJson: { status: priorStatus },
        afterJson: { stage, compensated: applied, status: applied ? 'archived' : priorStatus },
      })
    })
  } catch (auditError) {
    // Named, never carried: the error may quote a statement. Losing the trail
    // must not turn a successful compensation into a failed one, nor hide a
    // failed one — both verdicts are decided by `applied`, below.
    console.error(
      '[evidence-compensation] audit write failed:',
      auditError instanceof Error ? auditError.name : 'unknown'
    )
  }

  // `recalculateConfidenceScore` is deliberately NOT called. It scores a file
  // row 35 for its type before it looks at anything else, so recomputing here
  // would stamp a positive confidence on evidence that does not exist. Leaving
  // the column NULL says "never scored", which is true.

  if (!applied) throw new EvidenceUploadCompensationError(evidenceId, stage)
}

// Service functions
export async function listEvidenceForProject(projectId: string) {
  const { organization } = await requireOrganizationAccess()
  await verifyProjectOwnership(projectId, organization.id)
  return db.select().from(evidenceItems).where(eq(evidenceItems.projectId, projectId))
}

export async function getEvidenceByIdForProject(projectId: string, evidenceId: string) {
  const { organization } = await requireOrganizationAccess()
  await verifyProjectOwnership(projectId, organization.id)
  const rows = await db
    .select()
    .from(evidenceItems)
    .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))
  if (!rows.length) throw new Error('Evidence not found')
  return rows[0]
}

/**
 * THIS FUNCTION OWNS ITS OWN DATABASE CONTEXTS. Its caller must NOT wrap it.
 *
 * A file upload is one logical operation across two systems, and the storage
 * round trip can be 25 MB. Running it inside the transaction would pin a pooled
 * connection for the length of the upload, and — worse — would silently invert
 * the compensation this function was built around:
 *
 *   * the original code inserted the row, uploaded, and DELETED the row if the
 *     upload failed. Inside one transaction that delete is dead code, because
 *     the throw rolls the insert back anyway;
 *   * but the OPPOSITE case becomes a new, permanent bug: if the upload
 *     succeeds and a later step throws, the transaction discards the
 *     `evidence_items` row while the object stays in the bucket under an id
 *     that can never be reissued. An orphan with no row to find it from.
 *
 * So the phases are explicit: write the row, close; upload, outside any
 * transaction; finalise or compensate, in a second one. It is the only ordering
 * in which a compensation can run at all.
 *
 * WHAT THE COMPENSATION IS, THOUGH, IS NOT A DELETE — see
 * `compensateFailedFileUpload`. The reasoning above establishes only WHEN it
 * can run; M2-COMP-01 is about what happens when it does, and a DELETE against
 * a table with no DELETE policy erases nothing while reporting no error.
 */
export async function createFileEvidenceForProject(projectId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to upload evidence')
  }
  const parsed = CreateFileEvidenceSchema.parse(input)

  const sha256 = crypto.createHash('sha256').update(parsed.file.buffer).digest('hex')

  // ---- Phase 1: authorise and reserve the row --------------------------------
  const evidence = await withOrganizationDatabaseContext(async () => {
    await verifyProjectOwnership(projectId, organization.id)
    await verifyOutcomeIndicator(projectId, parsed.outcomeId, parsed.indicatorId)

    const [row] = await db
      .insert(evidenceItems)
      .values({
        projectId,
        organizationId: organization.id,
        type: 'file',
        title: parsed.title,
        description: parsed.description,
        outcomeId: parsed.outcomeId,
        indicatorId: parsed.indicatorId,
        fileSize: parsed.file.size,
        mimeType: parsed.file.mimeType,
        contentHash: sha256,
        status: 'draft',
        createdBy: user.id,
      })
      .returning()
    return row
  })

  // ---- Phase 2: the upload, with NO transaction open -------------------------
  const supabase = await createClient()
  const bucket = 'uellix-evidence'
  const filePath = `${projectId}/${evidence.id}/${sanitizeFileName(parsed.file.name)}`
  const { error } = await supabase.storage.from(bucket).upload(filePath, parsed.file.buffer, {
    contentType: parsed.file.mimeType,
    upsert: false,
  })

  if (error) {
    // Compensate: the row exists and its file does not. Its own context, and
    // its row count is checked — see compensateFailedFileUpload (M2-COMP-01).
    await compensateFailedFileUpload({
      evidenceId: evidence.id,
      projectId,
      organizationId: organization.id,
      actorUserId: user.id,
      stage: 'upload',
    })
    throw new Error(`Storage upload failed: ${error.message}`)
  }

  // ---- Phase 3: finalise -----------------------------------------------------
  try {
    await withOrganizationDatabaseContext(async () => {
      await db.update(evidenceItems).set({ filePath }).where(eq(evidenceItems.id, evidence.id))

      await logAuditAction({
        organizationId: organization.id,
        projectId,
        actorUserId: user.id,
        entityType: 'evidence_item',
        entityId: evidence.id,
        action: AUDIT_ACTIONS.EVIDENCE_CREATED,
        afterJson: { type: 'file', title: parsed.title, sha256 },
      })

      await recalculateConfidenceScore(projectId, evidence.id)
    })
  } catch (finalizeError) {
    // ONE transaction, so there is no partial finalise: the row still has no
    // `file_path`, and nothing can rediscover the object from it. The bytes are
    // now unreferenced in the bucket — that is a storage cost, not an evidence
    // claim, and it is strictly better than a row that reads as evidence for a
    // file the row cannot name. The object is NOT deleted in compensation: that
    // would route this path through `can_write_evidence_object`, which admits
    // only two of the four roles allowed to upload (M-2), i.e. a second
    // unreliable channel to repair the first.
    await compensateFailedFileUpload({
      evidenceId: evidence.id,
      projectId,
      organizationId: organization.id,
      actorUserId: user.id,
      stage: 'finalize',
    })
    throw finalizeError
  }

  return evidence
}

export async function createUrlEvidenceForProject(projectId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to create URL evidence')
  }
  const parsed = CreateUrlEvidenceSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)
  await verifyOutcomeIndicator(projectId, parsed.outcomeId, parsed.indicatorId)

  const normalizedUrl = parsed.url.trim().toLowerCase()
  // NOTE: for URL evidence this hashes the *reference* (the URL string), not the
  // content the URL points to — the remote page can change with the hash
  // unchanged. It is a stable identifier/dedupe key, not tamper-evidence of the
  // linked content. Only file evidence carries true content integrity.
  const sha256 = crypto.createHash('sha256').update(normalizedUrl).digest('hex')

  const [evidence] = await db
    .insert(evidenceItems)
    .values({
      projectId,
      organizationId: organization.id,
      type: 'url',
      title: parsed.title,
      description: parsed.description,
      outcomeId: parsed.outcomeId,
      indicatorId: parsed.indicatorId,
      url: normalizedUrl,
      contentHash: sha256,
      status: 'draft',
      createdBy: user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidence.id,
    action: AUDIT_ACTIONS.EVIDENCE_CREATED,
    afterJson: { type: 'url', title: parsed.title, sha256 },
  })

  await recalculateConfidenceScore(projectId, evidence.id)

  return evidence
}

export async function createTextEvidenceForProject(projectId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to create text evidence')
  }
  const parsed = CreateTextEvidenceSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)
  await verifyOutcomeIndicator(projectId, parsed.outcomeId, parsed.indicatorId)

  const normalizedText = parsed.text.trim()
  const sha256 = crypto.createHash('sha256').update(normalizedText).digest('hex')

  const [evidence] = await db
    .insert(evidenceItems)
    .values({
      projectId,
      organizationId: organization.id,
      type: 'text',
      title: parsed.title,
      description: parsed.description,
      outcomeId: parsed.outcomeId,
      indicatorId: parsed.indicatorId,
      contentHash: sha256,
      status: 'draft',
      createdBy: user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidence.id,
    action: AUDIT_ACTIONS.EVIDENCE_CREATED,
    afterJson: { type: 'text', title: parsed.title, sha256 },
  })

  await recalculateConfidenceScore(projectId, evidence.id)

  return evidence
}

export async function updateEvidenceReviewStatus(projectId: string, evidenceId: string, input: unknown) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'impact_manager')) {
    throw new Error('Insufficient permissions to change review status')
  }
  const parsed = UpdateReviewStatusSchema.parse(input)
  await verifyProjectOwnership(projectId, organization.id)

  const before = await getEvidenceByIdForProject(projectId, evidenceId)

  await db
    .update(evidenceItems)
    .set({ status: parsed.status, reviewNotes: parsed.reviewNotes })
    .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))

  const after = await getEvidenceByIdForProject(projectId, evidenceId)

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidenceId,
    action: AUDIT_ACTIONS.EVIDENCE_REVIEW_STATUS_CHANGED,
    beforeJson: before,
    afterJson: after,
  })

  await recalculateConfidenceScore(projectId, evidenceId)

  return after
}

export async function archiveEvidenceForProject(projectId: string, evidenceId: string) {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to archive evidence')
  }
  await verifyProjectOwnership(projectId, organization.id)

  const before = await getEvidenceByIdForProject(projectId, evidenceId)

  await db
    .update(evidenceItems)
    .set({ status: 'archived' })
    .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))

  const after = await getEvidenceByIdForProject(projectId, evidenceId)

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_item',
    entityId: evidenceId,
    action: AUDIT_ACTIONS.EVIDENCE_ARCHIVED,
    beforeJson: before,
    afterJson: after,
  })

  return after
}

/**
 * Re-computes the SHA-256 of the stored file and compares it to the hash
 * recorded at upload time. This is the verification path that makes the
 * "any later modification is detectable" guarantee real rather than merely
 * recorded — call it from the Trust Center or a scheduled integrity sweep.
 * Only applies to file evidence (URL/text hashes are reference identifiers).
 *
 * NOT read-only: on every call it persists `integrityVerified` /
 * `integrityVerifiedAt` on the evidence row and triggers
 * `recalculateConfidenceScore`, which may itself write `confidenceScore` and
 * append an audit_log entry. A periodic sweep that loops this over many
 * evidence items will produce a write (and possibly an audit entry) per item
 * checked, not just reads. Requires `impact_manager`+ (same threshold as
 * `updateEvidenceReviewStatus`), since it is a write path, not a read one.
 */
export async function verifyFileEvidenceIntegrity(
  projectId: string,
  evidenceId: string,
): Promise<{ verified: boolean; reason?: string; storedHash: string | null; computedHash: string | null }> {
  // OWNS ITS OWN CONTEXTS — see createFileEvidenceForProject. The whole stored
  // file is downloaded and re-hashed between the read and the write; that must
  // not happen with a transaction open.
  const { membership, organization } = await requireOrganizationAccess()
  if (!hasRole(membership.role, 'impact_manager')) {
    throw new Error('Insufficient permissions to verify evidence integrity')
  }

  const evidence = await withOrganizationDatabaseContext(async () => {
    await verifyProjectOwnership(projectId, organization.id)
    return getEvidenceByIdForProject(projectId, evidenceId)
  })

  if (evidence.type !== 'file') {
    return { verified: false, reason: 'Integrity verification only applies to file evidence', storedHash: evidence.contentHash, computedHash: null }
  }
  if (!evidence.filePath) {
    return { verified: false, reason: 'Evidence has no stored file path', storedHash: evidence.contentHash, computedHash: null }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.storage.from('uellix-evidence').download(evidence.filePath)
  if (error || !data) {
    return { verified: false, reason: `Stored file unreadable: ${error?.message ?? 'not found'}`, storedHash: evidence.contentHash, computedHash: null }
  }

  const buffer = Buffer.from(await data.arrayBuffer())
  const computedHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const verified = computedHash === evidence.contentHash

  await withOrganizationDatabaseContext(async () => {
    await db
      .update(evidenceItems)
      .set({ integrityVerified: verified, integrityVerifiedAt: new Date() })
      .where(and(eq(evidenceItems.projectId, projectId), eq(evidenceItems.id, evidenceId)))
    await recalculateConfidenceScore(projectId, evidenceId)
  })

  return { verified, storedHash: evidence.contentHash, computedHash }
}

export async function listEvidenceForOrganizationWithProject() {
  const { organization } = await requireOrganizationAccess()
  return db
    .select({
      id: evidenceItems.id,
      title: evidenceItems.title,
      type: evidenceItems.type,
      status: evidenceItems.status,
      contentHash: evidenceItems.contentHash,
      createdAt: evidenceItems.createdAt,
      projectName: projects.name,
      projectId: projects.id,
    })
    .from(evidenceItems)
    .innerJoin(projects, eq(evidenceItems.projectId, projects.id))
    .where(eq(evidenceItems.organizationId, organization.id))
}

