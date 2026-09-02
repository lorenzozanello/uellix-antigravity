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

/**
 * Can the user rate a financial proxy's defendibility rubric (FIBIU-09,
 * FIBC-011)? Distinct from `canApproveProxy` — rating the thirteen factors
 * is the governed HUMAN step that precedes and feeds approval, not the
 * approval decision itself, mirroring FIBIU-29's one-permission-per-
 * governed-action pattern (canClassifyEvidenceSensitivity vs
 * canDetermineEvidenceSufficiency).
 */
export function canEvaluateProxyRubric(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

/** Can the user generate an impact report? */
export function canGenerateReport(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

// ---------------------------------------------------------------------------
// Stella (AI advisor) permissions
// ---------------------------------------------------------------------------

// Roles allowed to invoke Stella. SET INCLUSION, not a hierarchy threshold —
// following the methodology-review convention (lib/pipeline/
// methodology-review.ts REVIEW_ROLES): 'reviewer' ranks below 'analyst' in
// ROLE_HIERARCHY yet is the dedicated reviewing role, so it is explicitly
// included here (the Stella reviewer/validator panels are review tooling).
// Only 'viewer' is denied — read-only members never trigger AI calls, which
// consume org quota and rate limit.
const STELLA_ROLES: readonly Role[] = [
  'super_admin',
  'organization_admin',
  'impact_manager',
  'analyst',
  'reviewer',
]

/** Can the user invoke Stella (advisor/validator/composer/reviewer roles)? */
export function canUseStella(role: Role): boolean {
  return STELLA_ROLES.includes(role)
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

// ---------------------------------------------------------------------------
// Review-set permissions (FIBIU-29 / FIBC-041)
// ---------------------------------------------------------------------------

// SET INCLUSION, not a hierarchy threshold — 'reviewer' ranks below 'analyst'
// in ROLE_HIERARCHY yet is the dedicated reviewing role, so it must be
// checked by explicit membership (same reasoning as STELLA_ROLES above).
// This is the SINGLE canonical definition of "the review set": every
// service that used to declare its own `['super_admin', 'organization_admin',
// 'impact_manager', 'reviewer']` array (lib/pipeline/methodology-review.ts,
// lib/pipeline/sroi-results.ts) now derives from this one.
const REVIEW_ROLES: readonly Role[] = [
  'super_admin',
  'organization_admin',
  'impact_manager',
  'reviewer',
]

/** Whether a role may act as a methodology/run reviewer — the "review set". */
export function isInReviewSet(role: Role): boolean {
  return REVIEW_ROLES.includes(role)
}

// ---------------------------------------------------------------------------
// FIBIU-29 (FIBC-041) — six discrete governed permissions. Server-authoritative
// only: every caller must be a server-side check (Server Action, Server
// Component, Route Handler) — never enforced client-side.
// ---------------------------------------------------------------------------

/**
 * Determine whether evidence is sufficient to support a monetized outcome
 * (FIBIU-06). Distinct from merely reviewing an individual evidence item's
 * status — this is the per-outcome sufficiency determination.
 */
export function canDetermineEvidenceSufficiency(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

/** Classify an evidence item's sensitivity and, where applicable, its treatment/access determination (FIBIU-05). */
export function canClassifyEvidenceSensitivity(role: Role): boolean {
  return hasRole(role, 'impact_manager')
}

/**
 * Governed, exceptional, irreversible erasure of evidence content (FIBIU-07).
 * Deliberately placed at `organization_admin`+ rather than edit-level —
 * NPDD-07 assigns retention and data-subject-rights decisions to the
 * organisation's own data governance, not to whoever can edit evidence.
 */
export function canEraseEvidenceContent(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

/** Dispose of (act on) a high-risk finding raised during methodological review. */
export function canDisposeHighRiskFinding(role: Role): boolean {
  return isInReviewSet(role)
}

/** Publish a report disclosure to a public-facing surface. `organization_admin`+ — an irreversible, externally visible act. */
export function canPublishReportDisclosure(role: Role): boolean {
  return hasRole(role, 'organization_admin')
}

/**
 * Approve a calculation run's methodology review. The review set, MINUS the
 * run's own author — a reviewer can never approve their own run.
 * `isRunAuthor` must come from a server-authoritative comparison (the run
 * row's `calculated_by` against the acting user's id), never from a
 * client-supplied flag.
 */
export function canApproveRunMethodology(role: Role, isRunAuthor: boolean): boolean {
  return isInReviewSet(role) && !isRunAuthor
}
