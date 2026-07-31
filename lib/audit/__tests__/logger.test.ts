// lib/audit/__tests__/logger.test.ts
// WS3b U2: unit tests for the audit writer and the Stella audit action
// vocabulary. No real DB — @/db/client is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockDbInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))

import { AUDIT_ACTIONS, logAuditAction } from '../logger'

describe('AUDIT_ACTIONS — Stella runtime vocabulary (WS3b)', () => {
  it('defines the three Stella runtime actions with entity.verb naming', () => {
    expect(AUDIT_ACTIONS.STELLA_INVOKED).toBe('stella.invoked')
    expect(AUDIT_ACTIONS.STELLA_DENIED).toBe('stella.denied')
    expect(AUDIT_ACTIONS.STELLA_INTEGRITY_REJECTED).toBe('stella.integrity_rejected')
  })

  it('defines the decision-persistence action (WS3b U4, dormant until G2)', () => {
    expect(AUDIT_ACTIONS.STELLA_DECISION_RECORDED).toBe('stella.decision_recorded')
  })

  it('keeps the pre-existing quota-management action untouched', () => {
    expect(AUDIT_ACTIONS.STELLA_SERVICE_UPDATED).toBe('stella_service.updated')
  })

  it('every action value follows the dot-separated lowercase convention', () => {
    for (const value of Object.values(AUDIT_ACTIONS)) {
      expect(value).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('has no duplicate action values', () => {
    const values = Object.values(AUDIT_ACTIONS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('logAuditAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
  })

  it('inserts a row with the given entry fields', async () => {
    await logAuditAction({
      organizationId: 'org-1',
      actorUserId: 'user-1',
      entityType: 'project',
      entityId: 'proj-1',
      action: AUDIT_ACTIONS.STELLA_INVOKED,
      afterJson: { stellaRole: 'advisor', pipelineStep: 'narrative', tokensUsed: 42 },
    })

    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const payload = mockInsertValues.mock.calls[0][0]
    expect(payload.organizationId).toBe('org-1')
    expect(payload.actorUserId).toBe('user-1')
    expect(payload.entityType).toBe('project')
    expect(payload.entityId).toBe('proj-1')
    expect(payload.action).toBe('stella.invoked')
    expect(payload.afterJson).toEqual({ stellaRole: 'advisor', pipelineStep: 'narrative', tokensUsed: 42 })
  })

  it('skips the insert (with a warning) when required fields are missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await logAuditAction({ entityType: '', entityId: 'x', action: AUDIT_ACTIONS.STELLA_DENIED })

    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('propagates DB failures to the caller (callers decide whether to swallow)', async () => {
    mockInsertValues.mockRejectedValue(new Error('db down'))

    await expect(
      logAuditAction({ entityType: 'project', entityId: 'p1', action: AUDIT_ACTIONS.STELLA_DENIED }),
    ).rejects.toThrow('db down')
  })
})
