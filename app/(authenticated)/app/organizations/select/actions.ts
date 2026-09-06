'use server'

// app/(authenticated)/app/organizations/select/actions.ts
//
// The EXPLICIT selection act (S2). Writes the selected-organization carrier
// ONLY after proving, against an existing membership source, that the caller
// holds an active membership in the requested organization.
//
// docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json
// SESSION_SCOPE.no_selection_behavior: "A user may not write an arbitrary
// organization id merely because it has a valid shape." The UUID-shape check
// lives in lib/auth/selected-organization.ts; the MEMBERSHIP check — the one
// that actually decides whether the write is allowed — lives here, against
// `getCurrentMembership`, an EXISTING identity/membership source
// (lib/auth/session.ts). No new membership table, view or query is
// introduced.
//
// THIS ACTION DOES NOT CONSTRUCT A REQUEST PRINCIPAL. It reads the caller's
// own active membership exactly the way every other entry point already does
// today (lib/auth/database-context.ts loadActiveMembershipWithinContext,
// singular / pick-first, unchanged by this batch — that rework is S3). It
// does not open an organization-scoped database context, and it writes no
// row. Selecting an organization here has NO effect on what
// `requireOrganizationAccess()` or any other authorization surface decides —
// see the INERTNESS_RULE in lib/auth/selected-organization.ts.

import { redirect } from 'next/navigation'
import { requireAuth, getCurrentMembership } from '@/lib/auth/session'
import {
  setSelectedOrganization,
  clearSelectedOrganization,
} from '@/lib/auth/selected-organization'

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
  const user = await requireAuth()

  const requestedOrganizationId = (formData.get('organizationId') as string | null)?.trim()
  if (!requestedOrganizationId) {
    redirect('/app/organizations/select?error=missing_organization')
  }

  const membership = await getCurrentMembership(user.id)
  if (!membership || membership.organizationId !== requestedOrganizationId) {
    // Refuse. The requested organization is not one the database says this
    // subject is an active member of. Never echoed, and never silently
    // resolved to the caller's own membership instead.
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
