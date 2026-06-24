/**
 * lib/auth/roles.ts
 * Single source of truth for Uellix roles.
 *
 * All roles are persisted in the database in snake_case.
 * Human-readable labels are only used in the UI layer.
 */

// ---------------------------------------------------------------------------
// Role type & constants
// ---------------------------------------------------------------------------

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ORGANIZATION_ADMIN: 'organization_admin',
  IMPACT_MANAGER: 'impact_manager',
  ANALYST: 'analyst',
  REVIEWER: 'reviewer',
  VIEWER: 'viewer',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

/** Ordered list of all valid roles (highest privilege first). */
export const ALL_ROLES: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ORGANIZATION_ADMIN,
  ROLES.IMPACT_MANAGER,
  ROLES.ANALYST,
  ROLES.REVIEWER,
  ROLES.VIEWER,
] as const

// ---------------------------------------------------------------------------
// Role hierarchy – higher number = higher privilege
// ---------------------------------------------------------------------------

export const ROLE_HIERARCHY: Record<Role, number> = {
  [ROLES.SUPER_ADMIN]: 100,
  [ROLES.ORGANIZATION_ADMIN]: 80,
  [ROLES.IMPACT_MANAGER]: 60,
  [ROLES.ANALYST]: 40,
  [ROLES.REVIEWER]: 20,
  [ROLES.VIEWER]: 10,
}

// ---------------------------------------------------------------------------
// UI labels (Spanish – matches Uellix's primary locale)
// ---------------------------------------------------------------------------

export const ROLE_LABELS: Record<Role, string> = {
  [ROLES.SUPER_ADMIN]: 'Super Administrador',
  [ROLES.ORGANIZATION_ADMIN]: 'Administrador de Organización',
  [ROLES.IMPACT_MANAGER]: 'Gestor de Impacto',
  [ROLES.ANALYST]: 'Analista',
  [ROLES.REVIEWER]: 'Revisor',
  [ROLES.VIEWER]: 'Visor',
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const roleSet = new Set<string>(ALL_ROLES)

/** Type-guard that narrows an arbitrary string to the `Role` union. */
export function isValidRole(value: string): value is Role {
  return roleSet.has(value)
}

/**
 * Normalises legacy PascalCase / mixed-case role strings to canonical
 * snake_case values.  Returns `null` when the input is not a recognised role.
 *
 * Examples:
 *   normalizeRole('SuperAdmin')        → 'super_admin'
 *   normalizeRole('OrgAdmin')          → 'organization_admin'
 *   normalizeRole('OrganizationAdmin') → 'organization_admin'
 *   normalizeRole('ImpactManager')     → 'impact_manager'
 *   normalizeRole('impact_manager')    → 'impact_manager'
 *   normalizeRole('garbage')           → null
 */
export function normalizeRole(value: string): Role | null {
  // If it's already a valid snake_case role, return directly.
  if (isValidRole(value)) return value

  // Map known legacy PascalCase strings to canonical values.
  const legacyMap: Record<string, Role> = {
    superadmin: ROLES.SUPER_ADMIN,
    orgadmin: ROLES.ORGANIZATION_ADMIN,
    organizationadmin: ROLES.ORGANIZATION_ADMIN,
    impactmanager: ROLES.IMPACT_MANAGER,
    analyst: ROLES.ANALYST,
    reviewer: ROLES.REVIEWER,
    viewer: ROLES.VIEWER,
  }

  const normalised = legacyMap[value.toLowerCase().replace(/[_\- ]/g, '')]
  return normalised ?? null
}
