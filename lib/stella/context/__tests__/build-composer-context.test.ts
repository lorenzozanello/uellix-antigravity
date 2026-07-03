// lib/stella/context/__tests__/build-composer-context.test.ts
// Composer context builder tests — no real DB, no real Gemini

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildComposerContext, StellaBuildComposerContextError } from '../build-composer-context'

// ---------------------------------------------------------------------------
// Mock DB client — no real DB connections in tests
// ---------------------------------------------------------------------------
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(),
  },
}))

const MOCK_PROJECT_ID = 'proj-cmp-test-0001'
const MOCK_ORG_ID = 'org-cmp-test-0001'
const OTHER_ORG_ID = 'org-cmp-test-9999'
const OTHER_PROJECT_ID = 'proj-cmp-test-9999'
const MOCK_REPORT_ID = 'rpt-cmp-test-0001'

const mockProject = {
  id: MOCK_PROJECT_ID,
  organizationId: MOCK_ORG_ID,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-06-15'),
}

const mockReport = {
  id: MOCK_REPORT_ID,
  organizationId: MOCK_ORG_ID,
  projectId: MOCK_PROJECT_ID,
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

const mockSections = [
  { id: 'sec-1', sectionType: 'executive_summary', title: 'Executive Summary', content: 'Some drafted content here.' },
  { id: 'sec-2', sectionType: 'methodology', title: 'Methodology', content: '' },
]

// ---------------------------------------------------------------------------
// Mock builder helpers — matches build-validator-context.test.ts pattern
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
// Helper: set up full mock sequence for a successful composer context build
// Query order matches buildComposerContext implementation exactly:
// 1. project → [mockProject]
// 2. report → [mockReport]
// 3. narrative → [mockNarrative]
// 4. stakeholders → mockStakeholders (array)
// 5. outcomes → mockOutcomes (array)
// 6. indicators → mockIndicators (array)
// 7. evidence → mockEvidenceItems (array)
// 8. proxy assignments (innerJoin) → mockAssignments (array)
// 9. source lookup → [{id: 'src-1', name: 'HACT Database'}] (single)
// 10. filter sets (innerJoin) → mockFilterSets (array)
// 11. latest calc run (.orderBy) → [mockCalcRun]
// 12. line items → mockLineItems (array, only if run exists)
// 13. readiness review (.orderBy) → [mockReview]
// 14. report sections → mockSections (array)
// ---------------------------------------------------------------------------
async function setupFullMockSequence(opts: {
  projectRow?: typeof mockProject
  reportRow?: typeof mockReport
  withCalcRun?: boolean
  withReview?: boolean
  sectionsRows?: typeof mockSections
} = {}) {
  const {
    projectRow = mockProject,
    reportRow = mockReport,
    withCalcRun = true,
    withReview = true,
    sectionsRows = mockSections,
  } = opts

  const { db } = await import('@/db/client')
  const selectMock = vi.mocked(db.select)

  const chain = selectMock
    .mockReturnValueOnce(makeChain([projectRow]) as never)                                       // 1. project
    .mockReturnValueOnce(makeChain([reportRow]) as never)                                        // 2. report
    .mockReturnValueOnce(makeChain([mockNarrative]) as never)                                    // 3. narrative
    .mockReturnValueOnce(makeChain(mockStakeholders) as never)                                   // 4. stakeholders
    .mockReturnValueOnce(makeChain(mockOutcomes) as never)                                       // 5. outcomes
    .mockReturnValueOnce(makeChain(mockIndicators) as never)                                     // 6. indicators
    .mockReturnValueOnce(makeChain(mockEvidenceItems) as never)                                  // 7. evidence
    .mockReturnValueOnce(makeChain(mockAssignments) as never)                                    // 8. proxy assignments
    .mockReturnValueOnce(makeChain([{ id: 'src-1', name: 'HACT Database' }]) as never)          // 9. source
    .mockReturnValueOnce(makeChain(mockFilterSets) as never)                                     // 10. filter sets
    .mockReturnValueOnce(makeChain(withCalcRun ? [mockCalcRun] : []) as never)                  // 11. calc run

  if (withCalcRun) {
    chain.mockReturnValueOnce(makeChain(mockLineItems) as never) // 12. line items
  }

  chain.mockReturnValueOnce(makeChain(withReview ? [mockReview] : []) as never) // 13. review
  chain.mockReturnValueOnce(makeChain(sectionsRows) as never) // 14. report sections
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('buildComposerContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Project ownership boundary
  // -------------------------------------------------------------------------
  describe('Project ownership boundary', () => {
    it('throws NOT_FOUND when project does not exist', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never) // empty → null

      let thrown: StellaBuildComposerContextError | null = null
      try {
        await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)
      } catch (e) {
        thrown = e as StellaBuildComposerContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildComposerContextError)
      expect(thrown?.code).toBe('NOT_FOUND')
    })

    it('throws UNAUTHORIZED when project belongs to different org', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValueOnce(
        makeChain([{ ...mockProject, organizationId: OTHER_ORG_ID }]) as never
      )

      let thrown: StellaBuildComposerContextError | null = null
      try {
        await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)
      } catch (e) {
        thrown = e as StellaBuildComposerContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildComposerContextError)
      expect(thrown?.code).toBe('UNAUTHORIZED')
    })
  })

  // -------------------------------------------------------------------------
  // Report ownership boundary
  // -------------------------------------------------------------------------
  describe('Report ownership boundary', () => {
    it('throws NOT_FOUND when report does not exist', async () => {
      const { db } = await import('@/db/client')
      const selectMock = vi.mocked(db.select)
      selectMock
        .mockReturnValueOnce(makeChain([mockProject]) as never) // project found
        .mockReturnValueOnce(makeChain([]) as never)             // report empty → null

      let thrown: StellaBuildComposerContextError | null = null
      try {
        await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)
      } catch (e) {
        thrown = e as StellaBuildComposerContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildComposerContextError)
      expect(thrown?.code).toBe('NOT_FOUND')
    })

    it('throws UNAUTHORIZED when report belongs to a different organization', async () => {
      const { db } = await import('@/db/client')
      const selectMock = vi.mocked(db.select)
      selectMock
        .mockReturnValueOnce(makeChain([mockProject]) as never)
        .mockReturnValueOnce(
          makeChain([{ ...mockReport, organizationId: OTHER_ORG_ID }]) as never
        )

      let thrown: StellaBuildComposerContextError | null = null
      try {
        await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)
      } catch (e) {
        thrown = e as StellaBuildComposerContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildComposerContextError)
      expect(thrown?.code).toBe('UNAUTHORIZED')
    })

    it('throws UNAUTHORIZED when report belongs to a different project', async () => {
      const { db } = await import('@/db/client')
      const selectMock = vi.mocked(db.select)
      selectMock
        .mockReturnValueOnce(makeChain([mockProject]) as never)
        .mockReturnValueOnce(
          makeChain([{ ...mockReport, projectId: OTHER_PROJECT_ID }]) as never
        )

      let thrown: StellaBuildComposerContextError | null = null
      try {
        await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)
      } catch (e) {
        thrown = e as StellaBuildComposerContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildComposerContextError)
      expect(thrown?.code).toBe('UNAUTHORIZED')
    })
  })

  // -------------------------------------------------------------------------
  // Report sections (key differentiator vs Validator/Advisor)
  // -------------------------------------------------------------------------
  describe('Report sections', () => {
    it('populates reportSections from the mocked sroi_report_sections rows', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.reportSections).toHaveLength(2)
      expect(ctx.reportSections[0].id).toBe('sec-1')
      expect(ctx.reportSections[0].title).toBe('Executive Summary')
      expect(ctx.reportSections[0].sectionType).toBe('executive_summary')
      expect(ctx.reportSections[0].contentLength).toBe('Some drafted content here.'.length)
      expect(ctx.reportSections[0].status).toBe('in_progress')
    })

    it('marks a section with empty content as draft', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      const draftSection = ctx.reportSections.find((s) => s.id === 'sec-2')
      expect(draftSection?.status).toBe('draft')
      expect(draftSection?.contentLength).toBe(0)
    })

    it('returns empty reportSections when the report has no sections yet', async () => {
      await setupFullMockSequence({ sectionsRows: [] })
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.reportSections).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Calculation snapshot
  // -------------------------------------------------------------------------
  describe('Calculation snapshot', () => {
    it('populates calculationSnapshot when a completed run exists', async () => {
      await setupFullMockSequence({ withCalcRun: true })
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.calculationSnapshot).not.toBeNull()
      expect(ctx.calculationSnapshot?.sroiRatio).toBe(3.6)
      expect(ctx.calculationSnapshot?.totalInvestment).toBe(50000)
      expect(ctx.calculationSnapshot?.grossSocialValue).toBe(180000)
      expect(ctx.calculationSnapshot?.netSocialValue).toBe(130000)
      expect(ctx.calculationSnapshot?.currency).toBe('USD')
      expect(ctx.calculationSnapshot?.lineItemCount).toBe(3)
    })

    it('calculationSnapshot is null when no completed run exists', async () => {
      await setupFullMockSequence({ withCalcRun: false })
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.calculationSnapshot).toBeNull()
    })

    it('does NOT include snapshotJson or raw calculation data', async () => {
      await setupFullMockSequence({ withCalcRun: true })
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      const json = JSON.stringify(ctx)
      expect(json).not.toContain('snapshotJson')
      expect(json).not.toContain('snapshot_json')
    })
  })

  // -------------------------------------------------------------------------
  // Core context fields (same as Validator/Advisor)
  // -------------------------------------------------------------------------
  describe('Core context fields', () => {
    it('returns correct projectId and organizationId', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
      expect(ctx.organizationId).toBe(MOCK_ORG_ID)
    })

    it('includes sanitized narrative summary', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(typeof ctx.narrativeSummary).toBe('string')
      expect(ctx.narrativeSummary.length).toBeGreaterThan(0)
    })

    it('includes stakeholder count', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.stakeholderCount).toBe(3)
    })

    it('includes outcomes snapshot', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.outcomesSnapshot).toHaveLength(2)
      expect(ctx.outcomesSnapshot[0].name).toBe('Improved Employment Rate')
    })

    it('includes evidence total count', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.evidenceTotal).toBe(2)
    })

    it('includes readinessScore from latest review', async () => {
      await setupFullMockSequence({ withReview: true })
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.readinessScore).toBe(87)
    })

    it('readinessScore is undefined when no review exists', async () => {
      await setupFullMockSequence({ withReview: false })
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.readinessScore).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Security invariants
  // -------------------------------------------------------------------------
  describe('Security: forbidden fields', () => {
    it('does NOT include GEMINI_API_KEY in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(JSON.stringify(ctx)).not.toContain('GEMINI_API_KEY')
    })

    it('does NOT include filePath field in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(JSON.stringify(ctx)).not.toContain('"filePath"')
      expect(JSON.stringify(ctx)).not.toContain('"file_path"')
    })

    it('organizationId in context matches requesting org (no cross-org leakage)', async () => {
      await setupFullMockSequence()
      const ctx = await buildComposerContext(MOCK_PROJECT_ID, MOCK_ORG_ID, MOCK_REPORT_ID)

      expect(ctx.organizationId).toBe(MOCK_ORG_ID)
    })
  })
})
