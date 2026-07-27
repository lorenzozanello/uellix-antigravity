// lib/stella/consent/consent-log.ts
// Etapa A2.1 (STL-A21-006/007) — the single insertion point for
// stella_ai_consent_events, mirroring lib/stella/audit-log.ts's centralized
// pattern for stella_interactions. Uses Drizzle over DATABASE_URL (the
// `postgres` superuser role) — the same mechanism, and the same reason, as
// recordStellaInteraction(): this bypasses RLS/table-grants by Postgres's
// own BYPASSRLS privilege, not by any Supabase service_role API key.

import { db } from '@/db/client'
import { stellaAiConsentEvents } from '@/db/schema'

export interface RecordConsentEventInput {
  organizationId: string
  eventType: 'accepted' | 'revoked'
  actorUserId: string
  /** Required when eventType === 'accepted'; omitted for 'revoked'. */
  aiTermsVersion?: string
  dataPolicyVersion?: string
  capabilityScope?: readonly string[]
  reason?: string
  /** For 'revoked': the accepted event being revoked. */
  supersedesEventId?: string
}

/** Records one append-only consent event. Never updates or deletes a prior row. */
export async function recordConsentEvent(input: RecordConsentEventInput): Promise<{ id: string }> {
  const [inserted] = await db
    .insert(stellaAiConsentEvents)
    .values({
      organizationId: input.organizationId,
      eventType: input.eventType,
      actorUserId: input.actorUserId,
      aiTermsVersion: input.aiTermsVersion,
      dataPolicyVersion: input.dataPolicyVersion,
      capabilityScope: input.capabilityScope ? [...input.capabilityScope] : undefined,
      reason: input.reason,
      supersedesEventId: input.supersedesEventId,
    })
    .returning({ id: stellaAiConsentEvents.id })

  return { id: inserted.id }
}
