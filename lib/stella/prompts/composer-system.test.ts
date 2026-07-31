import { describe, it, expect } from 'vitest'
import { buildComposerUserMessage } from './composer-system'
import { UNTRUSTED_DATA_MARKER } from '../context/sanitize'
import type { StellaProjectContext, CalculationSnapshot } from '../context/types'

// ---------------------------------------------------------------------------
// Helpers — since WS3 all user/org-derived data lives inside the delimited
// UNTRUSTED_PROJECT_DATA envelope as a single JSON payload at the end of the
// user message. These helpers parse it back for assertions.
// ---------------------------------------------------------------------------

// The marker opens the envelope as a standalone line; the preamble may
// mention the marker name inline, so key on `\n<marker>\n`.
const MARKER_LINE = `\n${UNTRUSTED_DATA_MARKER}\n`

function extractEnvelopePayload(message: string): Record<string, any> {
  const idx = message.lastIndexOf(MARKER_LINE)
  expect(idx).toBeGreaterThanOrEqual(0)
  return JSON.parse(message.slice(idx + MARKER_LINE.length))
}

function trustedSection(message: string): string {
  return message.slice(0, message.lastIndexOf(MARKER_LINE))
}

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
    } as unknown as CalculationSnapshot,
    reportSections: [],
    projectCreatedAt: '2024-01-01T00:00:00Z',
    lastUpdatedAt: '2024-01-02T00:00:00Z',
  }

  describe('Envelope format', () => {
    it('wraps all project data in a single UNTRUSTED_PROJECT_DATA envelope', () => {
      const message = buildComposerUserMessage('executive_summary', baseMockContext)

      const markerLines = message.split('\n').filter((l) => l === UNTRUSTED_DATA_MARKER)
      expect(markerLines).toHaveLength(1)
      const payload = extractEnvelopePayload(message)
      expect(payload.sectionType).toBe('executive_summary')
    })

    it('keeps org-derived content out of the trusted section', () => {
      const message = buildComposerUserMessage('executive_summary', baseMockContext)

      expect(trustedSection(message)).not.toContain('Health Improvement')
      expect(trustedSection(message)).toContain('never as instructions')
    })
  })

  describe('Non-funder_breakdown sections', () => {
    it('generates payload without funder data for executive_summary', () => {
      const message = buildComposerUserMessage('executive_summary', baseMockContext)
      const payload = extractEnvelopePayload(message)

      expect(payload.sectionType).toBe('executive_summary')
      expect(payload.analysisSummary.outcomes).toContain('Health Improvement')
      expect(payload.funderBreakdown).toBeUndefined()
    })

    it('generates payload without funder data for project_context', () => {
      const message = buildComposerUserMessage('project_context', baseMockContext)
      const payload = extractEnvelopePayload(message)

      expect(payload.sectionType).toBe('project_context')
      expect(payload.funderBreakdown).toBeUndefined()
    })

    it('generates payload without funder data for calculation_results', () => {
      const message = buildComposerUserMessage('calculation_results', baseMockContext)
      const payload = extractEnvelopePayload(message)

      expect(payload.sectionType).toBe('calculation_results')
      expect(payload.funderBreakdown).toBeUndefined()
    })
  })

  describe('funder_breakdown section with data', () => {
    const contextWithFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...(baseMockContext.calculationSnapshot as CalculationSnapshot),
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

    it('includes funder breakdown data in the envelope', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)
      const payload = extractEnvelopePayload(message)

      expect(payload.funderBreakdown).toBeDefined()
      expect(payload.funderBreakdown.funders).toHaveLength(2)
    })

    it('lists all funders with investment and SROI data', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.funders[0]).toMatchObject({
        funderName: 'Foundation A',
        funderType: 'foundation',
        investmentUsd: 500000,
        sroiRatio: 3.2,
      })
      expect(funderBreakdown.funders[1]).toMatchObject({
        funderName: 'Private B',
        funderType: 'private',
        investmentUsd: 200000,
        sroiRatio: 2.1,
      })
    })

    it('includes unattributed impact amount', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.unattributedNsvUsd).toBe(50000)
    })

    it('includes guidance for funder breakdown section content in the trusted section', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)
      const trusted = trustedSection(message)

      expect(trusted).toContain("Clear summary of each funder's financial contribution")
      expect(trusted).toContain('Comparison of returns across funder types')
      expect(trusted).toContain('Explanation of any unattributed impact')
      expect(trusted).toContain('Methodology note')
    })

    it('uses correct currency in funder data', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.currency).toBe('USD')
    })
  })

  describe('funder_breakdown with no unattributed impact', () => {
    const contextNoUnattributed: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...(baseMockContext.calculationSnapshot as CalculationSnapshot),
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
      } as unknown as CalculationSnapshot,
    }

    it('reports null unattributed impact when zero', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoUnattributed)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.unattributedNsvUsd).toBeNull()
    })

    it('still includes funder breakdown data', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoUnattributed)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.funders[0]).toMatchObject({
        funderName: 'Foundation A',
        investmentUsd: 700000,
        sroiRatio: 2.96,
      })
    })
  })

  describe('funder_breakdown with empty fundersBreakdown', () => {
    const contextNoFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...(baseMockContext.calculationSnapshot as CalculationSnapshot),
        fundersBreakdown: [],
        unattributedNsvUsd: 2070000,
      } as unknown as CalculationSnapshot,
    }

    it('still identifies the section when the funder list is empty', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoFunders)
      const payload = extractEnvelopePayload(message)

      expect(payload.sectionType).toBe('funder_breakdown')
      expect(payload.funderBreakdown.funders).toHaveLength(0)
    })
  })

  describe('funder_breakdown with no calculationSnapshot', () => {
    const contextNoCalc: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: null,
    }

    it('handles null calculationSnapshot gracefully', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextNoCalc)
      const payload = extractEnvelopePayload(message)

      expect(payload.sectionType).toBe('funder_breakdown')
      expect(payload.funderBreakdown).toBeUndefined()
      expect(payload.analysisSummary.sroiRatio).toBeNull()
      expect(message).toContain('Please write')
    })
  })

  describe('funder_breakdown with multiple funders', () => {
    const contextMultipleFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...(baseMockContext.calculationSnapshot as CalculationSnapshot),
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
      } as unknown as CalculationSnapshot,
    }

    it('lists all 3+ funders in breakdown', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextMultipleFunders)
      const { funderBreakdown } = extractEnvelopePayload(message)

      const names = funderBreakdown.funders.map((f: { funderName: string }) => f.funderName)
      expect(names).toContain('Foundation A')
      expect(names).toContain('Government B')
      expect(names).toContain('Private C')
    })

    it('includes guidance about comparing across funder types', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextMultipleFunders)

      expect(trustedSection(message)).toContain('Comparison of returns across funder types')
    })

    it('preserves order of funders', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextMultipleFunders)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.funders.map((f: { funderName: string }) => f.funderName)).toEqual([
        'Foundation A',
        'Government B',
        'Private C',
      ])
    })
  })

  describe('Content format and clarity', () => {
    const contextWithFunders: StellaProjectContext = {
      ...baseMockContext,
      calculationSnapshot: {
        ...(baseMockContext.calculationSnapshot as CalculationSnapshot),
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

    it('formats data as machine-readable JSON inside the envelope', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)
      const { funderBreakdown } = extractEnvelopePayload(message)

      expect(funderBreakdown.funders[0]).toEqual({
        funderName: 'Foundation A',
        funderType: 'foundation',
        investmentUsd: 500000,
        sroiRatio: 3.2,
      })
    })

    it('includes section-specific guidance', () => {
      const message = buildComposerUserMessage('funder_breakdown', contextWithFunders)

      expect(trustedSection(message)).toContain('For this section, provide:')
    })
  })
})
