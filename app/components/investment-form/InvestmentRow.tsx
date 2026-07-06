'use client'

import { useState, useEffect } from 'react'
import { Trash2, RefreshCw } from 'lucide-react'
import { convertToUsd } from '@/lib/pipeline/fx-math'

interface Funder {
  id: string
  name: string
  funderType?: string
}

interface Investment {
  id: string
  funderId: string
  amount: string
  currency: string
  amountUsd: string | null
  contributionType: 'cash' | 'in_kind'
  inKindValuationNotes: string | null
  year?: number | null
  description?: string | null
  status: string
  fxRateId?: string | null
}

interface InvestmentFormData {
  funderId: string
  amount: string
  currency: string
  contributionType: 'cash' | 'in_kind'
  inKindValuationNotes?: string
  year?: number
  description?: string
  fxRate?: string
  fxSource?: string
}

interface InvestmentRowProps {
  investment: Investment
  funders: Funder[]
  onUpdate: (data: Partial<InvestmentFormData>) => void | Promise<void>
  onDelete: () => void | Promise<void>
  canEdit: boolean
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * InvestmentRow: Single investment entry with:
 * - Funder select (with org-scoped funders)
 * - Contribution type (cash | in_kind)
 * - Amount + Currency
 * - USD equivalent (read-only)
 * - FX sub-form (for non-USD)
 * - In-kind valuation notes (conditional)
 * - Delete button
 */
export default function InvestmentRow({
  investment,
  funders,
  onUpdate,
  onDelete,
  canEdit,
}: InvestmentRowProps) {
  const [formData, setFormData] = useState<Partial<InvestmentFormData>>({
    funderId: investment.funderId,
    amount: investment.amount,
    currency: investment.currency,
    contributionType: investment.contributionType,
    inKindValuationNotes: investment.inKindValuationNotes ?? '',
    year: investment.year ?? undefined,
    description: investment.description ?? '',
  })

  const [fxRate, setFxRate] = useState<string>('')
  const [fxSource, setFxSource] = useState<string>('')
  const [fetching, setFetching] = useState(false)

  const selectedFunder = funders.find((f) => f.id === formData.funderId)
  const needsFxConversion = formData.currency && formData.currency !== 'USD'
  const isCop = formData.currency === 'COP'

  // Calculate USD equivalent (read-only display)
  const calculateUsdDisplay = () => {
    if (!formData.amount || !fxRate || formData.currency === 'USD') {
      return investment.amountUsd || null
    }
    return convertToUsd(formData.amount, fxRate)
  }

  const usdDisplay = calculateUsdDisplay()

  const handleChange = (field: keyof InvestmentFormData, value: any) => {
    const newData = { ...formData, [field]: value }
    setFormData(newData)
    onUpdate(newData)
  }

  const handleFetchCopRate = async () => {
    if (!formData.year) {
      alert('Por favor especifica el año de referencia para obtener la TRM')
      return
    }

    setFetching(true)
    try {
      // Fetch COP rate for Dec 31 of the given year
      const date = `${formData.year}-12-31`
      const response = await fetch('/api/fx-rates/fetch-cop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      })
      if (!response.ok) throw new Error('Failed to fetch COP rate')
      const data = await response.json()
      setFxRate(data.rateToUsd)
      setFxSource('TRM oficial')
    } catch (err) {
      console.error('COP rate fetch failed:', err)
      alert('No se pudo obtener la tasa TRM. Intenta nuevamente.')
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="border border-border rounded-lg p-4 space-y-4 bg-card">
      {/* Row 1: Funder + Contribution Type */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`funder-${investment.id}`} className="block text-sm font-medium text-foreground">
            Financiador <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <select
            id={`funder-${investment.id}`}
            value={formData.funderId || ''}
            onChange={(e) => handleChange('funderId', e.target.value)}
            disabled={!canEdit}
            className={INPUT_CLASS}
            required
          >
            <option value="">— Selecciona un financiador —</option>
            {funders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`ctype-${investment.id}`} className="block text-sm font-medium text-foreground">
            Tipo de aporte
          </label>
          <select
            id={`ctype-${investment.id}`}
            value={formData.contributionType}
            onChange={(e) => handleChange('contributionType', e.target.value as 'cash' | 'in_kind')}
            disabled={!canEdit}
            className={INPUT_CLASS}
          >
            <option value="cash">Efectivo</option>
            <option value="in_kind">En especie</option>
          </select>
        </div>
      </div>

      {/* Row 2: Amount + Currency */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label htmlFor={`amount-${investment.id}`} className="block text-sm font-medium text-foreground">
            Monto <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <input
            id={`amount-${investment.id}`}
            type="text"
            inputMode="decimal"
            value={formData.amount}
            onChange={(e) => handleChange('amount', e.target.value)}
            disabled={!canEdit}
            required
            className={INPUT_CLASS}
            placeholder="0.00"
          />
        </div>

        <div>
          <label htmlFor={`currency-${investment.id}`} className="block text-sm font-medium text-foreground">
            Moneda <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <input
            id={`currency-${investment.id}`}
            type="text"
            value={formData.currency}
            onChange={(e) => {
              handleChange('currency', e.target.value.toUpperCase())
              // Reset FX rate when currency changes
              setFxRate('')
              setFxSource('')
            }}
            disabled={!canEdit}
            required
            placeholder="USD, COP, EUR…"
            maxLength={3}
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor={`usd-${investment.id}`} className="block text-sm font-medium text-foreground">
            Equivalente USD
          </label>
          <div
            id={`usd-${investment.id}`}
            className="mt-1 flex items-center px-3 py-1.5 rounded-md border border-input bg-muted text-sm text-muted-foreground"
          >
            {usdDisplay ? (
              <span className="text-foreground tabular-nums font-medium">
                {parseFloat(usdDisplay).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{' '}
                USD
              </span>
            ) : formData.currency === 'USD' ? (
              <span className="text-foreground tabular-nums font-medium">
                {parseFloat(formData.amount || '0').toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{' '}
                USD
              </span>
            ) : (
              <span className="text-amber-600">Pendiente de conversión</span>
            )}
          </div>
        </div>
      </div>

      {/* Row 3: FX Conversion (if non-USD) */}
      {needsFxConversion && (
        <div className="border-t border-border pt-4 space-y-3">
          <h4 className="text-sm font-semibold text-foreground">Tasa de conversión</h4>

          {isCop ? (
            // COP: Auto-fetch option
            <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
              <div className="flex-1">
                <label htmlFor={`cop-year-${investment.id}`} className="block text-xs font-medium text-muted-foreground mb-1">
                  Año de referencia
                </label>
                <input
                  id={`cop-year-${investment.id}`}
                  type="number"
                  value={formData.year || ''}
                  onChange={(e) => handleChange('year', e.target.value ? parseInt(e.target.value) : undefined)}
                  disabled={!canEdit}
                  placeholder="2024"
                  className={INPUT_CLASS}
                />
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={handleFetchCopRate}
                  disabled={fetching || !formData.year}
                  className="mt-5 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`h-3 w-3 ${fetching ? 'animate-spin' : ''}`} />
                  Auto-obtener TRM
                </button>
              )}
              {fxRate && (
                <div className="mt-5 text-xs text-green-600 font-medium">
                  ✓ TRM: 1 COP = {fxRate} USD
                </div>
              )}
            </div>
          ) : (
            // Other currencies: Manual entry
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`rate-${investment.id}`} className="block text-xs font-medium text-foreground mb-1">
                  Tasa {formData.currency}→USD <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <input
                  id={`rate-${investment.id}`}
                  type="text"
                  inputMode="decimal"
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  disabled={!canEdit}
                  placeholder="0.00"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor={`source-${investment.id}`} className="block text-xs font-medium text-foreground mb-1">
                  Fuente de la tasa <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <input
                  id={`source-${investment.id}`}
                  type="text"
                  value={fxSource}
                  onChange={(e) => setFxSource(e.target.value)}
                  disabled={!canEdit}
                  placeholder="Ej: ECB, Banco Central"
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Row 4: In-kind Valuation Notes (if applicable) */}
      {formData.contributionType === 'in_kind' && (
        <div className="border-t border-border pt-4">
          <label htmlFor={`notes-${investment.id}`} className="block text-sm font-medium text-foreground">
            Notas de valoración <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">
            Explica cómo se valuó este aporte en especie (ej: costo de mercado, tarifa profesional, etc.)
          </p>
          <textarea
            id={`notes-${investment.id}`}
            value={formData.inKindValuationNotes || ''}
            onChange={(e) => handleChange('inKindValuationNotes', e.target.value)}
            disabled={!canEdit}
            required
            placeholder="Describe la metodología de valuación…"
            rows={2}
            className={INPUT_CLASS}
          />
        </div>
      )}

      {/* Row 5: Optional fields (Year + Description) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-border pt-4">
        <div>
          <label htmlFor={`year-${investment.id}`} className="block text-sm font-medium text-foreground">
            Año de referencia
            <span className="ml-1 text-xs text-muted-foreground font-normal">(opcional)</span>
          </label>
          <input
            id={`year-${investment.id}`}
            type="number"
            value={formData.year || ''}
            onChange={(e) => handleChange('year', e.target.value ? parseInt(e.target.value) : undefined)}
            disabled={!canEdit}
            placeholder="2024"
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor={`desc-${investment.id}`} className="block text-sm font-medium text-foreground">
            Notas
            <span className="ml-1 text-xs text-muted-foreground font-normal">(opcional)</span>
          </label>
          <input
            id={`desc-${investment.id}`}
            type="text"
            value={formData.description || ''}
            onChange={(e) => handleChange('description', e.target.value)}
            disabled={!canEdit}
            placeholder="Ej: Aporte anual"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {/* Delete button */}
      {canEdit && (
        <div className="flex justify-end pt-2 border-t border-border">
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-700 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            Eliminar
          </button>
        </div>
      )}
    </div>
  )
}
