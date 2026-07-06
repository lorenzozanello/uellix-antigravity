// Pure FX conversion functions (client-safe, no DB dependencies)
import Decimal from 'decimal.js'

// USD amounts carry 4 decimals, matching the numeric(20,4) money columns.
const USD_DP = 4

/**
 * Convert an amount in a source currency to USD.
 * amount_usd = amount / rate_to_usd, rounded HALF_UP to 4 decimals.
 * Throws on a non-positive rate (guards divide-by-zero / bad data).
 */
export function convertToUsd(amount: string, rateToUsd: string): string {
  const rate = new Decimal(rateToUsd)
  if (rate.lte(0)) throw new Error('rate_to_usd must be > 0')
  return new Decimal(amount).div(rate).toFixed(USD_DP)
}

/**
 * Convert USD back to source currency.
 * amount_source = amount_usd * rate_to_usd
 */
export function convertFromUsd(amountUsd: string, rateToUsd: string): string {
  const rate = new Decimal(rateToUsd)
  if (rate.lte(0)) throw new Error('rate_to_usd must be > 0')
  return new Decimal(amountUsd).times(rate).toFixed(USD_DP)
}
