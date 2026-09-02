// tests/stella-quota.test.ts
// TRAIN 4.3. This suite used to prove `checkStellaQuota`'s branches: no
// organization, quota 0, quota null, under the cap, at the cap. That function
// is gone — it was the UNLOCKED, reservation-blind authorization the five
// sibling actions ran before calling the provider, and removing it is what
// closes R1 and R6-INT at the runtime boundary (see lib/stella/quota.ts).
//
// What replaced it is not a better version of the same thing. Authorization
// moved into SQL (`bind_operation_ticket`, which locks and reserves in one
// statement) and only a DISPLAY reader remains here. So this suite proves two
// things about `readStellaCapacity`, and both are about what it must NOT do:
//
//   * it asks the canonical function and reconstructs no arithmetic of its own —
//     a second copy of "count the month's rows" is how the two numbers a user
//     is shown start disagreeing;
//   * it fails to `null` rather than to a number, because a display that cannot
//     read the capacity must show nothing rather than a zero it cannot justify.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecute = vi.fn()
vi.mock('@/db/client', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}))

import { readStellaCapacity, formatQuotaResetDate, startOfCurrentUtcMonth } from '@/lib/stella/quota'

describe('readStellaCapacity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports the canonical Limit / Consumed / LiveReserved / Available tuple', async () => {
    mockExecute.mockResolvedValue([{ limit_units: 50, consumed: 12, reserved: 3, available: 35 }])

    const capacity = await readStellaCapacity('org-1')

    expect(capacity).toEqual({ limit: 50, consumed: 12, reserved: 3, available: 35 })
  })

  it('counts a LIVE RESERVATION against availability — the whole of R1', async () => {
    // One unit charged, one reserved, cap of 2: available is ZERO, not one.
    // A reader that ignored `reserved` would tell a sibling action it had
    // headroom that a bound grounded ticket is already holding.
    mockExecute.mockResolvedValue([{ limit_units: 2, consumed: 1, reserved: 1, available: 0 }])

    const capacity = await readStellaCapacity('org-1')

    expect(capacity?.available).toBe(0)
  })

  it('keeps "unlimited" and "a lot" apart — a null cap yields a null availability', async () => {
    mockExecute.mockResolvedValue([{ limit_units: null, consumed: 7, reserved: 0, available: null }])

    const capacity = await readStellaCapacity('org-1')

    expect(capacity).toEqual({ limit: null, consumed: 7, reserved: 0, available: null })
  })

  it('asks uellix_stella.stella_capacity and reconstructs no arithmetic of its own', async () => {
    mockExecute.mockResolvedValue([{ limit_units: 50, consumed: 0, reserved: 0, available: 50 }])

    await readStellaCapacity('org-1')

    expect(mockExecute).toHaveBeenCalledTimes(1)
    const statement = JSON.stringify(mockExecute.mock.calls[0][0])
    expect(statement).toContain('uellix_stella.stella_capacity')
    // No local count of the ledger: the canonical function is the only source.
    expect(statement).not.toContain('stella_interactions')
  })

  it('returns null rather than a zero it cannot justify when the read fails', async () => {
    mockExecute.mockRejectedValue(new Error('function does not exist'))

    expect(await readStellaCapacity('org-1')).toBeNull()
  })

  it('returns null when the organization is out of scope or does not exist', async () => {
    // `stella_capacity` raises U0102 for both, deliberately indistinguishably.
    mockExecute.mockResolvedValue([])

    expect(await readStellaCapacity('org-missing')).toBeNull()
  })
})

describe('startOfCurrentUtcMonth', () => {
  it('is midnight UTC on the first of the month', () => {
    const start = startOfCurrentUtcMonth()
    expect(start.getUTCDate()).toBe(1)
    expect(start.getUTCHours()).toBe(0)
    expect(start.getUTCMinutes()).toBe(0)
    expect(start.getUTCSeconds()).toBe(0)
    expect(start.getUTCMilliseconds()).toBe(0)
  })
})

describe('formatQuotaResetDate', () => {
  it('formats an ISO string as a Spanish date in UTC', () => {
    expect(formatQuotaResetDate('2026-08-01T00:00:00.000Z')).toBe('1 de agosto de 2026')
  })

  it('does not shift the day across a timezone boundary', () => {
    // 23:59 UTC on the 1st must still read as the 1st, not the 2nd.
    expect(formatQuotaResetDate('2026-08-01T23:59:00.000Z')).toBe('1 de agosto de 2026')
  })
})
