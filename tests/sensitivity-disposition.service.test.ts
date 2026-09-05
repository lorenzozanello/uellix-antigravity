// tests/sensitivity-disposition.service.test.ts
// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — service-layer controls for
// dispositionSensitivityCandidate: a non-pending disposition always carries
// rationale and records who/when (POS-18-3), a disposition without rationale
// is refused (NEG-18-2), a candidate outside the caller's project/org cannot
// be dispositioned (NEG-18-4), and a candidate on an already-approved run
// cannot be dispositioned (NEG-18-10). MUT-18-2 is proven by the dedicated
// mutation campaign, not here.

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
const CANDIDATE_ID = 'cand-1'

const mockDb: Record<string, any[]> = {}

function resetMockDb() {
  mockDb.projects = [{ id: PROJECT_ID, organizationId: ORG_ID }]
  mockDb.sensitivityCandidates = [{
    id: CANDIDATE_ID, projectId: PROJECT_ID, organizationId: ORG_ID, calculationRunId: RUN_ID,
    candidateKey: 'methodological_filter:asgn-1:deadweight', candidateKind: 'methodological_filter',
    disposition: 'pending', rationale: null,
  }]
  mockDb.sroiRunReviews = []
}
resetMockDb()

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
          then: (cb: any) => Promise.resolve(cb(data)),
        }
        return queryResult
      }),
    })),
    update: vi.fn().mockImplementation((table: any) => ({
      set: vi.fn().mockImplementation((vals: any) => ({
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(() => {
            const pgName = (table as any)?._?.name || (table as any)[Symbol.for('drizzle:Name')]
            const camelName = pgName?.replace(/_([a-z])/g, (g: any) => g[1].toUpperCase())
            const rows = camelName ? mockDb[camelName] ?? [] : []
            const idx = rows.findIndex((r: any) => r.id === CANDIDATE_ID)
            if (idx === -1) return Promise.resolve([])
            rows[idx] = { ...rows[idx], ...vals }
            return Promise.resolve([rows[idx]])
          }),
        })),
      })),
    })),
  }
  return { db: dbMock }
})

import { requireOrganizationAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import { dispositionSensitivityCandidate } from '@/lib/pipeline/sroi-sensitivity'

beforeEach(() => {
  vi.clearAllMocks()
  resetMockDb()
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: { id: ORG_ID }, user: { id: USER_ID }, membership: { role: 'analyst' },
  } as any)
})

describe('dispositionSensitivityCandidate', () => {
  it('POS-18-3: a variation_required disposition persists disposition, rationale, dispositioned_by and dispositioned_at, and emits the audit verb', async () => {
    const before = Date.now()
    const updated = await dispositionSensitivityCandidate(PROJECT_ID, CANDIDATE_ID, {
      disposition: 'variation_required',
      rationale: 'Deadweight assumption is contested by the counterfactual review.',
    })
    expect(updated.disposition).toBe('variation_required')
    expect(updated.rationale).toBe('Deadweight assumption is contested by the counterfactual review.')
    expect(updated.dispositionedBy).toBe(USER_ID)
    expect(updated.dispositionedAt).not.toBeNull()
    expect(new Date(updated.dispositionedAt as Date).getTime()).toBeGreaterThanOrEqual(before)

    expect(vi.mocked(logAuditAction)).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.SENSITIVITY_CANDIDATE_DISPOSITIONED, entityId: CANDIDATE_ID, contentModifying: true })
    )
  })

  it('POS-18-3: a no_additional_variation_required disposition also requires and persists rationale', async () => {
    const updated = await dispositionSensitivityCandidate(PROJECT_ID, CANDIDATE_ID, {
      disposition: 'no_additional_variation_required',
      rationale: 'Value is fixed by contract, no reasonable alternative exists.',
    })
    expect(updated.disposition).toBe('no_additional_variation_required')
    expect(updated.rationale).toBeTruthy()
  })

  it('NEG-18-2: refuses a disposition with empty rationale', async () => {
    await expect(
      dispositionSensitivityCandidate(PROJECT_ID, CANDIDATE_ID, { disposition: 'variation_required', rationale: '' })
    ).rejects.toThrow(/rationale/i)
  })

  it('NEG-18-2: refuses a disposition with whitespace-only rationale', async () => {
    await expect(
      dispositionSensitivityCandidate(PROJECT_ID, CANDIDATE_ID, { disposition: 'variation_required', rationale: '   ' })
    ).rejects.toThrow(/rationale/i)
  })

  it('NEG-18-4: refuses to disposition a candidate that does not belong to the caller\'s project', async () => {
    // This suite's reflective db mock returns a table's full array regardless
    // of the where() clause content -- emptying mockDb.sensitivityCandidates
    // is how "row belongs to a different project" is reproduced under that
    // mock (real cross-tenant isolation is proven by the RLS probes in
    // tests/postgres/b5-completeness.pg.test.ts).
    mockDb.sensitivityCandidates = []
    await expect(
      dispositionSensitivityCandidate(PROJECT_ID, CANDIDATE_ID, { disposition: 'variation_required', rationale: 'x' })
    ).rejects.toThrow(/not found/i)
  })

  it('NEG-18-10: refuses to disposition a candidate whose run is already approved', async () => {
    mockDb.sroiRunReviews = [{ calculationRunId: RUN_ID, status: 'approved' }]
    await expect(
      dispositionSensitivityCandidate(PROJECT_ID, CANDIDATE_ID, { disposition: 'variation_required', rationale: 'x' })
    ).rejects.toThrow(/already approved/i)
  })
})
