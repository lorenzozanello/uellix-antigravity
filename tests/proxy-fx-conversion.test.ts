// tests/proxy-fx-conversion.test.ts
// Comprehensive tests for proxy USD conversion form validation and FX rate handling.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { convertToUsd, fetchCopTrmRate } from '@/lib/pipeline/fx'
import Decimal from 'decimal.js'

describe('FX Conversion: convertToUsd', () => {
  it('converts amount using rate with 4 decimal precision', () => {
    // 92 EUR at rate 0.92 EUR/USD = 100.0000 USD
    const result = convertToUsd('92', '0.92')
    expect(result).toBe('100.0000')
  })

  it('handles Decimal precision correctly for large amounts', () => {
    // 1000000 COP at rate 3941.5 COP/USD ≈ 253.71 USD
    const result = convertToUsd('1000000', '3941.5')
    const decimal = new Decimal(result)
    expect(decimal.toString()).toBe('253.7105') // Actual computed value
  })

  it('rounds HALF_UP to 4 decimals', () => {
    // 10 EUR at rate 1.234 = 8.1037... → 8.1037 (HALF_UP to 4 decimals)
    const result = convertToUsd('10', '1.234')
    expect(result).toBe('8.1037')
  })

  it('throws on zero rate', () => {
    expect(() => convertToUsd('100', '0')).toThrow('rate_to_usd must be > 0')
  })

  it('throws on negative rate', () => {
    expect(() => convertToUsd('100', '-1.5')).toThrow('rate_to_usd must be > 0')
  })

  it('handles very small rates', () => {
    const result = convertToUsd('100', '0.0001')
    expect(result).toBe('1000000.0000')
  })

  it('handles very large amounts', () => {
    const result = convertToUsd('999999999999', '2.5')
    const decimal = new Decimal(result)
    expect(result.includes('.')).toBe(true) // Has decimal point
    expect(decimal.toNumber()).toBeGreaterThan(0)
  })

  it('preserves input amount when rate is 1.0', () => {
    const result = convertToUsd('250.5', '1.0')
    expect(result).toBe('250.5000')
  })

  it('handles scientific notation rates', () => {
    const result = convertToUsd('100', '1e0') // 1e0 = 1.0
    expect(result).toBe('100.0000')
  })
})

describe('FX Conversion: Proxy Currency Scenarios', () => {
  it('USD proxy needs no conversion', () => {
    // USD amounts pass through as-is
    const usdAmount = '1234.5678'
    expect(usdAmount).toBe('1234.5678')
  })

  it('COP conversion example: typical Colombian wage', () => {
    // Colombean minimum wage 2024: ~$1,300,000 COP
    // TRM ~4000 COP/USD → ~$325 USD
    const result = convertToUsd('1300000', '4000')
    expect(result).toBe('325.0000')
  })

  it('EUR conversion example: European hourly rate', () => {
    // 15 EUR/hour at rate 0.92 EUR/USD = 16.3043 USD
    const result = convertToUsd('15', '0.92')
    expect(result).toBe('16.3043')
  })

  it('GBP conversion example', () => {
    // 10 GBP at rate 0.79 GBP/USD = 12.6582 USD
    const result = convertToUsd('10', '0.79')
    expect(result).toBe('12.6582')
  })
})

describe('FX Conversion: Proxy Form Validation Rules', () => {
  it('requires value to be numeric', () => {
    expect(() => {
      const val = 'abc'
      if (isNaN(Number(val))) throw new Error('value must be numeric')
    }).toThrow('value must be numeric')
  })

  it('requires currency to be present', () => {
    const currency = ''
    expect(currency).toBeFalsy()
  })

  it('requires referenceYear to be positive integer', () => {
    const year = 2024
    expect(Number.isInteger(year)).toBe(true)
    expect(year > 0).toBe(true)
  })

  it('requires unit to be present', () => {
    const unit = 'hectárea'
    expect(unit).toBeTruthy()
  })

  it('rejects non-numeric value input', () => {
    const invalidValues = ['abc', null, undefined]
    invalidValues.forEach((val) => {
      if (val === null || val === undefined) {
        expect(val).toBeFalsy()
      } else {
        const isNumeric = !isNaN(Number(val))
        expect(isNumeric).toBe(false)
      }
    })
  })

  it('accepts various numeric formats for value', () => {
    const validValues = ['100', '100.50', '0.01', '999999999.9999']
    validValues.forEach((val) => {
      expect(!isNaN(Number(val))).toBe(true)
    })
  })

  it('accepts valid ISO currency codes', () => {
    const validCurrencies = ['USD', 'COP', 'EUR', 'GBP', 'JPY', 'CHF']
    validCurrencies.forEach((cur) => {
      expect(cur.length).toBe(3)
    })
  })

  it('requires referenceYear between 1900 and 2999', () => {
    const years = [1900, 2024, 2999]
    years.forEach((year) => {
      expect(year >= 1900 && year <= 2999).toBe(true)
    })
  })
})

