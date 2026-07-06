'use client'

// components/calculation-results/FunderBreakdownTable.tsx
// Displays per-funder breakdown table with investment, attributed NSV, and SROI ratio.
// Read-only, frozen from snapshotJson at calculation time.

import React from 'react'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'

interface FunderBreakdownTableProps {
  fundersBreakdown: FunderBreakdownRow[]
  unattributedNsvUsd: string
  totalNetSocialValueUsd: string
  currency?: string
}

const formatCurrency = (value: string, currency: string = 'USD'): string => {
  try {
    const numValue = parseFloat(value)
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numValue)
  } catch {
    return `${currency} ${value}`
  }
}

const formatRatio = (ratio: string): string => {
  try {
    const numRatio = parseFloat(ratio)
    return `${numRatio.toFixed(2)}x`
  } catch {
    return ratio
  }
}

export function FunderBreakdownTable({
  fundersBreakdown,
  unattributedNsvUsd,
  totalNetSocialValueUsd,
  currency = 'USD',
}: FunderBreakdownTableProps) {
  if (!fundersBreakdown || fundersBreakdown.length === 0) {
    return null
  }

  const totalInvestment = fundersBreakdown.reduce((sum, row) => {
    return sum + parseFloat(row.investmentUsd)
  }, 0)

  const totalAttributedNsv = fundersBreakdown.reduce((sum, row) => {
    return sum + parseFloat(row.attributedNsvUsd)
  }, 0)

  const unattributedNsv = parseFloat(unattributedNsvUsd)
  const overallSroiRatio =
    totalInvestment > 0 ? ((totalAttributedNsv + unattributedNsv) / totalInvestment).toFixed(2) : '0.00'

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-4 py-3 text-left font-semibold text-foreground">Financiador</th>
            <th className="px-4 py-3 text-left font-semibold text-foreground">Tipo</th>
            <th className="px-4 py-3 text-right font-semibold text-foreground tabular-nums">Inversión</th>
            <th className="px-4 py-3 text-right font-semibold text-foreground tabular-nums">
              Valor Atribuido
            </th>
            <th className="px-4 py-3 text-right font-semibold text-foreground tabular-nums">Ratio SROI</th>
          </tr>
        </thead>
        <tbody>
          {fundersBreakdown.map((row, idx) => (
            <tr
              key={row.funderId}
              className={idx % 2 === 0 ? 'bg-background' : 'bg-muted/20'}
            >
              <td className="px-4 py-3 text-foreground font-medium">{row.funderName}</td>
              <td className="px-4 py-3 text-muted-foreground text-xs">{row.funderType}</td>
              <td className="px-4 py-3 text-right font-mono text-foreground">
                {formatCurrency(row.investmentUsd, currency)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-foreground">
                {formatCurrency(row.attributedNsvUsd, currency)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-foreground font-semibold">
                {formatRatio(row.sroiRatio)}
              </td>
            </tr>
          ))}
          {/* Totals row */}
          <tr className="border-t-2 border-border bg-muted/30 font-semibold">
            <td className="px-4 py-3 text-foreground">Total</td>
            <td className="px-4 py-3 text-muted-foreground text-xs">—</td>
            <td className="px-4 py-3 text-right font-mono text-foreground">
              {formatCurrency(totalInvestment.toFixed(4), currency)}
            </td>
            <td className="px-4 py-3 text-right font-mono text-foreground">
              {formatCurrency(totalAttributedNsv.toFixed(4), currency)}
            </td>
            <td className="px-4 py-3 text-right font-mono text-foreground">
              {formatRatio(overallSroiRatio)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
