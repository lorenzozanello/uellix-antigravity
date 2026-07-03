// tests/stella-quota.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDbData = vi.hoisted(() => ({
  org: null as { stellaMonthlyQuota: number | null } | null,
  interactionCount: 0,
}))

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation((fields?: Record<string, unknown>) => ({
      from: vi.fn().mockImplementation((table: { [key: symbol]: string }) => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => ({
            then: (cb: (rows: unknown[]) => unknown) => {
              const isOrgQuery = fields && 'stellaMonthlyQuota' in fields
              if (isOrgQuery) {
                return Promise.resolve(cb(mockDbData.org ? [mockDbData.org] : []))
              }
              return Promise.resolve(cb([]))
            },
          })),
          then: (cb: (rows: unknown[]) => unknown) => {
            // count query path (no .limit())
            return Promise.resolve(cb([{ value: mockDbData.interactionCount }]))
          },
        })),
      })),
    })),
  },
}))

import { checkStellaQuota } from '@/lib/stella/quota'

beforeEach(() => {
  vi.clearAllMocks()
  mockDbData.org = null
  mockDbData.interactionCount = 0
})

describe('checkStellaQuota', () => {
  it('allows unlimited access when quota is null', async () => {
    mockDbData.org = { stellaMonthlyQuota: null }
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(true)
  })

  it('blocks with reason no_quota when quota is 0', async () => {
    mockDbData.org = { stellaMonthlyQuota: 0 }
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('no_quota')
  })

  it('allows when usage is below a positive quota', async () => {
    mockDbData.org = { stellaMonthlyQuota: 10 }
    mockDbData.interactionCount = 3
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.used).toBe(3)
      expect(result.quota).toBe(10)
    }
  })

  it('blocks with reason quota_exceeded when usage equals quota', async () => {
    mockDbData.org = { stellaMonthlyQuota: 10 }
    mockDbData.interactionCount = 10
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe('quota_exceeded')
      expect(result.used).toBe(10)
      expect(result.quota).toBe(10)
    }
  })

  it('blocks with reason quota_exceeded when usage is over quota', async () => {
    mockDbData.org = { stellaMonthlyQuota: 10 }
    mockDbData.interactionCount = 15
    const result = await checkStellaQuota('org-1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('quota_exceeded')
  })

  it('treats a missing organization as no_quota (fails closed)', async () => {
    mockDbData.org = null
    const result = await checkStellaQuota('org-missing')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe('no_quota')
  })
})
