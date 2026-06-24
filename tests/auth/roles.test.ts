import { describe, it, expect } from 'vitest'
import {
  ROLES,
  ALL_ROLES,
  ROLE_HIERARCHY,
  ROLE_LABELS,
  isValidRole,
  normalizeRole,
  type Role,
} from '@/lib/auth/roles'

describe('ROLES constants', () => {
  it('all roles are snake_case', () => {
    const snakeCaseRegex = /^[a-z]+(_[a-z]+)*$/
    for (const role of Object.values(ROLES)) {
      expect(role).toMatch(snakeCaseRegex)
    }
  })

  it('ALL_ROLES contains exactly 6 roles', () => {
    expect(ALL_ROLES).toHaveLength(6)
  })

  it('ALL_ROLES matches ROLES values', () => {
    const roleValues = Object.values(ROLES)
    for (const role of ALL_ROLES) {
      expect(roleValues).toContain(role)
    }
  })

  it('ROLE_HIERARCHY has entries for every role', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_HIERARCHY[role]).toBeDefined()
      expect(typeof ROLE_HIERARCHY[role]).toBe('number')
    }
  })

  it('super_admin has highest hierarchy value', () => {
    const superAdminLevel = ROLE_HIERARCHY[ROLES.SUPER_ADMIN]
    for (const role of ALL_ROLES) {
      if (role !== ROLES.SUPER_ADMIN) {
        expect(superAdminLevel).toBeGreaterThan(ROLE_HIERARCHY[role])
      }
    }
  })

  it('viewer has lowest hierarchy value', () => {
    const viewerLevel = ROLE_HIERARCHY[ROLES.VIEWER]
    for (const role of ALL_ROLES) {
      if (role !== ROLES.VIEWER) {
        expect(viewerLevel).toBeLessThan(ROLE_HIERARCHY[role])
      }
    }
  })

  it('ROLE_LABELS has Spanish labels for every role', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_LABELS[role]).toBeDefined()
      expect(typeof ROLE_LABELS[role]).toBe('string')
      expect(ROLE_LABELS[role].length).toBeGreaterThan(0)
    }
  })
})

describe('isValidRole()', () => {
  it('returns true for all snake_case valid roles', () => {
    for (const role of ALL_ROLES) {
      expect(isValidRole(role)).toBe(true)
    }
  })

  it('returns false for PascalCase legacy strings', () => {
    expect(isValidRole('SuperAdmin')).toBe(false)
    expect(isValidRole('OrgAdmin')).toBe(false)
    expect(isValidRole('ImpactManager')).toBe(false)
    expect(isValidRole('Analyst')).toBe(false)
  })

  it('returns false for empty and garbage strings', () => {
    expect(isValidRole('')).toBe(false)
    expect(isValidRole('admin')).toBe(false)
    expect(isValidRole('root')).toBe(false)
    expect(isValidRole('SUPER_ADMIN')).toBe(false)
  })

  it('acts as a type guard narrowing to Role', () => {
    const value: string = 'organization_admin'
    if (isValidRole(value)) {
      // TypeScript should narrow this to Role
      const role: Role = value
      expect(role).toBe('organization_admin')
    }
  })
})

describe('normalizeRole()', () => {
  it('returns the same value for already-valid snake_case roles', () => {
    for (const role of ALL_ROLES) {
      expect(normalizeRole(role)).toBe(role)
    }
  })

  it('normalizes legacy PascalCase strings', () => {
    expect(normalizeRole('SuperAdmin')).toBe('super_admin')
    expect(normalizeRole('OrgAdmin')).toBe('organization_admin')
    expect(normalizeRole('OrganizationAdmin')).toBe('organization_admin')
    expect(normalizeRole('ImpactManager')).toBe('impact_manager')
  })

  it('normalizes case-insensitive legacy strings', () => {
    expect(normalizeRole('superadmin')).toBe('super_admin')
    expect(normalizeRole('ORGADMIN')).toBe('organization_admin')
  })

  it('returns null for unrecognized strings', () => {
    expect(normalizeRole('garbage')).toBeNull()
    expect(normalizeRole('')).toBeNull()
    expect(normalizeRole('root')).toBeNull()
    expect(normalizeRole('admin')).toBeNull()
  })
})
