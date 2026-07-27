'use server'
// app/actions/stella/retention.ts
// Etapa A2.4 (DR-004 aprobado) — thin server actions over
// lib/stella/retention/*.ts. Auth + org resolution only; ALL business rules
// (role checks, bounds, transactions) live in the service layer, not here —
// same convention as app/actions/stella/aggregation-declarations.ts.
//
// These actions do NOT purge stella_ai_consent_events or
// stella_sensitive_aggregation_declarations — those categories have no
// executable purge path in this stage (see lib/stella/retention/policy.ts's
// header). They also never accept organizationId, actorRole, cutoffAt, or
// policyVersion from the client — all resolved server-side from the
// session or computed from the current policy constants.

import { randomUUID } from 'crypto'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { CURRENT_STELLA_RETENTION_POLICY } from '@/lib/stella/retention/policy'
import {
  getEffectiveRetentionSettings,
  updateOrganizationRetentionSettings,
  previewRetentionSettingsImpact,
} from '@/lib/stella/retention/settings-service'
import {
  createRetentionHold,
  releaseRetentionHold,
  type HoldType,
  type HoldReasonCode,
} from '@/lib/stella/retention/hold-service'
import {
  previewStellaRetentionPurge,
  executeStellaRetentionPurge,
  resumeStellaRetentionPurge,
  getPurgeRunStatus,
  type PurgeRunSummary,
} from '@/lib/stella/retention/purge-service'
import { db } from '@/db/client'
import { stellaRetentionHolds, stellaRetentionPurgeRuns } from '@/db/schema'
import { desc, eq } from 'drizzle-orm'

async function currentActor() {
  return requireOrganizationAccess()
}

// ---------------------------------------------------------------------------
// Policy / settings
// ---------------------------------------------------------------------------

export interface RetentionOverview {
  policyVersion: string
  defaultResponseRetentionMonths: number
  minResponseRetentionMonths: number
  maxResponseRetentionMonths: number
  organizationResponseRetentionMonths: number
  isDefaultSetting: boolean
  configuredAt: Date | null
  canManage: boolean
}

/** Read-only for any active member — shows the EFFECTIVE policy (org override if configured, else the global default). Never accepts a client-supplied policy version. */
export async function getStellaRetentionOverview(): Promise<{ ok: true; data: RetentionOverview } | { ok: false; error: 'UNAUTHORIZED' }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }

  const settings = await getEffectiveRetentionSettings(ctx.organization.id)

  return {
    ok: true,
    data: {
      policyVersion: CURRENT_STELLA_RETENTION_POLICY.policyVersion,
      defaultResponseRetentionMonths: CURRENT_STELLA_RETENTION_POLICY.defaultResponseRetentionMonths,
      minResponseRetentionMonths: CURRENT_STELLA_RETENTION_POLICY.minResponseRetentionMonths,
      maxResponseRetentionMonths: CURRENT_STELLA_RETENTION_POLICY.maxResponseRetentionMonths,
      organizationResponseRetentionMonths: settings.responseRetentionMonths,
      isDefaultSetting: settings.isDefault,
      configuredAt: settings.configuredAt,
      canManage: ctx.membership.role === 'organization_admin',
    },
  }
}

/** Required before applying a REDUCTION — shows how many currently-retained responses would newly become eligible. Never mutates anything. */
export async function previewRetentionSettingsImpactAction(
  proposedMonths: number,
): Promise<{ ok: true; newlyEligibleCount: number } | { ok: false; error: 'UNAUTHORIZED' | 'FORBIDDEN_ROLE' }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }
  if (ctx.membership.role !== 'organization_admin') return { ok: false, error: 'FORBIDDEN_ROLE' }

  const { newlyEligibleCount } = await previewRetentionSettingsImpact(ctx.organization.id, proposedMonths)
  return { ok: true, newlyEligibleCount }
}

const SETTINGS_ERROR_MESSAGES: Record<'FORBIDDEN_ROLE' | 'INVALID_MONTHS', string> = {
  FORBIDDEN_ROLE: 'Solo un administrador de organización puede cambiar la retención de respuestas.',
  INVALID_MONTHS: `El valor debe ser un entero entre ${CURRENT_STELLA_RETENTION_POLICY.minResponseRetentionMonths} y ${CURRENT_STELLA_RETENTION_POLICY.maxResponseRetentionMonths} meses.`,
}

