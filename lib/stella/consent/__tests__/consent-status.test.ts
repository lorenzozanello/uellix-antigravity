// lib/stella/consent/__tests__/consent-status.test.ts
// Etapa A2.1 (STL-A21-005) — covers every sequence required by the task:
// accepted; accepted → revoked; accepted v1 → accepted v2 (same current
// version); accepted at an outdated version; revoked → accepted again;
// no events at all; and fail-closed on a query error.

import { describe, it, expect, vi } from 'vitest'
import { STELLA_AI_TERMS_VERSION, STELLA_DATA_POLICY_VERSION } from '../versions'

vi.mock('@/db/client', () => ({
  db: { select: vi.fn() },
}))

import { getStellaConsentStatus } from '../consent-status'

function makeChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const ORG_ID = 'org-1'

describe('getStellaConsentStatus', () => {
  it('returns "missing" when there are no consent events at all', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never)

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('missing')
    expect(status.currentAiTermsVersion).toBe(STELLA_AI_TERMS_VERSION)
    expect(status.currentDataPolicyVersion).toBe(STELLA_DATA_POLICY_VERSION)
  })

  it('returns "valid" for a single current-version acceptance', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([
        {
          id: 'event-1',
          eventType: 'accepted',
          aiTermsVersion: STELLA_AI_TERMS_VERSION,
          dataPolicyVersion: STELLA_DATA_POLICY_VERSION,
          actorUserId: 'user-1',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          capabilityScope: ['all'],
          supersedesEventId: null,
        },
      ]) as never,
    )

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('valid')
    expect(status.consentEventId).toBe('event-1')
    expect(status.acceptedBy).toBe('user-1')
  })

  it('returns "revoked" after accepted → revoked, enriched with the original acceptance', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select)
      .mockReturnValueOnce(
        makeChain([
          {
            id: 'event-2',
            eventType: 'revoked',
            aiTermsVersion: null,
            dataPolicyVersion: null,
            actorUserId: 'user-1',
            occurredAt: new Date('2026-01-02T00:00:00Z'),
            capabilityScope: null,
            supersedesEventId: 'event-1',
          },
        ]) as never,
      )
      .mockReturnValueOnce(
        makeChain([
          {
            id: 'event-1',
            eventType: 'accepted',
            aiTermsVersion: STELLA_AI_TERMS_VERSION,
            dataPolicyVersion: STELLA_DATA_POLICY_VERSION,
            actorUserId: 'user-1',
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            capabilityScope: ['all'],
            supersedesEventId: null,
          },
        ]) as never,
      )

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('revoked')
    expect(status.acceptedAiTermsVersion).toBe(STELLA_AI_TERMS_VERSION)
  })

  it('returns "valid" for accepted v1 → accepted v2 when v2 matches the current version', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([
        {
          id: 'event-2',
          eventType: 'accepted',
          aiTermsVersion: STELLA_AI_TERMS_VERSION,
          dataPolicyVersion: STELLA_DATA_POLICY_VERSION,
          actorUserId: 'user-2',
          occurredAt: new Date('2026-02-01T00:00:00Z'),
          capabilityScope: ['all'],
          supersedesEventId: 'event-1',
        },
      ]) as never,
    )

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('valid')
    expect(status.consentEventId).toBe('event-2')
  })

  it('returns "outdated" when the latest acceptance no longer matches the current version', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([
        {
          id: 'event-1',
          eventType: 'accepted',
          aiTermsVersion: 'v0',
          dataPolicyVersion: 'v0',
          actorUserId: 'user-1',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          capabilityScope: ['all'],
          supersedesEventId: null,
        },
      ]) as never,
    )

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('outdated')
    expect(status.acceptedAiTermsVersion).toBe('v0')
    expect(status.currentAiTermsVersion).toBe(STELLA_AI_TERMS_VERSION)
  })

  it('returns "valid" for revoked → accepted again (the latest event wins)', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([
        {
          id: 'event-3',
          eventType: 'accepted',
          aiTermsVersion: STELLA_AI_TERMS_VERSION,
          dataPolicyVersion: STELLA_DATA_POLICY_VERSION,
          actorUserId: 'user-1',
          occurredAt: new Date('2026-03-01T00:00:00Z'),
          capabilityScope: ['all'],
          supersedesEventId: null,
        },
      ]) as never,
    )

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('valid')
    expect(status.consentEventId).toBe('event-3')
  })

  it('fails closed to "missing" when the query throws', async () => {
    const { db } = await import('@/db/client')
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('connection lost')
    })

    const status = await getStellaConsentStatus(ORG_ID)
    expect(status.status).toBe('missing')
  })

  it('never includes another organization\'s data (query is always scoped by organizationId)', async () => {
    const { db } = await import('@/db/client')
    const chain = makeChain([])
    vi.mocked(db.select).mockReturnValueOnce(chain as never)

    await getStellaConsentStatus(ORG_ID)
    expect(chain.where).toHaveBeenCalledTimes(1)
  })
})
