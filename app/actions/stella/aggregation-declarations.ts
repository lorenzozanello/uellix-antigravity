'use server'
// app/actions/stella/aggregation-declarations.ts
// Etapa A2.3.1/A2.3.2 (STL-A231-017, STL-A232-016, DR-002/DR-003). Thin
// server actions over lib/stella/aggregation/declaration-service.ts — auth +
// org resolution only; ALL business rules (role checks, entity validation,
// threshold, dimension allowlist, transactions) live in the service, not
// here, so there is exactly one place that can approve a declaration.
//
// These actions do NOT touch Stella's feature flags, quota, or consent —
// they manage a completely separate, pre-existing-data concern (can THIS
// aggregate be shown to Stella at all), independent of whether Stella is
// even enabled.
//
// Fail-safe audit logging (Etapa A2.3.2, per the risk documented in
// supersedeSensitiveAggregationDeclaration's header): every logAuditAction()
// call here is wrapped in its own try/catch. The underlying DB operation
// already committed by the time we log it — a broken audit insert must
// never surface as if the whole action failed (the client would wrongly
// retry an already-successful create/verify/revoke/supersede).

import { requireOrganizationAccess } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/permissions'
import {
  createSensitiveAggregationDeclaration,
  verifySensitiveAggregationDeclaration,
  revokeSensitiveAggregationDeclaration,
  supersedeSensitiveAggregationDeclaration,
  type CreateDeclarationError,
  type VerifyDeclarationError,
  type RevokeDeclarationError,
  type SupersedeDeclarationError,
} from '@/lib/stella/aggregation/declaration-service'
import { listSensitiveAggregationDeclarationsForEntity } from '@/lib/stella/aggregation/declaration-query'
import type { CreateDeclarationInput, DeclarationRecord } from '@/lib/stella/aggregation/types'
import type { SensitiveEntityType } from '@/lib/stella/aggregation/policy'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type AggregationDeclarationActionResult<TError extends string> =
  | { ok: true; id: string }
  | { ok: false; error: TError | 'UNAUTHORIZED'; message: string }

const CREATE_ERROR_MESSAGES: Record<CreateDeclarationError, string> = {
  FORBIDDEN_ROLE: 'Solo un administrador de organización o un analista puede declarar un agregado.',
  INVALID_ENTITY_TYPE: 'Tipo de entidad no reconocido.',
  INVALID_CATEGORY: 'Categoría sensible no reconocida.',
  INVALID_GROUP_SIZE: 'El tamaño de grupo debe ser un entero positivo.',
  INVALID_COUNT_SOURCE: 'Fuente del conteo no reconocida.',
  ENTITY_NOT_FOUND: 'La entidad referenciada no existe.',
  ENTITY_ORGANIZATION_MISMATCH: 'La entidad no pertenece a tu organización.',
  ENTITY_PROJECT_MISMATCH: 'La entidad no pertenece a este proyecto.',
  ACTIVE_DECLARATION_EXISTS: 'Ya existe una declaración activa para esta entidad y categoría — revócala o sustitúyela antes de crear otra.',
  UNKNOWN_ERROR: 'No se pudo crear la declaración. Intentá de nuevo.',
}

const VERIFY_ERROR_MESSAGES: Record<VerifyDeclarationError, string> = {
  FORBIDDEN_ROLE: 'Solo un administrador de organización puede verificar una declaración.',
  NOT_FOUND: 'Declaración no encontrada.',
  CROSS_ORG: 'Declaración no encontrada.',
  ALREADY_VERIFIED: 'Esta declaración ya fue verificada.',
  ALREADY_REVOKED: 'Esta declaración fue revocada y no puede verificarse.',
  ALREADY_SUPERSEDED: 'Esta declaración fue sustituida y no puede verificarse.',
  GROUP_SIZE_BELOW_THRESHOLD: 'El tamaño de grupo declarado es menor al mínimo permitido. Agrupa categorías, amplía el período, o excluye este dato hasta contar con un grupo más grande.',
  TOO_MANY_DIMENSIONS: 'La declaración combina más dimensiones estructurales de las permitidas.',
  INVALID_DIMENSIONS: 'La declaración incluye una dimensión no permitida.',
  HIGH_RISK_DIMENSIONS: 'La combinación de dimensiones de esta declaración se considera de alto riesgo de reidentificación. Reduce el nivel de detalle antes de continuar.',
  UNKNOWN_ERROR: 'No se pudo verificar la declaración. Intentá de nuevo.',
}

