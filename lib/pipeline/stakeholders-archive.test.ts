// lib/pipeline/stakeholders-archive.test.ts
// FIBIU-03 — stakeholder groups gain a lifecycle state and an archive path.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { selectMock, fromMock, whereMock, thenMock, updateMock, setMock, updateWhereMock } = vi.hoisted(() => ({
  selectMock: vi.fn().mockReturnThis(),
  fromMock: vi.fn().mockReturnThis(),
  whereMock: vi.fn(),
  thenMock: vi.fn(),
  updateMock: vi.fn().mockReturnThis(),
  setMock: vi.fn().mockReturnThis(),
  updateWhereMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/db/client', () => ({
  db: {
    select: selectMock,
    from: fromMock,
    where: whereMock,
    update: updateMock,
    set: setMock,
  },
}))

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(),
}))

vi.mock('@/lib/audit/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit/logger')>('@/lib/audit/logger')
  return { ...actual, logAuditAction: vi.fn() }
})

vi.mock('@/lib/pipeline/domain-object-versions', () => ({
  createDomainObjectVersion: vi.fn(),
}))

import { archiveStakeholderGroup } from './stakeholders'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { logAuditAction } from '@/lib/audit/logger'
import { createDomainObjectVersion } from '@/lib/pipeline/domain-object-versions'

const CTX = {
  user: { id: 'user-1' },
  organization: { id: 'org-1' },
  membership: { role: 'analyst' },
}

const PROJECT = { id: 'proj-1', organizationId: 'org-1' }
const ACTIVE_GROUP = { id: 'sg-1', projectId: 'proj-1', status: 'active' }

describe('archiveStakeholderGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue(CTX as never)

    whereMock.mockImplementation(() => ({ then: thenMock, limit: vi.fn().mockReturnThis() }))
    let thenCall = 0
    thenMock.mockImplementation((cb: (rows: unknown[]) => unknown) => {
      thenCall += 1
      if (thenCall === 1) return Promise.resolve(cb([PROJECT]))
      if (thenCall === 2) return Promise.resolve(cb([ACTIVE_GROUP]))
      return Promise.resolve(cb([{ ...ACTIVE_GROUP, status: 'archived' }]))
    })
    updateWhereMock.mockResolvedValue(undefined)
    setMock.mockReturnValue({ where: updateWhereMock })
    updateMock.mockReturnValue({ set: setMock })
  })

  it('sets status to archived and records who/when', async () => {
    const result = await archiveStakeholderGroup('proj-1', 'sg-1')
    expect(result?.status).toBe('archived')
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'archived', archivedBy: 'user-1' })
    )
  })

  it('writes a governed audit event for the archive transition', async () => {
    await archiveStakeholderGroup('proj-1', 'sg-1')
    expect(logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'stakeholder_group', action: 'stakeholder_group.archived' })
    )
  })

  it('W1-05-RM1 R-6: appends a governed domain-object version alongside the archive', async () => {
    await archiveStakeholderGroup('proj-1', 'sg-1')
    expect(createDomainObjectVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        objectType: 'stakeholder_group',
        objectId: 'sg-1',
        actorId: 'user-1',
        payload: expect.objectContaining({ status: 'archived' }),
      })
    )
  })

  it('rejects archiving below analyst', async () => {
    vi.mocked(getCurrentOrganizationContext).mockResolvedValue({
      ...CTX,
      membership: { role: 'viewer' },
    } as never)
    await expect(archiveStakeholderGroup('proj-1', 'sg-1')).rejects.toThrow('Insufficient permissions')
  })
})
