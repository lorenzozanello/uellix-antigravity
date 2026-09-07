// lib/auth/database-context.ts
//
// THE CENTRAL API EVERY PROTECTED ENTRY POINT GOES THROUGH.
//
// db/identity-context.ts knows how to put an identity on a connection. This
// module knows WHOSE identity, and it is the only thing in the application
// allowed to decide that. Between them:
//
//     lib/auth/identity.ts      subject, from Supabase Auth      (no database)
//     lib/auth/database-context this file: principal + wrappers  (short reads)
//     db/identity-context.ts    claims + transaction + rollback  (the mechanism)
//
// WHY A "PRINCIPAL" STEP EXISTS AT ALL
//
// An organisation-scoped context needs an organisation id before it opens, and
// the only trustworthy source of that id is `organization_members` — a table
// behind RLS, which cannot be read without a context. That is a second cycle,
// smaller than the `getCurrentUser` one but the same shape.
//
// It is broken by opening an UNSCOPED context first (subject only, no
// organisation), reading the profile and the membership under it, and closing
// it. The organisation-scoped context is then opened once, with an id the
// database itself supplied.
//
// The unscoped read is memoised per request, so the cost is one extra short
// transaction per request, not one per service call. It is also why nesting is
// never violated: by the time anything opens an org-scoped context, the
// principal is already resolved and no inner call re-enters with a different
// organisation.
//
// WHAT IS REFUSED
//
//   * A caller-supplied `organizationId` that is not the one the database says
//     this user is an active member of. RLS would constrain the rows anyway;
//     the refusal exists because application code downstream reads that value
//     for things RLS does not cover (audit rows, storage prefixes, quota).
//   * A caller-supplied super-admin claim. There is no parameter for it. The
//     value is read from `public.users` under the user's own claims, and
//     db/identity-context.ts then re-checks it against
//     `current_user_is_super_admin()` before the context opens.
//   * A missing or rejected session. Every wrapper here throws rather than
//     falling back to an unscoped query, because an unscoped query as
//     `uellix_app` returns zero rows — a silent empty page instead of a 401.

import { cache } from 'react'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { organizationMembers, organizations, users } from '@/db/schema'
import {
  getBoundDatabaseContext,
  withDatabaseIdentityContext,
  type WithDatabaseIdentityContextOptions,
} from '@/db/identity-context'
import { getVerifiedAuthIdentityResult, type AuthIdentityFailure } from './identity'
import { isValidRole, type Role } from './roles'
// S3 (docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json
// REQUEST_PRINCIPAL): the ONLY read of the S2 carrier's VALUE anywhere in the
// authorization surface. Import direction is database-context -> carrier,
// never the reverse — the carrier stays a leaf (lib/auth/selected-organization.ts
// header). The value is an ASSERTION, never a grant: every membership it
// leads to below is re-derived from live database state, never trusted from
// the cookie alone.
import { getSelectedOrganizationId } from './selected-organization'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface AuthUser {
  id: string
  email: string
  fullName: string | null
  avatarUrl: string | null
  isSuperAdmin: boolean
}

export interface Membership {
  id: string
  organizationId: string
  userId: string
  role: Role
  status: string
}

export interface Organization {
  id: string
  name: string
  slug: string
  legalName: string | null
  country: string | null
  sector: string | null
  status: string
  baseCurrency?: string
  onboardingCompleted?: boolean
  stellaMonthlyQuota?: number | null
  stellaPlanLabel?: string | null
  logoUrl?: string | null
  brandColor?: string | null
  whiteLabelEnabled?: boolean
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  stripePriceId?: string | null
}

export interface OrganizationContext {
  user: AuthUser
  membership: Membership
  organization: Organization
}

/**
 * Everything the database will say about the caller, resolved once.
 *
 * `membership` and `organization` are nullable together: a super admin with no
 * membership is a legitimate principal, and so is a freshly signed-up user who
 * has not completed onboarding.
 */
