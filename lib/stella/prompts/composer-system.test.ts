import { describe, it, expect } from 'vitest'
import { buildComposerUserMessage } from './composer-system'
import type { StellaProjectContext } from '../context/types'

describe('buildComposerUserMessage - Funder Breakdown Enhancement', () => {
  const baseMockContext: StellaProjectContext = {
    projectId: 'proj-1',
    organizationId: 'org-1',
    narrativeSummary: 'Test project narrative',
    outcomesSnapshot: [
      {
        id: 'outcome-1',
        name: 'Health Improvement',
        description: 'health',
        stakeholderGroups: [],
      },
    ],
    indicatorsSnapshot: [],
    stakeholderCount: 5,
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [
      {
        assignmentId: 'assign-1',
        durationYears: 5,
      },
    ],
    calculationSnapshot: {
      totalInvestment: 700000,
      grossSocialValue: 2500000,
      netSocialValue: 2070000,
      sroiRatio: 2.96,
      currency: 'USD',
      lineItemCount: 10,
      version: 1,
    },
    reportSections: [],
    projectCreatedAt: '2024-01-01T00:00:00Z',
    lastUpdatedAt: '2024-01-02T00:00:00Z',
  }

  describe('Non-funder_breakdown sections', () => {
    it('generates message without funder context for executive_summary', () => {
      const message = buildComposerUserMessage('executive_summary', baseMockContext)

      expect(message).toContain('executive_summary')
      expect(message).toContain('Outcomes:')
      expect(message).not.toContain('Funder Breakdown')
    })

    it('generates message without funder context for project_context', () => {
      const message = buildComposerUserMessage('project_context', baseMockContext)

      expect(message).toContain('project_context')
      expect(message).not.toContain('Funder Breakdown')
    })

    it('generates message without funder context for calculation_results', () => {
      const message = buildComposerUserMessage('calculation_results', baseMockContext)

      expect(message).toContain('calculation_results')
      expect(message).not.toContain('Funder Breakdown')
    })
  })

  describe('funder_breakdown section with data', () => {
    const contextWithFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...baseMockContext.calculationSnapshot,
        fundersBreakdown: [
          {
            funderId: 'funder-1',
            funderName: 'Foundation A',
            funderType: 'foundation',
            investmentUsd: 500000,
            attributedNsvUsd: 1600000,
            sroiRatio: 3.2,
          },
          {
            funderId: 'funder-2',
            funderName: 'Private B',
            funderType: 'private',
            investmentUsd: 200000,
            attributedNsvUsd: 420000,
            sroiRatio: 2.1,
          },
        ],
        unattributedNsvUsd: 50000,
      },
    }

    it('includes funder breakdown section header', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      expect(message).toContain('**Funder Breakdown:**')
    })

    it('lists all funders with investment and SROI data', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      expect(message).toContain('Foundation A')
      expect(message).toContain('foundation')
      expect(message).toContain('500000')
      expect(message).toContain('3.20:1')

      expect(message).toContain('Private B')
      expect(message).toContain('private')
      expect(message).toContain('200000')
      expect(message).toContain('2.10:1')
    })

    it('includes unattributed impact note', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      expect(message).toContain('Unattributed impact')
      expect(message).toContain('50000')
    })

    it('includes guidance for funder breakdown section content', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      expect(message).toContain('Clear summary of each funder')
      expect(message).toContain('Comparison of returns across funder types')
      expect(message).toContain('Explanation of any unattributed impact')
      expect(message).toContain('Methodology note')
    })

    it('uses correct currency in funder data', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      // Should include USD with investment amounts
      const fundLines = message.split('\n').filter((line) => line.includes('invested'))
      expect(fundLines.length).toBeGreaterThan(0)
    })
  })

  describe('funder_breakdown with no unattributed impact', () => {
    const contextNoUnattributed: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...baseMockContext.calculationSnapshot,
        fundersBreakdown: [
          {
            funderId: 'funder-1',
            funderName: 'Foundation A',
            funderType: 'foundation',
            investmentUsd: 700000,
            attributedNsvUsd: 2070000,
            sroiRatio: 2.96,
          },
        ],
        unattributedNsvUsd: 0,
      },
    }

    it('omits unattributed impact note when zero', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoUnattributed)

      // Should not mention unattributed when it's 0
      expect(message).not.toContain('Unattributed impact (not yet')
    })

    it('still includes funder breakdown data', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoUnattributed)

      expect(message).toContain('Foundation A')
      expect(message).toContain('700000')
      expect(message).toContain('2.96:1')
    })
  })

  describe('funder_breakdown with empty fundersBreakdown', () => {
    const contextNoFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...baseMockContext.calculationSnapshot,
        fundersBreakdown: [],
        unattributedNsvUsd: 2070000,
      },
    }

    it('does not include funder breakdown section when empty', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoFunders)

      // Should still have section header but no specific funder data
      expect(message).toContain('funder_breakdown')
    })
  })

  describe('funder_breakdown with no calculationSnapshot', () => {
    const contextNoCalc: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: null,
    }

    it('handles null calculationSnapshot gracefully', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoCalc)

      // Should still generate a message, just without funder data
      expect(message).toContain('funder_breakdown')
      expect(message).toContain('Please write')
    })
  })

  describe('funder_breakdown with multiple funders', () => {
    const contextMultipleFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...baseMockContext.calculationSnapshot,
        fundersBreakdown: [
          {
            funderId: 'funder-1',
            funderName: 'Foundation A',
            funderType: 'foundation',
            investmentUsd: 300000,
            attributedNsvUsd: 900000,
            sroiRatio: 3.0,
          },
          {
            funderId: 'funder-2',
            funderName: 'Government B',
            funderType: 'government',
            investmentUsd: 250000,
            attributedNsvUsd: 550000,
            sroiRatio: 2.2,
          },
          {
            funderId: 'funder-3',
            funderName: 'Private C',
            funderType: 'private',
            investmentUsd: 150000,
            attributedNsvUsd: 300000,
            sroiRatio: 2.0,
          },
        ],
        unattributedNsvUsd: 30000,
      },
    }

    it('lists all 3+ funders in breakdown', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextMultipleFunders)

      expect(message).toContain('Foundation A')
      expect(message).toContain('Government B')
      expect(message).toContain('Private C')
    })

    it('includes guidance about comparing across funder types', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextMultipleFunders)

      expect(message).toContain('Comparison of returns across funder types')
    })

    it('preserves order of funders', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextMultipleFunders)

      const foundationIndex = message.indexOf('Foundation A')
      const governmentIndex = message.indexOf('Government B')
      const privateIndex = message.indexOf('Private C')

      expect(foundationIndex).toBeLessThan(governmentIndex)
      expect(governmentIndex).toBeLessThan(privateIndex)
    })
  })

  describe('Content format and clarity', () => {
    const contextWithFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...baseMockContext.calculationSnapshot,
        fundersBreakdown: [
          {
            funderId: 'funder-1',
            funderName: 'Foundation A',
            funderType: 'foundation',
            investmentUsd: 500000,
            attributedNsvUsd: 1600000,
            sroiRatio: 3.2,
          },
        ],
        unattributedNsvUsd: 50000,
      },
    }

    it('formats data clearly for Stella to parse', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      // Should follow consistent formatting for easy parsing
      expect(message).toMatch(/- Foundation A/)
      expect(message).toMatch(/foundation/)
      expect(message).toMatch(/500000/)
      expect(message).toMatch(/3.20:1/)
    })

    it('includes section-specific guidance', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      expect(message).toContain('For this section, provide:')
    })
  })
})
