// tests/sroi-readiness.service.test.ts
// FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17) — service-layer controls for
// computeAndPersistReadinessAssessment: immutability (one row per run,
// POS-17-6), the governed-model-version requirement, the audit verb
// (POS-17-7), and the absence of any human/Stella point-injection path
// (NEG-17-9). DB-free: mocks @/db/client generically and stubs the two
// heavier collaborators (loadCalculationData, checkCausalChainSufficiency)
// so this file exercises sroi-readiness.ts's OWN assembly/persistence logic,
// not sroi-calculation.ts's already-tested internal joins.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
}))

vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})

const ORG_ID = 'org-1'
const PROJECT_ID = 'proj-1'
const RUN_ID = 'run-1'
const USER_ID = 'user-1'

const { HAPPY_ASSIGNMENT } = vi.hoisted(() => ({
  HAPPY_ASSIGNMENT: {
    assignment: { id: 'asgn-1', outcomeId: 'out-1' },
    input: { quantity: '10' },
    filterSet: {
      deadweightPct: '20', attributionPct: '10', displacementPct: '0', dropoffPct: '5', durationYears: 3,
      deadweightJustification: 'j', attributionJustification: 'j', displacementJustification: 'j',
      dropoffJustification: 'j', durationJustification: 'j',
    },
    proxy: { id: 'proxy-1' },
    proxyVersion: {
      id: 'pv-1', reviewStatus: 'approved', valueUsd: '100',
      geographicContextualScope: 'x', linkedOutcomeContext: 'x', recoverableReference: 'x',
      relevanceJustification: 'x', consultationDate: new Date('2026-01-01'),
      c1SourceQualityVerifiability: 3, c2OutcomeCorrespondence: 3, c3StakeholderPopulationFit: 3,
      c4GeographicContextFit: 3, c5TemporalFit: 3, c6MethodologicalUnitComparability: 3,
      r1ProvenanceRisk: 0, r2SourceLimitationRisk: 0, r3ConceptualFitRisk: 0,
      r4GeographicPopulationTransferRisk: 0, r5TemporalObsolescenceRisk: 0, r6TransformationRisk: 0,
      r7MethodologicalUncertaintyRisk: 0, confidenceLevel: 'high', methodologicalRisk: 'low',
      exceptionalDefendibilityDetermination: null,
    },
    outcome: { id: 'out-1' },
  },
}))

vi.mock('@/lib/pipeline/sroi-calculation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipeline/sroi-calculation')>()
  return { ...actual, loadCalculationData: vi.fn().mockResolvedValue({ assignmentData: [HAPPY_ASSIGNMENT] }) }
})

vi.mock('@/lib/pipeline/theory-of-change', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipeline/theory-of-change')>()
  return { ...actual, checkCausalChainSufficiency: vi.fn().mockReturnValue({ sufficient: true, reason: 'sufficient' }) }
})

const mockDb: Record<string, any[]> = {
  projects: [{ id: PROJECT_ID, organizationId: ORG_ID, governanceRegime: 'pc01b' }],
  sroiCalculationRuns: [{
    id: RUN_ID, projectId: PROJECT_ID, methodologyVersion: '1.0.0', calculationEngineVersion: '1.0.0', buildIdentity: 'b1',
    snapshotJson: {
      monetizedOutcomeIds: ['out-1'],
      skippedAssignments: [],
      inputVersions: [{ objectType: 'project_investment', objectId: 'inv-1', versionId: 'v-1' }],
    },
  }],
  impactNarratives: [{ narrativeText: 'Acceso a agua segura.', createdAt: new Date('2026-01-01') }],
  stakeholderGroups: [{ id: 'sg-1' }],
  theoryOfChangeNodes: [{ id: 'toc-1' }],
  theoryOfChangeLinks: [],
  outcomes: [{ id: 'out-1', status: 'active', materialityClassification: 'material', materialityClassificationJustification: 'j', stakeholderGroupId: 'sg-1' }],
  indicators: [{ id: 'ind-1', outcomeId: 'out-1', status: 'active', unit: 'count', dataSource: 'survey', measurementPeriod: '2026', actualValue: '10' }],
  evidenceItems: [{ id: 'ev-1', outcomeId: 'out-1', type: 'file', status: 'approved', createdBy: USER_ID, createdAt: new Date(), filePath: '/f' }],
  evidenceVersions: [{ evidenceId: 'ev-1', ordinal: 1, sensitivityClassification: 'non_sensitive', legacyContentUnverifiable: false, content: null, contentHash: null }],
  evidenceSufficiencyDeterminations: [{ outcomeId: 'out-1', calculationRunId: RUN_ID, ordinal: 1 }],
  outcomeMonetizationDispositions: [{ outcomeId: 'out-1', calculationRunId: RUN_ID, disposition: 'monetized' }],
  counterfactualAssessments: [{ outcomeId: 'out-1', calculationRunId: RUN_ID, baselineAvailability: 'available', sources: 'x', basisKind: 'baseline_observation' }],
  methodologicalAssumptions: [{ id: 'a-1', materialityFlag: 'material' }],
  assumptionObjectLinks: [{ assumptionId: 'a-1' }],
  sensitivityCandidates: [{ id: 'c-1', disposition: 'no_additional_variation_required' }],
  sensitivityScenarios: [],
  stellaInteractions: [],
  // D10-5 — the run's own creation audit event.
  auditLogs: [{ id: 'audit-1', entityId: RUN_ID, action: 'sroi_calculation_run.calculated' }],
  sroiRunReviews: [{ status: 'approved', reviewerId: 'reviewer-1', createdBy: 'author-1' }],
  readinessAssessments: [],
  governedModelRegistry: [{ modelId: 'SROI_READINESS_MODEL', version: '1.0.0', effectiveFrom: new Date('2026-01-01') }],
}

