// app/actions/stella/__tests__/pilot-confirmation.test.ts
// Etapa B0 (modo piloto restringido) — no real DB, no real auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrganizationContext } from '@/lib/auth/session'

const mockRequireOrganizationAccess = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: (...args: unknown[]) => mockRequireOrganizationAccess(...args),
}))

const mockGetStatus = vi.fn()
const mockRecordEvent = vi.fn()
vi.mock('@/lib/stella/pilot/confirmation-service', () => ({
  getStellaPilotConfirmationStatus: (...args: unknown[]) => mockGetStatus(...args),
  recordPilotConfirmationEvent: (...args: unknown[]) => mockRecordEvent(...args),
}))

const mockGetStellaPilotConfig = vi.fn().mockReturnValue({ noticeVersion: 'v1' })
vi.mock('@/lib/stella/pilot/config', () => ({
  getStellaPilotConfig: (...args: unknown[]) => mockGetStellaPilotConfig(...args),
}))

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...original, logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args) }
})

import {
  getStellaPilotConfirmationStatusAction,
  acceptStellaPilotConfirmation,
  revokeStellaPilotConfirmation,
} from '../pilot-confirmation'

function makeCtx(role = 'organization_admin'): OrganizationContext {
  return {
    user: { id: 'user-1', email: 't@example.com', fullName: 'T', avatarUrl: null, isSuperAdmin: false },
    membership: { id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: role as never, status: 'active' },
    organization: { id: 'org-1', name: 'Org', slug: 'org', legalName: null, country: null, sector: null, status: 'active' } as never,
  }
}

describe('getStellaPilotConfirmationStatusAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await getStellaPilotConfirmationStatusAction()
    expect(result).toEqual({ ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' })
  })

  it('resolves organizationId/userId from the session, never client input', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx())
    mockGetStatus.mockResolvedValue({ status: 'valid', currentNoticeVersion: 'v1' })
    await getStellaPilotConfirmationStatusAction()
    expect(mockGetStatus).toHaveBeenCalledWith('org-1', 'user-1')
  })
})

describe('acceptStellaPilotConfirmation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns UNAUTHORIZED when not authenticated', async () => {
    mockRequireOrganizationAccess.mockRejectedValue(new Error('redirect'))
    const result = await acceptStellaPilotConfirmation()
    expect(result.ok).toBe(false)
  })

  it('has NO role restriction — any active member can accept for themselves (unlike DR-005 consent)', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx('viewer'))
    mockGetStatus.mockResolvedValue({ status: 'missing', currentNoticeVersion: 'v1' })
    mockRecordEvent.mockResolvedValue({ id: 'evt-1' })
    const result = await acceptStellaPilotConfirmation()
    expect(result.ok).toBe(true)
  })

  it('resolves the notice version server-side (never from client input) and logs an audit entry', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx())
    mockGetStatus.mockResolvedValue({ status: 'missing', currentNoticeVersion: 'v1' })
    mockRecordEvent.mockResolvedValue({ id: 'evt-1' })
    await acceptStellaPilotConfirmation()
    expect(mockRecordEvent).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', userId: 'user-1', eventType: 'accepted', noticeVersion: 'v1' }))
    expect(mockLogAuditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'stella_pilot_confirmation.accepted' }))
  })

  it('chains supersedesEventId to the previous confirmation event', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx())
    mockGetStatus.mockResolvedValue({ status: 'outdated', confirmationEventId: 'evt-old', currentNoticeVersion: 'v2' })
    mockRecordEvent.mockResolvedValue({ id: 'evt-new' })
    await acceptStellaPilotConfirmation()
    expect(mockRecordEvent).toHaveBeenCalledWith(expect.objectContaining({ supersedesEventId: 'evt-old' }))
  })
})

describe('revokeStellaPilotConfirmation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns NO_ACTIVE_CONFIRMATION_TO_REVOKE when there is nothing to revoke', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx())
    mockGetStatus.mockResolvedValue({ status: 'missing', currentNoticeVersion: 'v1' })
    const result = await revokeStellaPilotConfirmation()
    expect(result).toEqual({ ok: false, error: 'NO_ACTIVE_CONFIRMATION_TO_REVOKE', message: 'No hay una confirmación activa para revocar.' })
  })

  it('revokes a valid confirmation and logs an audit entry', async () => {
    mockRequireOrganizationAccess.mockResolvedValue(makeCtx())
    mockGetStatus.mockResolvedValue({ status: 'valid', confirmationEventId: 'evt-1', currentNoticeVersion: 'v1' })
    mockRecordEvent.mockResolvedValue({ id: 'evt-2' })
    const result = await revokeStellaPilotConfirmation()
    expect(result.ok).toBe(true)
    expect(mockLogAuditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'stella_pilot_confirmation.revoked' }))
  })
})
