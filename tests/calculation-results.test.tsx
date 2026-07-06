import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CalculationResultsCard } from '@/components/calculation-results/CalculationResultsCard'
import { FunderBreakdownTable } from '@/components/calculation-results/FunderBreakdownTable'
import { FxAuditTrail } from '@/components/calculation-results/FxAuditTrail'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'

// Mock data
const mockFunderBreakdown: FunderBreakdownRow[] = [
  {
    funderId: 'funder-1',
    funderName: 'Fundación A',
    funderType: 'foundation',
    investmentUsd: '500000.00',
    attributedNsvUsd: '1600000.00',
    sroiRatio: '3.20',
  },
  {
    funderId: 'funder-2',
    funderName: 'Donador Privado B',
    funderType: 'private',
    investmentUsd: '200000.00',
    attributedNsvUsd: '420000.00',
    sroiRatio: '2.10',
  },
]

const mockSnapshotJson = {
  version: 1,
  currency: 'USD',
  totalInvestment: '700000.00',
  grossSocialValue: '2100000.00',
  netSocialValue: '2070000.00',
  sroiRatio: '2.957',
  fundersBreakdown: mockFunderBreakdown,
  unattributedNsvUsd: '50000.00',
  investments: [
    {
      id: 'inv-1',
      funderId: 'funder-1',
      amount: '500000',
      currency: 'USD',
      amountUsd: '500000.00',
      year: 2024,
    },
    {
      id: 'inv-2',
      funderId: 'funder-2',
      amount: '1000000',
      currency: 'COP',
      amountUsd: '200000.00',
      year: 2024,
    },
  ],
}

describe('CalculationResultsCard', () => {
  it('renders null when snapshotJson is null', () => {
    const { container } = render(
      <CalculationResultsCard snapshotJson={null} currency="USD" />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders null when fundersBreakdown is empty', () => {
    const snapshot = {
      ...mockSnapshotJson,
      fundersBreakdown: [],
    }
    const { container } = render(
      <CalculationResultsCard snapshotJson={snapshot} currency="USD" />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders title and metrics when data is present', () => {
    render(
      <CalculationResultsCard snapshotJson={mockSnapshotJson} currency="USD" />
    )

    expect(screen.getByText(/Resultados SROI con Desglose/i)).toBeInTheDocument()
    expect(screen.getByText('Inversión Total USD')).toBeInTheDocument()
    expect(screen.getByText('Valor Social Neto USD')).toBeInTheDocument()
    expect(screen.getByText('Ratio SROI Global')).toBeInTheDocument()
  })

  it('displays correct main metrics', () => {
    render(
      <CalculationResultsCard snapshotJson={mockSnapshotJson} currency="USD" />
    )

    expect(screen.getByText('$700,000.00')).toBeInTheDocument()
    expect(screen.getByText('$2,070,000.00')).toBeInTheDocument()
    expect(screen.getByText('2.96x')).toBeInTheDocument()
  })

  it('renders funder breakdown table', () => {
    render(
      <CalculationResultsCard snapshotJson={mockSnapshotJson} currency="USD" />
    )

    expect(screen.getByText('Desglose por Financiador')).toBeInTheDocument()
    expect(screen.getByText('Fundación A')).toBeInTheDocument()
    expect(screen.getByText('Donador Privado B')).toBeInTheDocument()
  })

  it('displays unattributed NSV when present', () => {
    render(
      <CalculationResultsCard snapshotJson={mockSnapshotJson} currency="USD" />
    )

    expect(screen.getByText(/Valor Social Sin Atribuir/i)).toBeInTheDocument()
    expect(screen.getByText(/2.4%/)).toBeInTheDocument()
  })

  it('renders FX audit trail when enabled', () => {
    render(
      <CalculationResultsCard snapshotJson={mockSnapshotJson} currency="USD" showFxAudit={true} />
    )

    const button = screen.getByText(/Auditoría de Conversión FX/i)
    expect(button).toBeInTheDocument()
  })

  it('does not render FX audit trail when disabled', () => {
    render(
      <CalculationResultsCard snapshotJson={mockSnapshotJson} currency="USD" showFxAudit={false} />
    )

    expect(screen.queryByText(/Auditoría de Conversión/i)).not.toBeInTheDocument()
  })
})

describe('FunderBreakdownTable', () => {
  it('renders null when fundersBreakdown is empty', () => {
    const { container } = render(
      <FunderBreakdownTable
        fundersBreakdown={[]}
        unattributedNsvUsd="0"
        totalNetSocialValueUsd="0"
        currency="USD"
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders all funder rows', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    expect(screen.getByText('Fundación A')).toBeInTheDocument()
    expect(screen.getByText('Donador Privado B')).toBeInTheDocument()
    expect(screen.getByText('foundation')).toBeInTheDocument()
    expect(screen.getByText('private')).toBeInTheDocument()
  })

  it('displays correct currency-formatted amounts', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    expect(screen.getByText('$500,000.00')).toBeInTheDocument()
    expect(screen.getByText('$1,600,000.00')).toBeInTheDocument()
    expect(screen.getByText('$200,000.00')).toBeInTheDocument()
    expect(screen.getByText('$420,000.00')).toBeInTheDocument()
  })

  it('displays SROI ratios with 2 decimals and x suffix', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    expect(screen.getByText('3.20x')).toBeInTheDocument()
    expect(screen.getByText('2.10x')).toBeInTheDocument()
  })

  it('renders totals row with correct aggregation', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    expect(screen.getByText('Total')).toBeInTheDocument()
    const rows = screen.getAllByText(/\$700,000\.00/)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('calculates overall SROI ratio correctly', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    // Total NSV = 1600000 + 420000 + 50000 = 2070000
    // Total Investment = 500000 + 200000 = 700000
    // Ratio = 2070000 / 700000 = 2.96x
    expect(screen.getByText('2.96x')).toBeInTheDocument()
  })

  it('handles mobile responsiveness with proper table structure', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    const table = screen.getByRole('table')
    expect(table).toBeInTheDocument()
    expect(table.className).toContain('w-full')
  })
})

