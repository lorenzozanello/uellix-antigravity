'use client'

// components/calculation-results/FxAuditTrail.tsx
// Displays collapsible FX conversion audit trail.
// Shows per-investment currency, amount, conversion rate, date, and source.

import React, { useState } from 'react'
import { ChevronDown } from 'lucide-react'

interface FxAuditEntry {
  investmentId: string
  currency: string
  amount: string
  amountUsd: string | null
  year?: number
  fxRateId?: string
  conversationRate?: string
  source?: string
}

interface FxAuditTrailProps {
  investments: FxAuditEntry[]
  defaultCurrency?: string
}

export function FxAuditTrail({ investments, defaultCurrency = 'USD' }: FxAuditTrailProps) {
  const [isOpen, setIsOpen] = useState(false)

  if (!investments || investments.length === 0) {
    return null
  }

  // Filter to only show non-USD conversions (USD passes through)
  const conversions = investments.filter((inv) => inv.currency !== 'USD' && inv.amountUsd)

  if (conversions.length === 0) {
    return null
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-foreground/80 transition-colors w-full"
      >
        <ChevronDown
          className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        Auditoría de Conversión FX ({conversions.length} conversión{conversions.length !== 1 ? 'es' : ''})
      </button>

      {isOpen && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {conversions.map((inv) => (
            <div
              key={inv.investmentId}
              className="rounded-sm bg-background p-3 text-xs space-y-1 font-mono"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground">Aporte:</span>
                <span className="text-foreground font-medium">
                  {parseFloat(inv.amount).toLocaleString('es-MX')} {inv.currency}
                </span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground">Equivalente USD:</span>
                <span className="text-foreground font-medium">
                  {inv.amountUsd ? parseFloat(inv.amountUsd).toLocaleString('es-MX') : '—'} {defaultCurrency}
                </span>
              </div>
              {inv.year && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted-foreground">Año de referencia:</span>
                  <span className="text-foreground">{inv.year}</span>
                </div>
              )}
              {inv.source && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted-foreground">Fuente:</span>
                  <span className="text-foreground">{inv.source}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        Todas las conversiones están bloqueadas en el momento del cálculo para auditoría.
      </p>
    </div>
  )
}
