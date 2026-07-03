// lib/stella/context/__tests__/build-advisor-context.test.ts
// Sprint 9C-1: Context builder tests — no real DB, no real Gemini

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildAdvisorContext, StellaBuildContextError } from '../build-advisor-context'

// ---------------------------------------------------------------------------
// Mock DB client — no real DB connections in tests
// ---------------------------------------------------------------------------
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(),
  },
}))

const MOCK_PROJECT_ID = 'proj-test-uuid-0001'
const MOCK_ORG_ID = 'org-test-uuid-0001'
const OTHER_ORG_ID = 'org-test-uuid-9999'

const mockProject = {
  id: MOCK_PROJECT_ID,
  organizationId: MOCK_ORG_ID,
  name: 'Test Project',
  status: 'active',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-06-01'),
}

const mockNarrative = {
  narrativeText: 'This project improves community wellbeing through education programs.',
  theoryOfChangeSummary: 'By providing training, participants gain skills that lead to employment.',
}

const mockStakeholders = [
  { id: 'sh-1', name: 'Youth Participants', type: 'beneficiary' },
  { id: 'sh-2', name: 'Local Employers', type: 'secondary' },
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

// ---------------------------------------------------------------------------
// Mock builder helpers
// All DB queries end in .then((rows) => rows[0] ?? null) or return arrays directly.
// Single-row queries: pass [row] so rows[0] resolves correctly.
// Array queries: pass array directly.
// ---------------------------------------------------------------------------

function makeChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.then = vi.fn().mockImplementation(
    (cb: (v: unknown) => unknown) => Promise.resolve(cb(resolvedValue))
  )
  return chain
}

