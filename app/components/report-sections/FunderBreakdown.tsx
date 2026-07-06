'use client'

// app/components/report-sections/FunderBreakdown.tsx
// Renders the "Funder Breakdown" section of SROI reports.
// Displays per-funder SROI ratios, investments, and attributed net social value.
// Read-only: data comes from snapshotJson (frozen at report creation).

import React from 'react'
import { AlertCircle } from 'lucide-react'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'

interface FunderBreakdownProps {
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

export function FunderBreakdownSection({
  fundersBreakdown,
  unattributedNsvUsd,
  totalNetSocialValueUsd,
  currency = 'USD',
}: FunderBreakdownProps) {
  if (!fundersBreakdown || fundersBreakdown.length === 0) {
    return (
      <div className="flex gap-2 rounded-md border border-border bg-muted/40 p-3">
        <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">
          No hay datos de desglose financiero por financiador disponibles.
        </p>
      </div>
    )
  }

  const totalInvestment = fundersBreakdown.reduce((sum, row) => {
    return sum + parseFloat(row.investmentUsd)
  }, 0)

  const totalAttributedNsv = fundersBreakdown.reduce((sum, row) => {
    return sum + parseFloat(row.attributedNsvUsd)
  }, 0)

  const unattributedNsv = parseFloat(unattributedNsvUsd)
  const unattributedPct = totalNetSocialValueUsd
    ? ((unattributedNsv / parseFloat(totalNetSocialValueUsd)) * 100).toFixed(1)
    : '0.0'

  const overallSroiRatio =
    totalInvestment > 0 ? ((totalAttributedNsv + unattributedNsv) / totalInvestment).toFixed(2) : '0.00'

  return (
    <div className="space-y-4">
      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-2 text-left font-semibold text-foreground">Nombre del financiador</th>
              <th className="px-4 py-2 text-left font-semibold text-foreground">Tipo</th>
              <th className="px-4 py-2 text-right font-semibold text-foreground">Inversión</th>
              <th className="px-4 py-2 text-right font-semibold text-foreground">Valor Social Atribuido</th>
              <th className="px-4 py-2 text-right font-semibold text-foreground">Ratio SROI</th>
            </tr>
          </thead>
          <tbody>
            {fundersBreakdown.map((row, idx) => (
              <tr key={row.funderId} className={idx % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                <td className="px-4 py-2 text-foreground font-medium">{row.funderName}</td>
                <td className="px-4 py-2 text-muted-foreground text-xs">{row.funderType}</td>
                <td className="px-4 py-2 text-right font-mono text-foreground">
                  {formatCurrency(row.investmentUsd, currency)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-foreground">
                  {formatCurrency(row.attributedNsvUsd, currency)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-foreground font-semibold">
                  {formatRatio(row.sroiRatio)}
                </td>
              </tr>
            ))}
            {/* Totals row */}
            <tr className="border-t-2 border-border bg-muted/30 font-semibold">
              <td className="px-4 py-2 text-foreground">Total proyecto</td>
              <td className="px-4 py-2 text-muted-foreground text-xs">—</td>
              <td className="px-4 py-2 text-right font-mono text-foreground">
                {formatCurrency(totalInvestment.toFixed(4), currency)}
              </td>
              <td className="px-4 py-2 text-right font-mono text-foreground">
                {formatCurrency(totalAttributedNsv.toFixed(4), currency)}
              </td>
              <td className="px-4 py-2 text-right font-mono text-foreground">
                {formatRatio(overallSroiRatio)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Unattributed NSV line */}
      {unattributedNsv > 0 && (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <p className="text-sm text-foreground">
            <span className="font-semibold">Valor Social Sin Atribuir: </span>
            {formatCurrency(unattributedNsvUsd, currency)} ({unattributedPct}% del valor social total)
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Este valor no ha sido atribuido a ningún financiador específico a través de las asignaciones
            de resultados.
          </p>
        </div>
      )}

      {/* Disclaimer */}
      <div className="rounded-md bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Nota: </span>
          Este desglose es congelado en la ejecución del cálculo. Los ratios SROI individuales por
          financiador reflejan únicamente el valor atribuido a través de las asignaciones de
          resultados. El ratio SROI del proyecto incluye el valor social sin atribuir.
        </p>
      </div>
    </div>
  )
}