const REVOKE_ERROR_MESSAGES: Record<RevokeDeclarationError, string> = {
  FORBIDDEN_ROLE: 'Solo un administrador de organización puede revocar una declaración.',
  NOT_FOUND: 'Declaración no encontrada.',
  CROSS_ORG: 'Declaración no encontrada.',
  ALREADY_REVOKED: 'Esta declaración ya fue revocada.',
  ALREADY_SUPERSEDED: 'Esta declaración ya fue sustituida.',
  UNKNOWN_ERROR: 'No se pudo revocar la declaración. Intentá de nuevo.',
}

const SUPERSEDE_ERROR_MESSAGES: Record<SupersedeDeclarationError, string> = {
  ...CREATE_ERROR_MESSAGES,
  PREVIOUS_NOT_FOUND: 'La declaración a sustituir no existe.',
  PREVIOUS_CROSS_ORG: 'La declaración a sustituir no existe.',
  PREVIOUS_ALREADY_REVOKED: 'La declaración a sustituir ya fue revocada — registra una nueva declaración en su lugar.',
  PREVIOUS_ALREADY_SUPERSEDED: 'La declaración a sustituir ya fue sustituida.',
}

async function logAuditActionSafely(entry: Parameters<typeof logAuditAction>[0]): Promise<void> {
  try {
    await logAuditAction(entry)
  } catch (error) {
    // Never mask an already-committed operation with an audit-log failure.
    console.error('[stella-aggregation] logAuditAction failed after a successful operation:', error)
  }
}

export type CreateAggregationDeclarationInput = Omit<CreateDeclarationInput, 'organizationId' | 'projectId' | 'declaredByUserId'> & {
  projectId: string
}

/** Creates a new declaration in 'pending' status — never auto-verified. */
export async function createAggregationDeclaration(
  input: CreateAggregationDeclarationInput,
): Promise<AggregationDeclarationActionResult<CreateDeclarationError>> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await createSensitiveAggregationDeclaration(
    {
      organizationId: ctx.organization.id,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      sensitiveCategory: input.sensitiveCategory,
      groupSize: input.groupSize,
      dimensions: input.dimensions,
      countSourceType: input.countSourceType,
      countSourceId: input.countSourceId,
      countSourceNote: input.countSourceNote,
      declaredByUserId: ctx.user.id,
    },
    ctx.membership.role,
  )

  if (!result.ok) {
    return { ok: false, error: result.error, message: CREATE_ERROR_MESSAGES[result.error] }
  }

  await logAuditActionSafely({
    organizationId: ctx.organization.id,
    projectId: input.projectId,
    actorUserId: ctx.user.id,
    entityType: 'stella_sensitive_aggregation_declaration',
    entityId: result.id,
    action: AUDIT_ACTIONS.STELLA_SENSITIVE_AGGREGATION_DECLARED,
    afterJson: { entityType: input.entityType, sensitiveCategory: input.sensitiveCategory },
  })

  return { ok: true, id: result.id }
}

/** Verifies a pending declaration — organization_admin only, exact-match role check (no super_admin hierarchy bypass). */
export async function verifyAggregationDeclaration(
  declarationId: string,
): Promise<AggregationDeclarationActionResult<VerifyDeclarationError>> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await verifySensitiveAggregationDeclaration(
    { declarationId, organizationId: ctx.organization.id, verifiedByUserId: ctx.user.id },
    ctx.membership.role,
  )

  if (!result.ok) {
    return { ok: false, error: result.error, message: VERIFY_ERROR_MESSAGES[result.error] }
  }

  await logAuditActionSafely({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'stella_sensitive_aggregation_declaration',
    entityId: declarationId,
    action: AUDIT_ACTIONS.STELLA_SENSITIVE_AGGREGATION_VERIFIED,
  })

  return { ok: true, id: declarationId }
}

