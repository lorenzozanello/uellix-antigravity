/**
 * lib/auth/permissions.ts
 * Permission helpers for Uellix.
 *
 * Every permission check is a pure function that receives a `Role` and
 * returns a boolean.  These are designed to be called from server-side
 * code (Server Components, Server Actions, Route Handlers).
 *
 * The helpers intentionally do NOT fetch data from the database.
 * Fetching the user's role is the responsibility of the session helpers
 * in `lib/auth/session.ts`.
 */

import { type Role, ROLE_HIERARCHY } from './roles'

// Re-export for convenience
export type { Role } from './roles'

// ---------------------------------------------------------------------------
// Core hierarchy comparison
// ---------------------------------------------------------------------------

/** Returns `true` when `userRole` is at least as privileged as `requiredRole`. */
export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

// ---------------------------------------------------------------------------
// Organisation-level permissions
// ---------------------------------------------------------------------------

/** Can the user manage (invite, remove, change role) other members? */
export function canManageUsers(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

/** Can the user edit organisation settings (name, legal info, etc.)? */
export function canEditOrganization(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

/** Can the user administer the organisation (full admin control)? */
export function canManageOrganization(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

/** Can the user invite new users to the organisation? */
export function canInviteUsers(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

/** Can the user change another member's role? */
export function canChangeRoles(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

// ---------------------------------------------------------------------------
// Project-level permissions
// ---------------------------------------------------------------------------

/** Can the user create a new project? */
export function canCreateProject(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

/** Can the user upload evidence to a project? */
export function canUploadEvidence(role: Role): boolean {
  return hasRole(role, 'analyst')
}

/** Can the user approve a financial proxy? */
export function canApproveProxy(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

/** Can the user generate an impact report? */
export function canGenerateReport(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

// ---------------------------------------------------------------------------
// Admin-level permissions
// ---------------------------------------------------------------------------

/** Can the user access the `/admin` panel? Requires super_admin. */
export function canAccessAdmin(role: Role): boolean {
  return role === 'super_admin'
}

// ---------------------------------------------------------------------------
// Audit & visibility permissions
// ---------------------------------------------------------------------------

/** Can the user view audit logs for the organisation? */
export function canViewAuditLogs(role: Role): boolean {
  // SuperAdmin, OrgAdmin and ImpactManager have full audit access.
  // Analyst and Reviewer have limited access (handled at query level).
  // Viewer has no access.
  return hasRole(role, 'reviewer')
}

/** Can the user view the organisation's data? (any member can) */
export function canViewOrganization(role: Role): boolean {
  return hasRole(role, 'viewer')
}

/** Can the user create an organisation? (SuperAdmin only, or during onboarding) */
export function canCreateOrganization(role: Role): boolean {
  return role === 'super_admin'
}
