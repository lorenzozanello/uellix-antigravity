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

  it('allows reviewer — SET INCLUSION, not hierarchy (methodology-review convention)', () => {
    // reviewer ranks below analyst in ROLE_HIERARCHY yet is the dedicated
    // reviewing role (see lib/pipeline/methodology-review.ts REVIEW_ROLES);
    // a hierarchy threshold would wrongly lock it out.
    expect(canUseStella(ROLES.REVIEWER)).toBe(true)
  })

  it('denies viewer — the only role excluded', () => {
    expect(canUseStella(ROLES.VIEWER)).toBe(false)
  })

  it('every defined role gets a deterministic boolean', () => {
    for (const role of ALL_ROLES) {
      expect(typeof canUseStella(role)).toBe('boolean')
    }
  })

  it('is NOT reducible to the analyst hierarchy threshold (reviewer proves set inclusion)', () => {
    // Pin the reason the set exists: hasRole(reviewer, analyst) is false but
    // canUseStella(reviewer) is true. This test fails if someone "simplifies"
    // canUseStella back to hasRole(role, 'analyst').
    expect(hasRole(ROLES.REVIEWER, ROLES.ANALYST)).toBe(false)
    expect(canUseStella(ROLES.REVIEWER)).toBe(true)
  })
})
