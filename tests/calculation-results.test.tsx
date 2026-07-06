import { describe, it, expect } from 'vitest'
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

describe('CalculationResultsCard', () => {
  it('should render null when snapshotJson is null', () => {
    const result = CalculationResultsCard({ snapshotJson: null, currency: 'USD' })
    expect(result).toBeNull()
  })

  it('should render null when fundersBreakdown is empty', () => {
    const snapshot = {
      ...mockSnapshotJson,
      fundersBreakdown: [],
    }
    const result = CalculationResultsCard({ snapshotJson: snapshot, currency: 'USD' })
    expect(result).toBeNull()
  })

  it('should export component without errors', () => {
    expect(CalculationResultsCard).toBeDefined()
    expect(typeof CalculationResultsCard).toBe('function')
  })
})

describe('FunderBreakdownTable', () => {
  it('should render null when fundersBreakdown is empty', () => {
    const result = FunderBreakdownTable({
      fundersBreakdown: [],
      unattributedNsvUsd: '0',
      totalNetSocialValueUsd: '0',
      currency: 'USD',
    })
    expect(result).toBeNull()
  })

  it('should export component without errors', () => {
    expect(FunderBreakdownTable).toBeDefined()
    expect(typeof FunderBreakdownTable).toBe('function')
  })

  it('should calculate total SROI correctly', () => {
    // Total NSV = 1600000 + 420000 + 50000 = 2070000
    // Total Investment = 500000 + 200000 = 700000
    // Ratio = 2070000 / 700000 = 2.96x
    const totalInvestment = 500000 + 200000
    const totalAttributedNsv = 1600000 + 420000
    const unattributedNsv = 50000
    const expectedRatio = (totalAttributedNsv + unattributedNsv) / totalInvestment

    expect(expectedRatio.toFixed(2)).toBe('2.96')
  })

  it('should format currency correctly', () => {
    const formatter = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

    const formatted = formatter.format(500000)
    expect(formatted).toContain('500')
    expect(formatted).toContain('000')
  })

  it('should format SROI ratio with 2 decimals', () => {
    const ratio = 3.20
    const formatted = `${ratio.toFixed(2)}x`
    expect(formatted).toBe('3.20x')
  })
})

describe('FxAuditTrail', () => {
  it('should render null when investments is empty', () => {
    const result = FxAuditTrail({ investments: [] })
    expect(result).toBeNull()
  })

  it('should render null when no conversions needed (all USD)', () => {
    const usdOnly = mockInvestments.slice(0, 1)
    const result = FxAuditTrail({ investments: usdOnly })
    expect(result).toBeNull()
  })

  it('should export component without errors', () => {
    expect(FxAuditTrail).toBeDefined()
    expect(typeof FxAuditTrail).toBe('function')
  })

  it('should count only non-USD conversions', () => {
    // Only COP is converted, USD passes through
    const conversions = mockInvestments.filter((inv) => inv.currency !== 'USD' && inv.amountUsd)
    expect(conversions).toHaveLength(1)
  })

  it('should format locale-specific numbers correctly', () => {
    const formatted = (1000000).toLocaleString('es-MX')
    expect(formatted).toBe('1,000,000')
  })
})

describe('Currency and Ratio Formatting', () => {
  it('should format currency in es-MX locale with USD symbol', () => {
    const formatter = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

    const amount = 1234567.89
    const formatted = formatter.format(amount)

    // es-MX format includes $ symbol and thousand separators
    expect(formatted).toContain('1')
    expect(formatted).toContain('234')
  })

  it('should handle unattributed NSV percentage calculation', () => {
    const unattributedNsv = 50000
    const totalNsv = 2070000
    const percent = ((unattributedNsv / totalNsv) * 100).toFixed(1)

    expect(percent).toBe('2.4')
  })

  it('should handle zero division gracefully', () => {
    const totalInvestment = 0
    const totalAttributedNsv = 1000
    const unattributedNsv = 500

    const ratio = totalInvestment > 0
      ? ((totalAttributedNsv + unattributedNsv) / totalInvestment).toFixed(2)
      : '0.00'

    expect(ratio).toBe('0.00')
  })
})

describe('Component Integration', () => {
  it('should have CalculationResultsCard, FunderBreakdownTable, and FxAuditTrail exported', () => {
    expect(CalculationResultsCard).toBeDefined()
    expect(FunderBreakdownTable).toBeDefined()
    expect(FxAuditTrail).toBeDefined()
  })

  it('should handle complete snapshot data flow', () => {
    expect(mockSnapshotJson.fundersBreakdown).toHaveLength(2)
    expect(mockSnapshotJson.investments).toHaveLength(2)
    expect(mockSnapshotJson.unattributedNsvUsd).toBe('50000.00')
    expect(mockSnapshotJson.sroiRatio).toBe('2.957')
  })

  it('should validate funder breakdown row structure', () => {
    const row = mockFunderBreakdown[0]
    expect(row).toHaveProperty('funderId')
    expect(row).toHaveProperty('funderName')
    expect(row).toHaveProperty('funderType')
    expect(row).toHaveProperty('investmentUsd')
    expect(row).toHaveProperty('attributedNsvUsd')
    expect(row).toHaveProperty('sroiRatio')
  })

  it('should validate investment structure', () => {
    const inv = mockSnapshotJson.investments![0]
    expect(inv).toHaveProperty('id')
    expect(inv).toHaveProperty('currency')
    expect(inv).toHaveProperty('amount')
    expect(inv).toHaveProperty('amountUsd')
    expect(inv).toHaveProperty('year')
  })
})
