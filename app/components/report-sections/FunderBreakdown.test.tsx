import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FunderBreakdownSection } from './FunderBreakdown'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'

describe('FunderBreakdownSection', () => {
  const mockFunders: FunderBreakdownRow[] = [
    {
      funderId: 'funder-1',
      funderName: 'Foundation A',
      funderType: 'foundation',
      investmentUsd: '500000.0000',
      attributedNsvUsd: '1600000.0000',
      sroiRatio: '3.200000',
    },
    {
      funderId: 'funder-2',
      funderName: 'Private B',
      funderType: 'private',
      investmentUsd: '200000.0000',
      attributedNsvUsd: '420000.0000',
      sroiRatio: '2.100000',
    },
  ]

  describe('Section visibility', () => {
    it('renders table if fundersBreakdown is not empty', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    it('shows empty state if fundersBreakdown is empty', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={[]}
          unattributedNsvUsd="0.0000"
          totalNetSocialValueUsd="0.0000"
          currency="USD"
        />
      )

      expect(screen.getByText(/No hay datos de desglose/i)).toBeInTheDocument()
    })
  })

  describe('Table data rendering', () => {
    it('displays all funders with correct data', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      // Check funder names
      expect(screen.getByText('Foundation A')).toBeInTheDocument()
      expect(screen.getByText('Private B')).toBeInTheDocument()

      // Check funder types
      expect(screen.getByText('foundation')).toBeInTheDocument()
      expect(screen.getByText('private')).toBeInTheDocument()
    })

    it('formats currency values correctly', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      // Check that currency formatting is applied (locale-based)
      const cells = screen.getAllByText(/USD/)
      expect(cells.length).toBeGreaterThan(0)
    })

    it('formats SROI ratios to 2 decimal places', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      expect(screen.getByText('3.20x')).toBeInTheDocument()
      expect(screen.getByText('2.10x')).toBeInTheDocument()
    })
  })

  describe('Totals row', () => {
    it('displays totals row with correct calculations', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      expect(screen.getByText('Total proyecto')).toBeInTheDocument()

      // Total investment: 500000 + 200000 = 700000
      // Total attributed NSV: 1600000 + 420000 = 2020000
      // Overall SROI: (2020000 + 50000) / 700000 = 2.95714... ≈ 2.96
    })

    it('calculates overall SROI ratio including unattributed impact', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      // Overall = (2020000 + 50000) / 700000 = 2.96
      expect(screen.getByText('2.96x')).toBeInTheDocument()
    })
  })

  describe('Unattributed line', () => {
    it('shows unattributed NSV line when value > 0', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      expect(screen.getByText(/Valor Social Sin Atribuir:/)).toBeInTheDocument()
      expect(screen.getByText(/2.4%/)).toBeInTheDocument() // 50000 / 2070000 = 2.4%
    })

    it('hides unattributed NSV line when value is 0', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="0.0000"
          totalNetSocialValueUsd="2020000.0000"
          currency="USD"
        />
      )

      expect(screen.queryByText(/Valor Social Sin Atribuir:/)).not.toBeInTheDocument()
    })

    it('calculates unattributed percentage correctly', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="207000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      // 207000 / 2070000 = 10.0%
      expect(screen.getByText(/10.0%/)).toBeInTheDocument()
    })
  })

  describe('Multiple funders', () => {
    it('renders 3+ funders correctly', () => {
      const threeFunders: FunderBreakdownRow[] = [
        ...mockFunders,
        {
          funderId: 'funder-3',
          funderName: 'Government C',
          funderType: 'government',
          investmentUsd: '300000.0000',
          attributedNsvUsd: '750000.0000',
          sroiRatio: '2.500000',
        },
      ]

      render(
        <FunderBreakdownSection
          fundersBreakdown={threeFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2420000.0000"
          currency="USD"
        />
      )

      expect(screen.getByText('Foundation A')).toBeInTheDocument()
      expect(screen.getByText('Private B')).toBeInTheDocument()
      expect(screen.getByText('Government C')).toBeInTheDocument()
      expect(screen.getByText('government')).toBeInTheDocument()
    })
  })

  describe('Single funder backward compatibility', () => {
    it('renders table correctly with a single funder', () => {
      const singleFunder: FunderBreakdownRow[] = [
        {
          funderId: 'funder-1',
          funderName: 'Foundation A',
          funderType: 'foundation',
          investmentUsd: '500000.0000',
          attributedNsvUsd: '1600000.0000',
          sroiRatio: '3.200000',
        },
      ]

      render(
        <FunderBreakdownSection
          fundersBreakdown={singleFunder}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="1650000.0000"
          currency="USD"
        />
      )

      expect(screen.getByText('Foundation A')).toBeInTheDocument()
      expect(screen.getByText('foundation')).toBeInTheDocument()
      expect(screen.getByText('3.20x')).toBeInTheDocument()
    })
  })

  describe('Currency support', () => {
    it('uses provided currency code in formatting', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="EUR"
        />
      )

      const cells = screen.getAllByText(/EUR/)
      expect(cells.length).toBeGreaterThan(0)
    })
  })

  describe('Disclaimer section', () => {
    it('shows disclaimer about frozen snapshot', () => {
      render(
        <FunderBreakdownSection
          fundersBreakdown={mockFunders}
          unattributedNsvUsd="50000.0000"
          totalNetSocialValueUsd="2070000.0000"
          currency="USD"
        />
      )

      expect(screen.getByText(/Este desglose es congelado/i)).toBeInTheDocument()
      expect(screen.getByText(/congelado en la ejecución del cálculo/i)).toBeInTheDocument()
    })
  })
})
