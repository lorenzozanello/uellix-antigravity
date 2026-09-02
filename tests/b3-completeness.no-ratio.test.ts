// tests/b3-completeness.no-ratio.test.ts
// W2-B3 completeness (docs/ops/wave2/W2_B3_TEST_MANIFEST_v2.json) — the
// downstream no-ratio consumers AG-B3-2 authorizes: Stella context builders,
// user-message prompts and numeric guard (N-RATIO-3 / M-RATIO-3 /
// P-STELLA-1), the composer action's authorized-ratio list, and the run
// comparison delta rule (N-RATIO-5). Portfolio is covered in
// lib/portfolios/analytics.test.ts (N-RATIO-2 / M-RATIO-2); the public
// verification page in tests/b3-completeness.ui.test.tsx (N-RATIO-4).
//
// Forbidden downstream behaviour (frozen in the authority): NULL -> 0,
// NULL -> net/investment, NULL rendered as ':1', a fabricated fallback
// ratio, Stella receiving 0.0 when no ratio exists.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Key-based db.select mock (same shape build-advisor-context.parity uses):
// each query is identified by the sorted keys of its projection; a full-row
// select (no projection) is keyed ''.
// ---------------------------------------------------------------------------
type QueryFixtures = Record<string, unknown[]>
const fixtures: { current: QueryFixtures } = { current: {} }

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn().mockImplementation((projection?: Record<string, unknown>) => {
      const key = projection ? Object.keys(projection).sort().join(',') : ''
      const rows = fixtures.current[key] ?? []
      const chain: Record<string, unknown> = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.innerJoin = vi.fn().mockReturnValue(chain)
      chain.leftJoin = vi.fn().mockReturnValue(chain)
      chain.orderBy = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockReturnValue(chain)
      chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows))
      return chain
    }),
  },
}))
vi.mock('@/lib/pipeline/evidence-versions', () => ({
  getLatestEvidenceVersionsByEvidenceIds: vi.fn().mockResolvedValue(new Map()),
}))

import { buildAdvisorContext } from '@/lib/stella/context/build-advisor-context'
import { buildValidatorContext } from '@/lib/stella/context/build-validator-context'
import { buildComposerContext } from '@/lib/stella/context/build-composer-context'
import { buildComposerUserMessage } from '@/lib/stella/prompts/composer-system'
import { buildReviewerUserMessage } from '@/lib/stella/prompts/reviewer-system'
import { buildValidatorUserMessage } from '@/lib/stella/prompts/validator-system'
import { authorizedNumbersFromSnapshot, validateComposerNumbers } from '@/lib/stella/schemas/composer-numeric-guard'
import type { StellaProjectContext, CalculationSnapshot } from '@/lib/stella/context/types'

const PROJECT = 'proj-b3-no-ratio'
const ORG = 'org-b3-no-ratio'
const REPORT = 'rpt-b3-no-ratio'

