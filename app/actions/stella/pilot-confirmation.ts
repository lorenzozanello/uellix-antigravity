'use server'
// app/actions/stella/pilot-confirmation.ts
// Etapa B0 (modo piloto restringido) — per-user operative acceptance of the
// pilot's rules. Mirrors app/actions/stella/consent.ts's structure, but
// deliberately NOT organization_admin-gated: this is a personal attestation
// ("I will not upload prohibited data, I will review outputs") that any
// active member about to use the pilot must accept for themselves — unlike
// DR-005 consent, which is an organizational decision only an admin can make.

import { requireOrganizationAccess } from '@/lib/auth/session'
import {
  getStellaPilotConfirmationStatus,
  recordPilotConfirmationEvent,
  type StellaPilotConfirmationStatus,
} from '@/lib/stella/pilot/confirmation-service'
import { getStellaPilotConfig } from '@/lib/stella/pilot/config'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type StellaPilotConfirmationActionErrorCode = 'UNAUTHORIZED' | 'NO_ACTIVE_CONFIRMATION_TO_REVOKE' | 'UNKNOWN_ERROR'

export type StellaPilotConfirmationActionResult =
  | { ok: true; data: StellaPilotConfirmationStatus }
  | { ok: false; error: StellaPilotConfirmationActionErrorCode; message: string }

export async function getStellaPilotConfirmationStatusAction(): Promise<StellaPilotConfirmationActionResult> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }
  const status = await getStellaPilotConfirmationStatus(ctx.organization.id, ctx.user.id)
  return { ok: true, data: status }
}

/** Records the user's own acceptance of the current pilot notice version — version is ALWAYS resolved server-side, never accepted from client input. */
export async function acceptStellaPilotConfirmation(): Promise<StellaPilotConfirmationActionResult> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  try {
    const previous = await getStellaPilotConfirmationStatus(ctx.organization.id, ctx.user.id)
    const noticeVersion = getStellaPilotConfig().noticeVersion

    const { id } = await recordPilotConfirmationEvent({
      organizationId: ctx.organization.id,
      userId: ctx.user.id,
      eventType: 'accepted',
      noticeVersion,
      supersedesEventId: previous.confirmationEventId,
    })

    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'stella_pilot_confirmation',
      entityId: id,
      action: AUDIT_ACTIONS.STELLA_PILOT_CONFIRMATION_ACCEPTED,
      afterJson: { noticeVersion },
    })

    const status = await getStellaPilotConfirmationStatus(ctx.organization.id, ctx.user.id)
    return { ok: true, data: status }
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'No se pudo registrar la confirmación. Intentá de nuevo.' }
  }
}

export async function revokeStellaPilotConfirmation(): Promise<StellaPilotConfirmationActionResult> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  try {
    const current = await getStellaPilotConfirmationStatus(ctx.organization.id, ctx.user.id)
    if (current.status !== 'valid' && current.status !== 'outdated') {
      return { ok: false, error: 'NO_ACTIVE_CONFIRMATION_TO_REVOKE', message: 'No hay una confirmación activa para revocar.' }
    }

    const { id } = await recordPilotConfirmationEvent({
      organizationId: ctx.organization.id,
      userId: ctx.user.id,
      eventType: 'revoked',
      supersedesEventId: current.confirmationEventId,
    })

    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'stella_pilot_confirmation',
      entityId: id,
      action: AUDIT_ACTIONS.STELLA_PILOT_CONFIRMATION_REVOKED,
    })

    const status = await getStellaPilotConfirmationStatus(ctx.organization.id, ctx.user.id)
    return { ok: true, data: status }
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'No se pudo revocar la confirmación. Intentá de nuevo.' }
  }
}
