// lib/portfolios/analytics.test.ts
import { describe, it, expect } from 'vitest'
import {
  aggregatePortfolioSroi,
  compareApprovedReviews,
  compareRunsForSelection,
  type ExcludedProject,
  type ProjectRunSummary,
  type SelectedRunTrace,
} from './analytics'

/**
 * PF1 traceability of a selected approved run + its selected approved review.
 * Every fixture that carries a run carries one, because a run can only be part
 * of the population if an approved review selected it.
 */
function trace(projectId: string, over: Partial<SelectedRunTrace> = {}): SelectedRunTrace {
  return {
    runId: `run-${projectId}`,
    runVersion: 1,
    reviewId: `rev-${projectId}`,
    methodologyVersion: 'v1.0.0',
    ...over,
  }
}

function usdRun(
  projectId: string,
  totalInvestment: number,
  netSocialValue: number,
  legacyManualReadinessScore: number | null = null
): ProjectRunSummary {
  return {
    projectId,
    projectName: projectId,
    governanceRegime: 'pc01b',
    selection: 'approved',
    run: {
      currency: 'USD',
      totalInvestment,
      netSocialValue,
      sroiRatio: netSocialValue / totalInvestment,
    },
    selected: trace(projectId),
    legacyManualReadinessScore,
  }
}

describe('aggregatePortfolioSroi', () => {
  it('computes the portfolio ratio as Σ net / Σ investment, NOT the average of ratios', () => {
    // A: inv 100, net 300 → ratio 3.0 ; B: inv 900, net 900 → ratio 1.0
    // Correct portfolio ratio = (300+900)/(100+900) = 1200/1000 = 1.2
    // Average of ratios would be (3.0+1.0)/2 = 2.0 — the classic mistake.
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300), usdRun('B', 900, 900)])

    expect(result.totalInvestmentUsd).toBe(1000)
    expect(result.totalNetSocialValueUsd).toBe(1200)
    expect(result.portfolioSroiRatio).toBe(1.2)
    expect(result.includedCount).toBe(2)
  })

  it('excludes projects without a calculation run', () => {
    const result = aggregatePortfolioSroi([
      usdRun('A', 100, 300),
      {
        projectId: 'B',
        projectName: 'B',
        governanceRegime: 'pc01b',
        selection: 'no_calculated_run',
        run: null,
        selected: null,
        legacyManualReadinessScore: null,
      },
    ])
    expect(result.includedCount).toBe(1)
    expect(result.excluded).toEqual([{ projectId: 'B', projectName: 'B', reason: 'no_run' }])
    expect(result.portfolioSroiRatio).toBe(3)
  })

  it('excludes non-USD (legacy) runs rather than summing a wrong number', () => {
    const legacy: ProjectRunSummary = {
      projectId: 'B',
      projectName: 'B',
      governanceRegime: 'pc01b',
      selection: 'approved',
      run: { currency: 'COP', totalInvestment: 5000000, netSocialValue: 9000000, sroiRatio: 1.8 },
      selected: trace('B'),
      legacyManualReadinessScore: null,
    }
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300), legacy])
    expect(result.includedCount).toBe(1)
    expect(result.totalInvestmentUsd).toBe(100)
    expect(result.excluded).toEqual([{ projectId: 'B', projectName: 'B', reason: 'non_usd_currency' }])
  })

  it('returns a null ratio when no project is included', () => {
    const result = aggregatePortfolioSroi([
      {
        projectId: 'A',
        projectName: 'A',
        governanceRegime: 'pc01b',
        selection: 'no_calculated_run',
        run: null,
        selected: null,
        legacyManualReadinessScore: null,
      },
    ])
    expect(result.portfolioSroiRatio).toBeNull()
    expect(result.includedCount).toBe(0)
    expect(result.projectCount).toBe(1)
  })

  it('averages readiness only over included projects that have a score', () => {
    const result = aggregatePortfolioSroi([
      usdRun('A', 100, 300, 80),
      usdRun('B', 100, 100, 40),
      usdRun('C', 100, 100, null), // no review yet — excluded from the average
    ])
    expect(result.averageLegacyManualReadinessScore).toBe(60) // (80 + 40) / 2
    expect(result.legacyManualReadinessCoverage).toBe(2)
  })

  // FIBIU-17 (FIBC-021, W2-B5, HPO-ODS-W2-17) — this figure MAY continue to
  // be read (sroi_run_reviews.readiness_score), but is never labelled,
  // aggregated or presented as canonical FIBC-021 readiness. The population
  // predicate and the sum/sum formula above are FROZEN and unchanged.
  it('is explicitly labelled LEGACY_NON_AUTHORITATIVE — never presented as canonical readiness', () => {
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300, 80)])
    expect(result.readinessSource).toBe('LEGACY_NON_AUTHORITATIVE')
  })

  it('sums large money values without floating-point drift (Decimal)', () => {
    const result = aggregatePortfolioSroi([
      usdRun('A', 0.1, 0.2),
      usdRun('B', 0.2, 0.1),
    ])
    // 0.1 + 0.2 = 0.3 exactly with Decimal (0.30000000000000004 with floats)
    expect(result.totalInvestmentUsd).toBe(0.3)
    expect(result.totalNetSocialValueUsd).toBe(0.3)
    expect(result.portfolioSroiRatio).toBe(1)
  })
})

