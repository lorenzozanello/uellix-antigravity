// lib/stella/context/__tests__/build-validator-context.test.ts
// Sprint 9D-2: Validator context builder tests — no real DB, no real Gemini

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildValidatorContext, StellaBuildValidatorContextError } from '../build-validator-context'

// ---------------------------------------------------------------------------
// Mock DB client — no real DB connections in tests
// ---------------------------------------------------------------------------
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(),
  },
}))

const MOCK_PROJECT_ID = 'proj-val-test-0001'
const MOCK_ORG_ID = 'org-val-test-0001'
const OTHER_ORG_ID = 'org-val-test-9999'

const mockProject = {
  id: MOCK_PROJECT_ID,
  organizationId: MOCK_ORG_ID,
  name: 'SROI Validator Test Project',
  status: 'active',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-06-15'),
}

const mockNarrative = {
  narrativeText: 'This project improves employment outcomes through skills training.',
  theoryOfChangeSummary: 'Training leads to jobs which lead to increased income.',
}

const mockStakeholders = [
  { id: 'sh-1' },
  { id: 'sh-2' },
  { id: 'sh-3' },
]

const mockOutcomes = [
  { id: 'out-1', title: 'Improved Employment Rate', outcomeType: 'social', status: 'active' },
  { id: 'out-2', title: 'Increased Confidence', outcomeType: 'psychological', status: 'active' },
]

const mockIndicators = [
  { id: 'ind-1', outcomeId: 'out-1', name: 'Jobs secured within 6 months', unit: 'count' },
  { id: 'ind-2', outcomeId: 'out-2', name: 'Wellbeing score improvement', unit: 'score (1-10)' },
]

const mockEvidenceItems = [
  {
    id: 'ev-1',
    type: 'file',
    title: 'Survey Results 2026',
    status: 'approved',
    contentHash: 'abcdef1234567890abcdef1234567890',
    createdAt: new Date('2026-03-01'),
    outcomeId: 'out-1',
    indicatorId: 'ind-1',
  },
  {
    id: 'ev-2',
    type: 'url',
    title: 'External report reference',
    status: 'draft',
    contentHash: null,
    createdAt: new Date('2026-04-01'),
    outcomeId: null,
    indicatorId: null,
  },
]

const mockAssignments = [
  {
    assignmentId: 'asgn-1',
    proxyId: 'proxy-1',
    proxyName: 'Cost of treating mild depression',
    confidenceLevel: 'high',
    methodologicalRisk: 'low',
    sourceId: 'src-1',
  },
]

const mockFilterSets = [
  {
    assignmentId: 'asgn-1',
    deadweightPct: '25.00',
    displacementPct: '10.00',
    attributionPct: '60.00',
    dropoffPct: '5.00',
    durationYears: 3,
  },
]

const mockCalcRun = {
  id: 'run-001',
  version: 1,
  currency: 'USD',
  totalInvestment: '50000.00',
  grossSocialValue: '180000.00',
  netSocialValue: '130000.00',
  sroiRatio: '3.60',
}

const mockLineItems = [{ id: 'li-1' }, { id: 'li-2' }, { id: 'li-3' }]

const mockReview = { readinessScore: 87 }

// ---------------------------------------------------------------------------
// Mock builder helpers
// Validator uses .orderBy() in addition to the advisor chain methods.
// ---------------------------------------------------------------------------

function makeChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain) // needed for calc run + review queries
  chain.then = vi.fn().mockImplementation(
    (cb: (v: unknown) => unknown) => Promise.resolve(cb(resolvedValue))
  )
  return chain
}