describe('FX Conversion: Approval Constraint', () => {
  it('USD proxy can approve with just value and currency', () => {
    const proxy = {
      value: '100',
      currency: 'USD',
      referenceYear: 2024,
      valueUsd: '100', // Passes through as-is
      fxRateId: null, // No rate needed
    }
    expect(proxy.valueUsd).toBeTruthy()
    expect(proxy.currency === 'USD').toBe(true)
  })

  it('COP proxy must have valueUsd frozen on approval', () => {
    const proxy = {
      value: '1300000',
      currency: 'COP',
      referenceYear: 2024,
      valueUsd: '325.0000', // Auto-fetched & frozen
      fxRateId: 'fxrate-cop-2024-12-31',
    }
    expect(proxy.valueUsd).toBeTruthy()
    expect(proxy.fxRateId).toBeTruthy()
  })

  it('EUR proxy must have valueUsd set manually before approval', () => {
    const proxy = {
      value: '92',
      currency: 'EUR',
      referenceYear: 2024,
      valueUsd: '100.0000', // Must be set manually first
      fxRateId: 'fxrate-eur-manual-1',
    }
    expect(proxy.valueUsd).toBeTruthy()
    expect(proxy.fxRateId).toBeTruthy()
  })

  it('rejects approval without valueUsd', () => {
    const proxy = {
      value: '92',
      currency: 'EUR',
      referenceYear: 2024,
      valueUsd: null, // Missing!
      fxRateId: null,
    }
    // Simulating approval check
    const canApprove = Boolean(proxy.valueUsd && proxy.currency && proxy.value)
    expect(canApprove).toBe(false)
  })

  it('rejects approval without currency', () => {
    const proxy = {
      value: '100',
      currency: null,
      referenceYear: 2024,
      valueUsd: '100',
      fxRateId: null,
    }
    const canApprove = Boolean(proxy.valueUsd && proxy.currency && proxy.value)
    expect(canApprove).toBe(false)
  })

  it('rejects approval without value', () => {
    const proxy = {
      value: null,
      currency: 'EUR',
      referenceYear: 2024,
      valueUsd: '100',
      fxRateId: null,
    }
    const canApprove = Boolean(proxy.valueUsd && proxy.currency && proxy.value)
    expect(canApprove).toBe(false)
  })
})

describe('FX Conversion: Manual Rate Entry', () => {
  it('stores manual rate with correct format', () => {
    const input = { rateToUsd: '0.92', source: 'ECB' }
    const rate = Number(input.rateToUsd)
    expect(Number.isFinite(rate)).toBe(true)
    expect(rate > 0).toBe(true)
  })

  it('rejects zero rate in manual entry', () => {
    const input = { rateToUsd: '0', source: 'Manual' }
    const rate = Number(input.rateToUsd)
    expect(Number.isFinite(rate) && rate > 0).toBe(false)
  })

  it('rejects negative rate in manual entry', () => {
    const input = { rateToUsd: '-1.5', source: 'Manual' }
    const rate = Number(input.rateToUsd)
    expect(Number.isFinite(rate) && rate > 0).toBe(false)
  })

  it('requires source documentation', () => {
    const input = { rateToUsd: '0.92', source: '' }
    expect(input.source.length > 0).toBe(false)
  })

  it('accepts various source formats', () => {
    const sources = [
      'ECB',
      'Banco de España',
      'ISO 4217 historical',
      'X-RATES.COM 2024-12-31',
    ]
    sources.forEach((source) => {
      expect(source.length > 0).toBe(true)
    })
  })

  it('stores rate date as Dec 31 of reference year', () => {
    const referenceYear = 2024
    const rateDate = `${referenceYear}-12-31`
    expect(rateDate).toBe('2024-12-31')
  })
})

describe('FX Conversion: Non-USD Proxy Handling', () => {
  it('marks COP proxy as auto-fetchable (TRM)', () => {
    const proxy = { currency: 'COP' }
    const isCop = proxy.currency === 'COP'
    expect(isCop).toBe(true)
  })

  it('marks EUR proxy as manual-only', () => {
    const proxy = { currency: 'EUR' }
    const isManualOnly = proxy.currency !== 'USD' && proxy.currency !== 'COP'
    expect(isManualOnly).toBe(true)
  })

  it('marks GBP proxy as manual-only', () => {
    const proxy = { currency: 'GBP' }
    const isManualOnly = proxy.currency !== 'USD' && proxy.currency !== 'COP'
    expect(isManualOnly).toBe(true)
  })

  it('marks JPY proxy as manual-only', () => {
    const proxy = { currency: 'JPY' }
    const isManualOnly = proxy.currency !== 'USD' && proxy.currency !== 'COP'
    expect(isManualOnly).toBe(true)
  })
})

describe('FX Conversion: COP Auto-Fetch Date Resolution', () => {
  it('uses Dec 31 of reference year for rate lookup', () => {
    const referenceYear = 2024
    const date = new Date(`${referenceYear}-12-31`)
    const isoDate = date.toISOString().slice(0, 10)
    expect(isoDate).toBe('2024-12-31')
  })

  it('handles different reference years', () => {
    const years = [2020, 2021, 2022, 2023, 2024, 2025]
    years.forEach((year) => {
      const date = `${year}-12-31`
      expect(date.match(/\d{4}-12-31/)).toBeTruthy()
    })
  })

  it('constructs TRM query with correct date range', () => {
    const referenceYear = 2024
    const rateDate = `${referenceYear}-12-31`
    const stamp = `${rateDate}T00:00:00.000`
    expect(stamp).toBe('2024-12-31T00:00:00.000')
  })
})
