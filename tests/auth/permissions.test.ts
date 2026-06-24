import { describe, it, expect } from 'vitest'
import { ROLES, ALL_ROLES, type Role } from '@/lib/auth/roles'
import {
  hasRole,
  canManageUsers,
  canEditOrganization,
  canInviteUsers,
  canChangeRoles,
  canCreateProject,
  canUploadEvidence,
  canApproveProxy,
  canGenerateReport,
  canAccessAdmin,
  canViewAuditLogs,
  canViewOrganization,
  canCreateOrganization,
} from '@/lib/auth/permissions'

describe('hasRole() — hierarchy comparison', () => {
  it('super_admin passes every role check', () => {
    for (const role of ALL_ROLES) {
      expect(hasRole(ROLES.SUPER_ADMIN, role)).toBe(true)
    }
  })

  it('viewer only passes viewer check', () => {
    expect(hasRole(ROLES.VIEWER, ROLES.VIEWER)).toBe(true)
    expect(hasRole(ROLES.VIEWER, ROLES.REVIEWER)).toBe(false)
    expect(hasRole(ROLES.VIEWER, ROLES.ANALYST)).toBe(false)
    expect(hasRole(ROLES.VIEWER, ROLES.IMPACT_MANAGER)).toBe(false)
    expect(hasRole(ROLES.VIEWER, ROLES.ORGANIZATION_ADMIN)).toBe(false)
    expect(hasRole(ROLES.VIEWER, ROLES.SUPER_ADMIN)).toBe(false)
  })

  it('impact_manager passes impact_manager, analyst, reviewer, viewer', () => {
    expect(hasRole(ROLES.IMPACT_MANAGER, ROLES.IMPACT_MANAGER)).toBe(true)
    expect(hasRole(ROLES.IMPACT_MANAGER, ROLES.ANALYST)).toBe(true)
    expect(hasRole(ROLES.IMPACT_MANAGER, ROLES.REVIEWER)).toBe(true)
    expect(hasRole(ROLES.IMPACT_MANAGER, ROLES.VIEWER)).toBe(true)
    expect(hasRole(ROLES.IMPACT_MANAGER, ROLES.ORGANIZATION_ADMIN)).toBe(false)
    expect(hasRole(ROLES.IMPACT_MANAGER, ROLES.SUPER_ADMIN)).toBe(false)
  })
})

describe('canManageUsers()', () => {
  it('allows organization_admin and super_admin', () => {
    expect(canManageUsers(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canManageUsers(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies lower roles', () => {
    expect(canManageUsers(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canManageUsers(ROLES.ANALYST)).toBe(false)
    expect(canManageUsers(ROLES.REVIEWER)).toBe(false)
    expect(canManageUsers(ROLES.VIEWER)).toBe(false)
  })
})

describe('canEditOrganization()', () => {
  it('allows organization_admin and super_admin', () => {
    expect(canEditOrganization(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canEditOrganization(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies lower roles', () => {
    expect(canEditOrganization(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canEditOrganization(ROLES.VIEWER)).toBe(false)
  })
})

describe('canInviteUsers()', () => {
  it('allows organization_admin and above', () => {
    expect(canInviteUsers(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canInviteUsers(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies impact_manager and below', () => {
    expect(canInviteUsers(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canInviteUsers(ROLES.ANALYST)).toBe(false)
    expect(canInviteUsers(ROLES.VIEWER)).toBe(false)
  })
})

describe('canChangeRoles()', () => {
  it('allows organization_admin and above', () => {
    expect(canChangeRoles(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canChangeRoles(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies impact_manager and below', () => {
    expect(canChangeRoles(ROLES.IMPACT_MANAGER)).toBe(false)
  })
})

describe('canCreateProject()', () => {
  it('allows impact_manager and above', () => {
    expect(canCreateProject(ROLES.IMPACT_MANAGER)).toBe(true)
    expect(canCreateProject(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canCreateProject(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies analyst and below', () => {
    expect(canCreateProject(ROLES.ANALYST)).toBe(false)
    expect(canCreateProject(ROLES.REVIEWER)).toBe(false)
    expect(canCreateProject(ROLES.VIEWER)).toBe(false)
  })
})

describe('canUploadEvidence()', () => {
  it('allows analyst and above', () => {
    expect(canUploadEvidence(ROLES.ANALYST)).toBe(true)
    expect(canUploadEvidence(ROLES.IMPACT_MANAGER)).toBe(true)
    expect(canUploadEvidence(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies reviewer and below', () => {
    expect(canUploadEvidence(ROLES.REVIEWER)).toBe(false)
    expect(canUploadEvidence(ROLES.VIEWER)).toBe(false)
  })
})

describe('canApproveProxy()', () => {
  it('allows impact_manager and above', () => {
    expect(canApproveProxy(ROLES.IMPACT_MANAGER)).toBe(true)
    expect(canApproveProxy(ROLES.ORGANIZATION_ADMIN)).toBe(true)
  })

  it('denies analyst and below', () => {
    expect(canApproveProxy(ROLES.ANALYST)).toBe(false)
    expect(canApproveProxy(ROLES.VIEWER)).toBe(false)
  })
})

describe('canGenerateReport()', () => {
  it('allows impact_manager and above', () => {
    expect(canGenerateReport(ROLES.IMPACT_MANAGER)).toBe(true)
    expect(canGenerateReport(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies analyst and below', () => {
    expect(canGenerateReport(ROLES.ANALYST)).toBe(false)
  })
})

describe('canAccessAdmin()', () => {
  it('allows only super_admin', () => {
    expect(canAccessAdmin(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies all other roles including organization_admin', () => {
    expect(canAccessAdmin(ROLES.ORGANIZATION_ADMIN)).toBe(false)
    expect(canAccessAdmin(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canAccessAdmin(ROLES.ANALYST)).toBe(false)
    expect(canAccessAdmin(ROLES.REVIEWER)).toBe(false)
    expect(canAccessAdmin(ROLES.VIEWER)).toBe(false)
  })
})

describe('canViewAuditLogs()', () => {
  it('allows reviewer and above', () => {
    expect(canViewAuditLogs(ROLES.REVIEWER)).toBe(true)
    expect(canViewAuditLogs(ROLES.ANALYST)).toBe(true)
    expect(canViewAuditLogs(ROLES.IMPACT_MANAGER)).toBe(true)
    expect(canViewAuditLogs(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canViewAuditLogs(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies viewer', () => {
    expect(canViewAuditLogs(ROLES.VIEWER)).toBe(false)
  })
})

describe('canViewOrganization()', () => {
  it('allows all roles including viewer', () => {
    for (const role of ALL_ROLES) {
      expect(canViewOrganization(role)).toBe(true)
    }
  })
})

describe('canCreateOrganization()', () => {
  it('allows only super_admin', () => {
    expect(canCreateOrganization(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies all other roles', () => {
    expect(canCreateOrganization(ROLES.ORGANIZATION_ADMIN)).toBe(false)
    expect(canCreateOrganization(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canCreateOrganization(ROLES.VIEWER)).toBe(false)
  })
})

describe('No inconsistent role strings exported', () => {
  it('canAccessAdmin uses exact super_admin string', () => {
    // Ensure the function uses ROLES.SUPER_ADMIN, not a hardcoded string that might drift
    const superAdminRole: Role = 'super_admin'
    expect(canAccessAdmin(superAdminRole)).toBe(true)
    expect(canAccessAdmin('organization_admin' as Role)).toBe(false)
  })
})
