// tests/sensitivity-register.test.ts
// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — service-layer controls for
// registerSensitivityCandidates: all five adjustment dimensions register
// even at 0/unchanged (POS-18-1), the other mandatory candidate kinds
// register (POS-18-2), and no retrospective backfill for a legacy run
// (NEG-18-8). Pure buildSensitivityCandidateDrafts controls already live in
// tests/sroi-sensitivity.service.test.ts; this file proves the same through
// the full DB-backed service path. Real-PG/RLS controls run exclusively
// through tests/postgres/b5-completeness.pg.test.ts.

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

const { HAPPY_ASSIGNMENT } = vi.hoisted(() => ({
  HAPPY_ASSIGNMENT: {
    assignment: { id: 'asgn-1', outcomeId: 'out-1' },
    input: { quantity: '10' },
    filterSet: { deadweightPct: '0', attributionPct: '10', displacementPct: '0', dropoffPct: '5', durationYears: 3 },
    proxy: { id: 'proxy-1' },
    proxyVersion: { id: 'pv-1', valueUsd: '100' },
    outcome: { id: 'out-1' },
  },
}))

vi.mock('@/lib/pipeline/sroi-calculation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipeline/sroi-calculation')>()
  return { ...actual, loadCalculationData: vi.fn().mockResolvedValue({ assignmentData: [HAPPY_ASSIGNMENT] }) }
})

const mockDb: Record<string, any[]> = {
  projects: [{ id: PROJECT_ID, organizationId: ORG_ID }],
  sroiCalculationRuns: [{
    id: RUN_ID, projectId: PROJECT_ID, methodologyVersion: '1.0.0', calculationEngineVersion: '1.0.0',
    snapshotJson: { monetizedOutcomeIds: ['out-1'], discountRatePct: '5.00' },
  }],
  sroiRunReviews: [],
  methodologicalAssumptions: [{ id: 'a-1', formulation: 'Some material assumption' }],
  sensitivityCandidates: [],
  governedModelRegistry: [{ modelId: 'SROI_SENSITIVITY_MODEL', version: '1.0.0', effectiveFrom: new Date('2026-01-01') }],
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
          orderBy: vi.fn().mockImplementation(() => queryResult),
          limit: vi.fn().mockImplementation(() => queryResult),
          then: (cb: any) => Promise.resolve(cb(data)),
        }
        return queryResult
      }),
    })),
    insert: vi.fn().mockImplementation((table: any) => ({
      values: vi.fn().mockImplementation((vals: any) => ({
        onConflictDoNothing: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(() => {
            const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
            const camelName = pgName?.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
            const existing = camelName ? mockDb[camelName] ?? [] : []
            if (existing.some((r: any) => r.calculationRunId === vals.calculationRunId && r.candidateKey === vals.candidateKey)) {
              return Promise.resolve([])
            }
            const inserted = { disposition: 'pending', ...vals, id: `cand-${existing.length + 1}` }
            if (camelName && mockDb[camelName]) mockDb[camelName].push(inserted)
            return Promise.resolve([inserted])
          }),
        })),
      })),
    })),
  }
  return { db: dbMock }
})

import { requireOrganizationAccess } from '@/lib/auth/session'
import { registerSensitivityCandidates } from '@/lib/pipeline/sroi-sensitivity'

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.sensitivityCandidates = []
  mockDb.sroiRunReviews = []
  mockDb.sroiCalculationRuns = [{
    id: RUN_ID, projectId: PROJECT_ID, methodologyVersion: '1.0.0', calculationEngineVersion: '1.0.0',
    snapshotJson: { monetizedOutcomeIds: ['out-1'], discountRatePct: '5.00' },
  }]
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' },
  } as any)
})

describe('registerSensitivityCandidates', () => {
  it('POS-18-1: all five adjustment dimensions register, including a zero-valued one (deadweight=0)', async () => {
    const candidates = await registerSensitivityCandidates(PROJECT_ID, RUN_ID)
    const filterCandidates = candidates.filter((c: any) => c.candidateKind === 'methodological_filter')
    expect(filterCandidates).toHaveLength(5)
    const deadweight = filterCandidates.find((c: any) => c.candidateKey.endsWith(':deadweight'))
    expect(deadweight?.baseValue).toBe('0')
  })

  it('POS-18-2: structured_assumption, proxy_value and other_quantitative_input candidates all register', async () => {
    const candidates = await registerSensitivityCandidates(PROJECT_ID, RUN_ID)
    expect(candidates.some((c: any) => c.candidateKind === 'structured_assumption')).toBe(true)
    expect(candidates.some((c: any) => c.candidateKind === 'proxy_value')).toBe(true)
    const discountRate = candidates.find((c: any) => c.candidateKind === 'other_quantitative_input')
    expect(discountRate?.candidateKey).toBe('other_quantitative_input:discount_rate_pct')
    expect(discountRate?.baseValue).toBe('5.00')
  })

  it('every registered candidate starts pending, carrying the governed sensitivity_model_version', async () => {
    const candidates = await registerSensitivityCandidates(PROJECT_ID, RUN_ID)
    for (const c of candidates as any[]) {
      expect(c.disposition).toBe('pending')
      expect(c.sensitivityModelVersion).toBe('1.0.0')
    }
  })

  it('is idempotent — calling twice never duplicates a candidate (same run + candidate_key)', async () => {
    await registerSensitivityCandidates(PROJECT_ID, RUN_ID)
    const secondCall = await registerSensitivityCandidates(PROJECT_ID, RUN_ID)
    const keys = secondCall.map((c: any) => c.candidateKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('NEG-18-8: refuses to register candidates for a pre-model (legacy_non_authoritative) run — no retrospective backfill', async () => {
    mockDb.sroiCalculationRuns = [{ id: RUN_ID, projectId: PROJECT_ID, methodologyVersion: null, snapshotJson: {} }]
    await expect(registerSensitivityCandidates(PROJECT_ID, RUN_ID)).rejects.toThrow(/legacy_non_authoritative|predates/i)
  })

  it('refuses to register candidates for an already-approved run', async () => {
    mockDb.sroiRunReviews = [{ calculationRunId: RUN_ID, status: 'approved' }]
    await expect(registerSensitivityCandidates(PROJECT_ID, RUN_ID)).rejects.toThrow(/already approved/i)
  })
})
