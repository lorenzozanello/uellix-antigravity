// lib/portfolios/analytics.test.ts
import { describe, it, expect } from 'vitest'
import { aggregatePortfolioSroi, type ProjectRunSummary } from './analytics'

function usdRun(
  projectId: string,
  totalInvestment: number,
  netSocialValue: number,
  readinessScore: number | null = null
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
    readinessScore,
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
      { projectId: 'B', projectName: 'B', run: null, readinessScore: null },
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
      readinessScore: null,
    }
    const result = aggregatePortfolioSroi([usdRun('A', 100, 300), legacy])
    expect(result.includedCount).toBe(1)
    expect(result.totalInvestmentUsd).toBe(100)
    expect(result.excluded).toEqual([{ projectId: 'B', projectName: 'B', reason: 'non_usd_currency' }])
  })

  it('returns a null ratio when no project is included', () => {
    const result = aggregatePortfolioSroi([
      { projectId: 'A', projectName: 'A', run: null, readinessScore: null },
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
    expect(result.averageReadinessScore).toBe(60) // (80 + 40) / 2
    expect(result.readinessCoverage).toBe(2)
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