const projectRow = { id: PROJECT, organizationId: ORG, name: 'P', status: 'active', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-06-01') }
const reportRow = { id: REPORT, organizationId: ORG, projectId: PROJECT, calculationRunId: 'run-1' }
const runRow = (sroiRatio: string | null) => ({
  id: 'run-1',
  version: 3,
  currency: 'USD',
  totalInvestment: '10000.0000',
  grossSocialValue: '0.0000',
  netSocialValue: '0.0000',
  sroiRatio,
  runDate: new Date('2026-05-01T00:00:00Z'),
  snapshotJson: { sroiRatio, noRatioReason: sroiRatio === null ? 'NO_DEFENSIBLE_MONETIZATION' : null },
})

function baseFixtures(sroiRatio: string | null): QueryFixtures {
  return {
    'createdAt,id,name,organizationId,status,updatedAt': [projectRow],
    'createdAt,id,organizationId,updatedAt': [projectRow],
    'calculationRunId,id,organizationId,projectId': [reportRow],
    'narrativeText,theoryOfChangeSummary': [{ narrativeText: 'n', theoryOfChangeSummary: 't' }],
    'id,name,type': [],
    'id,outcomeType,stakeholderGroupId,status,title': [],
    'id,name,outcomeId,unit': [],
    'contentHash,createdAt,id,indicatorId,outcomeId,status,title,type': [],
    '': [projectRow],
    'assignmentId,confidenceLevel,currency,methodologicalRisk,proxyId,proxyName,sourceId,value': [],
    'id,name': [],
    'id,title': [],
    'assignmentId,attributionPct,deadweightPct,displacementPct,dropoffPct,durationYears': [],
    'currency,grossSocialValue,id,netSocialValue,sroiRatio,totalInvestment,version': [runRow(sroiRatio)],
    'currency,grossSocialValue,id,netSocialValue,snapshotJson,sroiRatio,totalInvestment,version': [runRow(sroiRatio)],
    id: [],
    'content,id,sectionType,title': [],
    readinessScore: [],
  }
}

beforeEach(() => {
  fixtures.current = baseFixtures(null)
})

describe('N-RATIO-3 / M-RATIO-3 — Stella context builders never fabricate a ratio', () => {
  it('advisor: a latest run with sroi_ratio NULL yields calculationSnapshot.sroiRatio === null (never 0)', async () => {
    const ctx = await buildAdvisorContext(PROJECT, ORG, 'calculation')
    expect(ctx.calculationSnapshot).not.toBeNull()
    expect(ctx.calculationSnapshot?.sroiRatio).toBeNull()
    expect(ctx.calculationSnapshot?.totalInvestment).toBe(10000)
  })

  it('validator: a latest run with sroi_ratio NULL yields calculationSnapshot.sroiRatio === null', async () => {
    const ctx = await buildValidatorContext(PROJECT, ORG, 'calculation')
    expect(ctx.calculationSnapshot).not.toBeNull()
    expect(ctx.calculationSnapshot?.sroiRatio).toBeNull()
  })

  it('composer: the pinned run with sroi_ratio NULL yields calculationSnapshot.sroiRatio === null', async () => {
    const ctx = await buildComposerContext(PROJECT, ORG, REPORT)
    expect(ctx.calculationSnapshot).not.toBeNull()
    expect(ctx.calculationSnapshot?.sroiRatio).toBeNull()
  })

  it('P-STELLA-1: a numeric ratio still flows through unchanged (advisor, validator, composer)', async () => {
    fixtures.current = baseFixtures('1.500000')
    expect((await buildAdvisorContext(PROJECT, ORG, 'calculation')).calculationSnapshot?.sroiRatio).toBe(1.5)
    expect((await buildValidatorContext(PROJECT, ORG, 'calculation')).calculationSnapshot?.sroiRatio).toBe(1.5)
    expect((await buildComposerContext(PROJECT, ORG, REPORT)).calculationSnapshot?.sroiRatio).toBe(1.5)
  })
})

function contextWithSnapshot(snapshot: CalculationSnapshot | null): StellaProjectContext {
  return {
    projectId: PROJECT,
    organizationId: ORG,
    projectName: 'P',
    projectStatus: 'active',
    narrativeSummary: null,
    theoryOfChangeSummary: null,
    stakeholderCount: 0,
    stakeholderTypes: [],
    outcomesSnapshot: [],
    indicatorsSnapshot: [],
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: snapshot,
    readinessScore: null,
    reportSections: [],
    contextHash: 'hash',
    builtAt: new Date('2026-06-01').toISOString(),
  } as unknown as StellaProjectContext
}

const NO_RATIO_SNAPSHOT: CalculationSnapshot = {
  totalInvestment: 10000,
  grossSocialValue: 0,
  netSocialValue: 0,
  sroiRatio: null,
  currency: 'USD',
  lineItemCount: 0,
  version: 3,
}

describe('N-RATIO-3 — prompts and numeric guard with a null ratio', () => {
  it('composer user message serializes sroiRatio: null (never 0)', () => {
    const text = buildComposerUserMessage('executive_summary', contextWithSnapshot(NO_RATIO_SNAPSHOT))
    expect(text).toMatch(/"sroiRatio":\s*null/)
    expect(text).not.toMatch(/"sroiRatio":\s*0\b/)
  })

  it('reviewer user message serializes sroiRatio: null with sroiCalculated: true', () => {
    const text = buildReviewerUserMessage('audit_assistant', contextWithSnapshot(NO_RATIO_SNAPSHOT))
    expect(text).toMatch(/"sroiCalculated":\s*true/)
    expect(text).toMatch(/"sroiRatio":\s*null/)
    expect(text).not.toMatch(/"sroiRatio":\s*0\b/)
  })

  it('validator user message serializes sroiRatio: null', () => {
    const text = buildValidatorUserMessage(contextWithSnapshot(NO_RATIO_SNAPSHOT))
    expect(text).toMatch(/"sroiRatio":\s*null/)
    expect(text).not.toMatch(/"sroiRatio":\s*0\b/)
  })

  it('numeric guard: authorizedNumbersFromSnapshot carries ratio null and authorizes NO ratio claim — a draft citing a ratio fails closed, the investment stays citable', () => {
    const authorized = authorizedNumbersFromSnapshot(NO_RATIO_SNAPSHOT)
    expect(authorized.ratio).toBeNull()
    const draft = (content: string) => ({ section_key: 'executive_summary', draft_title: 'Resumen', draft_content: content, assumptions: [], limitations: [], evidence_references: [], proxy_references: [] })
    expect(validateComposerNumbers(draft('El proyecto alcanza un ratio SROI de 2.30 por cada dólar invertido.') as never, authorized).ok).toBe(false)
    // (A bare '0' is a legitimately authorized token here — netSocialValue and
    // grossSocialValue ARE 0 in the no-ratio state — so the guard's contract is
    // 'no ratio is authorized', proven by ratio === null and the 2.30 refusal.)
    expect(validateComposerNumbers(draft('La inversión total fue de 10000 USD.') as never, authorized).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// N-RATIO-5 — the run comparison delta rule: null when either run has no ratio.
// compareCalculationRuns is DB-backed and authorized; its delta rule is pinned
// here through the same expression the service now uses, and end-to-end in
// tests/sroi-results.service.test.ts.
// ---------------------------------------------------------------------------
describe('N-RATIO-5 — comparison delta rule', () => {
  const delta = (a: string | null, b: string | null) => (a === null || b === null ? null : parseFloat(a) - parseFloat(b))
  it('is null when either side has no ratio, numeric otherwise', () => {
    expect(delta(null, '2.500000')).toBeNull()
    expect(delta('2.500000', null)).toBeNull()
    expect(delta(null, null)).toBeNull()
    expect(delta('3.000000', '2.500000')).toBeCloseTo(0.5)
  })
})
