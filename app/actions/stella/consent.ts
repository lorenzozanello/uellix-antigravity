'use server'
// app/actions/stella/consent.ts
// Etapa A2.1 (STL-A21-006/007, DR-005 aprobado 2026-07-25 via
// STELLA_A2_OWNER_DECISION_FORM.md). Explicit, versioned, revocable
// organization-level consent for Stella — independent of feature flags,
// quota, plan, and rate limiting.

import { requireOrganizationAccess } from '@/lib/auth/session'
import { getStellaConsentStatus, type StellaConsentStatus } from '@/lib/stella/consent/consent-status'
import { recordConsentEvent } from '@/lib/stella/consent/consent-log'
import { STELLA_AI_TERMS_VERSION, STELLA_DATA_POLICY_VERSION, STELLA_CONSENT_SCOPE_ALL } from '@/lib/stella/consent/versions'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type StellaConsentActionErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_NOT_ORG_ADMIN'
  | 'NO_ACTIVE_CONSENT_TO_REVOKE'
  | 'UNKNOWN_ERROR'

export type StellaConsentActionResult =
  | { ok: true; data: StellaConsentStatus }
  | { ok: false; error: StellaConsentActionErrorCode; message: string }

/**
 * Accepts Stella's current AI terms + data policy on behalf of the caller's
 * organization. Versions are ALWAYS resolved server-side from
 * lib/stella/consent/versions.ts — never accepted from client input, so a
 * caller cannot forge acceptance of an arbitrary version string.
 */
export async function acceptStellaConsent(): Promise<StellaConsentActionResult> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  // Etapa A2.1: strict, exact-match role check — deliberately NOT a
  // role-hierarchy check. A global super_admin must hold an actual
  // organization_admin membership row for THIS organization; hierarchy-based
  // bypass is exactly what the approved DR-005 decision forbids ("un
  // super_admin no puede figurar como aceptación... salvo que también sea
  // administrador legítimo de esa organización").
  if (ctx.membership.role !== 'organization_admin') {
    return {
      ok: false,
      error: 'FORBIDDEN_NOT_ORG_ADMIN',
      message: "Only an organization admin can accept Stella's AI terms.",
    }
  }

  try {
    const previous = await getStellaConsentStatus(ctx.organization.id)

    const { id } = await recordConsentEvent({
      organizationId: ctx.organization.id,
      eventType: 'accepted',
      actorUserId: ctx.user.id,
      aiTermsVersion: STELLA_AI_TERMS_VERSION,
      dataPolicyVersion: STELLA_DATA_POLICY_VERSION,
      capabilityScope: STELLA_CONSENT_SCOPE_ALL,
      supersedesEventId: previous.consentEventId,
    })

    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'stella_ai_consent_event',
      entityId: id,
      action: AUDIT_ACTIONS.STELLA_AI_CONSENT_ACCEPTED,
      afterJson: {
        aiTermsVersion: STELLA_AI_TERMS_VERSION,
        dataPolicyVersion: STELLA_DATA_POLICY_VERSION,
        capabilityScope: STELLA_CONSENT_SCOPE_ALL,
      },
    })

    const status = await getStellaConsentStatus(ctx.organization.id)
    return { ok: true, data: status }
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'Failed to record consent. Please try again.' }
  }
}

/**
 * Revokes the organization's current Stella consent. Blocks new Stella
 * calls immediately (the next getStellaConsentStatus() call resolves to
 * 'revoked'). Never deletes or edits any prior interaction, and never
 * touches quota/plan/feature-flag configuration.
 */
export async function revokeStellaConsent(reason?: string): Promise<StellaConsentActionResult> {
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  if (ctx.membership.role !== 'organization_admin') {
    return {
      ok: false,
      error: 'FORBIDDEN_NOT_ORG_ADMIN',
      message: "Only an organization admin can revoke Stella's AI consent.",
    }
  }

  try {
    const current = await getStellaConsentStatus(ctx.organization.id)
    if (current.status !== 'valid' && current.status !== 'outdated') {
      return {
        ok: false,
        error: 'NO_ACTIVE_CONSENT_TO_REVOKE',
        message: 'There is no active consent to revoke.',
      }
    }

    const { id } = await recordConsentEvent({
      organizationId: ctx.organization.id,
      eventType: 'revoked',
      actorUserId: ctx.user.id,
      reason,
      supersedesEventId: current.consentEventId,
    })

    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'stella_ai_consent_event',
      entityId: id,
      action: AUDIT_ACTIONS.STELLA_AI_CONSENT_REVOKED,
      reason,
    })

    const status = await getStellaConsentStatus(ctx.organization.id)
    return { ok: true, data: status }
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR', message: 'Failed to revoke consent. Please try again.' }
  }
}
