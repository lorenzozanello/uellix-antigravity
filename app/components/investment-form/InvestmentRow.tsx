'use client'

import { useState } from 'react'
import { Trash2, RefreshCw, Save, Check } from 'lucide-react'
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
  /** Called when the user explicitly clicks "Guardar". Never on keystroke. */
  onSave: (data: InvestmentFormData) => void | Promise<void>
  onDelete: () => void | Promise<void>
  canEdit: boolean
  isSaving: boolean
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * InvestmentRow: Single investment entry.
 *
 * Editing is local-only; nothing hits the server until the user clicks
 * "Guardar". For COP the official TRM is applied server-side at save time
 * (from the reference year), so the client "Ver TRM" button is a preview aid
 * only — it never has to succeed for the save to produce a correct USD value.
 */
export default function InvestmentRow({
  investment,
  funders,
  onSave,
  onDelete,
  canEdit,
  isSaving,
}: InvestmentRowProps) {
  const isTemp = investment.id.startsWith('temp-')

  const initial: InvestmentFormData = {
    funderId: investment.funderId,
    amount: investment.amount,
    currency: investment.currency,
    contributionType: investment.contributionType,
    inKindValuationNotes: investment.inKindValuationNotes ?? '',
    year: investment.year ?? undefined,
    description: investment.description ?? '',
  }

  const [formData, setFormData] = useState<InvestmentFormData>(initial)
  const [fxRate, setFxRate] = useState<string>('')
  const [fxSource, setFxSource] = useState<string>('')
  const [fxDate, setFxDate] = useState<string>('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const needsFxConversion = !!formData.currency && formData.currency !== 'USD'
  const isCop = formData.currency === 'COP'

  // USD equivalent shown to the user. For a saved row we trust the frozen
  // server value; while editing we preview using the locally fetched/entered
  // rate. TRM `valor` is COP-per-USD, so convertToUsd = amount / rate.
  const usdDisplay = (() => {
    if (formData.currency === 'USD') return formData.amount || null
    if (fxRate && formData.amount) {
      try {
        return convertToUsd(formData.amount, fxRate)
      } catch {
        return null
      }
    }
    // Fall back to the saved value only if the currency hasn't been changed.
    if (formData.currency === investment.currency) return investment.amountUsd
    return null
  })()

  // Dirty tracking so the "Guardar cambios" button only lights up when there
  // is something to persist on an already-saved row.
  const isDirty =
    isTemp ||
    formData.funderId !== initial.funderId ||
    formData.amount !== initial.amount ||
    formData.currency !== initial.currency ||
    formData.contributionType !== initial.contributionType ||
    (formData.inKindValuationNotes ?? '') !== (initial.inKindValuationNotes ?? '') ||
    (formData.year ?? undefined) !== (initial.year ?? undefined) ||
    (formData.description ?? '') !== (initial.description ?? '')

  // Validation
  const missing: string[] = []
  if (!formData.funderId) missing.push('Selecciona un financiador')
  if (!formData.amount) missing.push('Ingresa el monto')
  else if (parseFloat(formData.amount) <= 0) missing.push('El monto debe ser mayor a 0')
  if (!formData.currency) missing.push('Especifica la moneda')
  if (isCop && !formData.year) missing.push('Indica el año de referencia para aplicar la TRM oficial')
  if (formData.contributionType === 'in_kind' && !formData.inKindValuationNotes?.trim()) {
    missing.push('Agrega notas de valoración para el aporte en especie')
  }
  const isReadyToSave = missing.length === 0

  const handleChange = (field: keyof InvestmentFormData, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleFetchFxRate = async () => {
    if (!formData.year) {
      setFetchError('Primero indica el año de referencia.')
      return
    }
    setFetching(true)
    setFetchError(null)
    try {
      const date = `${formData.year}-12-31`
      const response = await fetch('/api/fx-rates/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, currency: formData.currency }),
      })
      if (!response.ok) {
        if (response.status === 502) {
          throw new Error('Tasa no encontrada. Ingreso manual requerido.')
        }
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()
      if (!data.rateToUsd) throw new Error('Sin tasa disponible para esa fecha')
      setFxRate(String(data.rateToUsd))
      setFxSource(data.source || 'Oráculo automático')
      setFxDate(data.rateDate || date)
    } catch (err: any) {
      console.error('FX rate fetch failed:', err)
      setFetchError(err.message || 'No se pudo obtener la tasa. Por favor ingrésela manualmente.')
    } finally {
      setFetching(false)
    }
  }

  const handleSave = () => {
    if (!isReadyToSave) return
    onSave({
      funderId: formData.funderId,
      amount: formData.amount,
      currency: formData.currency,
      contributionType: formData.contributionType,
      inKindValuationNotes: formData.inKindValuationNotes || undefined,
      year: formData.year,
      description: formData.description || undefined,
      fxRate: fxRate || undefined,
      fxSource: fxSource || undefined,
    })
  }

  const borderClass = isTemp
    ? isReadyToSave
      ? 'border-green-300'
      : 'border-amber-200'
    : isDirty
      ? 'border-amber-200'
      : 'border-border'

  return (
    <div className={`border rounded-lg p-4 space-y-4 bg-card transition-colors ${borderClass}`}>
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
            disabled={!canEdit || isSaving}
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
            disabled={!canEdit || isSaving}
            className={INPUT_CLASS}
          >
            <option value="cash">Efectivo</option>
            <option value="in_kind">En especie</option>
          </select>
        </div>
      </div>

      {/* Row 2: Amount + Currency + USD */}
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
            disabled={!canEdit || isSaving}
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
              // Reset any preview rate when the currency changes.
              setFxRate('')
              setFxSource('')
              setFxDate('')
              setFetchError(null)
            }}
            disabled={!canEdit || isSaving}
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
            className="mt-1 flex items-center px-3 py-1.5 rounded-md border border-input bg-muted text-sm min-h-[36px]"
          >
            {usdDisplay ? (
              <span className="text-foreground tabular-nums font-medium">
                {parseFloat(usdDisplay).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{' '}
                USD
              </span>
            ) : isCop ? (
              <span className="text-muted-foreground text-xs">Se calcula con la TRM al guardar</span>
            ) : (
              <span className="text-amber-600 text-xs">Pendiente de conversión</span>
            )}
          </div>
        </div>
      </div>

      {/* Row 3: FX Conversion (if non-USD) */}
      {needsFxConversion && (
        <div className="border-t border-border pt-4 space-y-3">
          <h4 className="text-sm font-semibold text-foreground">Tasa de conversión a USD</h4>

          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-end">
              <div className="flex-1 w-full max-w-[200px]">
                <label htmlFor={`fx-year-${investment.id}`} className="block text-xs font-medium text-muted-foreground mb-1">
                  Año de referencia <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <input
                  id={`fx-year-${investment.id}`}
                  type="number"
                  value={formData.year || ''}
                  onChange={(e) => handleChange('year', e.target.value ? parseInt(e.target.value) : undefined)}
                  disabled={!canEdit || isSaving}
                  placeholder="2024"
                  className={INPUT_CLASS}
                />
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={handleFetchFxRate}
                  disabled={fetching || !formData.year || isSaving}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <RefreshCw className={`h-3 w-3 ${fetching ? 'animate-spin' : ''}`} />
                  Consultar Tasa Automática
                </button>
              )}
            </div>

            {fxRate && !fetchError && (
              <p className="text-xs text-green-700 font-medium mt-2">
                ✓ Tasa obtenida{fxDate ? ` (${fxDate})` : ''}: 1 USD = {parseFloat(fxRate).toLocaleString('es-CO')} {formData.currency}
              </p>
            )}
            
            {fetchError && (
              <p className="text-xs text-amber-700 mt-2">{fetchError}</p>
            )}

            {(!isCop || fetchError) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div>
                  <label htmlFor={`rate-${investment.id}`} className="block text-xs font-medium text-foreground mb-1">
                    Tasa 1 USD = ? {formData.currency}
                  </label>
                  <input
                    id={`rate-${investment.id}`}
                    type="text"
                    inputMode="decimal"
                    value={fxRate}
                    onChange={(e) => setFxRate(e.target.value)}
                    disabled={!canEdit || isSaving}
                    placeholder="0.00"
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label htmlFor={`source-${investment.id}`} className="block text-xs font-medium text-foreground mb-1">
                    Fuente de la tasa
                  </label>
                  <input
                    id={`source-${investment.id}`}
                    type="text"
                    value={fxSource}
                    onChange={(e) => setFxSource(e.target.value)}
                    disabled={!canEdit || isSaving}
                    placeholder="Ej. Banco Central"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Se utiliza el valor histórico del 31 de diciembre del año de referencia.
            </p>
          </div>
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
            disabled={!canEdit || isSaving}
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
            <span className="ml-1 text-xs text-muted-foreground font-normal">
              {isCop ? '(requerido para COP)' : '(opcional)'}
            </span>
          </label>
          <input
            id={`year-${investment.id}`}
            type="number"
            value={formData.year || ''}
            onChange={(e) => handleChange('year', e.target.value ? parseInt(e.target.value) : undefined)}
            disabled={!canEdit || isSaving}
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
            disabled={!canEdit || isSaving}
            placeholder="Ej: Aporte anual"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {/* Validation hint */}
      {canEdit && !isReadyToSave && (formData.funderId || formData.amount || isTemp) && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
          <p className="font-medium mb-1">Completa antes de guardar:</p>
          <ul className="space-y-0.5">
            {missing.map((m, i) => (
              <li key={i}>• {m}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      {canEdit && (
        <div className="flex items-center justify-between pt-3 border-t border-border">
          <button
            type="button"
            onClick={onDelete}
            disabled={isSaving}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-700 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Eliminar
          </button>

          <div className="flex items-center gap-3">
            {!isTemp && !isDirty && (
              <span className="inline-flex items-center gap-1 text-xs text-green-700">
                <Check className="h-3.5 w-3.5" />
                Guardado
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={!isReadyToSave || isSaving || (!isTemp && !isDirty)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#FF6A00] rounded-md hover:bg-[#e65f00] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Guardando…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  {isTemp ? 'Guardar aporte' : 'Guardar cambios'}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
