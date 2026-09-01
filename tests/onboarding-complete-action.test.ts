// tests/onboarding-complete-action.test.ts
// RE-U4-CF-01: completeOnboarding is the actual authorization boundary for
// Phase-2 onboarding (app/app/organization/onboarding). This suite pins that
// boundary directly, independent of the page-level rendering branch covered
// by tests/auth/phase2-onboarding-trap.test.tsx — a client cannot execute the
// write by calling the server action directly, regardless of what the page
// renders.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireOrganizationAccess = vi.hoisted(() => vi.fn())
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: mockRequireOrganizationAccess,
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

vi.mock('@/db/client', () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: mockUpdateWhere,
      }),
    }),
  },
}))

import { completeOnboarding } from '@/app/actions/onboarding'

function mockContext(role: string) {
  mockRequireOrganizationAccess.mockResolvedValue({
    organization: { id: 'org-1' },
    membership: { role },
    user: { id: 'user-1' },
  })
}

function formData(overrides: Partial<Record<'country' | 'sector' | 'baseCurrency', string>> = {}) {
  const fd = new FormData()
  fd.set('country', overrides.country ?? 'MX')
  fd.set('sector', overrides.sector ?? 'Education')
  fd.set('baseCurrency', overrides.baseCurrency ?? 'USD')
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateWhere.mockResolvedValue(undefined)
})

describe('completeOnboarding authorization', () => {
  it('rejects a non-admin caller (analyst) with a governed Spanish message, in Spanish', async () => {
    mockContext('analyst')

    await expect(completeOnboarding(formData())).rejects.toThrow(
      'Solo un administrador de la organización puede completar la configuración inicial.'
    )
    expect(mockUpdateWhere).not.toHaveBeenCalled()
  })

  it('rejects a reviewer caller the same way', async () => {
    mockContext('reviewer')

    await expect(completeOnboarding(formData())).rejects.toThrow(
      'Solo un administrador de la organización puede completar la configuración inicial.'
    )
    expect(mockUpdateWhere).not.toHaveBeenCalled()
  })

  it('accepts an organization_admin caller and writes onboardingCompleted=true (non-regression)', async () => {
    mockContext('organization_admin')

    const result = await completeOnboarding(formData())

    expect(result).toEqual({ success: true })
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1)
  })

  it('accepts a super_admin caller (non-regression)', async () => {
    mockContext('super_admin')

    const result = await completeOnboarding(formData())

    expect(result).toEqual({ success: true })
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1)
  })
})
