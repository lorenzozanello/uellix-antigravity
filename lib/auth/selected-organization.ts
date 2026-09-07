// lib/auth/selected-organization.ts
//
// THE SELECTED-ORGANIZATION SESSION CARRIER (S2).
//
// docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json
// SELECTED_ORG_CARRIER (MO-04) + SESSION_SCOPE (MO-03 + MO-04). Not restated
// here — see that authority for the full doctrine this module implements.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// A session-scoped cookie naming which organization the subject WISHES to act
// in. Nothing more. It carries no role, no permission, no CommercialAccount
// identifier, and it is never persisted anywhere the browser session does not
// already reach — no users column, no preference row, no localStorage.
//
// ---------------------------------------------------------------------------
// THE TRUST MODEL — READ THIS BEFORE ADDING A CONSUMER
// ---------------------------------------------------------------------------
// THE CARRIER IS AN ASSERTION, NEVER A GRANT. It states which organization the
// subject wishes to act in; it authorizes nothing by itself. A cookie naming
// an organization the subject was removed from five minutes ago is perfectly
// authentic and must still be refused by whatever consumes it.
//
// THIS MODULE DOES NOT CONSUME ITS OWN VALUE FOR ANY AUTHORIZATION DECISION.
// It is deliberately a leaf: it imports nothing from lib/auth/database-context,
// lib/auth/session, lib/auth/permissions, lib/auth/roles or
// db/identity-context, and nothing in this batch reads it back for anything
// other than rendering which organization is currently selected.
//
// Consuming this value to construct a request principal, a role, an RLS
// predicate, a GUC or any capability check is node S3
// (MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json REQUEST_PRINCIPAL), which is
// NOT part of this batch
// (docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_v1.0.0.json
// S2.INERTNESS_RULE). Wiring this module into db/identity-context.ts,
// lib/auth/database-context.ts, lib/auth/session.ts, lib/auth/permissions.ts
// or lib/auth/roles.ts performs S3 without S3's revalidation lineage and is
// exactly the failure tests/tenancy/s2-selected-org-carrier.test.ts exists to
// catch.
//
// ---------------------------------------------------------------------------
// WHY A MANUAL COOKIE RATHER THAN A LIBRARY
// ---------------------------------------------------------------------------
// The cookie must be session-only (no Max-Age, no Expires) and must carry
// nothing beyond a single organization id. next/headers' `cookies()` already
// gives direct control over every mandatory attribute with no additional
// dependency, so no cookie library is introduced for a single string value.
//
// ---------------------------------------------------------------------------
// PATH SCOPE — MEASURED, NOT ASSUMED
// ---------------------------------------------------------------------------
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_v1.0.0.json S2
// leaves path_scope FUTURE_MEASUREMENT_REQUIRED and requires the choice to be
// justified against the live route tree. Measured at implementation time:
// every route this carrier has any business reaching — the pre-organization
// selector at `/app/organizations/select`, the pre-organization onboarding
// route at `/app/onboarding`, and the whole organization-gated workspace at
// `/app/**` — is served under the single URL prefix `/app` (route groups are
// stripped from the URL; `app/admin/**` is a SEPARATE top-level tree served at
// `/admin`, not `/app`, and has no business receiving this cookie). `/app` is
// therefore the narrowest Path that reaches every legitimate reader without
// also reaching `/login`, `/admin`, `/auth` or the marketing site.

import { cookies } from 'next/headers'

/**
 * Same shape check every identity boundary in this repository already uses
 * (db/identity-context.ts, lib/auth/identity.ts, lib/auth/session.ts): the
 * value below is interpolated where an organization id is expected, and a
 * non-UUID value is refused as a MALFORMED carrier rather than trusted.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The carrier's cookie name.
 *
 * Deliberately NOT the Supabase Auth cookie (`lib/supabase/server.ts`, a
 * different carrier with a different lifetime and a different purpose) and
 * deliberately namespaced so it cannot collide with any third-party cookie.
 */
export const SELECTED_ORGANIZATION_COOKIE_NAME = 'uellix_selected_organization_id'

/**
 * The narrowest Path that reaches every legitimate reader. See the module
 * header for the measurement that justifies this value.
 */
export const SELECTED_ORGANIZATION_COOKIE_PATH = '/app'

/**
 * The mandatory cookie attributes, exactly.
 *
 * `httpOnly`, `secure`, `sameSite: 'lax'` — MO-04, ratified verbatim.
 * NO `maxAge` and NO `expires` — SESSION_SCOPE requires the cookie to die
 * with the browser session; setting either would make the selection outlive
 * it, which is the exact defect this module exists to avoid.
 */
function cookieOptions(): {
  httpOnly: true
  secure: true
  sameSite: 'lax'
  path: string
} {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: SELECTED_ORGANIZATION_COOKIE_PATH,
  }
}

/**
 * Write the carrier.
 *
 * This is the ONLY way the carrier is written in this batch, and it is
 * reached only from an EXPLICIT selection act
 * (app/(authenticated)/app/organizations/select/actions.ts) — never from a
 * page render, never as a side effect of authentication, never inferred from
 * "the subject has exactly one membership". SESSION_SCOPE.no_selection_behavior
 * forbids exactly that inference, in both the single- and multi-membership
 * case.
 *
 * The caller (the selection action) is responsible for proving the subject
 * holds an active membership in `organizationId` BEFORE calling this
 * function — this module has no membership source to check against, by
 * design (see the module header: it imports no authorization surface).
 *
 * @throws if `organizationId` is not a UUID. The carrier's payload is a bare
 * organization id and nothing else; a non-UUID value is a programming error
 * at the call site, not a value this module silently accepts.
 */
export async function setSelectedOrganization(organizationId: string): Promise<void> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error('setSelectedOrganization: organizationId is not a UUID.')
  }

  const cookieStore = await cookies()
  cookieStore.set(SELECTED_ORGANIZATION_COOKIE_NAME, organizationId, cookieOptions())
}

/**
 * Read the carrier back, for rendering which organization is currently
 * selected. Returns `null` when absent OR malformed — a tampered, truncated
 * or non-UUID cookie value is treated identically to no selection, never as
 * a parse error the request must handle.
 *
 * This function performs NO membership check and NO organization lookup. It
 * reports what the cookie SAYS, not what it PROVES — the trust model above.
 * A caller that needs to know whether the named organization is one the
 * subject may actually act in must ask a membership source directly; this
 * module has none to ask, by design.
 */
export async function getSelectedOrganizationId(): Promise<string | null> {
  const cookieStore = await cookies()
  const value = cookieStore.get(SELECTED_ORGANIZATION_COOKIE_NAME)?.value ?? null
  if (!value || !UUID_PATTERN.test(value)) return null
  return value
}

/**
 * Clear the carrier. A new session already starts with no selection (the
 * cookie is session-only and never survives one); this is for an explicit
 * "change organization" action within the same session.
 */
export async function clearSelectedOrganization(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete({
    name: SELECTED_ORGANIZATION_COOKIE_NAME,
    path: SELECTED_ORGANIZATION_COOKIE_PATH,
  })
}
