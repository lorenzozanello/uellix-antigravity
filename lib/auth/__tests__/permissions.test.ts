// lib/auth/__tests__/permissions.test.ts
// WS3 (Fable Moonshot): permission helper tests — focus on canUseStella.
// FIBIU-29 (FIBC-041): the six discrete governed permissions, plus the
// canonical review-set membership check they and canApproveRunMethodology
// are built on.

import { describe, it, expect } from 'vitest'
import {
  canUseStella,
  hasRole,
  isInReviewSet,
  canDetermineEvidenceSufficiency,
  canClassifyEvidenceSensitivity,
  canEraseEvidenceContent,
  canDisposeHighRiskFinding,
  canPublishReportDisclosure,
  canApproveRunMethodology,
} from '../permissions'
import { ROLES, ALL_ROLES, type Role } from '../roles'

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

const NOT_IN_REVIEW_SET: readonly Role[] = [ROLES.ANALYST, ROLES.VIEWER]
const IN_REVIEW_SET: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ORGANIZATION_ADMIN,
  ROLES.IMPACT_MANAGER,
  ROLES.REVIEWER,
]

describe('isInReviewSet', () => {
  it('allows every review-set role', () => {
    for (const role of IN_REVIEW_SET) expect(isInReviewSet(role)).toBe(true)
  })

  it('denies analyst and viewer — SET INCLUSION, not hierarchy', () => {
    // analyst outranks reviewer in ROLE_HIERARCHY (40 > 20) yet is excluded —
    // a hierarchy threshold would wrongly admit it.
    for (const role of NOT_IN_REVIEW_SET) expect(isInReviewSet(role)).toBe(false)
  })
})

describe('canDetermineEvidenceSufficiency — positive/negative per role', () => {
  it('allows impact_manager and above', () => {
    expect(canDetermineEvidenceSufficiency(ROLES.SUPER_ADMIN)).toBe(true)
    expect(canDetermineEvidenceSufficiency(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canDetermineEvidenceSufficiency(ROLES.IMPACT_MANAGER)).toBe(true)
  })
  it('denies below impact_manager, including reviewer', () => {
    expect(canDetermineEvidenceSufficiency(ROLES.ANALYST)).toBe(false)
    expect(canDetermineEvidenceSufficiency(ROLES.REVIEWER)).toBe(false)
    expect(canDetermineEvidenceSufficiency(ROLES.VIEWER)).toBe(false)
  })
})

describe('canClassifyEvidenceSensitivity — positive/negative per role', () => {
  it('allows impact_manager and above', () => {
    expect(canClassifyEvidenceSensitivity(ROLES.ORGANIZATION_ADMIN)).toBe(true)
    expect(canClassifyEvidenceSensitivity(ROLES.IMPACT_MANAGER)).toBe(true)
  })
  it('denies below impact_manager', () => {
    expect(canClassifyEvidenceSensitivity(ROLES.ANALYST)).toBe(false)
    expect(canClassifyEvidenceSensitivity(ROLES.VIEWER)).toBe(false)
  })
})

describe('canEraseEvidenceContent — positive/negative per role', () => {
  it('allows organization_admin and above only', () => {
    expect(canEraseEvidenceContent(ROLES.SUPER_ADMIN)).toBe(true)
    expect(canEraseEvidenceContent(ROLES.ORGANIZATION_ADMIN)).toBe(true)
  })
  it('denies impact_manager — deliberately above edit-level (NPDD-07)', () => {
    // The highest-consequence permission of the six: placed one level above
    // canClassifyEvidenceSensitivity's threshold on purpose.
    expect(canEraseEvidenceContent(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canEraseEvidenceContent(ROLES.ANALYST)).toBe(false)
    expect(canEraseEvidenceContent(ROLES.VIEWER)).toBe(false)
  })
})

describe('canDisposeHighRiskFinding — positive/negative per role', () => {
  it('allows every review-set role', () => {
    for (const role of IN_REVIEW_SET) expect(canDisposeHighRiskFinding(role)).toBe(true)
  })
  it('denies analyst and viewer', () => {
    for (const role of NOT_IN_REVIEW_SET) expect(canDisposeHighRiskFinding(role)).toBe(false)
  })
})

describe('canPublishReportDisclosure — positive/negative per role', () => {
  it('allows organization_admin and above only', () => {
    expect(canPublishReportDisclosure(ROLES.SUPER_ADMIN)).toBe(true)
    expect(canPublishReportDisclosure(ROLES.ORGANIZATION_ADMIN)).toBe(true)
  })
  it('denies impact_manager and below — an irreversible, externally visible act', () => {
    expect(canPublishReportDisclosure(ROLES.IMPACT_MANAGER)).toBe(false)
    expect(canPublishReportDisclosure(ROLES.REVIEWER)).toBe(false)
  })
})

describe('canApproveRunMethodology — review set minus the run author', () => {
  it('allows a review-set role that is not the run author', () => {
    for (const role of IN_REVIEW_SET) {
      expect(canApproveRunMethodology(role, false)).toBe(true)
    }
  })

  it('denies every role when it is the run author — even super_admin', () => {
    // "minus the run author" is unconditional: no role bypasses it.
    for (const role of IN_REVIEW_SET) {
      expect(canApproveRunMethodology(role, true)).toBe(false)
    }
  })

  it('denies a non-review-set role regardless of authorship', () => {
    expect(canApproveRunMethodology(ROLES.ANALYST, false)).toBe(false)
    expect(canApproveRunMethodology(ROLES.ANALYST, true)).toBe(false)
  })

  it('unauthorized action fails closed: an analyst who happens to be the author is still denied for the right-shaped reason', () => {
    // Two independent reasons to deny (not in review set, AND is the
    // author) — the function must not accidentally let one excuse the other.
    expect(canApproveRunMethodology(ROLES.ANALYST, true)).toBe(false)
  })
})
