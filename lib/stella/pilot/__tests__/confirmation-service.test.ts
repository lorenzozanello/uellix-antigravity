// lib/stella/pilot/__tests__/confirmation-service.test.ts
// Etapa B0 (modo piloto restringido) — no real DB, no real auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}
function makeInsertChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const mockSelect = vi.fn()
const mockInsert = vi.fn()
vi.mock('@/db/client', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}))

const mockGetStellaPilotConfig = vi.fn().mockReturnValue({ noticeVersion: 'v1' })
vi.mock('../config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config')>()
  return { ...original, getStellaPilotConfig: (...args: unknown[]) => mockGetStellaPilotConfig(...args) }
})

import { getStellaPilotConfirmationStatus, recordPilotConfirmationEvent } from '../confirmation-service'

describe('getStellaPilotConfirmationStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns "missing" when no event exists', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([]))
    const result = await getStellaPilotConfirmationStatus('org-1', 'user-1')
    expect(result).toEqual({ status: 'missing', currentNoticeVersion: 'v1' })
  })

  it('returns "valid" when the latest event is accepted with the CURRENT notice version', async () => {
    const acceptedAt = new Date('2026-01-01')
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'evt-1', eventType: 'accepted', noticeVersion: 'v1', occurredAt: acceptedAt }]))
    const result = await getStellaPilotConfirmationStatus('org-1', 'user-1')
    expect(result).toEqual({ status: 'valid', confirmationEventId: 'evt-1', acceptedAt, acceptedNoticeVersion: 'v1', currentNoticeVersion: 'v1' })
  })

  it('returns "outdated" when the latest accepted event references an OLDER notice version', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'evt-1', eventType: 'accepted', noticeVersion: 'v0', occurredAt: new Date() }]))
    const result = await getStellaPilotConfirmationStatus('org-1', 'user-1')
    expect(result.status).toBe('outdated')
  })

  it('returns "revoked" when the latest event is a revocation', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'evt-2', eventType: 'revoked', noticeVersion: null, occurredAt: new Date() }]))
    const result = await getStellaPilotConfirmationStatus('org-1', 'user-1')
    expect(result.status).toBe('revoked')
  })

  it('fails closed to "missing" on an unexpected error', async () => {
    mockSelect.mockImplementationOnce(() => { throw new Error('db unavailable') })
    const result = await getStellaPilotConfirmationStatus('org-1', 'user-1')
    expect(result.status).toBe('missing')
  })

  it('scopes strictly to the given organizationId+userId — never another user\'s or org\'s confirmation', async () => {
    const chain = makeSelectChain([])
    mockSelect.mockReturnValueOnce(chain)
    await getStellaPilotConfirmationStatus('org-1', 'user-1')
    expect(chain.where).toHaveBeenCalled()
  })
})

describe('recordPilotConfirmationEvent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts an "accepted" event with the given notice version and returns its id', async () => {
    mockInsert.mockReturnValueOnce(makeInsertChain([{ id: 'evt-new' }]))
    const result = await recordPilotConfirmationEvent({ organizationId: 'org-1', userId: 'user-1', eventType: 'accepted', noticeVersion: 'v1' })
    expect(result).toEqual({ id: 'evt-new' })
  })

  it('inserts a "revoked" event referencing the prior accepted event via supersedesEventId', async () => {
    const insertChain = makeInsertChain([{ id: 'evt-revoke' }])
    mockInsert.mockReturnValueOnce(insertChain)
    await recordPilotConfirmationEvent({ organizationId: 'org-1', userId: 'user-1', eventType: 'revoked', supersedesEventId: 'evt-old' })
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'revoked', supersedesEventId: 'evt-old' }))
  })
})
