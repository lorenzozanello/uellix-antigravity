'use server'

// app/(public)/accept-commercial-terms/actions.ts
//
// L1 (HPO-ODS-W2-29) — the ORGANIZATION-class acceptance mutation. AB-3: ONE
// transaction containing EXACTLY TWO semantic writes — one organisation-class
// acceptance row and one audit row — and nothing else.
//
// WHAT THIS TRANSACTION MUST NOT CONTAIN (ATOMICITY_AUTHORITY.MUST_NOT_CONTAIN,
// exhaustive): any entitlement grant, any CommercialAccount mutation, any
// organizations.status change, any membership change, any selected-organisation
// carrier mutation, any invitation state transition, any instrument version
// publication. Acceptance is a PRECONDITION of entitlement, never a CAUSE of
// it — granting one here would make acceptance an entitlement source and
// contradict ratification CA-03. Writing this row grants NOTHING (I-T4-10).
//
// IT IS ALSO NOT FOLDED INTO THE AB-2 BOOTSTRAP (M-AO-14). Folding would make
// a founder's organisation pass L1 immediately and would make the
// ORGANIZATION_PENDING_COMMERCIAL_ACCEPTANCE window disappear — which looks
// like a better product and is exactly the engineering-away the parent
// forbids, since the window reopens on any administrator change or
// reacceptance anyway.
//
// ONE TRANSACTION, NO NESTED ONE. db/identity-context.ts
// withDatabaseIdentityContext IS the transaction (client.db.transaction), and
// the ambient `db` export is bound to it for the duration — so both writes
// below already commit or roll back together. Opening a nested transaction
// here would deadlock against its own parent's locks.

import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { organizationCommercialAcceptances } from '@/db/schema'
import { withOrganizationAcceptanceDischargeContext } from '@/lib/auth/database-context'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import {
  ACCEPT_COMMERCIAL_TERMS_PATH,
  loadRequiredOrganizationInstrumentsPendingAcceptance,
} from '@/lib/auth/organization-commercial-acceptance'

