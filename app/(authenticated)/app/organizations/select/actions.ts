'use server'

// app/(authenticated)/app/organizations/select/actions.ts
//
// The EXPLICIT selection act (S2, decircularised by S3). Writes the
// selected-organization carrier ONLY after proving, against the
// selectable-memberships enumerator, that the caller holds an active
// membership in the REQUESTED organization.
//
// docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json
// SESSION_SCOPE.no_selection_behavior: "A user may not write an arbitrary
// organization id merely because it has a valid shape." The UUID-shape check
// lives in lib/auth/selected-organization.ts; the MEMBERSHIP check — the one
// that actually decides whether the write is allowed — lives here.
//
// WHY NOT `getCurrentMembership` ANY MORE. After S3,
// `getCurrentMembership`/`getCurrentOrganizationContext` resolve through the
// CURRENTLY SELECTED pair — which, at the moment of making a NEW selection
// (there is none yet, or it names a different organization the caller is
// switching away from), is exactly the wrong thing to check: it would prove
// membership in the OLD selection, not the REQUESTED one. The proof here
// instead uses `listSelectableMemberships()`, the same non-authorizing
// enumerator the selector page renders from, keyed on (userId,
// status='active') alone — it never depends on what is currently selected,
// so it works identically whether this is a first selection, a switch, or a
// re-selection of the same organization.
//
// THIS ACTION DOES NOT CONSTRUCT A REQUEST PRINCIPAL. It does not open an
// organization-scoped database context, and it writes no row. Selecting an
// organization here still has NO effect on what `requireOrganizationAccess()`
// or any other authorization surface decides FOR THIS REQUEST — the write
// only changes what the NEXT request revalidates against
// (REQUEST_REVALIDATION) — see the header of
// lib/auth/selected-organization.ts.

import { redirect } from 'next/navigation'
import { requireAuth, listSelectableMemberships } from '@/lib/auth/session'
import {
  setSelectedOrganization,
  clearSelectedOrganization,
} from '@/lib/auth/selected-organization'
import { withAuthenticatedDatabaseContext } from '@/lib/auth/database-context'
import { emitOrganizationSelectionRefused } from '@/lib/audit/tenancy-refusal'

/**
 * Record a refused selection attempt, BEFORE the redirect that ends the act.
 *
 * TWO MEASURED HAZARDS SHAPE THIS HELPER, and neither is hypothetical.
 *
 * ORDERING. `redirect()` from next/navigation THROWS to unwind the request.
 * An emission placed after it is unreachable, so every call below runs first.
 * Equally, this must not be wrapped in a try/catch that also swallows
 * redirect's control-flow throw — so it is not wrapped at all. A failure to
 * record the refusal propagates and the request fails, which is the intended
 * fail-closed behaviour: a refusal must not complete while the row recording
 * it is missing.
 *
 * CONTEXT. `withAuthenticatedDatabaseContext` opens exactly the unscoped
 * { userId, organizationId: null } context the emitter requires, and is one of
 * the context openers tests/database-runtime-entrypoints.test.ts recognises.
 * Importing the emitter makes this module database-reaching; opening the
 * context here is what keeps it `contextualized` rather than dropping the
 * pinned magnitude by one.
 *
 * The raw submitted value is passed through UNCLASSIFIED. Deciding Form A from
 * Form B is the emitter's job, precisely so that malformed bytes are shape-
 * checked in exactly one place instead of at every call site.
 */
async function recordRefusedSelection(attempted: string | null | undefined): Promise<void> {
  await withAuthenticatedDatabaseContext(async ({ user }) => {
    await emitOrganizationSelectionRefused({ userId: user.id, attemptedOrganizationId: attempted })
  })
}

/**
 * Select an organization as a session-scoped carrier.
 *
 * Refuses (redirects back with an error, never a silent fallback) when:
 *   - no `organizationId` is supplied,
 *   - the caller has no active membership at all, or
 *   - the caller's active membership is in a DIFFERENT organization than the
 *     one requested.
 *
 * There is no fallback to "the caller's only membership" on refusal. A
 * refused selection leaves the carrier exactly as it was before the call —
 * unset if it was unset, unchanged if it was already set to something else.
 */
export async function selectOrganizationAction(formData: FormData): Promise<void> {
  await requireAuth()

  const requestedOrganizationId = (formData.get('organizationId') as string | null)?.trim()
  if (!requestedOrganizationId) {
    // FORM A. An explicit selection act that supplied no usable organisation
    // id. This is a genuine ATTEMPT and is therefore audited — unlike the
    // routine "signed in, nothing selected yet" state, which is not an attempt
    // and emits nothing (see lib/auth/database-context.ts).
    await recordRefusedSelection(requestedOrganizationId)
    redirect('/app/organizations/select?error=missing_organization')
  }

  const candidates = await listSelectableMemberships()
  const isSelectableMember = candidates.some(({ organization }) => organization.id === requestedOrganizationId)
  if (!isSelectableMember) {
    // Refuse. The requested organization is not one the database says this
    // subject is an active member of. Never echoed, and never silently
    // resolved to the caller's own (or currently selected) membership
    // instead — this check is deliberately independent of any prior
    // selection, so a caller has no way to bootstrap a wrong write from a
    // stale carrier.
    //
    // FORM B when the submitted value is a valid UUID; FORM A when it is
    // malformed. The emitter classifies, so hostile bytes never reach the
    // uuid subject column, and no organisation existence lookup is added
    // merely to record the event.
    await recordRefusedSelection(requestedOrganizationId)
    redirect('/app/organizations/select?error=not_a_member')
  }

  await setSelectedOrganization(requestedOrganizationId)
  redirect('/app/dashboard')
}

/**
 * Clear the carrier. An explicit "change organization" act — the session
 * itself already starts with no selection, so this exists for a signed-in
 * user who wants to select again, not as a substitute for session expiry.
 */
export async function clearOrganizationSelectionAction(): Promise<void> {
  await requireAuth()
  await clearSelectedOrganization()
  redirect('/app/organizations/select')
}
