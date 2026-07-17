'use client'

import React, { useState, useEffect } from 'react'
import Decimal from 'decimal.js'

export interface FxSubFormProps {
  currency?: string
  amount?: number | string
  rate?: number | string
  source?: string
  referenceYear?: number
  disabled?: boolean
  onChange?: (data: FxSubFormData) => void
  showUsdEquivalent?: boolean
}

export interface FxSubFormData {
  currency: string
  amount: string
  rate: string
  source: string
  valueUsd: string | null
}

const COMMON_CURRENCIES = ['USD', 'COP', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'MXN', 'BRL']

/**
 * FxSubForm — Reusable FX input component for multi-currency amounts.
 * Handles currency selection, amount entry, rate lookup (COP auto-fetch),
 * and manual rate entry for non-COP currencies.
 */
export function FxSubForm({
  currency = '',
  amount = '',
  rate = '',
  source = '',
  referenceYear,
  disabled = false,
  onChange,
  showUsdEquivalent = true,
}: FxSubFormProps) {
  const [localCurrency, setLocalCurrency] = useState(currency)
  const [localAmount, setLocalAmount] = useState(String(amount || ''))
  const [localRate, setLocalRate] = useState(String(rate || ''))
  const [localSource, setLocalSource] = useState(source)
  const [isAutoFetching, setIsAutoFetching] = useState(false)
  const [autoFetchError, setAutoFetchError] = useState<string | null>(null)
  const [rateFetched, setRateFetched] = useState(Boolean(rate && localCurrency === 'COP'))

  // Calculate USD equivalent when amount or rate changes
  const valueUsd = React.useMemo(() => {
    if (!localAmount || !localRate || localCurrency === 'USD') {
      return null
    }
    try {
      const amountDecimal = new Decimal(localAmount)
      const rateDecimal = new Decimal(localRate)
      if (!amountDecimal.gt(0) || !rateDecimal.gt(0)) {
        return null
      }
      return amountDecimal.div(rateDecimal).toFixed(4)
    } catch {
      return null
    }
  }, [localAmount, localRate, localCurrency])

  // Notify parent of changes
  useEffect(() => {
    if (onChange) {
      onChange({
        currency: localCurrency,
        amount: localAmount,
        rate: localRate,
        source: localSource,
        valueUsd: localCurrency === 'USD' ? localAmount : valueUsd,
      })
    }
  }, [localCurrency, localAmount, localRate, localSource, valueUsd, onChange])

  // Auto-fetch rate (COP via TRM, others via FX Oracle)
  const handleAutoFetchRate = async () => {
    if (!referenceYear || localCurrency === 'USD' || !localCurrency) {
      return
    }

    setIsAutoFetching(true)
    setAutoFetchError(null)

    try {
      // Construct the date for Dec 31 of the reference year
      const decemberDate = new Date(referenceYear, 11, 31)
      const isoDate = decemberDate.toISOString().split('T')[0]

      // Call the API to fetch rate
      const response = await fetch('/api/fx-rates/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: isoDate, currency: localCurrency }),
      })

      if (!response.ok) {
        if (response.status === 502) {
          throw new Error('Tasa no encontrada en oráculo automático.')
        }
        throw new Error('Failed to fetch rate')
      }

      const data = await response.json()
      if (!data.rateToUsd) {
        setAutoFetchError('Manual entry required')
        setIsAutoFetching(false)
        return
      }

      setLocalRate(String(data.rateToUsd))
      setLocalSource(data.source || 'Oráculo automático')
      setRateFetched(true)
      setAutoFetchError(null)
    } catch (error) {
      setAutoFetchError(error instanceof Error ? error.message : 'Ingreso manual requerido')
    } finally {
      setIsAutoFetching(false)
    }
  }

  const handleCurrencyChange = (newCurrency: string) => {
    setLocalCurrency(newCurrency)
    setLocalRate('')
    setLocalSource('')
    setRateFetched(false)
    setAutoFetchError(null)
  }

  const handleClearRate = () => {
    setLocalRate('')
    setLocalSource('')
    setRateFetched(false)
    setAutoFetchError(null)
  }

  const isRateRequired = localCurrency && localCurrency !== 'USD'
  const showAutoFetch = isRateRequired && !rateFetched
  const showManualRate = isRateRequired
  const displayValueUsd = localCurrency === 'USD' ? localAmount : valueUsd

  return (
    <div className="space-y-4">
      {/* Currency picker */}
      <div>
        <label htmlFor="fx-currency" className="block text-xs font-medium text-slate-300 mb-1">Moneda</label>
        <select
          id="fx-currency"
          value={localCurrency}
          onChange={(e) => handleCurrencyChange(e.target.value)}
          disabled={disabled}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">Selecciona una moneda</option>
          {COMMON_CURRENCIES.map((curr) => (
            <option key={curr} value={curr}>
              {curr}
            </option>
          ))}
        </select>
      </div>

      {/* Amount input */}
      {localCurrency && (
        <div>
          <label htmlFor="fx-amount" className="block text-xs font-medium text-slate-300 mb-1">
            Cantidad ({localCurrency})
          </label>
          <input
            id="fx-amount"
            type="number"
            value={localAmount}
            onChange={(e) => setLocalAmount(e.target.value)}
            disabled={disabled}
            placeholder="0"
            step="0.0001"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {localAmount && (
            <div className="text-xs text-slate-500 mt-1">
              {new Decimal(localAmount).gt(0) ? (
                <span className="text-green-600">✓ Válido</span>
              ) : (
                <span className="text-red-600">Debe ser mayor a 0</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Auto-fetch button */}
      {showAutoFetch && (
        <div>
          <button
            type="button"
            onClick={handleAutoFetchRate}
            disabled={disabled || isAutoFetching || !referenceYear}
            className="w-full rounded-md border border-amber-700 bg-amber-950/50 px-3 py-2 text-sm font-medium text-amber-300 hover:bg-amber-900/50 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {isAutoFetching ? 'Consultando...' : 'Obtener tasa automática (31 dic)'}
          </button>
          {autoFetchError && (
            <div className="text-xs text-amber-600 mt-1">
              {autoFetchError}
            </div>
          )}
        </div>
      )}

      {/* Manual rate input */}
      {showManualRate && (
        <>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="fx-rate" className="block text-xs font-medium text-slate-300">
                Tasa de conversión (1 USD = ? {localCurrency})
              </label>
              {rateFetched && (
                <button
                  type="button"
                  onClick={handleClearRate}
                  disabled={disabled}
                  className="text-xs text-slate-500 hover:text-slate-300 transition disabled:cursor-not-allowed"
                >
                  Modificar
                </button>
              )}
            </div>
            <input
              id="fx-rate"
              type="number"
              value={localRate}
              onChange={(e) => setLocalRate(e.target.value)}
              disabled={disabled || rateFetched}
              placeholder="Ej: 4150.25"
              step="0.0001"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {localRate && (
              <div className="text-xs text-slate-500 mt-1">
                {new Decimal(localRate).gt(0) ? (
                  <span className="text-green-600">✓ Válido</span>
                ) : (
                  <span className="text-red-600">Debe ser mayor a 0</span>
                )}
              </div>
            )}
          </div>

          {/* Source field (required for manual entry) */}
          <div>
            <label htmlFor="fx-source" className="block text-xs font-medium text-slate-300 mb-1">
              Fuente {!rateFetched && <span className="text-red-500">*</span>}
            </label>
            <input
              id="fx-source"
              type="text"
              value={localSource}
              onChange={(e) => setLocalSource(e.target.value)}
              disabled={disabled || rateFetched}
              placeholder="Ej: Banco de la República, ECB, etc."
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {!rateFetched && !localSource && localRate && (
              <div className="text-xs text-red-600 mt-1">Requerida si se ingresa tasa manual</div>
            )}
          </div>
        </>
      )}

      {/* USD equivalent display */}
      {showUsdEquivalent && localCurrency !== 'USD' && (
        <div className="bg-slate-950/50 border border-slate-800 rounded px-3 py-2">
          <label className="block text-xs font-medium text-slate-400 mb-1">USD Equivalente</label>
          <div className="text-lg font-semibold text-slate-100">
            {displayValueUsd ? `$${displayValueUsd} USD` : '—'}
          </div>
          {!displayValueUsd && (localAmount || localRate) && (
            <div className="text-xs text-slate-500 mt-1">
              Completa cantidad y tasa para ver el equivalente
            </div>
          )}
        </div>
      )}

      {/* USD direct equivalence */}
      {showUsdEquivalent && localCurrency === 'USD' && localAmount && (
        <div className="bg-slate-950/50 border border-slate-800 rounded px-3 py-2">
          <div className="text-xs text-slate-400 mb-1">Valor en USD</div>
          <div className="text-lg font-semibold text-green-400">${localAmount} USD</div>
        </div>
      )}
    </div>
  )
}
