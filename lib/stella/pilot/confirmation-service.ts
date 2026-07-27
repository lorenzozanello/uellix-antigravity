// lib/stella/pilot/confirmation-service.ts
// Etapa B0 (modo piloto restringido) — the single source of truth for a
// USER's operative pilot confirmation. Deliberately separate from
// lib/stella/consent/consent-status.ts (DR-005, organizational consent):
// this is a per-user, per-organization acceptance of the pilot's OWN
// operating rules (synthetic/non-identifiable data only, human review
// required, no certification claim) — never merged into the same
// checkbox or the same table as DR-005's consent.
//
// Fail-closed by design, same convention as getStellaConsentStatus: any
// unexpected error resolves to 'missing', never 'valid'.

import { db } from '@/db/client'
import { stellaPilotConfirmations } from '@/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { getStellaPilotConfig } from './config'

export type StellaPilotConfirmationStatusValue = 'valid' | 'missing' | 'revoked' | 'outdated'

export interface StellaPilotConfirmationStatus {
  status: StellaPilotConfirmationStatusValue
  confirmationEventId?: string
  acceptedAt?: Date
  acceptedNoticeVersion?: string
  currentNoticeVersion: string
}

function missingStatus(currentNoticeVersion: string): StellaPilotConfirmationStatus {
  return { status: 'missing', currentNoticeVersion }
}

/** Resolves from the most recent event (organizationId+userId scoped, ORDER BY occurred_at DESC LIMIT 1) — never another user's or another organization's confirmation. */
export async function getStellaPilotConfirmationStatus(
  organizationId: string,
  userId: string,
): Promise<StellaPilotConfirmationStatus> {
  const currentNoticeVersion = getStellaPilotConfig().noticeVersion
  try {
    const [latest] = await db
      .select()
      .from(stellaPilotConfirmations)
      .where(and(eq(stellaPilotConfirmations.organizationId, organizationId), eq(stellaPilotConfirmations.userId, userId)))
      .orderBy(desc(stellaPilotConfirmations.occurredAt))
      .limit(1)

    if (!latest) return missingStatus(currentNoticeVersion)

    if (latest.eventType === 'revoked') {
      return { status: 'revoked', confirmationEventId: latest.id, currentNoticeVersion }
    }

    const isCurrent = latest.noticeVersion === currentNoticeVersion
    return {
      status: isCurrent ? 'valid' : 'outdated',
      confirmationEventId: latest.id,
      acceptedAt: latest.occurredAt,
      acceptedNoticeVersion: latest.noticeVersion ?? undefined,
      currentNoticeVersion,
    }
  } catch (error) {
    console.error('[stella-pilot] getStellaPilotConfirmationStatus failed, failing closed to "missing":', error instanceof Error ? error.message : error)
    return missingStatus(currentNoticeVersion)
  }
}

export interface RecordPilotConfirmationInput {
  organizationId: string
  userId: string
  eventType: 'accepted' | 'revoked'
  /** Required when eventType === 'accepted'. */
  noticeVersion?: string
  supersedesEventId?: string
}

/** Records one append-only confirmation event. Never updates or deletes a prior row — mirrors recordConsentEvent(). */
export async function recordPilotConfirmationEvent(input: RecordPilotConfirmationInput): Promise<{ id: string }> {
  const [inserted] = await db
    .insert(stellaPilotConfirmations)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      eventType: input.eventType,
      noticeVersion: input.noticeVersion,
      supersedesEventId: input.supersedesEventId,
    })
    .returning({ id: stellaPilotConfirmations.id })

  return { id: inserted.id }
}