export interface RequestPrincipal {
  readonly user: AuthUser
  readonly membership: Membership | null
  readonly organization: Organization | null
  /**
   * WHY `membership`/`organization` are null, when they are. `null` when they
   * are present.
   *
   * S3 — REQUEST_PRINCIPAL_CONTRACT distinguishes two refusals that used to
   * collapse into one generic "no organization": an absent selection, and a
   * selection naming an organisation the caller does not hold an active
   * membership in. The second value also covers a DELETED or NONEXISTENT
   * selected organisation — deliberately indistinguishable from
   * non-membership here, so this boundary is never an existence oracle for
   * organisation ids the caller has no right to probe (indistinguishability_
   * requirement).
   */
  readonly organizationRefusalCode:
    | 'TENANCY_NO_ORGANIZATION_SELECTED'
    | 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'
    | null
}

export type AuthContextErrorCode =
  | 'AUTH_NO_SESSION'
  | 'AUTH_SESSION_REJECTED'
  | 'AUTH_MALFORMED_SUBJECT'
  | 'AUTH_UNAVAILABLE'
  | 'AUTH_NO_PROFILE'
  | 'AUTH_USER_DEACTIVATED'
  // Superseded by the two TENANCY_* codes below (S3, REQUEST_PRINCIPAL_CONTRACT
  // .refusal_codes). No longer thrown — SI-2's pick-first shape is what used to
  // make one generic "no organization" refusal sufficient. Kept in the union
  // rather than deleted: it is not a protected surface, but removing a public
  // error-code literal on a guess about every caller is not this node's call.
  | 'AUTH_NO_ORGANIZATION'
  | 'AUTH_ORGANIZATION_FORBIDDEN'
  | 'AUTH_NOT_SUPER_ADMIN'
  // S3 — REQUEST_PRINCIPAL_CONTRACT.refusal_codes, frozen by
  // docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.4.json.
  // Two distinct codes because the two failures are NOT the same refusal: one
  // is "you have not chosen", the other is "what you chose does not admit
  // you" — collapsing them would make M-4-style regressions (a silent
  // fallback dressed as a rename) harder to catch by code alone.
  | 'TENANCY_NO_ORGANIZATION_SELECTED'
  | 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'

export class AuthContextError extends Error {
  readonly name = 'AuthContextError'
  readonly code: AuthContextErrorCode

  constructor(code: AuthContextErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** The HTTP answer each refusal deserves. Route handlers read this. */
export function authContextErrorStatus(code: AuthContextErrorCode): number {
  switch (code) {
    case 'AUTH_NO_SESSION':
    case 'AUTH_SESSION_REJECTED':
    case 'AUTH_MALFORMED_SUBJECT':
      return 401
    case 'AUTH_UNAVAILABLE':
      return 503
    // A valid session that is simply not allowed here. 403, never 401: telling
    // a signed-in user to sign in again is a loop, not a fix.
    case 'AUTH_NO_PROFILE':
    case 'AUTH_USER_DEACTIVATED':
    case 'AUTH_NO_ORGANIZATION':
    case 'AUTH_ORGANIZATION_FORBIDDEN':
    case 'AUTH_NOT_SUPER_ADMIN':
    case 'TENANCY_NO_ORGANIZATION_SELECTED':
    case 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER':
      return 403
  }
}

function failureToCode(failure: AuthIdentityFailure): AuthContextErrorCode {
  switch (failure) {
    case 'NO_SESSION':
      return 'AUTH_NO_SESSION'
    case 'SESSION_REJECTED':
      return 'AUTH_SESSION_REJECTED'
    case 'MALFORMED_SUBJECT':
      return 'AUTH_MALFORMED_SUBJECT'
    case 'AUTH_UNAVAILABLE':
      return 'AUTH_UNAVAILABLE'
  }
}

/**
 * Currently only `{ client }`, the injection point tests use to reach a
 * non-default connection. Aliased rather than re-declared so that anything
 * db/identity-context.ts adds later is available here without a second edit.
 */
export type DatabaseContextOptions = WithDatabaseIdentityContextOptions

/* -------------------------------------------------------------------------- */
/* Loaders — these run ONLY inside a context                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read the caller's own `public.users` row.
 *
 * Precondition: a database identity context for `userId` is open. Outside one
 * this returns `null`, because `users_select_own` compares `id = auth.uid()`
 * and `auth.uid()` is NULL with no claims — the fail-closed behaviour the
 * cutover introduced, and the exact bug this module exists to stop happening
 * by accident.
 */
export async function loadCurrentUserWithinContext(userId: string): Promise<AuthUser | null> {
  const row = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!row) return null

  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    avatarUrl: row.avatarUrl,
    isSuperAdmin: row.isSuperAdmin,
  }
}

