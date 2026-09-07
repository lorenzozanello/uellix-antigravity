// tests/sensitivity-scenario.service.test.ts
// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — service-layer controls for
// recordSensitivityScenario: the base result is recomputed fresh through the
// SAME deterministic engine before any substitution, proving reproduction
// (POS-18-4); a one_at_a_time scenario substitutes exactly one candidate
// (POS-18-5); a combined scenario substitutes >=2 candidates and always
// carries combination_description (POS-18-6); the base run itself is never
// mutated by recording a scenario (POS-18-7); mismatched cardinality is
// refused (NEG-18-3); and a scenario may only be recorded against candidates
// disposed variation_required (NEG-18-5). runDeterministicCalc/parseNum are
// the REAL pure engine (not mocked) — only loadCalculationData is stubbed to
// supply a fixed, hand-verifiable assignment. MUT-18-5 is proven by the
// dedicated mutation campaign, not here.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/auth/session', () => ({ requireOrganizationAccess: vi.fn() }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})

const ORG_ID = 'org-1'
const PROJECT_ID = 'proj-1'
const RUN_ID = 'run-1'
const USER_ID = 'user-1'
const DEADWEIGHT_CANDIDATE_ID = 'cand-deadweight'
const PROXY_CANDIDATE_ID = 'cand-proxy'
const PENDING_CANDIDATE_ID = 'cand-pending'

// quantity=10 * proxyValue=100, all filters 0, duration=1, discount=0 ->
// grossValue = netSocialValue = 1000.00; investment 500.00 -> ratio 2.000000.
const { HAPPY_ASSIGNMENT } = vi.hoisted(() => ({
  HAPPY_ASSIGNMENT: {
    assignment: { id: 'asgn-1', outcomeId: 'out-1' },
    input: { quantity: '10' },
    filterSet: { deadweightPct: '0', attributionPct: '0', displacementPct: '0', dropoffPct: '0', durationYears: 1 },
    proxy: { id: 'proxy-1' },
    proxyVersion: { id: 'pv-1', valueUsd: '100' },
    outcome: { id: 'out-1', materialityClassification: 'material' },
  },
}))

vi.mock('@/lib/pipeline/sroi-calculation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipeline/sroi-calculation')>()
  return { ...actual, loadCalculationData: vi.fn().mockResolvedValue({ assignmentData: [HAPPY_ASSIGNMENT] }) }
})

const mockDb: Record<string, any[]> = {}

function resetMockDb() {
  mockDb.projects = [{ id: PROJECT_ID, organizationId: ORG_ID }]
  mockDb.sroiCalculationRuns = [{
    id: RUN_ID, projectId: PROJECT_ID, methodologyVersion: '1.0.0', calculationEngineVersion: '1.0.0',
    snapshotJson: { monetizedOutcomeIds: ['out-1'], discountRatePct: '0', investments: [{ amountUsd: '500' }] },
  }]
  mockDb.sroiRunReviews = []
  mockDb.sensitivityCandidates = [
    { id: DEADWEIGHT_CANDIDATE_ID, projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, candidateKey: 'methodological_filter:asgn-1:deadweight', candidateKind: 'methodological_filter', inputReference: { assignmentId: 'asgn-1', outcomeId: 'out-1', filter: 'deadweight' }, baseValue: '0', disposition: 'variation_required' },
    { id: PROXY_CANDIDATE_ID, projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, candidateKey: 'proxy_value:asgn-1:pv-1', candidateKind: 'proxy_value', inputReference: { assignmentId: 'asgn-1', outcomeId: 'out-1', proxyId: 'proxy-1', proxyVersionId: 'pv-1' }, baseValue: '100', disposition: 'variation_required' },
    { id: PENDING_CANDIDATE_ID, projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID, candidateKey: 'methodological_filter:asgn-1:attribution', candidateKind: 'methodological_filter', inputReference: { assignmentId: 'asgn-1', outcomeId: 'out-1', filter: 'attribution' }, baseValue: '0', disposition: 'pending' },
  ]
  mockDb.sensitivityScenarios = []
  mockDb.governedModelRegistry = [{ modelId: 'SROI_SENSITIVITY_MODEL', version: '1.0.0', effectiveFrom: new Date('2026-01-01') }]
}
resetMockDb()

