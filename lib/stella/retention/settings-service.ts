// lib/stella/retention/settings-service.ts
// Etapa A2.4 (DR-004 aprobado) — per-organization override of the default
// response_json retention period. One row per organization
// (stella_retention_settings.organization_id UNIQUE); no row means "use the
// global default" — never a NULL sentinel meaning "unlimited".
//
// SETTINGS_ROLES mirrors the CREATE_ROLES/VERIFY_ROLES pattern in
// lib/stella/aggregation/declaration-service.ts: an EXACT role match, not a
// hierarchy check. Only organization_admin may change retention — a
// super_admin without an explicit organization_admin membership in THIS
// organization does not substitute for that organization's own decision
// (same principle already applied to DR-005 consent and DR-002/DR-003
// aggregation verification).
//
// Changing the setting NEVER purges anything in the same request — see
// updateOrganizationRetentionSettings's header. A caller must run
// previewRetentionSettingsImpact() separately (and show it to the admin)
// before a reduction takes effect, per the approved policy's explicit
// requirement for an impact simulation.

import { db } from '@/db/client'
import { stellaRetentionSettings, stellaInteractions } from '@/db/schema'
import { and, count, eq, isNull, lte } from 'drizzle-orm'
import { CURRENT_STELLA_RETENTION_POLICY, isValidResponseRetentionMonths, type StellaRetentionPolicy } from './policy'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

const SETTINGS_ROLES: ReadonlySet<string> = new Set(['organization_admin'])

export interface EffectiveRetentionSettings {
  organizationId: string
  responseRetentionMonths: number
  policyVersion: string
  configuredBy: string | null
  configuredAt: Date | null
  /** true when no override row exists — the global default is in effect. */
  isDefault: boolean
}

/** Never resolves the client-supplied value — always reads the organization's own row (or the global default) from the server. */
export async function getEffectiveRetentionSettings(
  organizationId: string,
  policy: StellaRetentionPolicy = CURRENT_STELLA_RETENTION_POLICY,
): Promise<EffectiveRetentionSettings> {
  const [row] = await db.select().from(stellaRetentionSettings).where(eq(stellaRetentionSettings.organizationId, organizationId)).limit(1)

  if (!row) {
    return {
      organizationId,
      responseRetentionMonths: policy.defaultResponseRetentionMonths,
      policyVersion: policy.policyVersion,
      configuredBy: null,
      configuredAt: null,
      isDefault: true,
    }
  }

  return {
    organizationId,
    responseRetentionMonths: row.responseRetentionMonths,
    policyVersion: row.policyVersion,
    configuredBy: row.configuredBy,
    configuredAt: row.configuredAt,
    isDefault: false,
  }
}

export type UpdateRetentionSettingsError = 'FORBIDDEN_ROLE' | 'INVALID_MONTHS'
export type UpdateRetentionSettingsResult = { ok: true } | { ok: false; error: UpdateRetentionSettingsError }

export interface UpdateRetentionSettingsInput {
  organizationId: string
  responseRetentionMonths: number
  configuredByUserId: string
}

/**
 * Upserts the organization's override. Bounded server-side
 * (isValidResponseRetentionMonths) — the client cannot request 0, a
 * negative number, or a value beyond MAX_RESPONSE_RETENTION_MONTHS. Does
 * NOT purge anything — a lowered threshold only takes effect the next time
 * a purge preview/apply runs.
 */
export async function updateOrganizationRetentionSettings(
  input: UpdateRetentionSettingsInput,
  actorRole: string,
  policy: StellaRetentionPolicy = CURRENT_STELLA_RETENTION_POLICY,
): Promise<UpdateRetentionSettingsResult> {
  if (!SETTINGS_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }
  if (!isValidResponseRetentionMonths(input.responseRetentionMonths, policy)) return { ok: false, error: 'INVALID_MONTHS' }

  await db
    .insert(stellaRetentionSettings)
    .values({
      organizationId: input.organizationId,
      responseRetentionMonths: input.responseRetentionMonths,
      policyVersion: policy.policyVersion,
      configuredBy: input.configuredByUserId,
    })
    .onConflictDoUpdate({
      target: stellaRetentionSettings.organizationId,
      set: {
        responseRetentionMonths: input.responseRetentionMonths,
        policyVersion: policy.policyVersion,
        configuredBy: input.configuredByUserId,
        configuredAt: new Date(),
        updatedAt: new Date(),
      },
    })

  await logAuditAction({
    organizationId: input.organizationId,
    actorUserId: input.configuredByUserId,
    entityType: 'stella_retention_settings',
    entityId: input.organizationId,
    action: AUDIT_ACTIONS.STELLA_RETENTION_SETTINGS_UPDATED,
    afterJson: { responseRetentionMonths: input.responseRetentionMonths, policyVersion: policy.policyVersion },
  })

  return { ok: true }
}

/**
 * Impact simulation required before a reduction: counts interactions that
 * are NOT yet eligible under the CURRENT effective setting, but WOULD
 * become eligible under `proposedMonths` — i.e. exactly what a reduction
 * would newly expose to purge on the next run. Never mutates anything.
 */
export async function previewRetentionSettingsImpact(
  organizationId: string,
  proposedMonths: number,
  now: Date = new Date(),
): Promise<{ newlyEligibleCount: number }> {
  const cutoff = new Date(now.getTime())
  cutoff.setUTCMonth(cutoff.getUTCMonth() - proposedMonths)

  const [row] = await db
    .select({ value: count() })
    .from(stellaInteractions)
    .where(
      and(
        eq(stellaInteractions.organizationId, organizationId),
        isNull(stellaInteractions.responsePurgedAt),
        lte(stellaInteractions.createdAt, cutoff),
      ),
    )

  return { newlyEligibleCount: row?.value ?? 0 }
}
