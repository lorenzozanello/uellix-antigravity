// lib/portfolios/analytics.test.ts
import { describe, it, expect } from 'vitest'
import { aggregatePortfolioSroi, type ProjectRunSummary } from './analytics'

function usdRun(
  projectId: string,
  totalInvestment: number,
  netSocialValue: number,
  legacyManualReadinessScore: number | null = null
): ProjectRunSummary {
  return {
    projectId,
    projectName: projectId,
    run: {
      currency: 'USD',
      totalInvestment,
      netSocialValue,
      sroiRatio: netSocialValue / totalInvestment,
    },
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
      { projectId: 'B', projectName: 'B', run: null, legacyManualReadinessScore: null },
    ])
    expect(result.includedCount).toBe(1)
    expect(result.excluded).toEqual([{ projectId: 'B', projectName: 'B', reason: 'no_run' }])
    expect(result.portfolioSroiRatio).toBe(3)
  })

  it('excludes non-USD (legacy) runs rather than summing a wrong number', () => {
    const legacy: ProjectRunSummary = {
      projectId: 'B',
      projectName: 'B',
      run: { currency: 'COP', totalInvestment: 5000000, netSocialValue: 9000000, sroiRatio: 1.8 },
      legacyManualReadinessScore: null,
    }
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300), legacy])
    expect(result.includedCount).toBe(1)
    expect(result.totalInvestmentUsd).toBe(100)
    expect(result.excluded).toEqual([{ projectId: 'B', projectName: 'B', reason: 'non_usd_currency' }])
  })

  it('returns a null ratio when no project is included', () => {
    const result = aggregatePortfolioSroi([
      { projectId: 'A', projectName: 'A', run: null, legacyManualReadinessScore: null },
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
      run: { currency: 'USD', totalInvestment: 900, netSocialValue: 0, sroiRatio: null },
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
      { projectId: 'B', projectName: 'B', run: { currency: 'USD', totalInvestment: 900, netSocialValue: 0, sroiRatio: null }, legacyManualReadinessScore: null },
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
    // A run without valid totals is still "no run".
    expect(toProjectRunSummaryRun({ currency: 'USD', totalInvestment: null, netSocialValue: '1', sroiRatio: '1' })).toBeNull()
  })
})