/** Does NOT purge anything in this request — see previewRetentionSettingsImpactAction, which the UI must call first for a reduction. */
export async function updateRetentionSettingsAction(
  responseRetentionMonths: number,
): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await updateOrganizationRetentionSettings(
    { organizationId: ctx.organization.id, responseRetentionMonths, configuredByUserId: ctx.user.id },
    ctx.membership.role,
  )
  if (!result.ok) return { ok: false, error: result.error, message: SETTINGS_ERROR_MESSAGES[result.error] }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------
// Note: ALLOWED_HOLD_TYPES/ALLOWED_HOLD_REASON_CODES are NOT re-exported here
// — a 'use server' file may only export async functions (Next.js build
// constraint). Client code importing the fixed vocabularies must import them
// directly from lib/stella/retention/hold-service.ts.

const HOLD_ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN_ROLE: 'Solo un administrador de organización puede crear o liberar una preservación (hold).',
  INVALID_HOLD_TYPE: 'Tipo de preservación no reconocido.',
  INVALID_REASON_CODE: 'Código de motivo no reconocido.',
  PROJECT_NOT_FOUND: 'El proyecto indicado no existe.',
  PROJECT_ORGANIZATION_MISMATCH: 'El proyecto no pertenece a tu organización.',
  INTERACTION_NOT_FOUND: 'La interacción indicada no existe.',
  INTERACTION_SCOPE_MISMATCH: 'La interacción no pertenece a tu organización o al proyecto indicado.',
  NOT_FOUND: 'Preservación no encontrada.',
  ALREADY_RELEASED: 'Esta preservación ya fue liberada.',
  UNKNOWN_ERROR: 'No se pudo completar la operación. Intentá de nuevo.',
}

export interface CreateHoldActionInput {
  projectId?: string
  interactionId?: string
  holdType: HoldType
  reasonCode: HoldReasonCode
  expiresAt?: string
}

export async function createRetentionHoldAction(
  input: CreateHoldActionInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string; message: string }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await createRetentionHold(
    {
      organizationId: ctx.organization.id,
      projectId: input.projectId,
      interactionId: input.interactionId,
      holdType: input.holdType,
      reasonCode: input.reasonCode,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      createdByUserId: ctx.user.id,
    },
    ctx.membership.role,
  )
  if (!result.ok) return { ok: false, error: result.error, message: HOLD_ERROR_MESSAGES[result.error] ?? HOLD_ERROR_MESSAGES.UNKNOWN_ERROR }
  return { ok: true, id: result.id }
}

export async function releaseRetentionHoldAction(
  holdId: string,
): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await releaseRetentionHold({ holdId, organizationId: ctx.organization.id, releasedByUserId: ctx.user.id }, ctx.membership.role)
  if (!result.ok) return { ok: false, error: result.error, message: HOLD_ERROR_MESSAGES[result.error] ?? HOLD_ERROR_MESSAGES.UNKNOWN_ERROR }
  return { ok: true }
}

export interface RetentionHoldListItem {
  id: string
  projectId: string | null
  interactionId: string | null
  holdType: string
  reasonCode: string
  status: string
  createdAt: Date
  expiresAt: Date | null
  releasedAt: Date | null
}

/** Lists holds for the caller's organization — any active member may see the LIST (status/type/reason only), matching the same row-level-only RLS shape as every other Stella governance table. */
export async function listRetentionHoldsAction(): Promise<{ ok: true; items: RetentionHoldListItem[] } | { ok: false; error: 'UNAUTHORIZED' }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }

  const rows = await db
    .select()
    .from(stellaRetentionHolds)
    .where(eq(stellaRetentionHolds.organizationId, ctx.organization.id))
    .orderBy(desc(stellaRetentionHolds.createdAt))
    .limit(100)

  return {
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      interactionId: r.interactionId,
      holdType: r.holdType,
      reasonCode: r.reasonCode,
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      releasedAt: r.releasedAt,
    })),
  }
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