// ── W2-B3 completeness (AG-B3-2, FIBC-016) — N-RATIO-2 / M-RATIO-2 ────────────
// A project whose latest run carries no SROI ratio is never summed as a
// zero-return project and never recomputed as net/investment.

import { toProjectRunSummaryRun } from './analytics'

describe('W2-B3 no-ratio (N-RATIO-2 / M-RATIO-2)', () => {
  it('N-RATIO-2: a run with sroiRatio null is EXCLUDED with reason no_sroi_ratio — its investment never enters the denominator', () => {
    const noRatio: ProjectRunSummary = {
      projectId: 'B',
      projectName: 'B',
      governanceRegime: 'pc01b',
      selection: 'approved',
      run: { currency: 'USD', totalInvestment: 900, netSocialValue: 0, sroiRatio: null },
      selected: trace('B'),
      legacyManualReadinessScore: 50,
    }
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300), noRatio])
    expect(result.includedCount).toBe(1)
    expect(result.excluded).toEqual([{ projectId: 'B', projectName: 'B', reason: 'no_sroi_ratio' }])
    // M-RATIO-2: had B been summed with a fabricated 0 return, the ratio would be 300/1000 = 0.3.
    expect(result.totalInvestmentUsd).toBe(100)
    expect(result.portfolioSroiRatio).toBe(3)
    expect(result.portfolioSroiRatio).not.toBe(0.3)
    // Its readiness is not averaged in either (it is not an included project).
    expect(result.legacyManualReadinessCoverage).toBe(0)
  })

  it('a portfolio whose only project has no ratio yields a null portfolio ratio, never 0', () => {
    const result = aggregatePortfolioSroi([
      {
        projectId: 'B',
        projectName: 'B',
        governanceRegime: 'pc01b',
        selection: 'approved',
        run: { currency: 'USD', totalInvestment: 900, netSocialValue: 0, sroiRatio: null },
        selected: trace('B'),
        legacyManualReadinessScore: null,
      },
    ])
    expect(result.portfolioSroiRatio).toBeNull()
    expect(result.includedCount).toBe(0)
  })

  it('toProjectRunSummaryRun keeps NULL null — no net/investment recomputation, no 0 fallback (the historical `?? (net / investment)` is gone)', () => {
    expect(toProjectRunSummaryRun({ currency: 'USD', totalInvestment: '900.0000', netSocialValue: '0.0000', sroiRatio: null })).toEqual({
      currency: 'USD',
      totalInvestment: 900,
      netSocialValue: 0,
      sroiRatio: null,
    })
    expect(toProjectRunSummaryRun({ currency: 'USD', totalInvestment: '100.0000', netSocialValue: '300.0000', sroiRatio: '3.000000' })).toEqual({
      currency: 'USD',
      totalInvestment: 100,
      netSocialValue: 300,
      sroiRatio: 3,
    })
    // A run without a valid NET has no numerator to contribute — still "no run".
    expect(toProjectRunSummaryRun({ currency: 'USD', totalInvestment: '1', netSocialValue: null, sroiRatio: '1' })).toBeNull()
  })
})

// ── PF1 (PORTFOLIO_PF1_EXECUTION_AUTHORITY_v1.0.0) ────────────────────────────
// Approved-run population, the six-reason closed exclusion vocabulary in its
// frozen first-match-wins order, the nine-field traceability tuple, and the
// investment classification PF1-MUT-INVESTMENT-1 guards.

/** A project with calculated runs of which NONE carries an approved review. */
function unapprovedOnly(projectId: string): ProjectRunSummary {
  return {
    projectId,
    projectName: projectId,
    governanceRegime: 'pc01b',
    selection: 'no_approved_run',
    run: null,
    selected: null,
    legacyManualReadinessScore: null,
  }
}