/**
 * The caller's active membership in ONE SPECIFIC organisation. Context
 * required.
 *
 * S3 — REQUEST_PRINCIPAL_CONTRACT.PROHIBITED_IMPLEMENTATION_SHAPE: the
 * organisation is part of THIS PREDICATE, not a filter applied afterward to
 * an unqualified result. `organization_members_org_user_unique` guarantees
 * the triple (user_id, organization_id, status='active') addresses AT MOST
 * ONE row, so `.limit(1)` is a defensive cap on an already-unique lookup,
 * never how uniqueness is achieved. This is the SI-2 site
 * (lib/auth/database-context.ts:210/:219 before S3): the prior shape queried
 * `userId + status='active'` alone and took whichever row came back first.
 *
 * `organizationId` is the SELECTED organisation from the S2 carrier — an
 * ASSERTION, never authority. Finding no row here means "not an active
 * member of this organisation", which is also what a DELETED or NONEXISTENT
 * organisation id resolves to: there is no second query that could tell them
 * apart, by construction.
 */
export async function loadActiveMembershipWithinContext(
  userId: string,
  organizationId: string
): Promise<Membership | null> {
  const row = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.status, 'active')
      )
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!row) return null

  // Defensive against schema drift: a role the application does not know is
  // not a role it can make an authorisation decision with.
  const role = isValidRole(row.role) ? row.role : null
  if (!role) return null

  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role,
    status: row.status,
  }
}

/** One candidate the caller MAY select — never a principal, never authority. */
export interface SelectableMembership {
  readonly membership: Membership
  readonly organization: Organization
}

/**
 * Every ACTIVE membership the caller may select. Context required.
 *
 * S3 — SELECTOR_DECIRCULARISATION: the organisation-selection page cannot
 * require an already-selected principal in order to let the subject select
 * one. This enumerator is keyed on `(userId, status='active')` ALONE — no
 * selected organisation is read, consulted or required — and answers "which
 * organisations may this subject choose", never "which one is chosen".
 *
 * `enumerator_is_not_a_principal`: this result MUST NOT be used to construct
 * a principal, a role, an RLS predicate or a GUC, and MUST NOT drive an
 * auto-selection — not even when it holds exactly one row. Its only
 * authorised consumers are the selector page (to render candidates) and the
 * selection action (to prove the REQUESTED organisation, whichever one that
 * is, is one the caller may actually pick).
 *
 * `user_single_active_membership` (a UNIQUE partial index on
 * `organization_members(user_id) WHERE status='active'`) means this holds at
 * most one row in production today — S7 owns lifting that ceiling. The
 * predicate below is written for the post-S7 cardinality regardless, so nothing
 * here has to change when that index is dropped.
 */
export async function loadSelectableMembershipsWithinContext(
  userId: string
): Promise<SelectableMembership[]> {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active')))

  const selectable: SelectableMembership[] = []
  for (const row of rows) {
    const role = isValidRole(row.role) ? row.role : null
    if (!role) continue

    const organization = await loadOrganizationWithinContext(row.organizationId)
    if (!organization) continue

    selectable.push({
      membership: { id: row.id, organizationId: row.organizationId, userId: row.userId, role, status: row.status },
      organization,
    })
  }
  return selectable
}

