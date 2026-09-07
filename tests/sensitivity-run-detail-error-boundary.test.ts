// tests/sensitivity-run-detail-error-boundary.test.ts
// RD-BLK-1 remediation (independent FIBIU-18 audit blocker) — proves the
// run-detail page's FIBIU-17/18 reads fail CLOSED. The page used to wrap
// getReadinessAssessment / listSensitivityCandidates / listSensitivityScenarios
// / getRunSensitivityCompleteness in one broad try/catch that converted ANY
// failure — an authorization/RLS error included — into a synthesized empty
// state, with sensitivityCompleteness.complete hardcoded to true. That is a
// governance completeness predicate answering "yes, nothing is
// outstanding" for a state that was never actually verified.
//
// The fix removes the catch: these reads now behave exactly like every
// other read in the same server-component callback (reviews, inputDrift,
// coverage, sufficiency) — a thrown error propagates and fails the whole
// page render. This file renders the ACTUAL page component (same technique
// as tests/run-detail-page.sufficiency-reachability.test.tsx, which this
// file deliberately does not modify — it is not an authorized path under
// W2_B5_AUTHORITY_v1.0.0.json or its amendment).
//
//   POS-1  all four reads succeed -> the happy-path panel renders normally.
//   NEG-1  getReadinessAssessment rejects with an authorization-shaped error
//          -> the render itself rejects; nothing is synthesized.
//   NEG-2  listSensitivityCandidates rejects with an RLS-shaped error
//          -> the render itself rejects; never silently becomes an empty list.
//   NEG-3  getRunSensitivityCompleteness rejects with an unrelated,
//          unexpected error -> the render itself rejects; never becomes
//          { complete: true }.
//   NEG-4  a GENUINE zero-candidate run (the canonical service functions
//          themselves report zero, not an error) still renders successfully,
//          proving "nothing to report" and "could not be verified" are not
//          conflated in either direction.
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { PROJECT, RUN, OUTCOME_A, RUN_ROW, LINE_ITEMS } = vi.hoisted(() => {
  const PROJECT = '11111111-1111-4111-8111-111111111111'
  const RUN = '22222222-2222-4222-8222-222222222222'
  const OUTCOME_A = '33333333-3333-4333-8333-333333333333'

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
  ]

  return { PROJECT, RUN, OUTCOME_A, RUN_ROW, LINE_ITEMS }
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

vi.mock('@/lib/pipeline/evidence-sufficiency', () => ({
  getLatestSufficiencyDeterminationsByOutcomeIds: vi.fn().mockResolvedValue(new Map()),
}))

vi.mock('@/app/app/projects/[projectId]/pipeline/outcomes.actions', () => ({
  fetchOutcomes: vi.fn().mockResolvedValue([{ id: OUTCOME_A, title: 'Reducción del tiempo de acceso a agua' }]),
}))

// The module under this remediation — deliberately its own mock, unlike the
// unauthorized pre-existing test hosts that never anticipated it existing.
// Also stubs computeAndPersistReadinessAssessment (imported only by
// computeReadinessAssessment.action.ts, never invoked during a plain render).
const mockGetReadinessAssessment = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/sroi-readiness', () => ({
  getReadinessAssessment: mockGetReadinessAssessment,
  computeAndPersistReadinessAssessment: vi.fn(),
  READINESS_CRITERIA_COUNT: 46,
}))

// Stubs the three mutation entry points (dispositionSensitivityCandidate,
// recordSensitivityScenario, registerSensitivityCandidates) and
// SCENARIO_KIND_VALUES the action files import at module scope — none is
// invoked during a plain render, but the module must export them to satisfy
// those action files' own top-level imports.
const mockListSensitivityCandidates = vi.hoisted(() => vi.fn())
const mockListSensitivityScenarios = vi.hoisted(() => vi.fn())
const mockGetRunSensitivityCompleteness = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pipeline/sroi-sensitivity', () => ({
  listSensitivityCandidates: mockListSensitivityCandidates,
  listSensitivityScenarios: mockListSensitivityScenarios,
  getRunSensitivityCompleteness: mockGetRunSensitivityCompleteness,
  computeScenarioEnvelope: vi.fn(),
  registerSensitivityCandidates: vi.fn(),
  dispositionSensitivityCandidate: vi.fn(),
  recordSensitivityScenario: vi.fn(),
  SCENARIO_KIND_VALUES: ['one_at_a_time', 'combined'],
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

