// lib/stella/context/build-composer-context.funder-breakdown.test.ts
// Funder-breakdown extraction tests for buildComposerContext.
//
// Audit FIX 5 (WS4): the original file asserted only on hand-built literals
// and never invoked buildComposerContext. Reworked to drive the real builder
// through a mocked db layer (same makeChain pattern as
// __tests__/build-composer-context.test.ts) and assert the funder-breakdown
// extraction from a realistic snapshotJson fixture.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildComposerContext } from './build-composer-context'

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(),
  },
}))

const PROJECT_ID = 'proj-fb-0001'
const ORG_ID = 'org-fb-0001'
const REPORT_ID = 'rpt-fb-0001'

const projectRow = {
  id: PROJECT_ID,
  organizationId: ORG_ID,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-06-15'),
}

const reportRow = {
  id: REPORT_ID,
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
}

// Realistic snapshotJson as persisted by calculateAndPersistSroiRun — string
// money/ratio values at MONEY_DP=4 / RATIO_DP=6, plus keys (investments,
// assignments) that must NEVER leak into the Stella context.
const fundersBreakdownFixture = [
  {
    funderId: 'funder-1',
    funderName: 'Fundación Española de Impacto Social',
    funderType: 'foundation',
    investmentUsd: '500000.0000',
    attributedNsvUsd: '1600000.0000',
    sroiRatio: '3.200000',
  },
  {
    funderId: 'funder-2',
    funderName: 'Privado B',
    funderType: 'private',
    investmentUsd: '200000.0000',
    attributedNsvUsd: '420000.0000',
    sroiRatio: '2.100000',
  },
]

function makeSnapshotJson(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    currency: 'USD',
    totalInvestment: '700000.0000',
    grossSocialValue: '2500000.0000',
    netSocialValue: '2070000.0000',
    sroiRatio: '2.957142',
    fundersBreakdown: fundersBreakdownFixture,
    unattributedNsvUsd: '50000.0000',
    investments: [{ id: 'inv-1', fxRateId: 'canary-fx-rate-id', amount: '999999' }],
    assignments: [{ assignmentId: 'canary-assignment-id' }],
    ...overrides,
  }
}

function makeCalcRun(snapshotJson: unknown) {
  return {
    id: 'run-fb-001',
    version: 3,
    currency: 'USD',
    totalInvestment: '700000.0000',
    grossSocialValue: '2500000.0000',
    netSocialValue: '2070000.0000',
    sroiRatio: '2.957142',
    snapshotJson,
  }
}

// Chainable thenable query mock — same pattern as
// __tests__/build-composer-context.test.ts
function makeChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.then = vi.fn().mockImplementation(
    (cb: (v: unknown) => unknown) => Promise.resolve(cb(resolvedValue))
  )
  return chain
}

// Query order inside buildComposerContext (assignments carry sourceId: null,
// so the per-source lookup loop issues no query):
// 1. project  2. report  3. narrative  4. stakeholders  5. outcomes
// 6. indicators  7. evidence  8. proxy assignments  9. filter sets
// 10. latest calc run  [11. line items — only when a run exists]
// 12. readiness review  13. report sections
async function setupSequence(calcRunRows: unknown[]) {
  const { db } = await import('@/db/client')
  const selectMock = vi.mocked(db.select)

  const chain = selectMock
    .mockReturnValueOnce(makeChain([projectRow]) as never) // 1. project
    .mockReturnValueOnce(makeChain([reportRow]) as never) // 2. report
    .mockReturnValueOnce(makeChain([]) as never) // 3. narrative
    .mockReturnValueOnce(makeChain([]) as never) // 4. stakeholders
    .mockReturnValueOnce(makeChain([]) as never) // 5. outcomes
    .mockReturnValueOnce(makeChain([]) as never) // 6. indicators
    .mockReturnValueOnce(makeChain([]) as never) // 7. evidence
    .mockReturnValueOnce(makeChain([]) as never) // 8. assignments (no sourceIds → no source query)
    .mockReturnValueOnce(makeChain([]) as never) // 9. filter sets
    .mockReturnValueOnce(makeChain(calcRunRows) as never) // 10. calc run

  if (calcRunRows.length > 0) {
    chain.mockReturnValueOnce(makeChain([{ id: 'li-1' }, { id: 'li-2' }]) as never) // 11. line items
  }

  chain.mockReturnValueOnce(makeChain([]) as never) // 12. review
  chain.mockReturnValueOnce(makeChain([]) as never) // 13. sections
}

const build = () => buildComposerContext(PROJECT_ID, ORG_ID, REPORT_ID)