/** An approved selection with arbitrary overrides of its run totals / trace. */
function approved(
  projectId: string,
  run: Partial<NonNullable<ProjectRunSummary['run']>> = {},
  over: { governanceRegime?: string | null; selected?: Partial<SelectedRunTrace>; readiness?: number | null } = {}
): ProjectRunSummary {
  return {
    projectId,
    projectName: projectId,
    governanceRegime: over.governanceRegime === undefined ? 'pc01b' : over.governanceRegime,
    selection: 'approved',
    run: { currency: 'USD', totalInvestment: 100, netSocialValue: 300, sroiRatio: 3, ...run },
    selected: trace(projectId, over.selected ?? {}),
    legacyManualReadinessScore: over.readiness ?? null,
  }
}

const reasonOf = (result: ReturnType<typeof aggregatePortfolioSroi>, projectId: string) =>
  result.excluded.find((e) => e.projectId === projectId)?.reason

describe('PF1 — approved-run population', () => {
  it('a project whose calculated runs are all unapproved is excluded as no_approved_run, NOT as no_run', () => {
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300), unapprovedOnly('B')])
    expect(reasonOf(result, 'B')).toBe('no_approved_run')
    expect(result.includedCount).toBe(1)
    // The unapproved project contributes to NEITHER side of the ratio.
    expect(result.totalInvestmentUsd).toBe(100)
    expect(result.portfolioSroiRatio).toBe(3)
  })

  it('no_run and no_approved_run are distinct reasons — a reader can tell "never calculated" from "never approved"', () => {
    const result = aggregatePortfolioSroi([
      {
        projectId: 'A',
        projectName: 'A',
        governanceRegime: 'pc01b',
        selection: 'no_calculated_run',
        run: null,
        selected: null,
        legacyManualReadinessScore: null,
      },
      unapprovedOnly('B'),
    ])
    expect(result.excluded).toEqual([
      { projectId: 'A', projectName: 'A', reason: 'no_run' },
      { projectId: 'B', projectName: 'B', reason: 'no_approved_run' },
    ])
  })

  it('an approved selection is aggregated even when the project also carries newer unapproved runs — selection is what the aggregate is handed', () => {
    // The older approved run (version 2) is what reached the aggregate; the
    // newer unapproved run (version 3) never became a candidate.
    const result = aggregatePortfolioSroi([
      approved('A', { totalInvestment: 100, netSocialValue: 300 }, { selected: { runId: 'run-A-v2', runVersion: 2 } }),
    ])
    expect(result.includedCount).toBe(1)
    expect(result.included[0].runId).toBe('run-A-v2')
    expect(result.included[0].runVersion).toBe(2)
  })
})

describe('PF1 — legacy exclusion (FIBC-042)', () => {
  it('projects.governance_regime = pre_pc01b excludes as legacy_non_authoritative even with an approved review', () => {
    const result = aggregatePortfolioSroi([
      usdRun('A', 100, 300),
      approved('B', {}, { governanceRegime: 'pre_pc01b' }),
    ])
    expect(reasonOf(result, 'B')).toBe('legacy_non_authoritative')
    expect(result.includedCount).toBe(1)
    expect(result.totalInvestmentUsd).toBe(100)
  })

  it('a SELECTED run whose methodology_version IS NULL excludes as legacy_non_authoritative', () => {
    const result = aggregatePortfolioSroi([
      approved('B', {}, { selected: { methodologyVersion: null } }),
    ])
    expect(reasonOf(result, 'B')).toBe('legacy_non_authoritative')
    expect(result.portfolioSroiRatio).toBeNull()
  })

  it('approval does NOT override the legacy exclusion — an approved pre-PC-01B run is still excluded', () => {
    const result = aggregatePortfolioSroi([
      approved('B', {}, { governanceRegime: 'pre_pc01b', selected: { reviewId: 'rev-approved' } }),
    ])
    expect(result.includedCount).toBe(0)
    expect(reasonOf(result, 'B')).toBe('legacy_non_authoritative')
  })

  it('legacy precedes non_usd_currency and no_sroi_ratio — the FIBC-042 exclusion is never masked by a mechanical property', () => {
    const result = aggregatePortfolioSroi([
      approved('COP', { currency: 'COP' }, { governanceRegime: 'pre_pc01b' }),
      approved('NORATIO', { sroiRatio: null }, { selected: { methodologyVersion: null } }),
    ])
    expect(reasonOf(result, 'COP')).toBe('legacy_non_authoritative')
    expect(reasonOf(result, 'NORATIO')).toBe('legacy_non_authoritative')
  })

  it('a pc01b project with a non-null methodology version is NOT legacy', () => {
    const result = aggregatePortfolioSroi([approved('B')])
    expect(result.includedCount).toBe(1)
    expect(result.excluded).toEqual([])
  })
})

