// lib/stella/consent/__tests__/consent-log.test.ts
// Etapa A2.1 (STL-A21-006/007)

import { describe, it, expect, vi, beforeEach } from 'vitest'

const returningMock = vi.fn().mockResolvedValue([{ id: 'event-1' }])
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest params needed so the spread calls below type-check
const valuesMock = vi.fn((..._values: unknown[]) => ({ returning: returningMock }))
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest params needed so the spread calls below type-check
const insertMock = vi.fn((..._args: unknown[]) => ({ values: valuesMock }))

vi.mock('@/db/client', () => ({
  db: { insert: (...args: unknown[]) => insertMock(...args) },
}))

import { recordConsentEvent } from '../consent-log'

describe('recordConsentEvent', () => {
  beforeEach(() => {
    returningMock.mockClear()
    valuesMock.mockClear()
    insertMock.mockClear()
  })

  it('records an "accepted" event with versions and scope', async () => {
    const result = await recordConsentEvent({
      organizationId: 'org-1',
      eventType: 'accepted',
      actorUserId: 'user-1',
      aiTermsVersion: 'v1',
      dataPolicyVersion: 'v1',
      capabilityScope: ['all'],
    })

    expect(result).toEqual({ id: 'event-1' })
    const values = valuesMock.mock.calls[0][0] as Record<string, unknown>
    expect(values.eventType).toBe('accepted')
    expect(values.aiTermsVersion).toBe('v1')
    expect(values.dataPolicyVersion).toBe('v1')
    expect(values.capabilityScope).toEqual(['all'])
  })

  it('records a "revoked" event without versions, with a reason and supersedesEventId', async () => {
    await recordConsentEvent({
      organizationId: 'org-1',
      eventType: 'revoked',
      actorUserId: 'user-1',
      reason: 'No longer using Stella',
      supersedesEventId: 'event-1',
    })

    const values = valuesMock.mock.calls[0][0] as Record<string, unknown>
    expect(values.eventType).toBe('revoked')
    expect(values.aiTermsVersion).toBeUndefined()
    expect(values.dataPolicyVersion).toBeUndefined()
    expect(values.reason).toBe('No longer using Stella')
    expect(values.supersedesEventId).toBe('event-1')
  })
})
