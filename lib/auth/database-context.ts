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
}

export type AuthContextErrorCode =
  | 'AUTH_NO_SESSION'
  | 'AUTH_SESSION_REJECTED'
  | 'AUTH_MALFORMED_SUBJECT'
  | 'AUTH_UNAVAILABLE'
  | 'AUTH_NO_PROFILE'
  | 'AUTH_USER_DEACTIVATED'
  | 'AUTH_NO_ORGANIZATION'
  | 'AUTH_ORGANIZATION_FORBIDDEN'
  | 'AUTH_NOT_SUPER_ADMIN'

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

/** The caller's single active membership, if any. Context required. */
export async function loadActiveMembershipWithinContext(
  userId: string
): Promise<Membership | null> {
  const row = await db
    .select()
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active'))
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

  const membership = await loadActiveMembershipWithinContext(userId)
  const organization = membership
    ? await loadOrganizationWithinContext(membership.organizationId)
    : null

  // `membership` and `organization` are reported INDEPENDENTLY. A membership
  // whose organisation row is unreadable is a real membership — it is just not
  // usable as an organisation context, and it is the wrappers below (and
  // `requireOrganizationAccess`) that insist on both. Collapsing the two here
  // would silently change what `getCurrentMembership()` answers.
  return { user, membership, organization }
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
    throw new AuthContextError(
      'AUTH_NO_ORGANIZATION',
      'This account has no active organisation membership.'
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