describe('PF1 — investment classification (PF1-MUT-INVESTMENT-1)', () => {
  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -500],
  ])('a selected run with a %s total investment is excluded as zero_or_invalid_investment, never as no_run', (_label, totalInvestment) => {
    const result = aggregatePortfolioSroi([
      usdRun('A', 100, 300),
      approved('B', { totalInvestment, netSocialValue: 900, sroiRatio: 1.8 }),
    ])
    expect(reasonOf(result, 'B')).toBe('zero_or_invalid_investment')
    expect(reasonOf(result, 'B')).not.toBe('no_run')
    // Neither a zero nor a negative ever reaches the denominator.
    expect(result.totalInvestmentUsd).toBe(100)
    expect(result.totalNetSocialValueUsd).toBe(300)
    expect(result.portfolioSroiRatio).toBe(3)
  })

  it('a portfolio whose only project has an invalid investment yields a null ratio, never 0', () => {
    const result = aggregatePortfolioSroi([approved('B', { totalInvestment: 0 })])
    expect(result.portfolioSroiRatio).toBeNull()
    expect(result.includedCount).toBe(0)
  })

  it('zero_or_invalid_investment is the LAST reason — currency and ratio are evaluated first', () => {
    const result = aggregatePortfolioSroi([
      approved('COP', { currency: 'COP', totalInvestment: 0 }),
      approved('NORATIO', { sroiRatio: null, totalInvestment: -1 }),
    ])
    expect(reasonOf(result, 'COP')).toBe('non_usd_currency')
    expect(reasonOf(result, 'NORATIO')).toBe('no_sroi_ratio')
  })
})

describe('PF1 — traceability tuple', () => {
  it('an included component exposes EXACTLY the nine frozen fields, in order', () => {
    const result = aggregatePortfolioSroi([
      approved('A', { totalInvestment: 100, netSocialValue: 300, sroiRatio: 3 }, {
        selected: { runId: 'run-1', runVersion: 4, reviewId: 'review-1', methodologyVersion: 'v2.1.0' },
      }),
    ])
    expect(result.included).toHaveLength(1)
    expect(Object.keys(result.included[0])).toEqual([
      'projectId',
      'projectName',
      'runId',
      'runVersion',
      'reviewId',
      'methodologyVersion',
      'sroiRatio',
      'totalInvestment',
      'netSocialValue',
    ])
    expect(result.included[0]).toEqual({
      projectId: 'A',
      projectName: 'A',
      runId: 'run-1',
      runVersion: 4,
      reviewId: 'review-1',
      methodologyVersion: 'v2.1.0',
      sroiRatio: 3,
      totalInvestment: 100,
      netSocialValue: 300,
    })
  })

  it('runId and reviewId come from the SAME selection — a component never mixes a run from one path with a review from another', () => {
    const result = aggregatePortfolioSroi([
      approved('A', {}, { selected: { runId: 'run-A', reviewId: 'rev-of-run-A' } }),
      approved('B', {}, { selected: { runId: 'run-B', reviewId: 'rev-of-run-B' } }),
    ])
    expect(result.included.map((c) => [c.projectId, c.runId, c.reviewId])).toEqual([
      ['A', 'run-A', 'rev-of-run-A'],
      ['B', 'run-B', 'rev-of-run-B'],
    ])
  })

  it('each component reports its OWN methodology version — a mixed-version approved population still aggregates', () => {
    const result = aggregatePortfolioSroi([
      approved('A', { totalInvestment: 100, netSocialValue: 300 }, { selected: { methodologyVersion: 'v1.0.0' } }),
      approved('B', { totalInvestment: 900, netSocialValue: 900, sroiRatio: 1 }, { selected: { methodologyVersion: 'v2.0.0' } }),
    ])
    expect(result.included.map((c) => c.methodologyVersion)).toEqual(['v1.0.0', 'v2.0.0'])
    expect(result.portfolioSroiRatio).toBe(1.2)
  })
})

