export type Role = 'super_admin' | 'organization_admin' | 'impact_manager' | 'analyst' | 'reviewer' | 'viewer'

const ROLE_HIERARCHY: Record<Role, number> = {
  super_admin: 100,
  organization_admin: 80,
  impact_manager: 60,
  analyst: 40,
  reviewer: 20,
  viewer: 10,
}

export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

export function canManageUsers(userRole: Role): boolean {
  return hasRole(userRole, 'organization_admin')
}

export function canEditOrganization(userRole: Role): boolean {
  return hasRole(userRole, 'organization_admin')
}

export function canCreateProject(userRole: Role): boolean {
  return hasRole(userRole, 'impact_manager')
}

export function canUploadEvidence(userRole: Role): boolean {
  return hasRole(userRole, 'analyst')
}

export function canApproveProxy(userRole: Role): boolean {
  return hasRole(userRole, 'impact_manager')
}

export function canGenerateReport(userRole: Role): boolean {
  return hasRole(userRole, 'impact_manager')
}
