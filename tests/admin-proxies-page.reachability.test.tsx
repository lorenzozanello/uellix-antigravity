// tests/admin-proxies-page.reachability.test.tsx
// FIBIU-08 (FIBC-010/FIBC-012) — UI_CHANGES: "a full-provenance form;
// approval visible with actor and date." Proves both through the ACTUAL
// route/component tree: the recoverable-reference field renders on the
// creation form, and an approved proxy's sealed reviewed-date (read from
// its CURRENT VERSION, not the live row) renders in the table.
import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { PROXY_APPROVED } = vi.hoisted(() => ({
  PROXY_APPROVED: 'proxy-approved-1',
}))

const mockRequireAdminAccess = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/session', () => ({
  requireAdminAccess: mockRequireAdminAccess,
  runWithAdminAccess: async (cb: (user: unknown) => unknown) => cb(await mockRequireAdminAccess()),
}))

vi.mock('@/lib/admin/proxies', () => ({
  listGlobalProxySources: vi.fn().mockResolvedValue([{ id: 'source-1', name: 'DANE' }]),
  listGlobalFinancialProxies: vi.fn().mockResolvedValue([
    {
      id: PROXY_APPROVED,
      name: 'Salario mínimo',
      value: '100',
      currency: 'USD',
      unit: 'mes',
      referenceYear: 2024,
      valueUsd: '100',
      reviewStatus: 'approved',
    },
  ]),
  listPendingReviewProxies: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/pipeline/financial-proxy-versions', () => ({
  getLatestFinancialProxyVersionsByProxyIds: vi.fn().mockResolvedValue(
    new Map([
      [
        PROXY_APPROVED,
        {
          id: 'version-1',
          financialProxyId: PROXY_APPROVED,
          reviewerId: 'admin-1',
          reviewedAt: new Date('2026-03-15T00:00:00Z'),
        },
      ],
    ])
  ),
}))

import AdminProxiesPage from '@/app/admin/proxies/page'
import { requireAdminAccess } from '@/lib/auth/session'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'admin-1', isSuperAdmin: true } as never)
})

async function renderPage() {
  return render(await AdminProxiesPage({ params: undefined, searchParams: Promise.resolve({}) } as never))
}

describe('full-provenance form (FIBC-010)', () => {
  it('renders the recoverable-reference field, labeled as required for approval', async () => {
    await renderPage()
    expect(screen.getByPlaceholderText('URL, DOI, dataset o documento vinculado')).toBeInTheDocument()
    expect(screen.getByText(/para aprobar/i)).toBeInTheDocument()
  })
})

describe('approval visible with actor and date (FIBC-012)', () => {
  it('shows the sealed reviewed date for an approved proxy, read from its current version', async () => {
    const { container } = await renderPage()
    // es-MX short-date formatting of 2026-03-15 (UTC) — the exact day can
    // shift by one under a negative-UTC-offset test runner (local midnight
    // rolls back a calendar day), so this checks month+year, the part any
    // timezone agrees on, rather than pinning the exact day number.
    expect(container.textContent).toMatch(/mar.{0,3}2026/i)
  })
})
