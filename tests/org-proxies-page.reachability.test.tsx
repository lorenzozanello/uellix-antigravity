// tests/org-proxies-page.reachability.test.tsx
// W2-B2-R1 / R-B2-02 (closes B2-AR-B2) — ORGANIZATION provenance
// reachability, proven through the running route/component tree, not a
// schema: route -> rendered control -> action -> schema -> service. Per
// organization_provenance_requirements.reachability_definition, a zod field
// no rendered control supplies does NOT count, and neither does the
// admin-only surface the org approval path refuses to serve.
import React from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { PROXY_APPROVED, PROXY_DRAFT } = vi.hoisted(() => ({
  PROXY_APPROVED: 'proxy-approved-1',
  PROXY_DRAFT: 'proxy-draft-1',
}))

const mockCtx = vi.hoisted(() => ({
  organization: { id: 'org-1' },
  user: { id: 'user-1' },
  membership: { role: 'impact_manager' },
}))

vi.mock('@/lib/auth/session', () => ({
  runWithOptionalOrganizationAccess: async (cb: (ctx: unknown) => unknown) => cb(mockCtx),
  runWithOrganizationAccess: async (cb: () => unknown) => cb(),
}))

// Chrome around the form — not under test, and heavy (Stella panels, stepper).
vi.mock('@/components/sroi/Stepper', () => ({ default: () => null }))
vi.mock('@/components/sroi/PipelineStepHeader', () => ({ PipelineStepHeader: () => null }))
vi.mock('@/components/stella', () => ({ StellaContextualAdvisorPanel: () => null, StellaReviewerPanel: () => null }))
vi.mock('@/components/methodology/MethodologyReviewPanel', () => ({ MethodologyReviewPanel: () => null }))
vi.mock('@/app/components/proxy-bank-search/ProxyBankSearch', () => ({ ProxyBankSearch: () => null }))
vi.mock('@/lib/stella/config', () => ({ stellaConfig: { isEnabled: false }, stellaState: { canUseStella: false } }))
vi.mock('@/lib/pipeline/methodology-review', () => ({ canReviewMethodology: () => false }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/app/app/projects/[projectId]/pipeline/outcomes.actions', () => ({
  fetchOutcomes: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/pipeline/proxies', () => ({
  listFinancialProxies: vi.fn().mockResolvedValue([
    { id: PROXY_APPROVED, name: 'Salario mínimo', sourceId: 'source-1', value: '100', currency: 'USD', unit: 'mes', referenceYear: 2024, reviewStatus: 'approved' },
    { id: PROXY_DRAFT, name: 'Proxy en borrador', sourceId: 'source-1', value: '50', currency: 'USD', unit: 'mes', referenceYear: 2024, reviewStatus: 'suggested' },
  ]),
  listProxySources: vi.fn().mockResolvedValue([{ id: 'source-1', name: 'DANE' }]),
  listProxyAssignmentsForProject: vi.fn().mockResolvedValue([]),
  updateOrganizationFinancialProxy: vi.fn().mockResolvedValue({ id: PROXY_DRAFT }),
  createOrganizationFinancialProxy: vi.fn().mockResolvedValue({ id: 'new-proxy' }),
}))

vi.mock('@/lib/pipeline/financial-proxy-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipeline/financial-proxy-versions')>()
  return {
    ...actual,
    getLatestFinancialProxyVersionsByProxyIds: vi.fn().mockResolvedValue(
      new Map([
        [
          PROXY_APPROVED,
          {
            id: 'version-approved',
            financialProxyId: PROXY_APPROVED,
            reviewStatus: 'approved',
            reviewerId: 'reviewer-abcdef12',
            reviewedAt: new Date('2026-03-15T12:00:00Z'),
            geographicContextualScope: 'Nacional',
            linkedOutcomeContext: 'Ingreso mensual',
            recoverableReference: 'https://data.example.org/x',
            relevanceJustification: 'Misma población',
            documentedTransformations: 'none',
            consultationDate: new Date('2026-01-10T00:00:00Z'),
          },
        ],
        [PROXY_DRAFT, { id: 'version-draft', financialProxyId: PROXY_DRAFT, reviewStatus: 'draft' }],
      ])
    ),
  }
})

import ProxiesPage from '@/app/app/projects/[projectId]/pipeline/proxies/page'
import { updateFinancialProxyAction } from '@/app/app/projects/[projectId]/pipeline/proxies/updateFinancialProxy.action'
import { createFinancialProxyAction } from '@/app/app/projects/[projectId]/pipeline/proxies/createFinancialProxy.action'
import { updateOrganizationFinancialProxy, createOrganizationFinancialProxy } from '@/lib/pipeline/proxies'

// FIBC-010's eleven items as form control names on the organization surface.
const ELEVEN = {
  1: 'value',
  2: 'unit',
  3: 'currency',
  4: 'referenceYear',
  5: 'geographicContextualScope',
  6: 'linkedOutcomeContext',
  7: 'sourceId',
  8: 'consultationDate',
  9: 'recoverableReference',
  10: 'relevanceJustification',
  11: 'documentedTransformations',
} as const

