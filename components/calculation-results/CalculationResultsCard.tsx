'use client'

// components/calculation-results/CalculationResultsCard.tsx
// Main results display card with per-funder breakdown, unattributed NSV, and FX audit trail.
// Data is frozen from snapshotJson at calculation time (read-only).

import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { FunderBreakdownTable } from './FunderBreakdownTable'
import { FxAuditTrail } from './FxAuditTrail'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'

interface SnapshotJson {
  version?: number
  currency?: string
  totalInvestment?: string
  grossSocialValue?: string
  netSocialValue?: string
  sroiRatio?: string
  investments?: Array<{
    id: string
    funderId?: string
    contributionType?: string
    amount: string
    currency: string
    amountUsd: string | null
    year?: number
  }>
  fundersBreakdown?: FunderBreakdownRow[]
  unattributedNsvUsd?: string
  assignments?: Array<{
    assignmentId: string
    outcomeId: string
    proxyId: string
  }>
}

interface CalculationResultsCardProps {
  snapshotJson: SnapshotJson | null
  currency?: string
  showFxAudit?: boolean
}

const formatCurrency = (value: string | undefined, currency: string = 'USD'): string => {
  if (!value) return `${currency} 0.00`
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

export function CalculationResultsCard({
  snapshotJson,
  currency = 'USD',
  showFxAudit = true,
}: CalculationResultsCardProps) {
  if (!snapshotJson) {
    return null
  }

  const hasFunderBreakdown =
    snapshotJson.fundersBreakdown && snapshotJson.fundersBreakdown.length > 0

  if (!hasFunderBreakdown) {
    return null
  }

  const unattributedNsvUsd = snapshotJson.unattributedNsvUsd || '0'
  const totalNetSocialValueUsd = snapshotJson.netSocialValue || '0'

  const unattributedNsv = parseFloat(unattributedNsvUsd)
  const totalNsv = parseFloat(totalNetSocialValueUsd)
  const unattributedPct =
    totalNsv > 0 ? ((unattributedNsv / totalNsv) * 100).toFixed(1) : '0.0'

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resultados SROI con Desglose por Financiador</CardTitle>
        <CardDescription>
          Desglose congelado de inversión, valor social atribuido y ratio SROI por financiador
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Main metrics summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <p className="text-xs font-medium text-muted-foreground">Inversión Total USD</p>
            <p className="mt-2 text-lg font-bold text-foreground tabular-nums">
              {formatCurrency(snapshotJson.totalInvestment, currency)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <p className="text-xs font-medium text-muted-foreground">Valor Social Neto USD</p>
            <p className="mt-2 text-lg font-bold text-foreground tabular-nums">
              {formatCurrency(snapshotJson.netSocialValue, currency)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <p className="text-xs font-medium text-muted-foreground">Ratio SROI Global</p>
            <p className="mt-2 text-lg font-bold text-foreground tabular-nums">
              {snapshotJson.sroiRatio
                ? `${parseFloat(snapshotJson.sroiRatio).toFixed(2)}x`
                : '—'}
            </p>
          </div>
        </div>

        {/* Per-funder table */}
        {hasFunderBreakdown && (
          <div>
            <h3 className="mb-3 text-sm font-semibold text-foreground">Desglose por Financiador</h3>
            <FunderBreakdownTable
              fundersBreakdown={snapshotJson.fundersBreakdown || []}
              unattributedNsvUsd={unattributedNsvUsd}
              totalNetSocialValueUsd={totalNetSocialValueUsd}
              currency={currency}
            />
          </div>
        )}

        {/* Unattributed NSV line */}
        {unattributedNsv > 0 && (
          <div className="rounded-md border border-border bg-muted/20 p-4">
            <p className="text-sm text-foreground">
              <span className="font-semibold">Valor Social Sin Atribuir: </span>
              {formatCurrency(unattributedNsvUsd, currency)} ({unattributedPct}% del total)
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Impacto no atribuido a ningún financiador específico a través de las asignaciones de
              resultados.
            </p>
          </div>
        )}

        {/* FX Audit Trail */}
        {showFxAudit && snapshotJson.investments && snapshotJson.investments.length > 0 && (
          <FxAuditTrail
            investments={snapshotJson.investments.map((inv) => ({
              investmentId: inv.id,
              currency: inv.currency,
              amount: inv.amount,
              amountUsd: inv.amountUsd,
              year: inv.year,
            }))}
            defaultCurrency={currency}
          />
        )}

        {/* Frozen data note */}
        <div className="rounded-md bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Nota: </span>
            Este desglose es congelado en la ejecución del cálculo y no puede ser editado. Los
            datos representan un ratio SROI preliminar que requiere revisión humana para
            validación final.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
