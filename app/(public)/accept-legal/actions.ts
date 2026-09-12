'use server'

// app/(public)/accept-legal/actions.ts
//
// CL-1 (HPO-ODS-W2-28) — CL1-S4, the personal acceptance mutation. AB-1: one
// account-class acceptance row PER instrument accepted in this act, plus one
// audit row per acceptance, all in ONE transaction
// (ATOMICITY_BOUNDARIES.AB-1). Nothing else is written here — no
// organization row, no membership, no CommercialAccount, no entitlement
// (AB-1.must_not_contain).

import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { legalInstrumentVersions, accountLegalAcceptances } from '@/db/schema'
import { withAuthenticatedDatabaseContext } from '@/lib/auth/database-context'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'
import { ACCEPT_LEGAL_PATH } from '@/lib/auth/legal-acceptance'

export async function acceptRequiredLegalInstruments(formData: FormData): Promise<void> {
  const nextParam = formData.get('next')
  const safeNext = typeof nextParam === 'string' && isSafeRedirectPath(nextParam) ? nextParam : null

  const instrumentVersionIds = formData
    .getAll('instrumentVersionId')
    .filter((v): v is string => typeof v === 'string' && v.length > 0)

  if (instrumentVersionIds.length === 0) {
    redirect(`${ACCEPT_LEGAL_PATH}?error=nothing_to_accept`)
  }

  await withAuthenticatedDatabaseContext(async (ctx) => {
    for (const instrumentVersionId of instrumentVersionIds) {
      const [version] = await db
        .select({
          id: legalInstrumentVersions.id,
          instrumentKey: legalInstrumentVersions.instrumentKey,
          version: legalInstrumentVersions.version,
          contentDigest: legalInstrumentVersions.contentDigest,
        })
        .from(legalInstrumentVersions)
        .where(eq(legalInstrumentVersions.id, instrumentVersionId))
        .limit(1)

      // Absent or already-superseded version: the database trigger would
      // refuse this anyway (I-T3-4/I-T3-5). Skipping here just avoids an
      // avoidable thrown error for a version the caller can no longer see —
      // the gate re-evaluates currency from scratch on the very next request.
      if (!version) continue

      // I-T3-1: idempotent. A second identical acceptance is a no-op, not a
      // new fact — never a partial-form error.
      const [inserted] = await db
        .insert(accountLegalAcceptances)
        .values({
          userId: ctx.user.id,
          instrumentVersionId: version.id,
          contentDigest: version.contentDigest,
        })
        .onConflictDoNothing({
          target: [accountLegalAcceptances.userId, accountLegalAcceptances.instrumentVersionId],
        })
        .returning({ id: accountLegalAcceptances.id })

      if (!inserted) continue

      // AUDIT.THE_CONTENT_LEAK_PROHIBITION: instrument_key, version and the
      // content DIGEST only — never instrument text. No organizationId — an
      // account-class acceptance has no tenant (AUDIT.TENANT_SCOPE_OF_THE_AUDIT_ROW).
      await logAuditAction({
        actorUserId: ctx.user.id,
        entityType: 'user',
        entityId: ctx.user.id,
        action: AUDIT_ACTIONS.LEGAL_ACCOUNT_INSTRUMENT_ACCEPTED,
        afterJson: {
          instrumentKey: version.instrumentKey,
          version: version.version,
          contentDigest: version.contentDigest,
        },
      })
    }
  })

  redirect(safeNext ?? '/app/dashboard')
}
