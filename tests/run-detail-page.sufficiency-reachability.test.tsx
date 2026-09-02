// tests/run-detail-page.sufficiency-reachability.test.tsx
// W2-B1-R4 (R-B1-02, FIBIU-06) — proves the run-bound sufficiency
// determination is reachable through the ACTUAL route/component tree: the
// panel renders only for canDetermineEvidenceSufficiency, the outcomes
// listed are exactly the ones monetized BY THIS RUN's own line items, and
// the run identity is fixed by the server (never a user-editable form
// field) — the "unambiguous run context" the remediation authority
// requires.
import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { PROJECT, RUN, OUTCOME_A, OUTCOME_B, RUN_ROW, LINE_ITEMS } = vi.hoisted(() => {
  const PROJECT = '11111111-1111-4111-8111-111111111111'
  const RUN = '22222222-2222-4222-8222-222222222222'
  const OUTCOME_A = '33333333-3333-4333-8333-333333333333'
  const OUTCOME_B = '44444444-4444-4444-8444-444444444444'

  const RUN_ROW = {
    id: RUN,
    projectId: PROJECT,
    version: 1,
    status: 'calculated',
    sroiRatio: '2.50',
    netSocialValue: '100000',
    grossSocialValue: '150000',
    totalInvestment: '40000',
    currency: 'USD',
    calculatedAt: new Date('2026-01-01'),
    calculatedBy: 'user-author',
    methodologyVersion: 'v1',
    calculationEngineVersion: 'v1',
    buildIdentity: 'build-1',
  }

  const LINE_ITEMS = [
    { id: 'li-1', runId: RUN, assignmentId: 'a-1', outcomeId: OUTCOME_A, quantity: '10', proxyValue: '5', currency: 'USD', grossValue: '50', adjustedValue: '40', deadweightPct: '10', attributionPct: '10', displacementPct: '0', dropoffPct: '0' },
    { id: 'li-2', runId: RUN, assignmentId: 'a-2', outcomeId: OUTCOME_B, quantity: '5', proxyValue: '5', currency: 'USD', grossValue: '25', adjustedValue: '20', deadweightPct: '10', attributionPct: '10', displacementPct: '0', dropoffPct: '0' },
    // Same outcome twice across line items — must be deduplicated, not listed twice.
    { id: 'li-3', runId: RUN, assignmentId: 'a-3', outcomeId: OUTCOME_A, quantity: '2', proxyValue: '5', currency: 'USD', grossValue: '10', adjustedValue: '8', deadweightPct: '10', attributionPct: '10', displacementPct: '0', dropoffPct: '0' },
  ]

  return { PROJECT, RUN, OUTCOME_A, OUTCOME_B, RUN_ROW, LINE_ITEMS }
})

const mockRequireOrganizationAccess = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: mockRequireOrganizationAccess,
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) =>
    cb(await mockRequireOrganizationAccess()),
}))

vi.mock('@/components/calculation-results/CalculationResultsCard', () => ({
  CalculationResultsCard: () => null,
}))

const mockGetCalculationRunDetail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/sroi-results', () => ({
  getCalculationRunDetail: mockGetCalculationRunDetail,
  listSroiRunReviews: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/pipeline/sroi-calculation', () => ({
  detectRunInputDrift: vi.fn().mockResolvedValue({ hasDrift: false, driftedObjects: [] }),
  // W2-B3 completeness (FIBIU-12) — the run detail page now also renders the
  // monetization coverage panel; an empty coverage keeps this suite focused
  // on the sufficiency panel it pins.
  getRunMonetizationCoverage: vi.fn().mockResolvedValue({
    outcomes: [],
    monetizedOutcomeIds: [],
    missingDispositionOutcomeIds: [],
    notMonetizedByReason: {
      no_defensible_proxy: [], proxy_not_approved: [], insufficient_evidence: [], not_material: [],
      not_yet_eligible: [], superseded_version: [], other_governed_reason: [],
    },
    materialNotMonetizedOutcomeIds: [],
    unclassifiedOutcomeIds: [],
    hasDefensibleMonetization: true,
  }),
  MONETIZATION_REASON_VALUES: [
    'no_defensible_proxy', 'proxy_not_approved', 'insufficient_evidence',
    'not_material', 'not_yet_eligible', 'superseded_version', 'other_governed_reason',
  ],
}))