const READINESS_ROW = {
  id: 'ra-1',
  calculationRunId: RUN,
  readinessModelVersion: '1.0.0',
  globalScore: '72.00',
  band: 'advanced_preparation',
  dimensionScores: {},
  criteriaDetail: [],
}

const CANDIDATE_ROW = {
  id: 'cand-1',
  candidateKey: 'methodological_filter:a-1:deadweight',
  candidateKind: 'methodological_filter',
  disposition: 'pending',
  baseValue: '10',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireOrganizationAccess).mockReset()
  mockGetCalculationRunDetail.mockResolvedValue(detailWith(LINE_ITEMS))
  mockRole('impact_manager')
})

async function renderPage() {
  return render(
    await RunDetailPage({ params: Promise.resolve({ projectId: PROJECT, runId: RUN }) })
  )
}

describe('RunDetailPage FIBIU-17/18 error boundary (RD-BLK-1)', () => {
  it('POS-1: all four governed reads succeed -> the happy-path panel renders normally', async () => {
    mockGetReadinessAssessment.mockResolvedValue(READINESS_ROW)
    mockListSensitivityCandidates.mockResolvedValue([CANDIDATE_ROW])
    mockListSensitivityScenarios.mockResolvedValue([])
    mockGetRunSensitivityCompleteness.mockResolvedValue({
      complete: false,
      pendingCandidateIds: ['cand-1'],
      variationRequiredWithoutScenarioIds: [],
    })

    await renderPage()

    expect(screen.getByText('72.0')).toBeInTheDocument()
    expect(screen.getByText('Modelo 1.0.0')).toBeInTheDocument()
    expect(screen.getByText('methodological_filter:a-1:deadweight')).toBeInTheDocument()
    expect(screen.getByText(/Incompleto — 1 pendiente\(s\)/)).toBeInTheDocument()
  })

  it('NEG-1: an authorization failure from getReadinessAssessment is NOT swallowed — the render itself fails', async () => {
    mockGetReadinessAssessment.mockRejectedValue(new Error('Project not found or not owned'))
    mockListSensitivityCandidates.mockResolvedValue([])
    mockListSensitivityScenarios.mockResolvedValue([])
    mockGetRunSensitivityCompleteness.mockResolvedValue({ complete: true, pendingCandidateIds: [], variationRequiredWithoutScenarioIds: [] })

    await expect(renderPage()).rejects.toThrow('Project not found or not owned')
  })

  it('NEG-2: an RLS/access failure from listSensitivityCandidates is NOT converted into an empty list — the render itself fails', async () => {
    mockGetReadinessAssessment.mockResolvedValue(null)
    mockListSensitivityCandidates.mockRejectedValue(new Error('insufficient_privilege'))
    mockListSensitivityScenarios.mockResolvedValue([])
    mockGetRunSensitivityCompleteness.mockResolvedValue({ complete: true, pendingCandidateIds: [], variationRequiredWithoutScenarioIds: [] })

    await expect(renderPage()).rejects.toThrow('insufficient_privilege')
  })

  it('NEG-3: an unexpected service error from getRunSensitivityCompleteness is NOT converted into complete:true — the render itself fails', async () => {
    mockGetReadinessAssessment.mockResolvedValue(null)
    mockListSensitivityCandidates.mockResolvedValue([CANDIDATE_ROW])
    mockListSensitivityScenarios.mockResolvedValue([])
    mockGetRunSensitivityCompleteness.mockRejectedValue(new Error('unexpected failure'))

    await expect(renderPage()).rejects.toThrow('unexpected failure')
  })

  it('NEG-4: a GENUINE zero-candidate run (canonical semantics, not an error) still renders successfully — "nothing to report" is never conflated with "could not be verified"', async () => {
    mockGetReadinessAssessment.mockResolvedValue(null)
    mockListSensitivityCandidates.mockResolvedValue([])
    mockListSensitivityScenarios.mockResolvedValue([])
    // The canonical computeSensitivityCompleteness result for zero candidates
    // and zero scenarios really is { complete: true, ... } — the page must
    // still render this correctly-computed value, not refuse to render.
    mockGetRunSensitivityCompleteness.mockResolvedValue({ complete: true, pendingCandidateIds: [], variationRequiredWithoutScenarioIds: [] })

    await renderPage()

    expect(screen.getByText('Registrar candidatos de sensibilidad')).toBeInTheDocument()
    expect(screen.queryByText(/Registro completo/)).toBeNull()
    expect(screen.getByText('Aún no se ha computado la preparación para esta corrida.')).toBeInTheDocument()
  })
})