describe('PF1 — the exclusion vocabulary is closed at six, in a frozen order', () => {
  const FROZEN_REASONS: ExcludedProject['reason'][] = [
    'no_run',
    'no_approved_run',
    'legacy_non_authoritative',
    'non_usd_currency',
    'no_sroi_ratio',
    'zero_or_invalid_investment',
  ]

  it('every one of the six reasons is reachable, and nothing outside the six is ever emitted', () => {
    const result = aggregatePortfolioSroi([
      {
        projectId: 'P1',
        projectName: 'P1',
        governanceRegime: 'pc01b',
        selection: 'no_calculated_run',
        run: null,
        selected: null,
        legacyManualReadinessScore: null,
      },
      unapprovedOnly('P2'),
      approved('P3', {}, { governanceRegime: 'pre_pc01b' }),
      approved('P4', { currency: 'COP' }),
      approved('P5', { sroiRatio: null }),
      approved('P6', { totalInvestment: 0 }),
    ])
    expect(result.excluded.map((e) => e.reason)).toEqual(FROZEN_REASONS)
    expect(result.includedCount).toBe(0)
    expect(result.portfolioSroiRatio).toBeNull()
    for (const e of result.excluded) expect(FROZEN_REASONS).toContain(e.reason)
  })

  it('a mixed population aggregates Σ/Σ over the included subset only', () => {
    const result = aggregatePortfolioSroi([
      usdRun('A', 100, 300, 80),
      usdRun('B', 900, 900, 40),
      unapprovedOnly('C'),
      approved('D', {}, { governanceRegime: 'pre_pc01b', readiness: 100 }),
      approved('E', { totalInvestment: 5000, sroiRatio: null }, { readiness: 100 }),
    ])
    expect(result.projectCount).toBe(5)
    expect(result.includedCount).toBe(2)
    expect(result.totalInvestmentUsd).toBe(1000)
    expect(result.totalNetSocialValueUsd).toBe(1200)
    expect(result.portfolioSroiRatio).toBe(1.2)
    // The excluded projects' readiness never enters the average either.
    expect(result.legacyManualReadinessCoverage).toBe(2)
    expect(result.averageLegacyManualReadinessScore).toBe(60)
  })

  it('PF1 emits no PF3 descriptive intelligence — the aggregate carries exactly its frozen key set', () => {
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300)])
    expect(Object.keys(result)).toEqual([
      'projectCount',
      'includedCount',
      'totalInvestmentUsd',
      'totalNetSocialValueUsd',
      'portfolioSroiRatio',
      'included',
      'excluded',
      'readinessSource',
      'averageLegacyManualReadinessScore',
      'legacyManualReadinessCoverage',
    ])
  })
})

describe('PF1 — deterministic selection orders', () => {
  const at = (iso: string) => new Date(iso)

  it('compareRunsForSelection orders by version DESC, then calculated_at DESC', () => {
    const runs = [
      { version: 2, calculatedAt: at('2026-01-01T00:00:00Z') },
      { version: 5, calculatedAt: at('2025-01-01T00:00:00Z') },
      { version: 3, calculatedAt: at('2026-06-01T00:00:00Z') },
    ]
    expect([...runs].sort(compareRunsForSelection).map((r) => r.version)).toEqual([5, 3, 2])
  })

  // PF1-POS-TIEBREAK-1 — created_at DESC, then id DESC. reviewed_at is NEVER
  // an input: it is nullable and PostgreSQL sorts NULLs FIRST under DESC, so
  // an unstamped approved review would outrank a stamped one.
  it('compareApprovedReviews orders by created_at DESC, then id DESC', () => {
    const reviews = [
      { id: 'a', createdAt: at('2026-01-01T00:00:00Z') },
      { id: 'z', createdAt: at('2026-01-01T00:00:00Z') },
      { id: 'm', createdAt: at('2026-03-01T00:00:00Z') },
    ]
    expect([...reviews].sort(compareApprovedReviews).map((r) => r.id)).toEqual(['m', 'z', 'a'])
  })

  it('compareApprovedReviews breaks an identical created_at by id DESC, so the order is total', () => {
    const sameInstant = at('2026-02-02T00:00:00Z')
    const reviews = [
      { id: '00000000-0000-4000-8000-000000000001', createdAt: sameInstant },
      { id: '00000000-0000-4000-8000-000000000009', createdAt: sameInstant },
      { id: '00000000-0000-4000-8000-000000000005', createdAt: sameInstant },
    ]
    const sorted = [...reviews].sort(compareApprovedReviews).map((r) => r.id)
    expect(sorted[0]).toBe('00000000-0000-4000-8000-000000000009')
    expect(sorted[2]).toBe('00000000-0000-4000-8000-000000000001')
    expect(compareApprovedReviews(reviews[0], reviews[0])).toBe(0)
  })
})
