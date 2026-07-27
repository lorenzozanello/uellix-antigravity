// lib/stella/consent/consent-status.ts
// Etapa A2.1 (STL-A21-005, DR-005 aprobado 2026-07-25) — the single service
// that resolves an organization's current Stella consent status. This is
// the compuerta's source of truth: no server action, no UI, and no other
// service should independently re-derive "is Stella consented for this
// org" — they all call getStellaConsentStatus().
//
// Fail-closed by design: ANY unexpected error (DB unavailable, malformed
// row, etc.) resolves to 'missing', the same as no consent ever having
// existed — never 'valid'. This mirrors the fail-closed convention already
// used by lib/stella/quota.ts and lib/stella/rate-limit.ts.

import { db } from '@/db/client'
import { stellaAiConsentEvents } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { STELLA_AI_TERMS_VERSION, STELLA_DATA_POLICY_VERSION } from './versions'

export type StellaConsentStatusValue = 'valid' | 'missing' | 'revoked' | 'outdated'

export interface StellaConsentStatus {
  status: StellaConsentStatusValue
  consentEventId?: string
  acceptedBy?: string
  acceptedAt?: Date
  acceptedAiTermsVersion?: string
  acceptedDataPolicyVersion?: string
  currentAiTermsVersion: string
  currentDataPolicyVersion: string
  capabilityScope?: string[]
}

function missingStatus(): StellaConsentStatus {
  return {
    status: 'missing',
    currentAiTermsVersion: STELLA_AI_TERMS_VERSION,
    currentDataPolicyVersion: STELLA_DATA_POLICY_VERSION,
  }
}

/**
 * Resolves the organization's consent status from the most recent event
 * (ORDER BY occurred_at DESC LIMIT 1 — see the index in migration 0045).
 * Never consumes quota, never depends on the model, never reads another
 * organization's rows (the query is always scoped by organizationId).
 */
export async function getStellaConsentStatus(organizationId: string): Promise<StellaConsentStatus> {
  try {
    const [latest] = await db
      .select()
      .from(stellaAiConsentEvents)
      .where(eq(stellaAiConsentEvents.organizationId, organizationId))
      .orderBy(desc(stellaAiConsentEvents.occurredAt))
      .limit(1)

    if (!latest) return missingStatus()

    if (latest.eventType === 'revoked') {
      // Best-effort enrichment with the accepted event this revocation
      // refers to, for display purposes only — status stays 'revoked'
      // regardless of whether this secondary lookup succeeds.
      let acceptedInfo: Partial<StellaConsentStatus> = {}
      if (latest.supersedesEventId) {
        const [accepted] = await db
          .select()
          .from(stellaAiConsentEvents)
          .where(eq(stellaAiConsentEvents.id, latest.supersedesEventId))
          .limit(1)
        if (accepted) {
          acceptedInfo = {
            acceptedBy: accepted.actorUserId,
            acceptedAt: accepted.occurredAt,
            acceptedAiTermsVersion: accepted.aiTermsVersion ?? undefined,
            acceptedDataPolicyVersion: accepted.dataPolicyVersion ?? undefined,
            capabilityScope: accepted.capabilityScope ?? undefined,
          }
        }
      }

      return {
        status: 'revoked',
        consentEventId: latest.id,
        currentAiTermsVersion: STELLA_AI_TERMS_VERSION,
        currentDataPolicyVersion: STELLA_DATA_POLICY_VERSION,
        ...acceptedInfo,
      }
    }

    // latest.eventType === 'accepted'
    const isCurrent =
      latest.aiTermsVersion === STELLA_AI_TERMS_VERSION && latest.dataPolicyVersion === STELLA_DATA_POLICY_VERSION

    return {
      status: isCurrent ? 'valid' : 'outdated',
      consentEventId: latest.id,
      acceptedBy: latest.actorUserId,
      acceptedAt: latest.occurredAt,
      acceptedAiTermsVersion: latest.aiTermsVersion ?? undefined,
      acceptedDataPolicyVersion: latest.dataPolicyVersion ?? undefined,
      currentAiTermsVersion: STELLA_AI_TERMS_VERSION,
      currentDataPolicyVersion: STELLA_DATA_POLICY_VERSION,
      capabilityScope: latest.capabilityScope ?? undefined,
    }
  } catch (error) {
    console.error(
      '[stella-consent] getStellaConsentStatus failed, failing closed to "missing":',
      error instanceof Error ? error.message : error,
    )
    return missingStatus()
  }
}