export async function acceptRequiredOrganizationInstrument(formData: FormData): Promise<void> {
  // THE ONE AUTHORITATIVE SELECTOR THE CLIENT MAY SUPPLY, and only as the
  // selector of WHICH pending acceptance is being discharged. Everything else
  // is server-derived below and NO other form field is read — not the
  // organisation, not the subject, not the role, not the instrument key, not
  // the digest, not the timestamp.
  //
  // A ROLE FIELD SUBMITTED ANYWAY IS IGNORED, NOT VALIDATED
  // (ACCEPTOR_AUTHORITY.a_forged_role_is_IGNORED_not_merely_refused,
  // control BIND-forged-role-ignored). A validated client role is still a
  // client role, and a validation that happens to pass makes the client the
  // source of the value. Nothing in this function reads formData beyond the
  // line below.
  const submitted = formData.get('instrumentVersionId')
  const instrumentVersionId = typeof submitted === 'string' && submitted.length > 0 ? submitted : null

  await withOrganizationAcceptanceDischargeContext(async (ctx) => {
    // RE-DERIVED AT SUBMISSION TIME, never trusted from the rendered page
    // (SUBMISSION_BINDING.RE_DERIVATION_AT_SUBMISSION_TIME). A page rendered
    // minutes ago is not evidence of what is currently required, and a
    // submission whose version has since left the pending set is REFUSED
    // rather than accepted on the strength of what the page showed
    // (BIND-stale-version-refused; mutation
    // MUT-L1-trust-the-submitted-version-without-rederivation — under which
    // every ordinary submission still succeeds and only a submission across a
    // publication boundary is wrong, which is the case manual testing never
    // reaches).
    const pending = await loadRequiredOrganizationInstrumentsPendingAcceptance(ctx.organization.id)
    const version = instrumentVersionId
      ? pending.find((item) => item.instrumentVersionId === instrumentVersionId)
      : undefined

    // REFUSED IDENTICALLY AND WITHOUT AN ORACLE (REFUSAL-no-oracle). A forged
    // id, a random UUID, a stale version, a superseded one, one already
    // accepted by this organisation, one belonging to ANOTHER organisation's
    // pending set, an ACCOUNT-class version, a not-yet-effective version, a
    // non-required key, and an absent field ALL land here — none of them can
    // appear in the server-derived set, and the caller cannot tell which
    // reason applied. The submitted id is NOT echoed: it is the thing the
    // caller controls, and echoing it turns the error into an oracle — the
    // same discipline withOrganizationDatabaseContext already applies to
    // AUTH_ORGANIZATION_FORBIDDEN. NO audit row is written on any refusal
    // path (AUDIT_AUTHORITY.WHAT_MUST_NOT_BE_AUDITED.refusals).
    if (!version) return

    // WRITE 1 of 2 — the acceptance row. Every persisted value except the
    // version id comes from the SERVER-DERIVED record or from the resolved
    // context; the digest is the canonical digest of that version, not
    // anything the client sent. accepted_by_role is the role the database
    // itself confirmed during context resolution, and the BEFORE INSERT
    // trigger re-verifies it against current_user_role_in_org at the database
    // boundary in this same transaction, so a stale or forged value is
    // refused rather than stored (I-T4-6, I-T4-7).
    //
    // ON CONFLICT DO NOTHING IS A RACE GUARD, NOT THE CONCURRENCY CONTROL.
    // The I-T4-1 unique constraint is the concurrency authority and is what
    // makes two administrators accepting the same version concurrently yield
    // EXACTLY ONE ROW (N-AO-17). This clause exists only so the loser of that
    // race gets a clean no-op instead of an unhandled 23505 — and the
    // `if (!inserted)` branch below is what stops it from HIDING the
    // duplicate: no second row means NO SECOND AUDIT ROW and no second
    // acceptance event. Dropping the unique index to obtain idempotency, or
    // letting this clause report a concurrent duplicate as a successful
    // acceptance, would both defeat I-T4-1.
    const [inserted] = await db
      .insert(organizationCommercialAcceptances)
      .values({
        organizationId: ctx.organization.id,
        instrumentKey: version.instrumentKey,
        instrumentVersionId: version.instrumentVersionId,
        contentDigest: version.contentDigest,
        acceptedByUserId: ctx.user.id,
        acceptedByRole: ctx.membership.role,
      })
      .onConflictDoNothing({
        target: [
          organizationCommercialAcceptances.organizationId,
          organizationCommercialAcceptances.instrumentVersionId,
        ],
      })
      .returning({ id: organizationCommercialAcceptances.id })

    if (!inserted) return

    // WRITE 2 of 2 — the audit row. TENANT-SCOPED, carrying the accepted
    // organisation, attributed to the accepting subject: admitted by the
    // PRE-EXISTING 0042 audit_logs_insert_member_or_admin policy on its first
    // disjunct, with NO fourth audit_logs INSERT policy added anywhere
    // (R-L1-12).
    //
    // instrument_key, version and the content DIGEST only — never instrument
    // text, body, excerpt or rendered markup, and no IP address, user agent,
    // device or fingerprint (X-AO-05, sentinel
    // S-L1-NO-INSTRUMENT-TEXT-IN-AUDIT). The digest already identifies the
    // document uniquely and the bytes are retained once, in the registry.
    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'organization',
      entityId: ctx.organization.id,
      action: AUDIT_ACTIONS.LEGAL_ORGANIZATION_INSTRUMENT_ACCEPTED,
      afterJson: {
        instrumentKey: version.instrumentKey,
        version: version.version,
        contentDigest: version.contentDigest,
      },
    })
  })

  // Back to the discharge surface, which now renders its terminal state for a
  // fully accepted organisation rather than trapping the administrator
  // (TOPO-discharge-surface-not-a-dead-end). Its own render re-derives the
  // pending set, so this is a fact-driven destination and not an assumption
  // that the write succeeded.
  redirect(ACCEPT_COMMERCIAL_TERMS_PATH)
}