describe('FxAuditTrail', () => {
  const mockInvestments = [
    {
      investmentId: 'inv-1',
      currency: 'USD',
      amount: '500000',
      amountUsd: '500000.00',
      year: 2024,
    },
    {
      investmentId: 'inv-2',
      currency: 'COP',
      amount: '1000000',
      amountUsd: '200000.00',
      year: 2024,
    },
  ]

  it('returns null when investments is empty', () => {
    const { container } = render(<FxAuditTrail investments={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('returns null when no conversions needed (all USD)', () => {
    const usdOnly = mockInvestments.slice(0, 1)
    const { container } = render(<FxAuditTrail investments={usdOnly} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders collapsible section when conversions exist', () => {
    render(<FxAuditTrail investments={mockInvestments} />)
    expect(screen.getByText(/Auditoría de Conversión FX/i)).toBeInTheDocument()
    expect(screen.getByText('(1 conversión)')).toBeInTheDocument()
  })

  it('renders collapsible button', () => {
    render(<FxAuditTrail investments={mockInvestments} />)

    const button = screen.getByText(/Auditoría de Conversión FX/i)
    expect(button).toBeInTheDocument()
  })

  it('displays correct entry count in button', () => {
    render(<FxAuditTrail investments={mockInvestments} />)

    const button = screen.getByText(/Auditoría de Conversión FX/i)
    expect(button).toHaveTextContent('1 conversión')
  })

  it('counts only non-USD conversions', () => {
    render(<FxAuditTrail investments={mockInvestments} />)

    // Only 1 COP conversion, USD is not counted
    expect(screen.getByText(/1 conversión/)).toBeInTheDocument()
  })

  it('renders audit trail note', () => {
    render(<FxAuditTrail investments={mockInvestments} />)

    expect(
      screen.getByText(/Todas las conversiones están bloqueadas/i)
    ).toBeInTheDocument()
  })
})

describe('Currency and Ratio Formatting', () => {
  it('formats currency in es-MX locale', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={[
          {
            funderId: 'test',
            funderName: 'Test',
            funderType: 'foundation',
            investmentUsd: '1234567.89',
            attributedNsvUsd: '9876543.21',
            sroiRatio: '8.00',
          },
        ]}
        unattributedNsvUsd="0"
        totalNetSocialValueUsd="9876543.21"
        currency="USD"
      />
    )

    expect(screen.getByText('$1,234,567.89')).toBeInTheDocument()
    expect(screen.getByText('$9,876,543.21')).toBeInTheDocument()
  })

  it('formats SROI ratio with 2 decimals', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={[
          {
            funderId: 'test',
            funderName: 'Test',
            funderType: 'foundation',
            investmentUsd: '100000',
            attributedNsvUsd: '350123.456',
            sroiRatio: '3.50123456',
          },
        ]}
        unattributedNsvUsd="0"
        totalNetSocialValueUsd="350123.456"
        currency="USD"
      />
    )

    expect(screen.getByText('3.50x')).toBeInTheDocument()
  })
})

describe('Print-friendly Styles', () => {
  it('renders table with printable structure', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    const table = screen.getByRole('table')
    expect(table).toHaveClass('w-full')
    expect(table.parentElement).toHaveClass('rounded-md', 'border')
  })

  it('uses semantic table structure for print', () => {
    render(
      <FunderBreakdownTable
        fundersBreakdown={mockFunderBreakdown}
        unattributedNsvUsd="50000.00"
        totalNetSocialValueUsd="2070000.00"
        currency="USD"
      />
    )

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Financiador/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Inversión/ })).toBeInTheDocument()
  })
})
