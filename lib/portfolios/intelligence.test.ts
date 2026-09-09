// lib/portfolios/intelligence.test.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — binds POS-AGG-5 and POS-TI-1
// to this file (TEST_CONTRACT.inherited_pf3_exclusive_controls).
//
// Every TI-N fact is exercised through its pure half, deriving from
// already-computed PF1/EH structures rather than a mocked db/client — TI-3/
// TI-5/TI-6/TI-7/TI-8 are REUSED from the aggregate and EH-2/EH-4/EH-6, not
// recomputed, so these tests assert that reuse holds and never diverges.

import { describe, expect, it } from 'vitest'
import type { ExcludedProject, PortfolioIncludedComponent } from './analytics'
import type { Eh2Result, Eh5DrillRow, Eh6Result } from './evidence-health'
import { computeTi3, computeTi4, ti1FromExcluded, ti2FromIncludedAndReportedRuns, ti5FromEh2, ti6FromEh5Rows, ti8FromEh6 } from './intelligence'

function includedComponent(overrides: Partial<PortfolioIncludedComponent> = {}): PortfolioIncludedComponent {
  return {
    projectId: 'p1',
    projectName: 'Project 1',
    runId: 'run-1',
    runVersion: 1,
    reviewId: 'review-1',
    methodologyVersion: 'v1',
    sroiRatio: 2,
    totalInvestment: 1000,
    netSocialValue: 2000,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* TI-1                                                                        */
/* -------------------------------------------------------------------------- */

describe('POS-TI-1 — TI-1: reproducible from the aggregate exclusion set, source-identified', () => {
  it('includes only reason=no_approved_run, never no_run', () => {
    const excluded: ExcludedProject[] = [
      { projectId: 'e1', projectName: 'Excluded A', reason: 'no_approved_run' },
      { projectId: 'e2', projectName: 'Excluded B', reason: 'no_run' },
      { projectId: 'e3', projectName: 'Excluded C', reason: 'non_usd_currency' },
    ]
    const result = ti1FromExcluded(excluded)
    expect(result.projectIds).toEqual(['e1'])
    expect(result.projects).toEqual([{ projectId: 'e1', projectName: 'Excluded A' }])
  })

  it('is deterministic: the same excluded set reproduces the same fact', () => {
    const excluded: ExcludedProject[] = [{ projectId: 'e1', projectName: 'Excluded A', reason: 'no_approved_run' }]
    expect(ti1FromExcluded(excluded)).toEqual(ti1FromExcluded([...excluded]))
  })
})

/* -------------------------------------------------------------------------- */
/* TI-2                                                                        */
/* -------------------------------------------------------------------------- */

describe('POS-TI-1 — TI-2: approved run without a report, source-identified by runId', () => {
  it('reports projects whose selected run id is absent from reportedRunIds', () => {
    const included = [includedComponent({ projectId: 'p1', runId: 'run-1' }), includedComponent({ projectId: 'p2', runId: 'run-2' })]
    const reportedRunIds = new Set(['run-1'])

    const result = ti2FromIncludedAndReportedRuns(included, reportedRunIds)

    expect(result.projectIds).toEqual(['p2'])
    expect(result.projects[0]).toEqual({ projectId: 'p2', projectName: 'Project 1', runId: 'run-2' })
  })

  it('reports nothing when every included run has a report', () => {
    const included = [includedComponent({ projectId: 'p1', runId: 'run-1' })]
    const result = ti2FromIncludedAndReportedRuns(included, new Set(['run-1']))
    expect(result.projectIds).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* TI-3 / POS_AGG_5_RESTATED                                                   */
/* -------------------------------------------------------------------------- */

describe('POS-AGG-5 — TI-3 dispersion statistics, distinct from portfolioSroiRatio', () => {
  it('computes min/median/max under their own names, source-identified by project', () => {
    const ratios = [
      { projectId: 'p1', sroiRatio: 1.5 },
      { projectId: 'p2', sroiRatio: 4.0 },
      { projectId: 'p3', sroiRatio: 2.5 },
    ]
    const result = computeTi3(ratios)

    expect(result.minimum).toBe(1.5)
    expect(result.median).toBe(2.5)
    expect(result.maximum).toBe(4.0)
    expect(result.ratioCount).toBe(3)
    expect(result.sourceProjectIds).toHaveLength(3)

    // POS_AGG_5_RESTATED: the median of individual ratios is NOT the
    // consolidated Sum(net)/Sum(investment) ratio — they coincide only by
    // accident. Demonstrated with concrete net/investment figures whose
    // weighted (consolidated) ratio provably differs from the median of the
    // three members' own ratios.
    const members = [
      { netSocialValue: 150, totalInvestment: 100 }, // ratio 1.5
      { netSocialValue: 400, totalInvestment: 100 }, // ratio 4.0
      { netSocialValue: 250, totalInvestment: 100 }, // ratio 2.5
    ]
    const consolidated =
      members.reduce((sum, m) => sum + m.netSocialValue, 0) / members.reduce((sum, m) => sum + m.totalInvestment, 0)
    expect(consolidated).toBeCloseTo(2.667, 2)
    expect(result.median).not.toBeCloseTo(consolidated, 2)
  })

  it('handles an even count with an averaged median, and an empty set with nulls', () => {
    const even = computeTi3([
      { projectId: 'p1', sroiRatio: 1 },
      { projectId: 'p2', sroiRatio: 3 },
    ])
    expect(even.median).toBe(2)

    const empty = computeTi3([])
    expect(empty).toEqual({ minimum: null, median: null, maximum: null, ratioCount: 0, sourceProjectIds: [] })
  })
})

/* -------------------------------------------------------------------------- */
/* TI-4                                                                        */
/* -------------------------------------------------------------------------- */

describe('POS-TI-1 — TI-4: exclusion-reason frequency, source-identified', () => {
  it('groups by reason and preserves the source project ids', () => {
    const excluded: ExcludedProject[] = [
      { projectId: 'e1', projectName: 'A', reason: 'no_run' },
      { projectId: 'e2', projectName: 'B', reason: 'no_run' },
      { projectId: 'e3', projectName: 'C', reason: 'non_usd_currency' },
    ]
    const result = computeTi4(excluded)
    expect(result.byReason).toEqual({ no_run: 2, non_usd_currency: 1 })
    expect(result.excludedProjectIds.sort()).toEqual(['e1', 'e2', 'e3'])
  })
})

/* -------------------------------------------------------------------------- */
/* TI-5 (source: EH-2)                                                         */
/* -------------------------------------------------------------------------- */

describe('POS-TI-1 — TI-5: reused from EH-2, never recomputed independently', () => {
  it('reports the set difference of active minus covered outcomes, per project', () => {
    const eh2: Eh2Result = {
      numerator: 1,
      denominator: 2,
      coveredOutcomeIds: ['o1'],
      activeOutcomeIds: ['o1', 'o2'],
      byProject: [{ projectId: 'p1', projectName: 'Project 1', coveredOutcomeIds: ['o1'], activeOutcomeIds: ['o1', 'o2'] }],
    }
    const result = ti5FromEh2(eh2)
    expect(result.byProject).toEqual([{ projectId: 'p1', projectName: 'Project 1', uncoveredOutcomeIds: ['o2'] }])
  })
})

/* -------------------------------------------------------------------------- */
/* TI-6 (source: EH-5 denominator rows, organization-bound via the assignment) */
/* -------------------------------------------------------------------------- */

describe('POS-TI-1 — TI-6: proxy versions shared across more than one member project', () => {
  it('flags a version only when its assignments span more than one distinct project', () => {
    const rows: Eh5DrillRow[] = [
      { assignmentId: 'a1', projectId: 'p1', financialProxyVersionId: 'v-shared', financialProxyId: 'proxy-1' },
      { assignmentId: 'a2', projectId: 'p2', financialProxyVersionId: 'v-shared', financialProxyId: 'proxy-1' },
      { assignmentId: 'a3', projectId: 'p1', financialProxyVersionId: 'v-solo', financialProxyId: 'proxy-2' },
    ]
    const result = ti6FromEh5Rows(rows)

    expect(result.sharedVersions).toHaveLength(1)
    expect(result.sharedVersions[0].financialProxyVersionId).toBe('v-shared')
    expect(result.sharedVersions[0].projectIds.sort()).toEqual(['p1', 'p2'])
    expect(result.sharedVersions[0].assignmentIds.sort()).toEqual(['a1', 'a2'])
  })

  it('reports nothing when every version is used by exactly one project', () => {
    const rows: Eh5DrillRow[] = [{ assignmentId: 'a1', projectId: 'p1', financialProxyVersionId: 'v1', financialProxyId: 'proxy-1' }]
    expect(ti6FromEh5Rows(rows).sharedVersions).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* TI-8 (source: EH-6)                                                         */
/* -------------------------------------------------------------------------- */

describe('POS-TI-1 — TI-8: reused from EH-6, only projects with count > 0', () => {
  it('filters to projects with at least one item newer than the run', () => {
    const eh6: Eh6Result = {
      byProject: [
        { projectId: 'p1', projectName: 'Project 1', count: 2, denominator: 5, evidenceItemIds: ['e1', 'e2'] },
        { projectId: 'p2', projectName: 'Project 2', count: 0, denominator: 3, evidenceItemIds: [] },
      ],
    }
    const result = ti8FromEh6(eh6)
    expect(result.projectIds).toEqual(['p1'])
    expect(result.projects).toEqual([{ projectId: 'p1', projectName: 'Project 1', count: 2 }])
  })
})