const PURGE_ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN_ROLE: 'Solo un administrador de organización puede ejecutar una purga de retención.',
  PREVIEW_NOT_FOUND: 'La simulación (dry-run) de referencia no existe.',
  PREVIEW_ORGANIZATION_MISMATCH: 'La simulación de referencia no pertenece a tu organización.',
  POLICY_CHANGED_SINCE_PREVIEW: 'La política cambió desde la última simulación. Ejecutá un nuevo dry-run antes de aplicar.',
  RUN_NOT_FOUND: 'Ejecución no encontrada.',
  RUN_ORGANIZATION_MISMATCH: 'La ejecución no pertenece a tu organización.',
  RUN_NOT_RESUMABLE: 'Esta ejecución no puede reanudarse (ya finalizó o no es una purga real).',
}

export async function previewStellaRetentionPurgeAction(): Promise<{ ok: true; run: PurgeRunSummary } | { ok: false; error: string; message: string }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await previewStellaRetentionPurge(ctx.organization.id, ctx.user.id, ctx.membership.role)
  if (!result.ok) return { ok: false, error: result.error, message: PURGE_ERROR_MESSAGES[result.error] }
  return { ok: true, run: result.run }
}

/** Requires a recent dry-run's id — rejects if the policy changed since that preview (forces a fresh dry-run instead of applying a stale one). Generates its own idempotency key when the caller doesn't supply one (double-submit guard). */
export async function executeStellaRetentionPurgeAction(
  previewRunId: string,
  idempotencyKey?: string,
): Promise<{ ok: true; run: PurgeRunSummary; alreadyExisted: boolean } | { ok: false; error: string; message: string }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await executeStellaRetentionPurge(ctx.organization.id, ctx.user.id, ctx.membership.role, {
    previewRunId,
    idempotencyKey: idempotencyKey ?? randomUUID(),
  })
  if (!result.ok) return { ok: false, error: result.error, message: PURGE_ERROR_MESSAGES[result.error] }
  return { ok: true, run: result.run, alreadyExisted: result.alreadyExisted }
}

export async function resumeStellaRetentionPurgeAction(
  runId: string,
): Promise<{ ok: true; run: PurgeRunSummary } | { ok: false; error: string; message: string }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await resumeStellaRetentionPurge(runId, ctx.organization.id, ctx.membership.role)
  if (!result.ok) return { ok: false, error: result.error, message: PURGE_ERROR_MESSAGES[result.error] }
  return { ok: true, run: result.run }
}

export interface RecentPurgeRunItem {
  id: string
  mode: string
  status: string
  createdAt: Date
  completedAt: Date | null
  recordsPurged: number
  recordsEligible: number
  recordsScanned: number
  recordsSkippedHold: number
}

/** Most recent runs for the caller's organization — for the UI's "última ejecución" display. Counts only, never response content. */
export async function listRecentStellaRetentionPurgeRunsAction(
  limit = 5,
): Promise<{ ok: true; items: RecentPurgeRunItem[] } | { ok: false; error: 'UNAUTHORIZED' }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }

  const rows = await db
    .select()
    .from(stellaRetentionPurgeRuns)
    .where(eq(stellaRetentionPurgeRuns.organizationId, ctx.organization.id))
    .orderBy(desc(stellaRetentionPurgeRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 20))

  return {
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      status: r.status,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      recordsPurged: r.recordsPurged,
      recordsEligible: r.recordsEligible,
      recordsScanned: r.recordsScanned,
      recordsSkippedHold: r.recordsSkippedHold,
    })),
  }
}

export async function getStellaRetentionPurgeRunStatusAction(
  runId: string,
): Promise<{ ok: true; run: PurgeRunSummary | null } | { ok: false; error: 'UNAUTHORIZED' }> {
  let ctx: Awaited<ReturnType<typeof currentActor>>
  try {
    ctx = await currentActor()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }

  const run = await getPurgeRunStatus(runId, ctx.organization.id)
  return { ok: true, run }
}

/**
 * UI capability flag — deliberately an EXACT match against 'organization_admin'
 * (never hasRole()'s hierarchy check), mirroring every role check in the
 * service layer above (SETTINGS_ROLES/HOLD_ROLES/PURGE_ROLES). A super_admin
 * outranks organization_admin hierarchically but is NOT in any of those
 * sets — a UI flag built on hasRole() would show a button the server then
 * rejects with FORBIDDEN_ROLE.
 */
export async function canManageStellaRetention(): Promise<boolean> {
  try {
    const ctx = await currentActor()
    return ctx.membership.role === 'organization_admin'
  } catch {
    return false
  }
}
