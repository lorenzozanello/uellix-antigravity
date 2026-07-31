// lib/auth/__tests__/permissions.test.ts
// WS3 (Fable Moonshot): permission helper tests — focus on canUseStella.

import { describe, it, expect } from 'vitest'
import { canUseStella, hasRole } from '../permissions'
import { ROLES, ALL_ROLES } from '../roles'

describe('canUseStella', () => {
  it('allows organization_admin', () => {
    expect(canUseStella(ROLES.ORGANIZATION_ADMIN)).toBe(true)
  })

  it('allows analyst', () => {
    expect(canUseStella(ROLES.ANALYST)).toBe(true)
  })

  it('allows roles above analyst in the hierarchy (impact_manager, super_admin)', () => {
    expect(canUseStella(ROLES.IMPACT_MANAGER)).toBe(true)
    expect(canUseStella(ROLES.SUPER_ADMIN)).toBe(true)
  })

  it('denies viewer', () => {
    expect(canUseStella(ROLES.VIEWER)).toBe(false)
  })

  it('denies reviewer (below analyst — human reviewers act through review flows, not Stella invocation)', () => {
    expect(canUseStella(ROLES.REVIEWER)).toBe(false)
  })

  it('every defined role gets a deterministic boolean', () => {
    for (const role of ALL_ROLES) {
      expect(typeof canUseStella(role)).toBe('boolean')
    }
  })
})

describe('hasRole (sanity for the hierarchy canUseStella relies on)', () => {
  it('analyst threshold splits exactly at analyst', () => {
    expect(hasRole(ROLES.ANALYST, ROLES.ANALYST)).toBe(true)
    expect(hasRole(ROLES.REVIEWER, ROLES.ANALYST)).toBe(false)
    expect(hasRole(ROLES.VIEWER, ROLES.ANALYST)).toBe(false)
  })
})
