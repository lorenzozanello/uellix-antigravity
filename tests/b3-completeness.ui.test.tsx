// tests/b3-completeness.ui.test.tsx
// W2-B3 completeness (docs/ops/wave2/W2_B3_TEST_MANIFEST_v2.json) — the UI
// controls, rendered through the ACTUAL server-component pages (same
// technique as tests/run-detail-page.sufficiency-reachability.test.tsx):
//
//   P-UI-11-1 / N-UI-11-1   outcomes page: human materiality classification,
//                           legacy score labelled non-determinative, no Stella
//                           classification path.
//   P-UI-12-1 / P-UI-12-2   run detail: per-outcome disposition form bound to
//                           THIS run, coverage panel rendered BEFORE the review
//                           form, per-reason buckets, missing disposition visible.
//   P-UI-12-3 / N-UI-12-1   explicit "Sin ratio SROI" on run detail, preview
//                           and run list — never '0.00:1', never NaN.
//   P-UI-13-1 / P-UI-13-2 / N-UI-13-1  five discrete filter justifications and
//                           the "0 justificado" vs "desconocido" distinction.
//   N-RATIO-4               public verification never renders 'null:1'.
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const OUT_A = '33333333-3333-4333-8333-333333333333'
const OUT_B = '44444444-4444-4444-8444-444444444444'
const ASSIGNMENT = '55555555-5555-4555-8555-555555555555'

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------
const mockRequireOrganizationAccess = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: mockRequireOrganizationAccess,
  runWithOrganizationAccess: async (cb: (ctx: unknown) => unknown) => cb(await mockRequireOrganizationAccess()),
  getCurrentOrganizationContext: mockRequireOrganizationAccess,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))
vi.mock('@/lib/stella/config', () => ({
  stellaConfig: { isEnabled: false, isAdvisorEnabled: false, isValidatorEnabled: false, isAuditAssistantEnabled: false },
  stellaState: { canUseStella: false },
}))
vi.mock('@/components/stella', () => ({
  StellaContextualAdvisorPanel: () => null,
  StellaValidatorPanel: () => null,
  StellaReviewerPanel: () => null,
}))
vi.mock('@/components/sroi/Stepper', () => ({ default: () => null }))
vi.mock('@/components/sroi/PipelineStepHeader', () => ({ PipelineStepHeader: () => null }))
vi.mock('@/components/methodology/MethodologyReviewPanel', () => ({ MethodologyReviewPanel: () => null }))
vi.mock('@/lib/pipeline/methodology-review', () => ({ canReviewMethodology: () => false }))
vi.mock('@/lib/taxonomies/service', () => ({
  listCatalogsWithCodes: vi.fn().mockResolvedValue([]),
  listOutcomeMappingsForProject: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/pipeline/funders', () => ({
  listFundersForCurrentOrganization: vi.fn().mockResolvedValue([]),
  FUNDER_TYPES: [],
}))
vi.mock('@/lib/pipeline/allocations', () => ({
  listAllocationsForProject: vi.fn().mockResolvedValue([]),
  sumPct: () => 0,
}))
vi.mock('@/lib/pipeline/investments', () => ({ listInvestments: vi.fn().mockResolvedValue([]) }))
vi.mock('@/components/taxonomy/OutcomeTaxonomyMapper', () => ({ OutcomeTaxonomyMapper: () => null }))
vi.mock('@/app/components/allocation-form/OutcomeAllocationWrapper', () => ({ OutcomeAllocationWrapper: () => null }))
vi.mock('@/app/components/investment-form/InvestmentFormIntegration', () => ({ default: () => null }))
vi.mock('@/components/calculation-results/CalculationResultsCard', () => ({ CalculationResultsCard: () => null }))

const mockSetClassification = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/outcomes', () => ({ setOutcomeMaterialityClassification: mockSetClassification }))
const mockFetchOutcomes = vi.hoisted(() => vi.fn())
vi.mock('@/app/app/projects/[projectId]/pipeline/outcomes.actions', () => ({
  fetchOutcomes: mockFetchOutcomes,
  addOutcome: vi.fn(),
  updateOutcomeMateriality: vi.fn(),
}))
vi.mock('@/app/app/projects/[projectId]/pipeline/stakeholders.actions', () => ({ fetchStakeholders: vi.fn().mockResolvedValue([]) }))

