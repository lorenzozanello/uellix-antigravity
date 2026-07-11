// lib/taxonomies/service.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}))
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ id: 'proj-1', organizationId: 'org-1' }]),
  },
}))
vi.mock('@/lib/audit/logger', () => ({ logAuditAction: vi.fn(), AUDIT_ACTIONS: {} }))

import { groupMappingsByCatalog, createOutcomeMapping, type OutcomeMappingView } from './service'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

describe('groupMappingsByCatalog', () => {
  it('groups mappings by catalog, preserving first-seen order', () => {
    const rows: OutcomeMappingView[] = [
      { id: '1', outcomeId: 'o1', catalogCode: 'ODS', catalogName: 'ODS', code: 'ODS-4', label: 'Educación', mappingConfidence: 'high', rationale: null },
      { id: '2', outcomeId: 'o1', catalogCode: 'IRIS+', catalogName: 'IRIS+', code: 'IRIS-EDUCATION', label: 'Educación', mappingConfidence: 'medium', rationale: null },
      { id: '3', outcomeId: 'o1', catalogCode: 'ODS', catalogName: 'ODS', code: 'ODS-8', label: 'Trabajo decente', mappingConfidence: 'low', rationale: null },
    ]
    const grouped = groupMappingsByCatalog(rows)
    expect(grouped.map((g) => g.catalogCode)).toEqual(['ODS', 'IRIS+'])
    expect(grouped[0].items.map((i) => i.code)).toEqual(['ODS-4', 'ODS-8'])
    expect(grouped[1].items.map((i) => i.code)).toEqual(['IRIS-EDUCATION'])
  })

  it('returns an empty array for no mappings', () => {
    expect(groupMappingsByCatalog([])).toEqual([])
  })
})

describe('outcome mapping — authorization', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects mapping creation from a role without outcome-edit permission (viewer)', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      user: { id: 'u1', email: 't@e.com', fullName: null, avatarUrl: null, isSuperAdmin: false },
      organization: { id: 'org-1', name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' },
      membership: { id: 'm1', organizationId: 'org-1', userId: 'u1', role: 'viewer', status: 'active' },
    } as never)

    await expect(
      createOutcomeMapping('proj-1', {
        outcomeId: 'o1',
        taxonomyCodeId: 'c1',
        mappingConfidence: 'medium',
      })
    ).rejects.toThrow('Permission denied')
  })
})
