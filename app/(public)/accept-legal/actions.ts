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
import { db } from '@/db/client'
import { accountLegalAcceptances } from '@/db/schema'
import { withAccountAcceptanceDischargeContext } from '@/lib/auth/database-context'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'
import { ACCEPT_LEGAL_PATH, loadRequiredInstrumentsPendingAcceptance } from '@/lib/auth/legal-acceptance'

export async function acceptRequiredLegalInstruments(formData: FormData): Promise<void> {
  const nextParam = formData.get('next')
  const safeNext = typeof nextParam === 'string' && isSafeRedirectPath(nextParam) ? nextParam : null

  const instrumentVersionIds = formData
    .getAll('instrumentVersionId')
    .filter((v): v is string => typeof v === 'string' && v.length > 0)

  if (instrumentVersionIds.length === 0) {
    redirect(`${ACCEPT_LEGAL_PATH}?error=nothing_to_accept`)
  }

  // B-1 REPAIR: withAccountAcceptanceDischargeContext, NOT
  // withAuthenticatedDatabaseContext — see its own doc comment. This is the
  // write half of the same self-lock: a verified-but-unaccepted subject must
  // be able to PERSIST the very acceptance that discharges L0.
  await withAccountAcceptanceDischargeContext(async (ctx) => {
    // D-1 REPAIR: a submitted instrumentVersionId is never trusted on its own
    // — it must belong to the EXACT server-derived pending set for this
    // subject, the SAME resolver CL1-S3 used to render the form
    // (S-AO-PREDICATE-CARDINALITY), re-derived fresh at submission time. This
    // is what makes a historical/superseded id, an already-accepted id, an
    // id for a non-required or not-yet-effective version, or a plain forged
    // UUID all refuse identically to an absent one: none of them can appear
    // in this map. instrumentKey/version/contentDigest are read FROM this
    // server-derived record, never from client-submitted form fields — the
    // client only ever supplies the id.
    const pendingById = new Map(
      (await loadRequiredInstrumentsPendingAcceptance(ctx.user.id)).map((item) => [
        item.instrumentVersionId,
        item,
      ])
    )

    for (const instrumentVersionId of instrumentVersionIds) {
      const version = pendingById.get(instrumentVersionId)

      // Not in the server-derived pending set: refused, not trusted. The
      // database trigger (I-T3-4/I-T3-5) would refuse an already-superseded
      // row anyway; this simply refuses BEFORE any insert is attempted, for
      // every reason a submitted id could fail to belong to the set.
      if (!version) continue

      // I-T3-1: idempotent. A second identical acceptance is a no-op, not a
      // new fact — never a partial-form error.
      const [inserted] = await db
        .insert(accountLegalAcceptances)
        .values({
          userId: ctx.user.id,
          instrumentVersionId: version.instrumentVersionId,
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