// Run detail deps
const mockGetCalculationRunDetail = vi.hoisted(() => vi.fn())
const mockListSroiRunReviews = vi.hoisted(() => vi.fn())
const mockCompareCalculationRuns = vi.hoisted(() => vi.fn())
const mockGetRunList = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/sroi-results', () => ({
  getCalculationRunDetail: mockGetCalculationRunDetail,
  listSroiRunReviews: mockListSroiRunReviews,
  compareCalculationRuns: mockCompareCalculationRuns,
  getRunList: mockGetRunList,
}))
const mockGetRunMonetizationCoverage = vi.hoisted(() => vi.fn())
const mockGetSroiCalculationReadiness = vi.hoisted(() => vi.fn())
const mockCalculateSroiPreview = vi.hoisted(() => vi.fn())
const mockCalculateSroiScenarios = vi.hoisted(() => vi.fn())
const mockListSroiCalculationRuns = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/sroi-calculation', () => ({
  detectRunInputDrift: vi.fn().mockResolvedValue({ hasDrift: false, driftedObjects: [] }),
  getRunMonetizationCoverage: mockGetRunMonetizationCoverage,
  getSroiCalculationReadiness: mockGetSroiCalculationReadiness,
  calculateSroiPreview: mockCalculateSroiPreview,
  calculateSroiScenarios: mockCalculateSroiScenarios,
  listSroiCalculationRuns: mockListSroiCalculationRuns,
  MONETIZATION_REASON_VALUES: [
    'no_defensible_proxy', 'proxy_not_approved', 'insufficient_evidence',
    'not_material', 'not_yet_eligible', 'superseded_version', 'other_governed_reason',
  ],
}))
vi.mock('@/lib/pipeline/evidence-sufficiency', () => ({
  getLatestSufficiencyDeterminationsByOutcomeIds: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/runs/createSroiRunReview.action', () => ({ createSroiRunReviewAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/runs/recordEvidenceSufficiencyDetermination.action', () => ({ recordEvidenceSufficiencyDeterminationAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/runs/recordOutcomeMonetizationDisposition.action', () => ({ recordOutcomeMonetizationDispositionAction: vi.fn() }))
// vi.mock is hoisted, so each action module is named literally.
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/calculateSroiRun.action', () => ({ calculateSroiRunAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/upsertProjectInvestment.action', () => ({ upsertProjectInvestmentAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/upsertSroiAssignmentInput.action', () => ({ upsertSroiAssignmentInputAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/upsertSroiFilterSet.action', () => ({ upsertSroiFilterSetAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/funderAllocation.actions', () => ({ createFunderAction: vi.fn(), addAllocationAction: vi.fn(), archiveAllocationAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/setDiscountRate.action', () => ({ setDiscountRateAction: vi.fn() }))
vi.mock('@/app/app/projects/[projectId]/pipeline/calculation/manageInvestment.action', () => ({ createInvestmentAction: vi.fn(), updateInvestmentAction: vi.fn(), deleteInvestmentAction: vi.fn() }))

// Calculation page reads a handful of tables directly through the db client.
const tableRows = vi.hoisted(() => ({ current: {} as Record<string, unknown[]> }))
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      let rows: unknown[] = []
      const chain: Record<string, unknown> = {}
      chain.from = vi.fn().mockImplementation((table: Record<symbol, string>) => {
        const name = table[Symbol.for('drizzle:Name')]
        rows = tableRows.current[name] ?? []
        return chain
      })
      chain.innerJoin = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.orderBy = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockReturnValue(chain)
      chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows))
      return chain
    }),
  },
}))

// Public verify page
const mockGetPublicVerifiedReport = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reports/public-verify', () => ({ getPublicVerifiedReport: mockGetPublicVerifiedReport }))

import OutcomesPage from '@/app/app/projects/[projectId]/pipeline/outcomes/page'
import RunDetailPage from '@/app/app/projects/[projectId]/pipeline/calculation/runs/[runId]/page'
import CalculationPage from '@/app/app/projects/[projectId]/pipeline/calculation/page'
import VerifyPage from '@/app/(public)/verify/[hash]/page'

function mockRole(role: string) {
  mockRequireOrganizationAccess.mockResolvedValue({
    organization: { id: 'org-1', name: 'Org' },
    membership: { role },
    user: { id: 'user-1' },
  })
}