/** Revokes a declaration — preserves the row and its history, never deletes. */
export async function revokeAggregationDeclaration(
  declarationId: string,
  reason?: string,
): Promise<AggregationDeclarationActionResult<RevokeDeclarationError>> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await revokeSensitiveAggregationDeclaration(
    { declarationId, organizationId: ctx.organization.id, revokedByUserId: ctx.user.id, reason },
    ctx.membership.role,
  )

  if (!result.ok) {
    return { ok: false, error: result.error, message: REVOKE_ERROR_MESSAGES[result.error] }
  }

  await logAuditActionSafely({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'stella_sensitive_aggregation_declaration',
    entityId: declarationId,
    action: AUDIT_ACTIONS.STELLA_SENSITIVE_AGGREGATION_REVOKED,
    reason,
  })

  return { ok: true, id: declarationId }
}

export type SupersedeAggregationDeclarationInput = CreateAggregationDeclarationInput

/** Atomically replaces `previousDeclarationId` with a new (pending) declaration — see supersedeSensitiveAggregationDeclaration's header for the transaction/rollback guarantees. */
export async function supersedeAggregationDeclaration(
  previousDeclarationId: string,
  input: SupersedeAggregationDeclarationInput,
): Promise<AggregationDeclarationActionResult<SupersedeDeclarationError>> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  const result = await supersedeSensitiveAggregationDeclaration(
    previousDeclarationId,
    {
      organizationId: ctx.organization.id,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      sensitiveCategory: input.sensitiveCategory,
      groupSize: input.groupSize,
      dimensions: input.dimensions,
      countSourceType: input.countSourceType,
      countSourceId: input.countSourceId,
      countSourceNote: input.countSourceNote,
      declaredByUserId: ctx.user.id,
    },
    ctx.membership.role,
  )

  if (!result.ok) {
    return { ok: false, error: result.error, message: SUPERSEDE_ERROR_MESSAGES[result.error] }
  }

  await logAuditActionSafely({
    organizationId: ctx.organization.id,
    projectId: input.projectId,
    actorUserId: ctx.user.id,
    entityType: 'stella_sensitive_aggregation_declaration',
    entityId: result.id,
    action: AUDIT_ACTIONS.STELLA_SENSITIVE_AGGREGATION_DECLARED,
    reason: `supersedes:${previousDeclarationId}`,
    afterJson: { entityType: input.entityType, sensitiveCategory: input.sensitiveCategory },
  })

  return { ok: true, id: result.id }
}

/** Trimmed view for roles below organization_admin/analyst — never exposes who declared/verified/revoked or when. */
export type EntityDeclarationHistoryItem =
  | DeclarationRecord
  | Omit<DeclarationRecord, 'declaredBy' | 'verifiedBy' | 'revokedBy' | 'revocationReason'>

/**
 * Lists every declaration ever created for one entity (all categories),
 * newest first — the UI's "historial" view. Per DR-007-consistent
 * authorization: `organization_admin`/`impact_manager`/`analyst` see the
 * full actor/date history; `viewer`/`reviewer` see only the
 * status/category/bucket/policy fields (never who declared/verified/
 * revoked, or when) — mirroring how `viewer` never sees the detailed
 * `stella_interactions` history either.
 */
export async function listEntityAggregationDeclarations(
  projectId: string,
  entityType: SensitiveEntityType,
  entityId: string,
): Promise<{ ok: true; items: EntityDeclarationHistoryItem[] } | { ok: false; error: 'UNAUTHORIZED' }> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED' }
  }

  const records = await listSensitiveAggregationDeclarationsForEntity({
    organizationId: ctx.organization.id,
    projectId,
    entityType,
    entityId,
  })

  const canSeeActorHistory = hasRole(ctx.membership.role, 'analyst')
  if (canSeeActorHistory) return { ok: true, items: records }

  const trimmed = records.map(({ declaredBy: _declaredBy, verifiedBy: _verifiedBy, revokedBy: _revokedBy, revocationReason: _revocationReason, ...rest }) => rest)
  return { ok: true, items: trimmed }
}
