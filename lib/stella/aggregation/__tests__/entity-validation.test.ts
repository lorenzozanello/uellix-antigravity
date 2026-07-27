// lib/stella/aggregation/__tests__/entity-validation.test.ts
// Etapa A2.3.1 (STL-A231-017) — no real DB. Each entity type gets its own
// query path; this proves each one checks existence + organization/project
// scope independently, and that a mismatch is never silently treated as valid.

import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const mockSelect = vi.fn()
vi.mock('@/db/client', () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}))

import { validateEntityScope } from '../entity-validation'

describe('validateEntityScope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("entityType: 'project'", () => {
    it('is valid when entityId equals projectId and organization matches', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'proj-1', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'project', entityId: 'proj-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects when entityId differs from projectId', async () => {
      const result = await validateEntityScope({ entityType: 'project', entityId: 'other-proj', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'project_mismatch' })
    })

    it('rejects a cross-org project', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'proj-1', organizationId: 'org-2' }]))
      const result = await validateEntityScope({ entityType: 'project', entityId: 'proj-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'organization_mismatch' })
    })

    it('rejects a non-existent project', async () => {
      mockSelect.mockReturnValueOnce(makeChain([]))
      const result = await validateEntityScope({ entityType: 'project', entityId: 'proj-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'not_found' })
    })
  })

  describe("entityType: 'outcome'", () => {
    it('is valid when the outcome belongs to the given project/organization', async () => {
      mockSelect
        .mockReturnValueOnce(makeChain([{ id: 'o-1', projectId: 'proj-1' }]))
        .mockReturnValueOnce(makeChain([{ id: 'proj-1', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'outcome', entityId: 'o-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects an outcome from a different project', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'o-1', projectId: 'proj-OTHER' }]))
      const result = await validateEntityScope({ entityType: 'outcome', entityId: 'o-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'project_mismatch' })
    })

    it('rejects a non-existent outcome', async () => {
      mockSelect.mockReturnValueOnce(makeChain([]))
      const result = await validateEntityScope({ entityType: 'outcome', entityId: 'missing', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'not_found' })
    })

    it('rejects when the project itself belongs to a different organization', async () => {
      mockSelect
        .mockReturnValueOnce(makeChain([{ id: 'o-1', projectId: 'proj-1' }]))
        .mockReturnValueOnce(makeChain([{ id: 'proj-1', organizationId: 'org-OTHER' }]))
      const result = await validateEntityScope({ entityType: 'outcome', entityId: 'o-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'organization_mismatch' })
    })
  })

  describe("entityType: 'indicator'", () => {
    it('is valid when scoped correctly', async () => {
      mockSelect
        .mockReturnValueOnce(makeChain([{ id: 'i-1', projectId: 'proj-1' }]))
        .mockReturnValueOnce(makeChain([{ id: 'proj-1', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'indicator', entityId: 'i-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects a non-existent indicator', async () => {
      mockSelect.mockReturnValueOnce(makeChain([]))
      const result = await validateEntityScope({ entityType: 'indicator', entityId: 'missing', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'not_found' })
    })
  })

  describe("entityType: 'stakeholder_group'", () => {
    it('is valid when scoped correctly', async () => {
      mockSelect
        .mockReturnValueOnce(makeChain([{ id: 'sg-1', projectId: 'proj-1' }]))
        .mockReturnValueOnce(makeChain([{ id: 'proj-1', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'stakeholder_group', entityId: 'sg-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: true })
    })
  })

  describe("entityType: 'evidence'", () => {
    it('is valid when the evidence item matches both organization and project', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'ev-1', projectId: 'proj-1', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'evidence', entityId: 'ev-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects cross-org evidence even if the project id happens to match', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'ev-1', projectId: 'proj-1', organizationId: 'org-OTHER' }]))
      const result = await validateEntityScope({ entityType: 'evidence', entityId: 'ev-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'organization_mismatch' })
    })
  })

  describe("entityType: 'report_section'", () => {
    it('is valid when the section matches both organization and project', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'sec-1', projectId: 'proj-1', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'report_section', entityId: 'sec-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects a section from a different project', async () => {
      mockSelect.mockReturnValueOnce(makeChain([{ id: 'sec-1', projectId: 'proj-OTHER', organizationId: 'org-1' }]))
      const result = await validateEntityScope({ entityType: 'report_section', entityId: 'sec-1', organizationId: 'org-1', projectId: 'proj-1' })
      expect(result).toEqual({ valid: false, reason: 'project_mismatch' })
    })
  })
})