// ---------------------------------------------------------------------------
// Helper: set up full mock sequence for a successful context build
// ---------------------------------------------------------------------------
async function setupFullMockSequence(projectRow = mockProject) {
  const { db } = await import('@/db/client')
  const selectMock = vi.mocked(db.select)

  // Call order in buildAdvisorContext:
  // 1. project query → .then((rows) => rows[0] ?? null) → needs array
  // 2. narrative query → .then((rows) => rows[0] ?? null) → needs array
  // 3. stakeholders → returns array directly via Drizzle (no .then unwrapping)
  // 4. outcomes → array
  // 5. indicators → array
  // 6. evidence → array
  // 7. proxy assignments (innerJoin) → array
  // 8. source lookup → .then((rows) => rows[0] ?? null) → needs array
  selectMock
    .mockReturnValueOnce(makeChain([projectRow]) as never)                   // project
    .mockReturnValueOnce(makeChain([mockNarrative]) as never)                // narrative
    .mockReturnValueOnce(makeChain(mockStakeholders) as never)               // stakeholders
    .mockReturnValueOnce(makeChain(mockOutcomes) as never)                   // outcomes
    .mockReturnValueOnce(makeChain(mockIndicators) as never)                 // indicators
    .mockReturnValueOnce(makeChain(mockEvidenceItems) as never)              // evidence
    .mockReturnValueOnce(makeChain(mockAssignments) as never)                // proxy assignments
    .mockReturnValueOnce(makeChain([{ id: 'src-1', name: 'HACT Database' }]) as never) // source
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('buildAdvisorContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Calculation step support', () => {
    it('does NOT throw for "calculation" — Advisor now supports this step', async () => {
      await setupFullMockSequence()

      await expect(
        buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'calculation')
      ).resolves.toBeDefined()
    })

    it('does NOT throw for "Cálculo" (Spanish label)', async () => {
      await setupFullMockSequence()

      await expect(
        buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'Cálculo')
      ).resolves.toBeDefined()
    })
  })

  describe('Project ownership boundary', () => {
    it('throws NOT_FOUND when project does not exist', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never) // empty array → rows[0] = undefined → null

      let thrown: StellaBuildContextError | null = null
      try {
        await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')
      } catch (e) {
        thrown = e as StellaBuildContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildContextError)
      expect(thrown?.code).toBe('NOT_FOUND')
    })

    it('throws UNAUTHORIZED when project belongs to different org', async () => {
      const { db } = await import('@/db/client')
      vi.mocked(db.select).mockReturnValueOnce(
        makeChain([{ ...mockProject, organizationId: OTHER_ORG_ID }]) as never
      )

      let thrown: StellaBuildContextError | null = null
      try {
        await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')
      } catch (e) {
        thrown = e as StellaBuildContextError
      }
      expect(thrown).toBeInstanceOf(StellaBuildContextError)
      expect(thrown?.code).toBe('UNAUTHORIZED')
    })
  })

  describe('Narrative step', () => {
    it('returns context with correct projectId and organizationId', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'Narrativa')

      expect(ctx.projectId).toBe(MOCK_PROJECT_ID)
      expect(ctx.organizationId).toBe(MOCK_ORG_ID)
    })

    it('includes sanitized narrative summary', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(typeof ctx.narrativeSummary).toBe('string')
      expect(ctx.narrativeSummary.length).toBeGreaterThan(0)
    })

    it('includes stakeholder count', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(ctx.stakeholderCount).toBe(2)
    })

    it('includes outcome count', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(ctx.outcomesSnapshot).toHaveLength(2)
    })
  })

  describe('Outcomes step', () => {
    it('includes outcomes with sanitized titles', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'outcomes')

      expect(ctx.outcomesSnapshot[0].name).toBe('Improved Employment Rate')
      expect(ctx.outcomesSnapshot[1].name).toBe('Increased Confidence')
    })
  })

  describe('Indicators step', () => {
    it('includes indicators with names and units', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'indicators')

      expect(ctx.indicatorsSnapshot).toHaveLength(2)
      expect(ctx.indicatorsSnapshot[0].name).toBe('Jobs secured within 6 months')
      expect(ctx.indicatorsSnapshot[0].unit).toBe('count')
    })

    it('indicators reference the correct outcomeId', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'indicators')

      expect(ctx.indicatorsSnapshot[0].outcomeId).toBe('out-1')
    })
  })

  describe('Evidence step', () => {
    it('includes evidence total count', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'evidence')

      expect(ctx.evidenceTotal).toBe(2)
    })

    it('includes evidence metadata with hash truncated to 8 chars', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'evidence')

      const ev = ctx.evidenceMetadata.find((e) => e.id === 'ev-1')
      expect(ev).toBeDefined()
      expect(ev?.contentHashTruncated).toBe('abcdef12')
      expect(ev?.contentHashTruncated?.length).toBe(8)
    })

    it('does NOT include full SHA-256 hash (32 chars)', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'evidence')

      for (const ev of ctx.evidenceMetadata) {
        if (ev.contentHashTruncated) {
          expect(ev.contentHashTruncated).not.toBe('abcdef1234567890abcdef1234567890')
          expect(ev.contentHashTruncated.length).toBeLessThanOrEqual(8)
        }
      }
    })
  })

  describe('Proxies step', () => {
    it('includes proxy names and confidence levels', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'proxies')

      expect(ctx.proxySummary).toHaveLength(1)
      expect(ctx.proxySummary[0].name).toBe('Cost of treating mild depression')
      expect(ctx.proxySummary[0].confidenceLevel).toBe('high')
    })

    it('excludes proxy financial value and currency (Advisor role)', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'proxies')

      for (const proxy of ctx.proxySummary) {
        expect(proxy.value).toBe('')
        expect(proxy.currency).toBe('')
      }
    })
  })

  describe('Security: forbidden fields', () => {
    it('does NOT include GEMINI_API_KEY in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(JSON.stringify(ctx)).not.toContain('GEMINI_API_KEY')
      expect(JSON.stringify(ctx)).not.toContain('gemini_api_key')
    })

    it('does NOT include SUPABASE_SERVICE_ROLE_KEY in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(JSON.stringify(ctx)).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    })

    it('does NOT include filePath field in context', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'evidence')

      expect(JSON.stringify(ctx)).not.toContain('"filePath"')
      expect(JSON.stringify(ctx)).not.toContain('"file_path"')
    })

    it('calculationSnapshot is null (Advisor never touches calculation)', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(ctx.calculationSnapshot).toBeNull()
    })

    it('organizationId in context matches requesting org (no cross-org leakage)', async () => {
      await setupFullMockSequence()
      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(ctx.organizationId).toBe(MOCK_ORG_ID)
    })
  })

  describe('Narrative sanitization', () => {
    it('filters narratives containing forbidden patterns', async () => {
      const { db } = await import('@/db/client')
      const selectMock = vi.mocked(db.select)

      selectMock
        .mockReturnValueOnce(makeChain([mockProject]) as never)
        .mockReturnValueOnce(makeChain([{
          narrativeText: 'Config: GEMINI_API_KEY=sk_secret_abc123 in use',
          theoryOfChangeSummary: 'Normal theory of change.',
        }]) as never)
        .mockReturnValueOnce(makeChain([]) as never)   // stakeholders
        .mockReturnValueOnce(makeChain([]) as never)   // outcomes
        .mockReturnValueOnce(makeChain([]) as never)   // indicators
        .mockReturnValueOnce(makeChain([]) as never)   // evidence
        .mockReturnValueOnce(makeChain([]) as never)   // proxy assignments

      const ctx = await buildAdvisorContext(MOCK_PROJECT_ID, MOCK_ORG_ID, 'narrative')

      expect(ctx.narrativeSummary).not.toContain('GEMINI_API_KEY')
      expect(ctx.narrativeSummary).not.toContain('sk_secret_abc123')
    })
  })
})
