// lib/pipeline/evidence-sufficiency.ts
// FIBIU-06 — human evidence sufficiency determination (FIBDB-014/FIBC-008).
// A governed determination over an outcome's evidence SET, never inferred
// from count, individual status, or confidence_score. This module owns the
// write and the latest-read; consumption inside run readiness/approval
// lives in lib/pipeline/sroi-calculation.ts and lib/pipeline/sroi-results.ts
// respectively — both import getLatestSufficiencyDetermination from here
// rather than reimplementing the lookup.

import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { evidenceSufficiencyDeterminations, outcomes, projects } from '@/db/schema'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { canDetermineEvidenceSufficiency } from '@/lib/auth/permissions'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { z } from 'zod'

export type EvidenceSufficiencyDetermination = typeof evidenceSufficiencyDeterminations.$inferSelect
export type SufficiencyDetermination = 'sufficient' | 'insufficient'

const RecordDeterminationSchema = z.object({
  determination: z.enum(['sufficient', 'insufficient'] as const),
  rationale: z.string().min(1),
})

/** The current (highest-ordinal) determination for an outcome, or null if never determined. */
export async function getLatestSufficiencyDetermination(
  outcomeId: string
): Promise<EvidenceSufficiencyDetermination | null> {
  const rows = await db
    .select()
    .from(evidenceSufficiencyDeterminations)
    .where(eq(evidenceSufficiencyDeterminations.outcomeId, outcomeId))
    .orderBy(desc(evidenceSufficiencyDeterminations.ordinal))
    .limit(1)
  return rows[0] ?? null
}

/** Batch form, keyed by outcomeId — for readiness/approval checks over many outcomes at once. */
export async function getLatestSufficiencyDeterminationsByOutcomeIds(
  outcomeIds: readonly string[]
): Promise<Map<string, EvidenceSufficiencyDetermination>> {
  if (outcomeIds.length === 0) return new Map()

  const rows = await db
    .select()
    .from(evidenceSufficiencyDeterminations)
    .where(inArray(evidenceSufficiencyDeterminations.outcomeId, outcomeIds))

  const latest = new Map<string, EvidenceSufficiencyDetermination>()
  for (const row of rows) {
    const existing = latest.get(row.outcomeId)
    if (!existing || row.ordinal > existing.ordinal) latest.set(row.outcomeId, row)
  }
  return latest
}

/**
 * Record a governed human sufficiency determination for an outcome's
 * evidence set. Append-only — a re-determination is a new row (ordinal+1),
 * never an edit. FC (FIBC-008): never inferred from count, status, or
 * confidence_score — this function accepts only an explicit human
 * determination and rationale, both required.
 */
export async function recordEvidenceSufficiencyDetermination(
  projectId: string,
  outcomeId: string,
  input: unknown
): Promise<EvidenceSufficiencyDetermination> {
  const { membership, organization, user } = await requireOrganizationAccess()
  if (!canDetermineEvidenceSufficiency(membership.role)) {
    throw new Error('Insufficient permissions to determine evidence sufficiency')
  }
  const parsed = RecordDeterminationSchema.parse(input)

  const proj = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!proj.length || proj[0].organizationId !== organization.id) {
    throw new Error('Project does not belong to your organization')
  }

  const outcome = await db.select().from(outcomes).where(eq(outcomes.id, outcomeId)).limit(1)
  if (!outcome.length || outcome[0].projectId !== projectId) {
    throw new Error('Outcome does not belong to the project')
  }

  const current = await getLatestSufficiencyDetermination(outcomeId)
  const ordinal = (current?.ordinal ?? 0) + 1

  const [created] = await db
    .insert(evidenceSufficiencyDeterminations)
    .values({
      organizationId: organization.id,
      projectId,
      outcomeId,
      ordinal,
      determination: parsed.determination,
      rationale: parsed.rationale,
      actorUserId: user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: organization.id,
    projectId,
    actorUserId: user.id,
    entityType: 'evidence_sufficiency_determination',
    entityId: created.id,
    action: AUDIT_ACTIONS.EVIDENCE_SUFFICIENCY_DETERMINATION_RECORDED,
    afterJson: { outcomeId, determination: created.determination, ordinal: created.ordinal },
  })

  return created
}
