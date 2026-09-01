// tests/evidence-page.sensitivity-erasure-reachability.test.tsx
// W2-B1-R4 (R-B2-05) — proves the two governed remedies FIBIU-05 and
// FIBIU-07 are reachable through the ACTUAL route/component tree, not just
// as direct server-action imports: the evidence page renders the
// affordance only for an authorized role, an unauthorized role never sees
// it, and an already-erased row never re-offers erasure as if it were
// reversible.
import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { PROJECT, EVIDENCE_ROWS, VERSIONS_BY_EVIDENCE } = vi.hoisted(() => {
  const PROJECT = '11111111-1111-4111-8111-111111111111'
  const EVIDENCE_UNCLASSIFIED = '22222222-2222-4222-8222-222222222222'
  const EVIDENCE_ERASED = '33333333-3333-4333-8333-333333333333'

  const EVIDENCE_ROWS = [
    {
      id: EVIDENCE_UNCLASSIFIED,
      title: 'Encuesta de salida',
      type: 'text',
      status: 'draft',
      confidenceScore: null,
      integrityVerified: null,
      integrityVerifiedAt: null,
      contentHash: 'a'.repeat(64),
      createdAt: new Date('2026-01-01'),
    },
    {
      id: EVIDENCE_ERASED,
      title: 'Documento borrado',
      type: 'file',
      status: 'approved',
      confidenceScore: 80,
      integrityVerified: true,
      integrityVerifiedAt: new Date('2026-01-02'),
      contentHash: 'b'.repeat(64),
      createdAt: new Date('2026-01-02'),
    },
  ]

  const VERSIONS_BY_EVIDENCE = new Map([
    [EVIDENCE_UNCLASSIFIED, { sensitivityClassification: null, treatment: null, erasureState: null }],
    [
      EVIDENCE_ERASED,
      { sensitivityClassification: 'personal_data', treatment: 'anonymized', erasureState: 'erasure_complete' },
    ],
  ])

  return { PROJECT, EVIDENCE_UNCLASSIFIED, EVIDENCE_ERASED, EVIDENCE_ROWS, VERSIONS_BY_EVIDENCE }
})

const mockRequireOrganizationAccess = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: mockRequireOrganizationAccess,
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

vi.mock('@/lib/stella/config', () => ({
  stellaConfig: { isEnabled: false, isAdvisorEnabled: false, isEvidenceReviewerEnabled: false },
  stellaState: { canUseStella: false },
}))

vi.mock('@/app/actions/grounding/evidence-corpus-state', () => ({
  readProjectCorpusStateForProject: vi.fn().mockResolvedValue({ status: 'disabled' }),
}))

vi.mock('@/app/app/projects/[projectId]/pipeline/outcomes.actions', () => ({
  fetchOutcomes: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/app/app/projects/[projectId]/pipeline/indicators.actions', () => ({
  fetchIndicators: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/pipeline/evidence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pipeline/evidence')>()
  return {
    ...original,
    listEvidenceForProject: vi.fn().mockResolvedValue(EVIDENCE_ROWS),
  }
})

vi.mock('@/lib/pipeline/evidence-versions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pipeline/evidence-versions')>()
  return {
    ...original,
    getLatestEvidenceVersionsByEvidenceIds: vi.fn().mockResolvedValue(VERSIONS_BY_EVIDENCE),
  }
})

import EvidencePage from '@/app/app/projects/[projectId]/pipeline/evidence/page'
import { requireOrganizationAccess } from '@/lib/auth/session'

function mockRole(role: string) {
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: 'org-1' },
    membership: { role },
    user: { id: 'user-1' },
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireOrganizationAccess).mockReset()
})

describe('sensitivity classification affordance (FIBIU-05, canClassifyEvidenceSensitivity)', () => {
  it('impact_manager sees a classification form for an unclassified row', async () => {
    mockRole('impact_manager')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    expect(screen.getByLabelText('Clasificar sensibilidad')).toBeInTheDocument()
    expect(screen.getByText('Sin clasificar')).toBeInTheDocument()
  })

  it('analyst (below the threshold) never sees the classification form', async () => {
    mockRole('analyst')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    expect(screen.queryByLabelText('Clasificar sensibilidad')).toBeNull()
  })

  it('an already-erased row does not re-offer reclassification', async () => {
    mockRole('organization_admin')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    // Two rows are on the page; the unclassified/non-erased row still offers
    // classification even for this high-privilege role.
    const classifyForms = screen.getAllByLabelText('Clasificar sensibilidad')
    expect(classifyForms).toHaveLength(1)
  })
})

describe('governed erasure affordance (FIBIU-07, canEraseEvidenceContent)', () => {
  it('organization_admin sees the erasure form for content not yet erased', async () => {
    mockRole('organization_admin')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    expect(screen.getByText('Solicitar borrado de contenido')).toBeInTheDocument()
    expect(screen.getByLabelText('Motivo del borrado')).toBeInTheDocument()
  })

  it('impact_manager (below organization_admin) never sees the erasure form — not even the reachable remedy weakens the threshold', async () => {
    mockRole('impact_manager')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    expect(screen.queryByText('Solicitar borrado de contenido')).toBeNull()
  })

  it('a row already erasureState=erasure_complete shows the tombstone badge and NOT a re-erase affordance, even for organization_admin', async () => {
    mockRole('organization_admin')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    expect(screen.getByText('Contenido borrado')).toBeInTheDocument()
    // Only ONE erasure form exists (for the unclassified/non-erased row) —
    // the erased row must not offer a second, redundant erase action.
    expect(screen.getAllByText('Solicitar borrado de contenido')).toHaveLength(1)
  })

  it('the erasure affordance is visibly distinguished from ordinary archive — never presented as an equivalent DELETE', async () => {
    mockRole('organization_admin')
    render(await EvidencePage({ params: Promise.resolve({ projectId: PROJECT }) }))

    expect(screen.getByText(/No es un DELETE ordinario/i)).toBeInTheDocument()
    expect(screen.getByText(/Borrado gobernado de contenido \(irreversible\)/i)).toBeInTheDocument()
  })
})