describe('buildComposerContext — funder breakdown extraction (real invocation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts fundersBreakdown from snapshotJson, parsing strings to numbers', async () => {
    await setupSequence([makeCalcRun(makeSnapshotJson())])
    const ctx = await build()

    const fb = ctx.calculationSnapshot?.fundersBreakdown
    expect(fb).toBeDefined()
    expect(fb).toHaveLength(2)
    expect(fb![0]).toEqual({
      funderId: 'funder-1',
      funderName: 'Fundación Española de Impacto Social', // unicode preserved
      funderType: 'foundation',
      investmentUsd: 500000,
      attributedNsvUsd: 1600000,
      sroiRatio: 3.2,
    })
    expect(typeof fb![0].investmentUsd).toBe('number')
    expect(typeof fb![0].sroiRatio).toBe('number')
  })

  it('preserves multiple funders in order with their types', async () => {
    await setupSequence([makeCalcRun(makeSnapshotJson())])
    const ctx = await build()

    const fb = ctx.calculationSnapshot!.fundersBreakdown!
    expect(fb.map((f) => f.funderId)).toEqual(['funder-1', 'funder-2'])
    expect(fb[1].funderType).toBe('private')
    expect(fb[1].investmentUsd).toBe(200000)
    expect(fb[1].attributedNsvUsd).toBe(420000)
    expect(fb[1].sroiRatio).toBe(2.1)
  })

  it('parses unattributedNsvUsd from the snapshot', async () => {
    await setupSequence([makeCalcRun(makeSnapshotJson())])
    const ctx = await build()

    expect(ctx.calculationSnapshot?.unattributedNsvUsd).toBe(50000)
    expect(typeof ctx.calculationSnapshot?.unattributedNsvUsd).toBe('number')
  })

  it('populates run totals alongside the breakdown', async () => {
    await setupSequence([makeCalcRun(makeSnapshotJson())])
    const ctx = await build()

    expect(ctx.calculationSnapshot?.totalInvestment).toBe(700000)
    expect(ctx.calculationSnapshot?.grossSocialValue).toBe(2500000)
    expect(ctx.calculationSnapshot?.netSocialValue).toBe(2070000)
    expect(ctx.calculationSnapshot?.sroiRatio).toBe(2.957142)
    expect(ctx.calculationSnapshot?.lineItemCount).toBe(2)
    expect(ctx.calculationSnapshot?.version).toBe(3)
  })

  it('leaves fundersBreakdown/unattributedNsvUsd undefined when snapshotJson is null', async () => {
    await setupSequence([makeCalcRun(null)])
    const ctx = await build()

    expect(ctx.calculationSnapshot).not.toBeNull()
    expect(ctx.calculationSnapshot?.fundersBreakdown).toBeUndefined()
    expect(ctx.calculationSnapshot?.unattributedNsvUsd).toBeUndefined()
    // Totals still come from the run columns, not the snapshot
    expect(ctx.calculationSnapshot?.totalInvestment).toBe(700000)
  })

  it('leaves fundersBreakdown undefined when the snapshot predates Fase 1b (no key)', async () => {
    const legacySnapshot = makeSnapshotJson()
    delete (legacySnapshot as Record<string, unknown>).fundersBreakdown
    delete (legacySnapshot as Record<string, unknown>).unattributedNsvUsd
    await setupSequence([makeCalcRun(legacySnapshot)])
    const ctx = await build()

    expect(ctx.calculationSnapshot?.fundersBreakdown).toBeUndefined()
    expect(ctx.calculationSnapshot?.unattributedNsvUsd).toBeUndefined()
  })

  it('maps an empty fundersBreakdown array to an empty array (not undefined)', async () => {
    await setupSequence([
      makeCalcRun(makeSnapshotJson({ fundersBreakdown: [], unattributedNsvUsd: '0.0000' })),
    ])
    const ctx = await build()

    expect(ctx.calculationSnapshot?.fundersBreakdown).toEqual([])
    // '0.0000' parses to 0
    expect(ctx.calculationSnapshot?.unattributedNsvUsd).toBe(0)
  })

  it('returns a null calculationSnapshot when no calculated run exists', async () => {
    await setupSequence([])
    const ctx = await build()

    expect(ctx.calculationSnapshot).toBeNull()
  })

  it('sanitizes funder names (truncated at 200 chars, control chars stripped)', async () => {
    const longName = 'A'.repeat(250)
    await setupSequence([
      makeCalcRun(
        makeSnapshotJson({
          fundersBreakdown: [
            { ...fundersBreakdownFixture[0], funderName: longName },
            { ...fundersBreakdownFixture[1], funderName: 'Fund\x00ación\x1F X' },
          ],
        })
      ),
    ])
    const ctx = await build()

    const fb = ctx.calculationSnapshot!.fundersBreakdown!
    // sanitizeString(_, 200): substring(0, 200) + '...'
    expect(fb[0].funderName).toBe('A'.repeat(200) + '...')
    expect(fb[1].funderName).not.toContain('\x00')
    expect(fb[1].funderName).not.toContain('\x1F')
  })

  it('never leaks the raw snapshotJson (investments/assignments) into the context', async () => {
    await setupSequence([makeCalcRun(makeSnapshotJson())])
    const ctx = await build()

    const json = JSON.stringify(ctx)
    expect(json).not.toContain('snapshotJson')
    expect(json).not.toContain('canary-fx-rate-id')
    expect(json).not.toContain('canary-assignment-id')
    expect(json).not.toContain('999999')
  })
})