function getTableData(table: any): any[] {
  const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
  if (!pgName) return []
  const camelName = pgName.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
  return mockDb[camelName] ?? mockDb[pgName] ?? []
}

function getTableName(table: any): string | undefined {
  const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
  return pgName?.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
}

/**
 * recordSensitivityScenario's own cardinality check
 * (`candidates.length !== candidateIds.length`) needs the sensitivityCandidates
 * lookup to genuinely respect its inArray(id, candidateIds) filter -- unlike
 * every other query in this suite, which tolerates the reflective "ignore
 * where(), return the whole table" mock (see the sibling register/disposition
 * test files). This walks drizzle's SQL AST for the literal id values an
 * inArray/eq condition carries, scoped to this one call site.
 */
function extractWhereParamValues(condition: unknown): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  function collect(node: unknown) {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const cname = (node as any).constructor?.name
    if (cname === 'Param') { collect((node as any).value); if (typeof (node as any).value !== 'object') out.push((node as any).value); return }
    if (Array.isArray((node as any).queryChunks)) { (node as any).queryChunks.forEach(collect); return }
    if (cname === 'Array') { Array.from(node as any).forEach(collect); return }
  }
  collect(condition)
  return out
}

vi.mock('@/db/client', () => {
  const dbMock: any = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: any) => {
        const data = getTableData(table)
        const isSensitivityCandidates = getTableName(table) === 'sensitivityCandidates'
        const queryResult: any = {
          where: vi.fn().mockImplementation((condition: unknown) => {
            if (isSensitivityCandidates) {
              const paramValues = new Set(extractWhereParamValues(condition))
              queryResult.__filtered = data.filter((row: any) => paramValues.has(row.id))
            }
            return queryResult
          }),
          orderBy: vi.fn().mockImplementation(() => queryResult),
          limit: vi.fn().mockImplementation(() => queryResult),
          then: (cb: any) => Promise.resolve(cb(queryResult.__filtered ?? data)),
        }
        return queryResult
      }),
    })),
    insert: vi.fn().mockImplementation((table: any) => ({
      values: vi.fn().mockImplementation((vals: any) => ({
        returning: vi.fn().mockImplementation(() => {
          const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
          const camelName = pgName?.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
          const inserted = { ...vals, id: 'scenario-1' }
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
import { recordSensitivityScenario } from '@/lib/pipeline/sroi-sensitivity'

// resultJson/baseResultJson are jsonb columns typed `unknown` by drizzle's
// inferred select type; this test only ever reads the toResultSummary() shape
// recordSensitivityScenario itself writes.
function asResult(value: unknown): { netSocialValueExact: string; sroiRatioExact: string | null } {
  return value as { netSocialValueExact: string; sroiRatioExact: string | null }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetMockDb()
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' },
  } as any)
})

describe('recordSensitivityScenario', () => {
  it('POS-18-4: recomputes the base result fresh through the same engine — the reproduction proof — matching the hand-verified base figures', async () => {
    const scenario = await recordSensitivityScenario(PROJECT_ID, RUN_ID, {
      scenarioKind: 'one_at_a_time',
      substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
      reason: 'Testing sensitivity to the deadweight assumption.',
    })
    expect(asResult(scenario.baseResultJson).netSocialValueExact).toBe('1000.0000')
    expect(asResult(scenario.baseResultJson).sroiRatioExact).toBe('2.000000')
  })

  it('POS-18-5: a one_at_a_time scenario substitutes exactly one candidate and recomputes the result', async () => {
    const scenario = await recordSensitivityScenario(PROJECT_ID, RUN_ID, {
      scenarioKind: 'one_at_a_time',
      substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
      reason: 'Testing sensitivity to the deadweight assumption.',
    })
    expect(scenario.scenarioKind).toBe('one_at_a_time')
    // deadweight 0 -> 50: net social value halves (1000 -> 500), ratio 2.0 -> 1.0.
    expect(asResult(scenario.resultJson).netSocialValueExact).toBe('500.0000')
    expect(asResult(scenario.resultJson).sroiRatioExact).toBe('1.000000')
  })

  it('POS-18-6: a combined scenario substitutes >=2 candidates, requires combination_description, and recomputes jointly', async () => {
    const scenario = await recordSensitivityScenario(PROJECT_ID, RUN_ID, {
      scenarioKind: 'combined',
      substitutions: [
        { candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' },
        { candidateId: PROXY_CANDIDATE_ID, alternativeValue: '50' },
      ],
      reason: 'Joint pessimistic scenario.',
      combinationDescription: 'Deadweight doubled and proxy value halved together.',
    })
    expect(scenario.scenarioKind).toBe('combined')
    expect(scenario.combinationDescription).toBe('Deadweight doubled and proxy value halved together.')
    // deadweight 0->50 halves the adjustment factor; proxy 100->50 halves the
    // gross value too: 1000 * 0.5 * 0.5 = 250.
    expect(asResult(scenario.resultJson).netSocialValueExact).toBe('250.0000')
  })

  it('POS-18-7: recording a scenario never mutates the base calculation run row', async () => {
    const before = JSON.stringify(mockDb.sroiCalculationRuns[0])
    await recordSensitivityScenario(PROJECT_ID, RUN_ID, {
      scenarioKind: 'one_at_a_time',
      substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
      reason: 'Testing sensitivity to the deadweight assumption.',
    })
    expect(JSON.stringify(mockDb.sroiCalculationRuns[0])).toBe(before)
  })

  it('emits the audit verb with the scenario kind and substituted candidate ids', async () => {
    const scenario = await recordSensitivityScenario(PROJECT_ID, RUN_ID, {
      scenarioKind: 'one_at_a_time',
      substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
      reason: 'Testing sensitivity to the deadweight assumption.',
    })
    expect(vi.mocked(logAuditAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.SENSITIVITY_SCENARIO_RECORDED,
        entityId: scenario.id,
        afterJson: expect.objectContaining({ scenarioKind: 'one_at_a_time', candidateIds: [DEADWEIGHT_CANDIDATE_ID] }),
      })
    )
  })

  it('NEG-18-3: refuses a one_at_a_time scenario with more than one substitution', async () => {
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'one_at_a_time',
        substitutions: [
          { candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' },
          { candidateId: PROXY_CANDIDATE_ID, alternativeValue: '50' },
        ],
        reason: 'x',
      })
    ).rejects.toThrow(/exactly one/i)
  })

  it('NEG-18-3: refuses a combined scenario with fewer than two substitutions', async () => {
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'combined',
        substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
        reason: 'x',
        combinationDescription: 'y',
      })
    ).rejects.toThrow(/two or more/i)
  })

  it('NEG-18-3: refuses a combined scenario without combination_description', async () => {
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'combined',
        substitutions: [
          { candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' },
          { candidateId: PROXY_CANDIDATE_ID, alternativeValue: '50' },
        ],
        reason: 'x',
      })
    ).rejects.toThrow(/combination_description/i)
  })

  it('refuses a scenario with an empty reason', async () => {
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'one_at_a_time',
        substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
        reason: '   ',
      })
    ).rejects.toThrow(/reason/i)
  })

  it('NEG-18-5: refuses to record a scenario for a candidate not disposed variation_required', async () => {
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'one_at_a_time',
        substitutions: [{ candidateId: PENDING_CANDIDATE_ID, alternativeValue: '50' }],
        reason: 'x',
      })
    ).rejects.toThrow(/variation_required/i)
  })

  it('refuses when a substituted candidate cannot be found for this run', async () => {
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'one_at_a_time',
        substitutions: [{ candidateId: 'does-not-exist', alternativeValue: '50' }],
        reason: 'x',
      })
    ).rejects.toThrow(/not found/i)
  })

  it('refuses to record a scenario for an already-approved run', async () => {
    mockDb.sroiRunReviews = [{ calculationRunId: RUN_ID, status: 'approved' }]
    await expect(
      recordSensitivityScenario(PROJECT_ID, RUN_ID, {
        scenarioKind: 'one_at_a_time',
        substitutions: [{ candidateId: DEADWEIGHT_CANDIDATE_ID, alternativeValue: '50' }],
        reason: 'x',
      })
    ).rejects.toThrow(/already approved/i)
  })
})
