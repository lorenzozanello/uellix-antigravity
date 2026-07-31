// tests/billing-page.test.tsx
// Billing page must reflect the REAL quota semantics from lib/stella/quota.ts:
// null = unlimited, 0/absent = no plan assigned (fail-closed, blocked) — never
// a fabricated fallback quota. Usage comes from the same source as the admin
// rollup (count of stella_interactions in the current UTC month).
import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDbData = vi.hoisted(() => ({
  usedThisMonth: 0,
}))

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}))

// Avoid importing the real Stripe server action module (touches stripe client).
vi.mock('@/app/app/organization/billing/actions', () => ({
  createStripePortalSession: vi.fn(),
}))

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          then: (cb: (rows: unknown[]) => unknown) =>
            Promise.resolve(cb([{ value: mockDbData.usedThisMonth }])),
        })),
      })),
    })),
  },
}))

import BillingPage from '@/app/app/organization/billing/page'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { getStellaQuotaDisplay } from '@/app/app/organization/billing/quota-display'

function mockContext(overrides: {
  stellaMonthlyQuota: number | null
  stellaPlanLabel?: string | null
  stripeCustomerId?: string | null
  role?: string
}) {
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: {
      id: 'org-1',
      name: 'Acme Impact',
      stellaMonthlyQuota: overrides.stellaMonthlyQuota,
      stellaPlanLabel: overrides.stellaPlanLabel ?? null,
      stripeCustomerId: overrides.stripeCustomerId ?? null,
    },
    membership: { role: overrides.role ?? 'organization_admin' },
    user: { id: 'user-1' },
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDbData.usedThisMonth = 0
})

describe('getStellaQuotaDisplay', () => {
  it('null → unlimited', () => {
    expect(getStellaQuotaDisplay(null).state).toBe('unlimited')
  })
  it('0 or absent → unassigned (fail-closed, never a fake default)', () => {
    expect(getStellaQuotaDisplay(0).state).toBe('unassigned')
    expect(getStellaQuotaDisplay(undefined).state).toBe('unassigned')
  })
  it('positive → assigned with the real number', () => {
    const display = getStellaQuotaDisplay(50)
    expect(display.state).toBe('assigned')
    expect(display.quotaLabel).toContain('50')
  })
})

describe('BillingPage', () => {
  it('quota null renders "ilimitado" and no fabricated quota number', async () => {
    mockContext({ stellaMonthlyQuota: null, stellaPlanLabel: 'Interno' })
    mockDbData.usedThisMonth = 25

    render(await BillingPage())

    expect(screen.getAllByText(/ilimitad/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/acceso a 10 consultas/i)).toBeNull()
    // Usage still shown from the interactions count.
    expect(screen.getByText(/25/)).toBeInTheDocument()
  })

  it('quota 0 renders "sin plan asignado — contactá a Uellix", never a fake 10', async () => {
    mockContext({ stellaMonthlyQuota: 0, stellaPlanLabel: null })

    render(await BillingPage())

    expect(screen.getAllByText(/sin plan asignado/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/contactá a uellix/i)).toBeInTheDocument()
    expect(screen.queryByText(/acceso a 10 consultas/i)).toBeNull()
    expect(screen.queryByText(/plan actual: free/i)).toBeNull()
  })

  it('positive quota renders real used/quota from the interactions count', async () => {
    mockContext({
      stellaMonthlyQuota: 50,
      stellaPlanLabel: 'Pro',
      stripeCustomerId: 'cus_123',
    })
    mockDbData.usedThisMonth = 12

    render(await BillingPage())

    expect(screen.getByText(/12\s*\/\s*50/)).toBeInTheDocument()
    expect(screen.getByText(/plan actual: pro/i)).toBeInTheDocument()
    // Button relabeled to reflect reality: plans are managed by Uellix.
    expect(screen.getByRole('button', { name: /portal de facturación/i })).toBeInTheDocument()
    expect(screen.getByText(/gestionan.*uellix/i)).toBeInTheDocument()
  })
})