// ---------------------------------------------------------------------------
// Helper: set up full mock sequence for a successful validator context build
// Query order matches buildValidatorContext implementation exactly:
// 1. project → [mockProject]
// 2. narrative → [mockNarrative]
// 3. stakeholders → mockStakeholders (array)
// 4. outcomes → mockOutcomes (array)
// 5. indicators → mockIndicators (array)
// 6. evidence → mockEvidenceItems (array)
// 7. proxy assignments (innerJoin) → mockAssignments (array)
// 8. source lookup → [{id: 'src-1', name: 'HACT Database'}] (single)
// 9. filter sets (innerJoin) → mockFilterSets (array)
// 10. latest calc run (.orderBy) → [mockCalcRun]
// 11. line items → mockLineItems (array, only if run exists)
// 12. readiness review (.orderBy) → [mockReview]
// ---------------------------------------------------------------------------
async function setupFullMockSequence(opts: {
  projectRow?: typeof mockProject
  withCalcRun?: boolean
  withReview?: boolean
} = {}) {
  const {
    projectRow = mockProject,
    withCalcRun = true,
    withReview = true,
  } = opts

  const { db } = await import('@/db/client')
  const selectMock = vi.mocked(db.select)

  const chain = selectMock
    .mockReturnValueOnce(makeChain([projectRow]) as never)                                       // 1. project
    .mockReturnValueOnce(makeChain([mockNarrative]) as never)                                    // 2. narrative
    .mockReturnValueOnce(makeChain(mockStakeholders) as never)                                   // 3. stakeholders
    .mockReturnValueOnce(makeChain(mockOutcomes) as never)                                       // 4. outcomes
    .mockReturnValueOnce(makeChain(mockIndicators) as never)                                     // 5. indicators
    .mockReturnValueOnce(makeChain(mockEvidenceItems) as never)                                  // 6. evidence
    .mockReturnValueOnce(makeChain(mockAssignments) as never)                                    // 7. proxy assignments
    .mockReturnValueOnce(makeChain([{ id: 'src-1', name: 'HACT Database' }]) as never)          // 8. source
    .mockReturnValueOnce(makeChain(mockFilterSets) as never)                                     // 9. filter sets
    .mockReturnValueOnce(makeChain(withCalcRun ? [mockCalcRun] : []) as never)                  // 10. calc run

  if (withCalcRun) {
    chain.mockReturnValueOnce(makeChain(mockLineItems) as never) // 11. line items
  }

  chain.mockReturnValueOnce(makeChain(withReview ? [mockReview] : []) as never) // 12. review
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('buildValidatorContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Step validation — only Calculation accepted
  // -------------------------------------------------------------------------
  describe('UNSUPPORTED_STEP: non-calculation steps', () => {
    const nonCalcSteps = ['narrative', 'Narrative', 'outcomes', 'indicators', 'evidence', 'proxies', 'Narrativa', 'stakeholders']

    for (const step of nonCalcSteps) {
      it(`throws UNSUPPORTED_STEP for "${step}" without touching DB`, async () => {
        let thrown: StellaBuildValidatorContextError | null = null
        try {
          await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, step)
        } catch (e) {
          thrown = e as StellaBuildValidatorContextError
        }
        expect(thrown).toBeInstanceOf(StellaBuildValidatorContextError)
        expect(thrown?.code).toBe('UNSUPPORTED_STEP')
      })
    }

    it('throws UNSUPPORTED_STEP for empty step', async () => {
      let thrown: StellaBuildValidatorContextError | null = null
      try {
        await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, '')
      } catch (e) {
        thrown = e as StellaBuildValidatorContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildValidatorContextError)
      expect(thrown?.code).toBe('UNSUPPORTED_STEP')
    })
  })

  describe('Accepted step variants', () => {
    it('accepts "calculation" (lowercase)', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')
      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
    })

    it('accepts "Calculation" (title case)', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'Calculation')
      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
    })

    it('accepts "cálculo" (Spanish)', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'cálculo')
      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
    })

    it('accepts "Cálculo" (Spanish title case)', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'Cálculo')
      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
    })
  })

  // -------------------------------------------------------------------------
  // Project ownership boundary
  // -------------------------------------------------------------------------
  describe('Project ownership boundary', () => {
    it('throws PROJECT_NOT_FOUND when project does not exist', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never) // empty → null

      let thrown: StellaBuildValidatorContextError | null = null
      try {
        await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')
      } catch (e) {
        thrown = e as StellaBuildValidatorContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildValidatorContextError)
      expect(thrown?.code).toBe('PROJECT_NOT_FOUND')
    })

    it('throws PROJECT_NOT_FOUND when project belongs to different org', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValueOnce(
        makeChain([{ ...mockProject, organizationId: OTHER_ORG_ID }]) as never
      )

      let thrown: StellaBuildValidatorContextError | null = null
      try {
        await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')
      } catch (e) {
        thrown = e as StellaBuildValidatorContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildValidatorContextError)
      expect(thrown?.code).toBe('PROJECT_NOT_FOUND')
    })
  })

  // -------------------------------------------------------------------------
  // Calculation snapshot (key differentiator vs Advisor)
  // -------------------------------------------------------------------------
  describe('Calculation snapshot', () => {
    it('populates calculationSnapshot when a completed run exists', async () => {
      await setupFullMockSequence({ withCalcRun: true })
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.calculationSnapshot).not.toBeNull()
      expect(ctx.calculationSnapshot?.sroiRatio).toBe(3.6)
      expect(ctx.calculationSnapshot?.totalInvestment).toBe(50000)
      expect(ctx.calculationSnapshot?.grossSocialValue).toBe(180000)
      expect(ctx.calculationSnapshot?.netSocialValue).toBe(130000)
      expect(ctx.calculationSnapshot?.currency).toBe('USD')
    })

    it('calculationSnapshot.lineItemCount reflects the number of line items', async () => {
      await setupFullMockSequence({ withCalcRun: true })
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.calculationSnapshot?.lineItemCount).toBe(3) // mockLineItems has 3 items
    })

    it('calculationSnapshot is null when no completed run exists', async () => {
      await setupFullMockSequence({ withCalcRun: false })
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.calculationSnapshot).toBeNull()
    })

    it('does NOT include snapshotJson or raw calculation data', async () => {
      await setupFullMockSequence({ withCalcRun: true })
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      const json = JSON.stringify(ctx)
      expect(json).not.toContain('snapshotJson')
      expect(json).not.toContain('snapshot_json')
    })
  })

  // -------------------------------------------------------------------------
  // Filter sets
  // -------------------------------------------------------------------------
  describe('Filter sets summary', () => {
    it('includes filter set percentages as numbers', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.filterSetsSummary).toHaveLength(1)
      expect(ctx.filterSetsSummary[0].deadweightPct).toBe(25)
      expect(ctx.filterSetsSummary[0].attributionPct).toBe(60)
      expect(ctx.filterSetsSummary[0].displacementPct).toBe(10)
      expect(ctx.filterSetsSummary[0].dropoffPct).toBe(5)
    })

    it('includes durationYears', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.filterSetsSummary[0].durationYears).toBe(3)
    })

    it('returns empty filterSetsSummary when no filter sets exist', async () => {
      const { db } = await import('@/db/client')
      const selectMock = vi.mocked(db.select)

      selectMock
        .mockReturnValueOnce(makeChain([mockProject]) as never)
        .mockReturnValueOnce(makeChain([mockNarrative]) as never)
        .mockReturnValueOnce(makeChain([]) as never)           // stakeholders
        .mockReturnValueOnce(makeChain([]) as never)           // outcomes
        .mockReturnValueOnce(makeChain([]) as never)           // indicators
        .mockReturnValueOnce(makeChain([]) as never)           // evidence
        .mockReturnValueOnce(makeChain([]) as never)           // assignments
        .mockReturnValueOnce(makeChain([]) as never)           // filter sets (empty)
        .mockReturnValueOnce(makeChain([]) as never)           // calc run (none)
        .mockReturnValueOnce(makeChain([]) as never)           // review

      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')
      expect(ctx.filterSetsSummary).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Readiness score
  // -------------------------------------------------------------------------
  describe('Readiness score', () => {
    it('includes readinessScore from latest review', async () => {
      await setupFullMockSequence({ withReview: true })
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.readinessScore).toBe(87)
    })

    it('readinessScore is undefined when no review exists', async () => {
      await setupFullMockSequence({ withReview: false })
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.readinessScore).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Core context fields (same as Advisor)
  // -------------------------------------------------------------------------
  describe('Core context fields', () => {
    it('returns correct projectId and organizationId', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
      expect(ctx.organizationId).toBe(MOCK_ORG_ID)
    })

    it('includes sanitized narrative summary', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(typeof ctx.narrativeSummary).toBe('string')
      expect(ctx.narrativeSummary.length).toBeGreaterThan(0)
    })

    it('includes stakeholder count', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.stakeholderCount).toBe(3)
    })

    it('includes outcomes snapshot', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.outcomesSnapshot).toHaveLength(2)
      expect(ctx.outcomesSnapshot[0].name).toBe('Improved Employment Rate')
    })

    it('includes evidence total count', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.evidenceTotal).toBe(2)
    })

    it('includes evidence metadata with hash truncated to 8 chars', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      const ev = ctx.evidenceMetadata.find((e) => e.id === 'ev-1')
      expect(ev?.contentHashTruncated).toBe('abcdef12')
      expect(ev?.contentHashTruncated?.length).toBe(8)
    })

    it('includes proxy confidence levels', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.proxySummary).toHaveLength(1)
      expect(ctx.proxySummary[0].confidenceLevel).toBe('high')
    })

    it('excludes proxy financial value and currency', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      for (const proxy of ctx.proxySummary) {
        expect(proxy.value).toBe('')
        expect(proxy.currency).toBe('')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security: forbidden fields', () => {
    it('does NOT include GEMINI_API_KEY in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(JSON.stringify(ctx)).not.toContain('GEMINI_API_KEY')
    })

    it('does NOT include filePath field in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(JSON.stringify(ctx)).not.toContain('"filePath"')
      expect(JSON.stringify(ctx)).not.toContain('"file_path"')
    })

    it('organizationId in context matches requesting org (no cross-org leakage)', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      expect(ctx.organizationId).toBe(MOCK_ORG_ID)
    })

    it('context hash input does NOT include full snapshotJson', async () => {
      await setupFullMockSequence()
      const ctx = await buildValidatorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')

      // snapshotJson is the raw column — the context only has calculationSnapshot with totals
      expect(JSON.stringify(ctx)).not.toContain('snapshotJson')
    })
  })
})
