// lib/pipeline/fx-oracle.ts
// Service for fetching historical exchange rates to USD for non-COP currencies
// Uses the free, open-source Frankfurter API (based on ECB data)

import Decimal from 'decimal.js'

// Known currencies supported by the European Central Bank (Frankfurter)
// Used to quickly fail for unsupported currencies.
const SUPPORTED_CURRENCIES = new Set([
  'EUR', 'MXN', 'BRL', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY', 
  'CNY', 'INR', 'ZAR', 'NZD', 'SGD', 'HKD', 'SEK', 'NOK', 
  'DKK', 'TRY', 'KRW', 'MYR', 'IDR', 'THB', 'PHP', 'PLN', 
  'CZK', 'HUF', 'ILS', 'RON', 'BGN', 'ISK'
])

export interface FxOracleResult {
  rateToUsd: Decimal
  source: string
}

/**
 * Fetches the historical exchange rate for a given currency to USD on a specific date.
 * Represents "1 {currency} = ? USD".
 * 
 * @param currency 3-letter currency code (e.g. 'EUR')
 * @param date ISO date string (YYYY-MM-DD)
 * @returns FxOracleResult if successful, null if failed or unsupported
 */
export async function fetchHistoricalRateToUsd(currency: string, date: string): Promise<FxOracleResult | null> {
  if (currency === 'USD') {
    return { rateToUsd: new Decimal(1), source: 'USD Base' }
  }

  // COP is handled exclusively by the Socrata TRM fetcher in fx.ts
  if (currency === 'COP' || !SUPPORTED_CURRENCIES.has(currency)) {
    return null
  }

  try {
    const response = await fetch(`https://api.frankfurter.app/${date}?from=USD&to=${currency}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })

    if (!response.ok) {
      if (response.status === 404) {
        return null
      }
      throw new Error(`Frankfurter API error: ${response.status}`)
    }

    const data = await response.json()
    
    if (data && data.rates && data.rates[currency]) {
      return {
        rateToUsd: new Decimal(data.rates[currency]),
        source: `Frankfurter API (ECB reference rates) - ${data.date}`
      }
    }
    
    return null
  } catch (error) {
    console.error(`[FX Oracle] Failed to fetch rate for ${currency} on ${date}:`, error)
    return null
  }
}
