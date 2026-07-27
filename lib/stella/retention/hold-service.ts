// lib/stella/retention/hold-service.ts
// Etapa A2.4 (DR-004 aprobado) — preservation holds that block retention
// purge at organization/project/interaction scope. Minimized by design: a
// hold stores a fixed hold_type + reason_code, never a free-text
// description of the underlying matter (legal review pending — see the
// module header note on authorization below).
//
// HOLD_ROLES mirrors SETTINGS_ROLES/CREATE_ROLES elsewhere in Stella: an
// EXACT role match (organization_admin only), not a hierarchy check. No
// approved rule exists yet for who else may create/release a hold (the
// encargo explicitly anticipates this: "documenta la necesidad de revisión
// legal antes de producción") — restricting to organization_admin is the
// conservative default until that review happens, not a final answer.
//
// Audit is TRANSACTIONAL here (Option A from
// STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md#17): both the write and
// its audit entry happen inside the same db.transaction, closing the
// best-effort gap documented for Etapa A2.3.2's declaration actions
// (logAuditActionSafely there is unchanged — this module does not touch it).

import { db } from '@/db/client'
import { stellaRetentionHolds, projects, stellaInteractions } from '@/db/schema'
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { isAllowedHoldType, isAllowedHoldReasonCode, type HoldType, type HoldReasonCode } from './policy'

export { ALLOWED_HOLD_TYPES, ALLOWED_HOLD_REASON_CODES, type HoldType, type HoldReasonCode } from './policy'

const HOLD_ROLES: ReadonlySet<string> = new Set(['organization_admin'])

export interface CreateHoldInput {
  organizationId: string
  projectId?: string
  interactionId?: string
  holdType: HoldType
  reasonCode: HoldReasonCode
  expiresAt?: Date
  createdByUserId: string
}

export type CreateHoldError = 'FORBIDDEN_ROLE' | 'INVALID_HOLD_TYPE' | 'INVALID_REASON_CODE' | 'PROJECT_NOT_FOUND' | 'PROJECT_ORGANIZATION_MISMATCH' | 'INTERACTION_NOT_FOUND' | 'INTERACTION_SCOPE_MISMATCH' | 'UNKNOWN_ERROR'
export type CreateHoldResult = { ok: true; id: string } | { ok: false; error: CreateHoldError }

export async function createRetentionHold(input: CreateHoldInput, actorRole: string): Promise<CreateHoldResult> {
  if (!HOLD_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }
  if (!isAllowedHoldType(input.holdType)) return { ok: false, error: 'INVALID_HOLD_TYPE' }
  if (!isAllowedHoldReasonCode(input.reasonCode)) return { ok: false, error: 'INVALID_REASON_CODE' }

  if (input.projectId) {
    const [project] = await db.select({ id: projects.id, organizationId: projects.organizationId }).from(projects).where(eq(projects.id, input.projectId)).limit(1)
    if (!project) return { ok: false, error: 'PROJECT_NOT_FOUND' }
    if (project.organizationId !== input.organizationId) return { ok: false, error: 'PROJECT_ORGANIZATION_MISMATCH' }
  }

  if (input.interactionId) {
    const [interaction] = await db
      .select({ id: stellaInteractions.id, organizationId: stellaInteractions.organizationId, projectId: stellaInteractions.projectId })
      .from(stellaInteractions)
      .where(eq(stellaInteractions.id, input.interactionId))
      .limit(1)
    if (!interaction) return { ok: false, error: 'INTERACTION_NOT_FOUND' }
    if (interaction.organizationId !== input.organizationId) return { ok: false, error: 'INTERACTION_SCOPE_MISMATCH' }
    if (input.projectId && interaction.projectId !== input.projectId) return { ok: false, error: 'INTERACTION_SCOPE_MISMATCH' }
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(stellaRetentionHolds)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          interactionId: input.interactionId,
          holdType: input.holdType,
          reasonCode: input.reasonCode,
          expiresAt: input.expiresAt,
          createdBy: input.createdByUserId,
        })
        .returning({ id: stellaRetentionHolds.id })

      await logAuditAction(
        {
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorUserId: input.createdByUserId,
          entityType: 'stella_retention_hold',
          entityId: row.id,
          action: AUDIT_ACTIONS.STELLA_RETENTION_HOLD_CREATED,
          afterJson: { holdType: input.holdType, reasonCode: input.reasonCode, scope: input.interactionId ? 'interaction' : input.projectId ? 'project' : 'organization' },
        },
        tx,
      )

      return { ok: true, id: row.id }
    })
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR' }
  }
}