const emptyCoverage = () => ({
  outcomes: [],
  monetizedOutcomeIds: [],
  missingDispositionOutcomeIds: [],
  notMonetizedByReason: {
    no_defensible_proxy: [], proxy_not_approved: [], insufficient_evidence: [], not_material: [],
    not_yet_eligible: [], superseded_version: [], other_governed_reason: [],
  },
  materialNotMonetizedOutcomeIds: [],
  unclassifiedOutcomeIds: [],
  hasDefensibleMonetization: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockRole('analyst')
  mockListSroiRunReviews.mockResolvedValue([])
  mockGetRunMonetizationCoverage.mockResolvedValue(emptyCoverage())
  mockFetchOutcomes.mockResolvedValue([
    { id: OUT_A, title: 'Acceso a agua', outcomeType: null, description: null, materialityScore: 4, materialityRationale: 'score legacy', materialityClassification: null, materialityClassificationJustification: null },
    { id: OUT_B, title: 'Ingreso familiar', outcomeType: null, description: null, materialityScore: null, materialityRationale: null, materialityClassification: 'not_material', materialityClassificationJustification: 'Fuera del alcance del análisis.' },
  ])
  tableRows.current = {}
})

// ---------------------------------------------------------------------------
// FIBIU-11 — outcomes page
// ---------------------------------------------------------------------------
describe('FIBIU-11 outcomes page (P-UI-11-1 / N-UI-11-1)', () => {
  async function renderOutcomes() {
    return render(await OutcomesPage({ params: Promise.resolve({ projectId: PROJECT }) }))
  }

  it('P-UI-11-1: renders a human classification form per outcome (material / not_material / unclassified + justification), the current state, and the legacy score labelled non-determinative', async () => {
    const { container } = await renderOutcomes()
    const blockA = within(screen.getByTestId(`materiality-classification-${OUT_A}`))
    expect(blockA.getByText(/Sin clasificar — pendiente de decisión humana/)).toBeInTheDocument()
    const select = blockA.getByLabelText('Clasificación') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'material', 'not_material'])
    expect(blockA.getByLabelText('Justificación metodológica')).toBeInTheDocument()
    expect(blockA.getByRole('button', { name: 'Clasificar' })).toBeInTheDocument()

    const blockB = within(screen.getByTestId(`materiality-classification-${OUT_B}`))
    expect(blockB.getByText(/No material — Fuera del alcance del análisis\./)).toBeInTheDocument()
    expect((blockB.getByLabelText('Clasificación') as HTMLSelectElement).value).toBe('not_material')

    // Legacy 1-5 score: visible, explicitly non-determinative.
    expect(screen.getAllByText('apoyo — no determinante').length).toBe(2)
    expect(screen.getByText(/4\/5 — score legacy/)).toBeInTheDocument()
    // The classification write path is the human form: hidden project/outcome ids, no run id, no Stella field.
    const formA = blockA.getByRole('button', { name: 'Clasificar' }).closest('form')!
    expect(formA.querySelector('input[name="projectId"]')).not.toBeNull()
    expect(formA.querySelector('input[name="outcomeId"]')).not.toBeNull()
    expect(container.querySelectorAll('input[name="materialityClassification"]')).toHaveLength(0)
  })

  it('N-UI-11-1: no Stella control participates in classification — the classification block carries no Stella prefill/action and the legacy score form never writes the classification', async () => {
    await renderOutcomes()
    const blockA = screen.getByTestId(`materiality-classification-${OUT_A}`)
    expect(blockA.textContent).toMatch(/Stella no clasifica/)
    expect(blockA.querySelector('[data-stella], [name*="stella" i]')).toBeNull()
    // The legacy score form has no classification field at all.
    const scoreSelect = screen.getByLabelText('Score', { selector: `#materiality-score-${OUT_A}` })
    const scoreForm = scoreSelect.closest('form')!
    expect(scoreForm.querySelector('select[name="materialityClassification"]')).toBeNull()
    expect(mockSetClassification).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// FIBIU-12 — run detail page
// ---------------------------------------------------------------------------
const RUN_ROW = (sroiRatio: string | null) => ({
  id: RUN,
  projectId: PROJECT,
  version: 2,
  status: 'calculated',
  sroiRatio,
  netSocialValue: '0',
  grossSocialValue: '0',
  totalInvestment: '1000',
  currency: 'USD',
  calculatedAt: new Date('2026-01-01'),
  calculatedBy: 'user-author',
  methodologyVersion: 'v1',
  calculationEngineVersion: 'v1',
  buildIdentity: 'build-1',
})

describe('FIBIU-12 run detail page (P-UI-12-1 / P-UI-12-2 / P-UI-12-3)', () => {
  async function renderRun() {
    return render(await RunDetailPage({ params: Promise.resolve({ projectId: PROJECT, runId: RUN }) }))
  }

  beforeEach(() => {
    mockGetCalculationRunDetail.mockResolvedValue({
      run: RUN_ROW(null),
      lineItems: [{ id: 'li-1', runId: RUN, assignmentId: ASSIGNMENT, outcomeId: OUT_A, quantity: '1', proxyValue: '1', currency: 'USD', grossValue: '1', adjustedValue: '1', deadweightPct: '0', attributionPct: '0', displacementPct: '0', dropoffPct: '0' }],
      snapshotJson: { sroiRatio: null, noRatioReason: 'NO_DEFENSIBLE_MONETIZATION' },
      currency: 'USD',
      projectContext: { id: PROJECT, organizationId: 'org-1' },
    })
    mockGetRunMonetizationCoverage.mockResolvedValue({
      ...emptyCoverage(),
      outcomes: [
        { outcomeId: OUT_A, bucket: 'missing_disposition', materialityClassification: 'material', engineMonetized: true, disposition: null },
        { outcomeId: OUT_B, bucket: 'not_monetized:proxy_not_approved', materialityClassification: 'material', engineMonetized: false, disposition: { disposition: 'not_monetized', reason: 'proxy_not_approved', justification: 'Proxy en revisión.' } },
      ],
      missingDispositionOutcomeIds: [OUT_A],
      notMonetizedByReason: { ...emptyCoverage().notMonetizedByReason, proxy_not_approved: [OUT_B] },
      materialNotMonetizedOutcomeIds: [OUT_B],
      hasDefensibleMonetization: false,
    })
  })

  it('P-UI-12-1: an analyst sees, per outcome, a disposition form bound to THIS run (hidden field only, no run id field) with the seven governed reasons and a justification', async () => {
    const { container } = await renderRun()
    const panel = within(screen.getByTestId('monetization-coverage'))
    expect(panel.getAllByLabelText('Disposición de monetización')).toHaveLength(2)
    const reasonSelect = panel.getAllByLabelText('Razón gobernada')[0] as HTMLSelectElement
    expect(Array.from(reasonSelect.options).map((o) => o.value)).toEqual([
      '', 'no_defensible_proxy', 'proxy_not_approved', 'insufficient_evidence', 'not_material', 'not_yet_eligible', 'superseded_version', 'other_governed_reason',
    ])
    expect(panel.getAllByLabelText('Justificación de la disposición')).toHaveLength(2)
    expect(container.querySelectorAll('input[name="calculationRunId"], input[name="runId"]')).toHaveLength(0)
    expect(container.querySelector(`input[name="outcomeId"][value="${OUT_A}"]`)).not.toBeNull()
  })

  it('P-UI-12-2: the coverage panel is rendered BEFORE the review/approval form, with distinct per-reason buckets and the missing disposition visible', async () => {
    await renderRun()
    const coverage = screen.getByTestId('monetization-coverage')
    const reviews = screen.getByText('Revisiones Metodológicas')
    // DOCUMENT_POSITION_FOLLOWING (4): reviews come after the coverage panel.
    expect(coverage.compareDocumentPosition(reviews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('coverage-missing-count').textContent).toBe('1')
    expect(screen.getByTestId('coverage-reason-proxy_not_approved').textContent).toBe('1')
    expect(screen.getByTestId('coverage-reason-no_defensible_proxy').textContent).toBe('0')
    expect(screen.getByText('Sin disposición')).toBeInTheDocument()
    expect(screen.getByText(/No monetizado — Proxy no aprobado/)).toBeInTheDocument()
    expect(screen.getByTestId('coverage-defensible').textContent).toContain('No — sin ratio SROI')
    // Seven distinct reason rows, none collapsed.
    expect(within(screen.getByTestId('coverage-by-reason')).getAllByRole('listitem')).toHaveLength(7)
  })

  it('P-UI-12-3: a run persisted with sroi_ratio NULL shows the explicit no-ratio state on the KPI — never "0.00:1" and never a bare dash', async () => {
    await renderRun()
    expect(screen.getByTestId('run-no-ratio').textContent).toBe('Sin ratio SROI')
    expect(screen.queryByText('0.00:1')).toBeNull()
    expect(screen.getByText(/Ningún resultado tiene monetización defendible/)).toBeInTheDocument()
  })

  it('a viewer sees the coverage but never the disposition form; an approved run shows the immutability note instead of the form', async () => {
    mockRole('viewer')
    await renderRun()
    expect(screen.getByTestId('monetization-coverage')).toBeInTheDocument()
    expect(screen.queryAllByLabelText('Disposición de monetización')).toHaveLength(0)

    mockRole('analyst')
    mockListSroiRunReviews.mockResolvedValue([{ id: 'rev-1', status: 'approved', createdAt: new Date(), items: [] }])
    const { unmount } = await renderRun()
    expect(screen.queryAllByLabelText('Disposición de monetización')).toHaveLength(0)
    expect(screen.getByText(/Corrida aprobada: las disposiciones son inmutables/)).toBeInTheDocument()
    unmount()
  })
})

// ---------------------------------------------------------------------------
// FIBIU-13 + FIBIU-12 — calculation page
// ---------------------------------------------------------------------------
describe('FIBIU-13 / FIBIU-12 calculation page (P-UI-13-1 / P-UI-13-2 / N-UI-13-1 / P-UI-12-3 / N-UI-12-1)', () => {
  async function renderCalc() {
    return render(await CalculationPage({ params: Promise.resolve({ projectId: PROJECT }) }))
  }

  beforeEach(() => {
    tableRows.current = {
      outcome_proxy_assignments: [{
        assignment: { id: ASSIGNMENT, outcomeId: OUT_A, proxyId: 'proxy-1', projectId: PROJECT, organizationId: 'org-1', assignmentStatus: 'active' },
        outcome: { id: OUT_A, title: 'Acceso a agua', materialityClassification: null },
        proxy: { id: 'proxy-1', name: 'Proxy agua', value: '10', currency: 'USD', unit: 'persona' },
      }],
      sroi_filter_sets: [{
        id: 'fs-1', assignmentId: ASSIGNMENT, organizationId: 'org-1',
        deadweightPct: '0', attributionPct: null, displacementPct: '15', dropoffPct: '', durationYears: 3,
        deadweightJustification: 'No hay contrafactual: la población no tenía acceso.', attributionJustification: null,
        displacementJustification: null, dropoffJustification: null, durationJustification: 'Efecto estimado a 3 años.',
        justification: null,
      }],
    }
    mockGetSroiCalculationReadiness.mockResolvedValue({ canCalculate: true, blockingReasons: [], issues: [], currencyMismatch: false })
    mockCalculateSroiPreview.mockResolvedValue({
      canCalculate: true,
      readiness: { canCalculate: true, blockingReasons: [], issues: [], currencyMismatch: false },
      result: {
        currency: 'USD', totalInvestment: 1000, grossSocialValue: 0, netSocialValue: 0,
        sroiRatio: null, noRatioReason: 'NO_DEFENSIBLE_MONETIZATION', hasDefensibleMonetization: false, monetizedOutcomeIds: [],
        materialityUnclassifiedOutcomeIds: [OUT_A],
        preliminaryFilterAssumptions: [{ assignmentId: ASSIGNMENT, outcomeId: OUT_A, filter: 'attribution', assumedValue: 0 }],
        lineItems: [], fundersBreakdown: [], unattributedNsvUsd: '0.0000',
        skippedAssignments: [{ outcomeId: OUT_A, reason: 'not_material' }],
        discountRatePct: null, formulaNotes: 'Values normalized to USD. No discount rate applied.',
      },
    })
    mockCalculateSroiScenarios.mockResolvedValue({ canCalculate: false, readiness: null, scenarios: null, deltaPp: 10 })
    mockListSroiCalculationRuns.mockResolvedValue([
      { ...RUN_ROW(null), version: 1, createdAt: new Date('2026-01-01') },
      { ...RUN_ROW('2.500000'), id: 'run-2', version: 2, createdAt: new Date('2026-02-01') },
    ])
  })

  it('P-UI-13-1: renders one discrete justification field per governed filter (five) plus the legacy shared field, wired to the existing upsert action names', async () => {
    const { container } = await renderCalc()
    for (const name of ['deadweightJustification', 'attributionJustification', 'displacementJustification', 'dropoffJustification', 'durationJustification']) {
      expect(container.querySelector(`input[name="${name}"]`), name).not.toBeNull()
    }
    expect(container.querySelector('input[name="justification"]')).not.toBeNull()
    expect(screen.getByLabelText('Justificación de deadweight')).toBeInTheDocument()
    expect(screen.getByLabelText('Justificación de duración')).toBeInTheDocument()
  })

  it('P-UI-13-2 / N-UI-13-1: a justified 0 and an unknown value are visually and textually distinct — and the unknown input is NOT prefilled with 0', async () => {
    const { container } = await renderCalc()
    expect(screen.getByTestId(`filter-state-deadweight-${ASSIGNMENT}`).textContent).toBe('0 justificado (valor explícito)')
    expect(screen.getByTestId(`filter-state-attribution-${ASSIGNMENT}`).textContent).toBe('Desconocido / sin definir — no es 0')
    expect(screen.getByTestId(`filter-state-dropoff-${ASSIGNMENT}`).textContent).toBe('Desconocido / sin definir — no es 0')
    expect(screen.getByTestId(`filter-state-displacement-${ASSIGNMENT}`).textContent).toBe('Valor sin justificación')
    expect(screen.getByTestId(`filter-state-duration-${ASSIGNMENT}`).textContent).toBe('Valor justificado')
    expect((container.querySelector('input[name="attributionPct"]') as HTMLInputElement).value).toBe('')
    expect((container.querySelector('input[name="deadweightPct"]') as HTMLInputElement).value).toBe('0')
  })

  it('P-UI-12-3 / N-UI-12-1: the preview shows the explicit no-ratio state (no NaN, no 0.00:1), itemizes the unclassified contribution, the preliminary filter assumption and the not_material exclusion; the run list never renders 0.00:1 for a run without a ratio', async () => {
    await renderCalc()
    expect(screen.getByTestId('preview-no-ratio').textContent).toBe('Sin ratio SROI')
    expect(screen.getByTestId('preview-no-ratio-notice')).toBeInTheDocument()
    expect(screen.getByTestId('preview-unclassified-notice').textContent).toContain('Acceso a agua')
    expect(screen.getByTestId('preview-filter-assumptions').textContent).toContain('attribution asumido como 0')
    expect(screen.getByTestId('preview-skipped').textContent).toContain('clasificado no material')
    expect(document.body.textContent).not.toContain('NaN')
    expect(document.body.textContent).not.toContain('0.00:1')
    // Run list: v1 has no ratio, v2 has 2.50:1.
    expect(screen.getAllByText('Sin ratio SROI').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('2.50:1')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// N-RATIO-4 — public verification page
// ---------------------------------------------------------------------------
describe('N-RATIO-4 public verification page', () => {
  const data = (sroiRatio: string | null) => ({
    report: { title: 'Reporte', lockedAt: new Date('2026-03-01') },
    project: { name: 'Proyecto' },
    organization: { name: 'Org' },
    run: { totalInvestment: '1000', grossSocialValue: '0', netSocialValue: '0', currency: 'USD', sroiRatio },
  })

  it('renders "Sin ratio SROI" for a locked report whose run has sroi_ratio NULL — never null:1 / 0:1 / 0.00:1', async () => {
    mockGetPublicVerifiedReport.mockResolvedValue(data(null))
    render(await VerifyPage({ params: Promise.resolve({ hash: 'abc' }) }))
    expect(screen.getByTestId('verify-no-ratio').textContent).toContain('Sin ratio SROI')
    expect(document.body.textContent).not.toMatch(/null:1|0:1|0\.00:1/)
  })

  it('still renders the numeric ratio when the run has one', async () => {
    mockGetPublicVerifiedReport.mockResolvedValue(data('2.500000'))
    render(await VerifyPage({ params: Promise.resolve({ hash: 'abc' }) }))
    expect(screen.getByText('2.500000:1')).toBeInTheDocument()
  })
})