/** The organisation row. Context required. */
export async function loadOrganizationWithinContext(
  organizationId: string
): Promise<Organization | null> {
  const org = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!org) return null

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    legalName: org.legalName,
    country: org.country,
    sector: org.sector,
    status: org.status,
    baseCurrency: org.baseCurrency,
    onboardingCompleted: org.onboardingCompleted,
    stellaMonthlyQuota: org.stellaMonthlyQuota,
    stellaPlanLabel: org.stellaPlanLabel,
    logoUrl: org.logoUrl,
    brandColor: org.brandColor,
    whiteLabelEnabled: org.whiteLabelEnabled,
    stripeCustomerId: org.stripeCustomerId,
    stripeSubscriptionId: org.stripeSubscriptionId,
    stripePriceId: org.stripePriceId,
  }
}

/* -------------------------------------------------------------------------- */
/* The principal                                                              */
/* -------------------------------------------------------------------------- */

async function readPrincipalUnderOpenContext(userId: string): Promise<RequestPrincipal | null> {
  const user = await loadCurrentUserWithinContext(userId)
  if (!user) return null

  // S3 — REQUEST_PRINCIPAL_CONTRACT.authoritative_rederivation: re-read on
  // EVERY call, never cached beyond this one request's memoised principal.
  // The carrier is an ASSERTION ONLY — reaching this line proves nothing by
  // itself; every membership below is re-derived from live database state.
  const selectedOrganizationId = await getSelectedOrganizationId()

  if (selectedOrganizationId === null) {
    return { user, membership: null, organization: null, organizationRefusalCode: 'TENANCY_NO_ORGANIZATION_SELECTED' }
  }

  const membership = await loadActiveMembershipWithinContext(userId, selectedOrganizationId)
  if (!membership) {
    // S3-4: a DELETED or NONEXISTENT selected organisation resolves HERE,
    // through the SAME qualified predicate, to the SAME refusal as ordinary
    // non-membership — organization_members.organization_id is a RESTRICT
    // (never CASCADE) foreign key, so an organisation cannot be removed while
    // an active membership still references it. There is no second query
    // that could tell "deleted" apart from "never a member", by construction,
    // which is what makes this boundary immune to being an existence oracle.
    return { user, membership: null, organization: null, organizationRefusalCode: 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER' }
  }

  // `membership` and `organization` are reported INDEPENDENTLY from here,
  // exactly as before S3: a membership whose organisation row cannot be read
  // is still a real membership — it is just not usable as an organisation
  // context, and it is the wrappers below (and `requireOrganizationAccess`)
  // that insist on both. Collapsing the two would silently change what
  // `getCurrentMembership()` answers for no reason the qualified predicate
  // above does not already cover.
  const organization = await loadOrganizationWithinContext(membership.organizationId)

  return {
    user,
    membership,
    organization,
    organizationRefusalCode: organization ? null : 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER',
  }
}

/**
 * Resolve who the caller is, according to the database, once per request.
 *
 * Returns `null` when there is no verified session OR when the verified
 * subject has no readable profile row. The two are separated by
 * `resolveRequestPrincipalResult` for callers that must distinguish them.
 */
export const loadRequestPrincipal = cache(async (): Promise<RequestPrincipal | null> => {
  return (await resolveRequestPrincipal()).principal
})

export interface RequestPrincipalResult {
  readonly principal: RequestPrincipal | null
  readonly failure: AuthContextErrorCode | null
}

async function resolveRequestPrincipal(
  options: DatabaseContextOptions = {}
): Promise<RequestPrincipalResult> {
  const { identity, failure } = await getVerifiedAuthIdentityResult()
  if (!identity) {
    return { principal: null, failure: failureToCode(failure ?? 'NO_SESSION') }
  }

  // ALREADY INSIDE A CONTEXT FOR THIS SUBJECT.
  //
  // Re-entering `withDatabaseIdentityContext` with `organizationId: null`
  // while an organisation-scoped context is open for the same user is a
  // NESTED MISMATCH — the identity differs by one field. The ordinary request
  // flow never gets here (the principal is resolved before any org context
  // opens), but `cache()` is a per-render memo and a route handler or a
  // background call may run outside that scope. Reading through the open
  // context is both correct and cheaper than opening a second transaction.
  const bound = getBoundDatabaseContext()
  if (bound !== undefined && bound.identity.userId === identity.userId) {
    const principal = await readPrincipalUnderOpenContext(identity.userId)
    return { principal, failure: principal ? null : 'AUTH_NO_PROFILE' }
  }

  const principal = await withDatabaseIdentityContext(
    { userId: identity.userId, organizationId: null, isSuperAdmin: false },
    () => readPrincipalUnderOpenContext(identity.userId),
    options
  )

  return { principal, failure: principal ? null : 'AUTH_NO_PROFILE' }
}

/** Non-memoised principal resolution, with the reason it failed. */
export async function loadRequestPrincipalResult(
  options: DatabaseContextOptions = {}
): Promise<RequestPrincipalResult> {
  return resolveRequestPrincipal(options)
}

/* -------------------------------------------------------------------------- */
/* Wrappers                                                                   */
/* -------------------------------------------------------------------------- */

export interface AuthenticatedContext {
  readonly user: AuthUser
  readonly membership: Membership | null
  readonly organization: Organization | null
}

async function requirePrincipal(options: DatabaseContextOptions): Promise<RequestPrincipal> {
  // The memo is consulted first so a page that opens several contexts pays for
  // one GoTrue round trip and one unscoped transaction, not several.
  const memoised = await loadRequestPrincipal()
  if (memoised) return memoised

  const { principal, failure } = await resolveRequestPrincipal(options)
  if (principal) return principal

  const code = failure ?? 'AUTH_NO_SESSION'
  throw new AuthContextError(
    code,
    code === 'AUTH_NO_PROFILE'
      ? 'The session is valid but the account has no readable profile row. Refusing to continue: ' +
          'every organisation and role decision downstream reads that row.'
      : 'No verified session is attached to this request.'
  )
}

/**
 * The selectable-memberships enumerator (S3 —
 * SELECTOR_DECIRCULARISATION.enumerator_is_not_a_principal), for the
 * currently authenticated caller.
 *
 * Opens (or reuses) the SAME unscoped context `loadRequestPrincipal` does —
 * never an organisation-scoped one, since enumerating candidates must not
 * require having already selected one. Requires a session; throws exactly
 * what `requirePrincipal` throws when there is none.
 *
 * The result MUST NOT be used to construct a principal, a role, an RLS
 * predicate or a GUC, and MUST NOT drive an auto-selection.
 */
export async function listSelectableMemberships(
  options: DatabaseContextOptions = {}
): Promise<SelectableMembership[]> {
  const principal = await requirePrincipal(options)

  const bound = getBoundDatabaseContext()
  if (bound !== undefined && bound.identity.userId === principal.user.id) {
    return loadSelectableMembershipsWithinContext(principal.user.id)
  }

  return withDatabaseIdentityContext(
    { userId: principal.user.id, organizationId: null, isSuperAdmin: principal.user.isSuperAdmin },
    () => loadSelectableMembershipsWithinContext(principal.user.id),
    options
  )
}

/**
 * Run `callback` inside a database identity context for the caller.
 *
 * Not organisation-scoped: use this for work that belongs to the user rather
 * than to a tenant — onboarding, invitation acceptance, profile reads.
 */
export async function withAuthenticatedDatabaseContext<T>(
  callback: (context: AuthenticatedContext) => Promise<T>,
  options: DatabaseContextOptions = {}
): Promise<T> {
  const principal = await requirePrincipal(options)

  return withDatabaseIdentityContext(
    {
      userId: principal.user.id,
      organizationId: null,
      // Read from the database under the user's own claims, never from a
      // caller. db/identity-context.ts re-checks it against
      // current_user_is_super_admin() before this callback runs.
      isSuperAdmin: principal.user.isSuperAdmin,
    },
    () =>
      callback({
        user: principal.user,
        membership: principal.membership,
        organization: principal.organization,
      }),
    options
  )
}

export interface WithOrganizationOptions extends DatabaseContextOptions {
  /**
   * Assert that the request operates in this organisation.
   *
   * Client-supplied values are welcome here BECAUSE they are checked: the id
   * must be the one the database says this user is an active member of, and a
   * mismatch is `AUTH_ORGANIZATION_FORBIDDEN` rather than a silent switch.
   */
  readonly organizationId?: string
}

/**
 * Run `callback` inside an organisation-scoped database identity context.
 *
 * The organisation comes from the caller's active membership — read from the
 * database, not from the request.
 */
export async function withOrganizationDatabaseContext<T>(
  callback: (context: OrganizationContext) => Promise<T>,
  options: WithOrganizationOptions = {}
): Promise<T> {
  const principal = await requirePrincipal(options)

  if (!principal.membership || !principal.organization) {
    // S3 — REQUEST_PRINCIPAL_CONTRACT.refusal_codes supersedes the single
    // generic AUTH_NO_ORGANIZATION this used to throw unconditionally: "no
    // selection" and "selected organisation refuses membership" are different
    // refusals, and M-4 exists to catch either one being silently smoothed
    // over into the other or into a fallback.
    throw new AuthContextError(
      principal.organizationRefusalCode ?? 'TENANCY_NO_ORGANIZATION_SELECTED',
      principal.organizationRefusalCode === 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'
        ? 'The selected organisation is not one this account holds an active membership in.'
        : 'No organisation is selected for this session.'
    )
  }

  if (
    options.organizationId !== undefined &&
    options.organizationId !== principal.organization.id
  ) {
    // The id is not echoed: it is the thing the caller controls, and echoing it
    // turns the error message into an oracle.
    throw new AuthContextError(
      'AUTH_ORGANIZATION_FORBIDDEN',
      'The requested organisation is not the one this session is an active member of.'
    )
  }

  const context: OrganizationContext = {
    user: principal.user,
    membership: principal.membership,
    organization: principal.organization,
  }

  return withDatabaseIdentityContext(
    {
      userId: principal.user.id,
      organizationId: principal.organization.id,
      isSuperAdmin: principal.user.isSuperAdmin,
    },
    () => callback(context),
    options
  )
}

/**
 * Run `callback` inside a context, having confirmed super-admin status.
 *
 * Unscoped rather than organisation-scoped: an administrator acts across
 * tenants, and pinning `app.organization_id` to whichever organisation they
 * happen to belong to would be misleading. The privilege is checked twice —
 * here against `public.users`, and inside db/identity-context.ts against
 * `current_user_is_super_admin()`.
 */
export async function withSuperAdminDatabaseContext<T>(
  callback: (user: AuthUser) => Promise<T>,
  options: DatabaseContextOptions = {}
): Promise<T> {
  const principal = await requirePrincipal(options)

  if (!principal.user.isSuperAdmin) {
    throw new AuthContextError('AUTH_NOT_SUPER_ADMIN', 'This account is not a super administrator.')
  }

  return withDatabaseIdentityContext(
    { userId: principal.user.id, organizationId: null, isSuperAdmin: true },
    () => callback(principal.user),
    options
  )
}

/**
 * Run `callback` with a context when there is a session, and with `null` when
 * there is not.
 *
 * For entry points that legitimately serve both — a public page that shows
 * extra controls to a signed-in user. The unauthenticated branch gets NO
 * claims: it is not given a fabricated identity, and any RLS-protected query
 * it makes will correctly return nothing.
 */
export async function withOptionalDatabaseIdentityContext<T>(
  callback: (context: OrganizationContext | null) => Promise<T>,
  options: DatabaseContextOptions = {}
): Promise<T> {
  const memoised = await loadRequestPrincipal()
  const principal = memoised ?? (await resolveRequestPrincipal(options)).principal

  if (!principal || !principal.membership || !principal.organization) {
    return callback(null)
  }

  const context: OrganizationContext = {
    user: principal.user,
    membership: principal.membership,
    organization: principal.organization,
  }

  return withDatabaseIdentityContext(
    {
      userId: principal.user.id,
      organizationId: principal.organization.id,
      isSuperAdmin: principal.user.isSuperAdmin,
    },
    () => callback(context),
    options
  )
}
