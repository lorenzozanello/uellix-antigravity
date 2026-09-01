// lib/pipeline/evidence-sufficiency.ts
// FIBIU-06 — human evidence sufficiency determination (FIBDB-014/FIBC-008).
// A governed determination over an outcome's evidence SET, never inferred
// from count, individual status, or confidence_score. This module owns the
// write and the latest-read; consumption inside run-review approval lives
// in lib/pipeline/sroi-results.ts, which imports
// getLatestSufficiencyDeterminationsByOutcomeIds from here rather than
// reimplementing the lookup.
//
// W2-B1-R3 (R-B1-04, M-1) — FIBDB-014 verbatim: "Per monetized outcome per
// run." Every read and write here is bound to an explicit
// calculationRunId: a determination recorded for run R1 can never satisfy
// approval of run R2, even for the same outcome. There is deliberately no
// outcome-only lookup left in this module — that shape is exactly the
// defect this remediation closes.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { evidenceSufficiencyDeterminations, outcomes, projects, sroiCalculationRuns } from '@/db/schema'
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

/** The current (highest-ordinal) determination for an outcome BOUND TO THE EXACT RUN, or null if never determined for that run. */
export async function getLatestSufficiencyDetermination(
  outcomeId: string,
  calculationRunId: string
): Promise<EvidenceSufficiencyDetermination | null> {
  const rows = await db
    .select()
    .from(evidenceSufficiencyDeterminations)
    .where(
      and(
        eq(evidenceSufficiencyDeterminations.outcomeId, outcomeId),
        eq(evidenceSufficiencyDeterminations.calculationRunId, calculationRunId)
      )
    )
    .orderBy(desc(evidenceSufficiencyDeterminations.ordinal))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Batch form, keyed by outcomeId — for the run-review approval check over
 * many outcomes at once, ALL bound to the one run being approved. Never
 * "the highest-ordinal determination for the outcome across any run" — a
 * determination that governed a different run must never silently satisfy
 * this one.
 */
export async function getLatestSufficiencyDeterminationsByOutcomeIds(
  outcomeIds: readonly string[],
  calculationRunId: string
): Promise<Map<string, EvidenceSufficiencyDetermination>> {
  if (outcomeIds.length === 0) return new Map()

  const rows = await db
    .select()
    .from(evidenceSufficiencyDeterminations)
    .where(
      and(
        inArray(evidenceSufficiencyDeterminations.outcomeId, outcomeIds),
        eq(evidenceSufficiencyDeterminations.calculationRunId, calculationRunId)
      )
    )

  const latest = new Map<string, EvidenceSufficiencyDetermination>()
  for (const row of rows) {
    const existing = latest.get(row.outcomeId)
    if (!existing || row.ordinal > existing.ordinal) latest.set(row.outcomeId, row)
  }
  return latest
}

/**
 * Record a governed human sufficiency determination for an outcome's
 * evidence set, bound to the exact calculation run it was made for.
 * Append-only — a re-determination is a new row (ordinal+1) WITHIN the
 * same (outcome, run) pair, never an edit and never carried over from a
 * different run. FC (FIBC-008): never inferred from count, status, or
 * confidence_score — this function accepts only an explicit human
 * determination and rationale, both required.
 */
export async function recordEvidenceSufficiencyDetermination(
  projectId: string,
  outcomeId: string,
  calculationRunId: string,
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

  const run = await db
    .select()
    .from(sroiCalculationRuns)
    .where(eq(sroiCalculationRuns.id, calculationRunId))
    .limit(1)
  if (!run.length || run[0].projectId !== projectId || run[0].organizationId !== organization.id) {
    throw new Error('Calculation run does not belong to the project')
  }

  const current = await getLatestSufficiencyDetermination(outcomeId, calculationRunId)
  const ordinal = (current?.ordinal ?? 0) + 1

  const [created] = await db
    .insert(evidenceSufficiencyDeterminations)
    .values({
      organizationId: organization.id,
      projectId,
      outcomeId,
      calculationRunId,
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
    afterJson: { outcomeId, calculationRunId, determination: created.determination, ordinal: created.ordinal },
  })

  return created
}