export interface ReleaseHoldInput {
  holdId: string
  organizationId: string
  releasedByUserId: string
}

export type ReleaseHoldError = 'FORBIDDEN_ROLE' | 'NOT_FOUND' | 'ALREADY_RELEASED' | 'UNKNOWN_ERROR'
export type ReleaseHoldResult = { ok: true } | { ok: false; error: ReleaseHoldError }

/** Releasing does NOT purge anything immediately — it only makes the scope eligible again for the NEXT preview/apply run. */
export async function releaseRetentionHold(input: ReleaseHoldInput, actorRole: string): Promise<ReleaseHoldResult> {
  if (!HOLD_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  try {
    return await db.transaction(async (tx) => {
      const [hold] = await tx.select().from(stellaRetentionHolds).where(eq(stellaRetentionHolds.id, input.holdId)).for('update').limit(1)
      if (!hold || hold.organizationId !== input.organizationId) return { ok: false, error: 'NOT_FOUND' }
      if (hold.status !== 'active') return { ok: false, error: 'ALREADY_RELEASED' }

      await tx
        .update(stellaRetentionHolds)
        .set({ status: 'released', releasedBy: input.releasedByUserId, releasedAt: new Date() })
        .where(eq(stellaRetentionHolds.id, input.holdId))

      await logAuditAction(
        {
          organizationId: input.organizationId,
          actorUserId: input.releasedByUserId,
          entityType: 'stella_retention_hold',
          entityId: input.holdId,
          action: AUDIT_ACTIONS.STELLA_RETENTION_HOLD_RELEASED,
        },
        tx,
      )

      return { ok: true }
    })
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR' }
  }
}

/**
 * Batch resolution of "is there a currently-active hold covering this
 * interaction" for every interactionId in `interactionIds` — ONE query
 * (never N), scoped to organizationId. An active hold at ANY level
 * (organization-wide, this interaction's project, or the interaction
 * itself) counts. Expired holds (expiresAt in the past) are treated as NOT
 * blocking, even though their `status` column still literally says
 * 'active' — a separate sweep to flip expired rows to status='expired' is
 * out of scope for a purge-time read; the purge engine only needs the
 * correct boolean verdict right now, computed from expiresAt directly.
 */
export async function getActiveHoldStatusForInteractions(params: {
  organizationId: string
  interactions: ReadonlyArray<{ id: string; projectId: string }>
  now?: Date
}): Promise<Map<string, 'active' | 'none'>> {
  const now = params.now ?? new Date()
  const result = new Map<string, 'active' | 'none'>()
  for (const i of params.interactions) result.set(i.id, 'none')
  if (params.interactions.length === 0) return result

  const projectIds = [...new Set(params.interactions.map((i) => i.projectId))]
  const interactionIds = params.interactions.map((i) => i.id)

  const notExpired = or(isNull(stellaRetentionHolds.expiresAt), gt(stellaRetentionHolds.expiresAt, now))

  const orgHolds = await db
    .select({ id: stellaRetentionHolds.id })
    .from(stellaRetentionHolds)
    .where(and(eq(stellaRetentionHolds.organizationId, params.organizationId), eq(stellaRetentionHolds.status, 'active'), isNull(stellaRetentionHolds.projectId), isNull(stellaRetentionHolds.interactionId), notExpired))
    .limit(1)

  if (orgHolds.length > 0) {
    // An organization-wide hold blocks EVERYTHING in this batch.
    for (const i of params.interactions) result.set(i.id, 'active')
    return result
  }

  const projectHolds = await db
    .select({ projectId: stellaRetentionHolds.projectId })
    .from(stellaRetentionHolds)
    .where(and(eq(stellaRetentionHolds.organizationId, params.organizationId), eq(stellaRetentionHolds.status, 'active'), inArray(stellaRetentionHolds.projectId, projectIds), isNull(stellaRetentionHolds.interactionId), notExpired))

  const heldProjectIds = new Set(projectHolds.map((h) => h.projectId).filter((id): id is string => id !== null))
  for (const i of params.interactions) {
    if (heldProjectIds.has(i.projectId)) result.set(i.id, 'active')
  }

  const interactionHolds = await db
    .select({ interactionId: stellaRetentionHolds.interactionId })
    .from(stellaRetentionHolds)
    .where(and(eq(stellaRetentionHolds.organizationId, params.organizationId), eq(stellaRetentionHolds.status, 'active'), inArray(stellaRetentionHolds.interactionId, interactionIds), notExpired))

  for (const h of interactionHolds) {
    if (h.interactionId) result.set(h.interactionId, 'active')
  }

  return result
}