function getTableData(table: any): any[] {
  const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
  if (!pgName) return []
  const camelName = pgName.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
  return mockDb[camelName] ?? mockDb[pgName] ?? []
}

vi.mock('@/db/client', () => {
  const dbMock: any = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: any) => {
        const data = getTableData(table)
        const queryResult: any = {
          where: vi.fn().mockImplementation(() => queryResult),
          limit: vi.fn().mockImplementation(() => queryResult),
          orderBy: vi.fn().mockImplementation(() => queryResult),
          then: (cb: any) => Promise.resolve(cb(data)),
        }
        return queryResult
      }),
    })),
    insert: vi.fn().mockImplementation((table: any) => ({
      values: vi.fn().mockImplementation((vals: any) => ({
        returning: vi.fn().mockImplementation(() => {
          const inserted = { ...vals, id: 'new-readiness-id' }
          const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
          const camelName = pgName?.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
          if (camelName && mockDb[camelName]) mockDb[camelName].push(inserted)
          return Promise.resolve([inserted])
        }),
      })),
    })),
  }
  return { db: dbMock }
})

import { requireOrganizationAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { computeAndPersistReadinessAssessment } from '@/lib/pipeline/sroi-readiness'

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.readinessAssessments = []
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' },
  } as any)
})

describe('computeAndPersistReadinessAssessment', () => {
  it('POS-17-6 / POS-17-7: persists exactly one readiness_assessments row with the global score, dimension scores, criterion detail and readiness_model_version, and emits the audit verb', async () => {
    const row = await computeAndPersistReadinessAssessment(PROJECT_ID, RUN_ID)
    expect(row.calculationRunId).toBe(RUN_ID)
    expect(row.readinessModelVersion).toBe('1.0.0')
    expect(row.globalScore).toBe('98.00')
    expect(row.dimensionScores).toBeDefined()
    expect(row.criteriaDetail).toHaveLength(46)
    expect(row.createdBy).toBe(USER_ID)

    expect(vi.mocked(logAuditAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.READINESS_ASSESSMENT_COMPUTED, actorUserId: USER_ID })
    )
  })

  it('POS-17-6: immutable — a second call for the SAME run refuses rather than overwriting', async () => {
    await computeAndPersistReadinessAssessment(PROJECT_ID, RUN_ID)
    await expect(computeAndPersistReadinessAssessment(PROJECT_ID, RUN_ID)).rejects.toThrow(/already exists|immutable/i)
    expect(mockDb.readinessAssessments).toHaveLength(1)
  })

  it('refuses when the governed model SROI_READINESS_MODEL is not registered', async () => {
    mockDb.governedModelRegistry = []
    await expect(computeAndPersistReadinessAssessment(PROJECT_ID, RUN_ID)).rejects.toThrow(/SROI_READINESS_MODEL/)
  })

  it('NEG-17-9: no exported function accepts a caller-supplied global_score or criterion override', async () => {
    const readinessModule = await import('@/lib/pipeline/sroi-readiness')
    // The only mutation entry point takes (projectId, runId) — no score,
    // no dimension, no criterion override parameter exists anywhere in the
    // module's public surface.
    expect(readinessModule.computeAndPersistReadinessAssessment.length).toBe(2)
    expect(Object.keys(readinessModule)).not.toContain('setReadinessScore')
    expect(Object.keys(readinessModule)).not.toContain('overrideCriterion')
  })
})