beforeEach(() => {
  vi.clearAllMocks()
})

async function renderPage() {
  return render(await ProxiesPage({ params: Promise.resolve({ projectId: 'project-1' }) } as never))
}

describe('route -> rendered control: the organization proxy page renders a control for all eleven FIBC-010 items', () => {
  it.each(Object.entries(ELEVEN))('item %s (%s) has a control on the CREATE form', async (_item, name) => {
    const { container } = await renderPage()
    const createForm = container.querySelector('#proxy-name')?.closest('form')
    expect(createForm, 'create form mounted').not.toBeNull()
    expect(createForm!.querySelector(`[name="${name}"]`), `create control for ${name}`).not.toBeNull()
  })

  it.each(Object.entries(ELEVEN))('item %s (%s) has a control on the EDIT form of an existing proxy', async (_item, name) => {
    const { container } = await renderPage()
    const editForm = container.querySelector(`#${CSS.escape(`${PROXY_DRAFT}-edit-value`)}`)?.closest('form')
    expect(editForm, 'edit form mounted').not.toBeNull()
    expect(editForm!.querySelector(`[name="${name}"]`), `edit control for ${name}`).not.toBeNull()
  })

  it('marks the ten approval-blocking items as required-for-approval and the consultation date as conditional', async () => {
    const { container } = await renderPage()
    const createForm = container.querySelector('#proxy-name')!.closest('form')!
    const text = createForm.textContent ?? ''
    expect((text.match(/para aprobar/g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(text).toMatch(/cuando aplique/)
  })
})

describe('display: recorded provenance and the sealed approval actor/moment on the organization surface', () => {
  it('shows every recorded provenance item of the approved proxy, read from its current version', async () => {
    const { container } = await renderPage()
    const dl = container.querySelector(`[data-testid="provenance-${PROXY_APPROVED}"]`)
    expect(dl).not.toBeNull()
    const text = dl!.textContent ?? ''
    expect(text).toContain('Nacional')
    expect(text).toContain('Ingreso mensual')
    expect(text).toContain('https://data.example.org/x')
    expect(text).toContain('Misma población')
    expect(text).toContain('none')
  })

  it('shows the sealed approval moment and actor for the approved proxy only', async () => {
    const { container } = await renderPage()
    const sealed = container.querySelector(`[data-testid="sealed-approval-${PROXY_APPROVED}"]`)
    expect(sealed).not.toBeNull()
    expect(sealed!.textContent).toMatch(/2026/)
    expect(sealed!.textContent).toMatch(/revisor reviewer/)
    expect(container.querySelector(`[data-testid="sealed-approval-${PROXY_DRAFT}"]`)).toBeNull()
  })

  it('names, for the draft proxy, which missing items block approval', async () => {
    const { container } = await renderPage()
    const dl = container.querySelector(`[data-testid="provenance-${PROXY_DRAFT}"]`)
    expect(dl!.textContent).toMatch(/bloquea la aprobación/)
  })
})

describe('action -> schema -> service: every item reaches the service through the organization actions', () => {
  it('updateFinancialProxyAction forwards all eleven items', async () => {
    const patch = {
      sourceId: '550e8400-e29b-41d4-a716-446655440002',
      value: '120',
      currency: 'USD',
      unit: 'mes',
      referenceYear: 2025,
      geographicContextualScope: 'Nacional',
      linkedOutcomeContext: 'Ingreso',
      recoverableReference: 'https://x',
      relevanceJustification: 'Misma población',
      documentedTransformations: 'none',
      consultationDate: '2026-01-10',
    }
    await updateFinancialProxyAction('project-1', PROXY_DRAFT, patch)
    expect(updateOrganizationFinancialProxy).toHaveBeenCalledWith(PROXY_DRAFT, patch)
  })

  it('createFinancialProxyAction forwards the six provenance items alongside the legacy fields', async () => {
    const input = {
      sourceId: '550e8400-e29b-41d4-a716-446655440002',
      name: 'Nuevo',
      currency: 'USD',
      value: '100',
      unit: 'mes',
      referenceYear: 2025,
      geographicContextualScope: 'Nacional',
      linkedOutcomeContext: 'Ingreso',
      recoverableReference: 'https://x',
      relevanceJustification: 'Misma población',
      documentedTransformations: 'none',
      consultationDate: '2026-01-10',
    }
    await createFinancialProxyAction('project-1', input)
    expect(createOrganizationFinancialProxy).toHaveBeenCalledWith(expect.objectContaining(input))
  })

  it('NEGATIVE: the patch schema rejects a system-sealed key (review_status) at the action boundary', async () => {
    await expect(
      updateFinancialProxyAction('project-1', PROXY_DRAFT, { reviewStatus: 'approved', value: '1' } as never)
    ).resolves.toBeDefined()
    // zod strips unknown keys: the sealed key never reaches the service.
    expect(updateOrganizationFinancialProxy).toHaveBeenCalledWith(PROXY_DRAFT, { value: '1' })
  })
})