const mockGetLatestSufficiencyDeterminationsByOutcomeIds = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/evidence-sufficiency', () => ({
  getLatestSufficiencyDeterminationsByOutcomeIds: mockGetLatestSufficiencyDeterminationsByOutcomeIds,
}))

vi.mock('@/app/app/projects/[projectId]/pipeline/outcomes.actions', () => ({
  fetchOutcomes: vi.fn().mockResolvedValue([
    { id: OUTCOME_A, title: 'Reducción del tiempo de acceso a agua' },
    { id: OUTCOME_B, title: 'Aumento de ingreso familiar' },
  ]),
}))

import RunDetailPage from '@/app/app/projects/[projectId]/pipeline/calculation/runs/[runId]/page'
import { requireOrganizationAccess } from '@/lib/auth/session'

function mockRole(role: string) {
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: 'org-1' },
    membership: { role },
    user: { id: 'user-viewer' },
  } as never)
}

function detailWith(lineItems: unknown[]) {
  return {
    run: RUN_ROW,
    lineItems,
    snapshotJson: null,
    currency: 'USD',
    projectContext: { id: PROJECT, organizationId: 'org-1' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireOrganizationAccess).mockReset()
  mockGetCalculationRunDetail.mockResolvedValue(detailWith(LINE_ITEMS))
  mockGetLatestSufficiencyDeterminationsByOutcomeIds.mockResolvedValue(new Map())
})

async function renderPage() {
  return render(
    await RunDetailPage({ params: Promise.resolve({ projectId: PROJECT, runId: RUN }) })
  )
}

describe('sufficiency panel affordance (FIBIU-06, canDetermineEvidenceSufficiency)', () => {
  it('impact_manager sees a determination form for each outcome monetized BY THIS RUN, deduplicated', async () => {
    mockRole('impact_manager')
    await renderPage()

    expect(screen.getByText('Reducción del tiempo de acceso a agua')).toBeInTheDocument()
    expect(screen.getByText('Aumento de ingreso familiar')).toBeInTheDocument()
    // OUTCOME_A appears in two line items but must be ONE row/form, not two.
    expect(screen.getAllByText('Reducción del tiempo de acceso a agua')).toHaveLength(1)
    expect(screen.getAllByLabelText('Determinación de suficiencia')).toHaveLength(2)
  })

  it('analyst (below impact_manager) sees the current determinations but never the write form', async () => {
    mockRole('analyst')
    await renderPage()

    expect(screen.getByText('Reducción del tiempo de acceso a agua')).toBeInTheDocument()
    expect(screen.queryAllByLabelText('Determinación de suficiencia')).toHaveLength(0)
    expect(screen.getAllByText('Sin determinar').length).toBeGreaterThan(0)
  })

  it('the run identity is fixed by the server, never a submittable form field — proving the panel cannot be confused about which run it is recording for', async () => {
    mockRole('impact_manager')
    const { container } = await renderPage()

    // No hidden/visible input anywhere in the sufficiency forms carries the
    // run id as user-controllable data; the server action closes over `runId`
    // from the route params instead.
    const runIdInputs = container.querySelectorAll('input[name="calculationRunId"], input[name="runId"]')
    expect(runIdInputs).toHaveLength(0)
  })

  it('shows an existing run-bound determination and its rationale, not a fabricated default', async () => {
    mockGetLatestSufficiencyDeterminationsByOutcomeIds.mockResolvedValue(
      new Map([
        [
          OUTCOME_A,
          {
            id: 'det-1',
            outcomeId: OUTCOME_A,
            calculationRunId: RUN,
            ordinal: 1,
            determination: 'sufficient',
            rationale: 'Tres fuentes independientes corroboran el resultado.',
          },
        ],
      ])
    )
    mockRole('impact_manager')
    await renderPage()

    // "Suficiente" also appears as an <option> in the write-form select for
    // the OTHER (undetermined) outcome row — scope to the status badge.
    const badges = screen.getAllByText('Suficiente').filter((el) => el.tagName === 'DIV')
    expect(badges).toHaveLength(1)
    expect(screen.getByText('Tres fuentes independientes corroboran el resultado.')).toBeInTheDocument()
  })

  it('a run with no monetized outcomes on its own line items renders no sufficiency panel at all', async () => {
    mockGetCalculationRunDetail.mockResolvedValue(detailWith([]))
    mockRole('impact_manager')
    await renderPage()

    expect(screen.queryByText('Suficiencia de Evidencia')).toBeNull()
  })
})
