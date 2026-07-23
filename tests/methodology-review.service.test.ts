// tests/methodology-review.service.test.ts
// Authorization guard for the Fase 2 methodology review matrix service.
// The pure scoring/template logic is unit-tested in
// lib/pipeline/methodology-review.test.ts; this pins the security boundary.
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}))

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    // authorizeProject's project lookup resolves to a matching project so the
    // role check (not the ownership check) is what rejects.
    where: vi.fn().mockResolvedValue([{ id: 'proj-1', organizationId: 'org-1' }]),
  },
}))

vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {},
}))

import {
  upsertMethodologyReviewItem,
  startMethodologyReview,
} from '@/lib/pipeline/methodology-review'
import { requireOrganizationAccess } from '@/lib/auth/session'
import type { OrganizationContext } from '@/lib/auth/session'
import type { Role } from '@/lib/auth/roles'

function ctxWithRole(role: Role): OrganizationContext {
  return {
    user: { id: 'user-1', email: 't@e.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
    organization: { id: 'org-1', name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' },
    membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role, status: 'active' },
  }
}

describe('methodology review — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an item upsert from a non-reviewing role (viewer)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctxWithRole('viewer'))

    await expect(
      upsertMethodologyReviewItem('proj-1', 'evidence', {
        itemKey: 'evidence_sources_verified',
        label: 'Fuentes verificadas',
        status: 'pass',
        severity: 'high',
      })
    ).rejects.toThrow('Permission denied')
  })

  it('rejects starting a review from a non-reviewing role (analyst)', async () => {
    vi.mocked(requireOrganizationAccess).mockResolvedValue(ctxWithRole('analyst'))

    await expect(startMethodologyReview('proj-1', 'outcomes')).rejects.toThrow('Permission denied')
  })
})
