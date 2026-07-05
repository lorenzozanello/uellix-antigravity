// lib/pipeline/fx.ts
// Fase 1a — FX adapter: normalize contributions/proxies to USD.
//
// COP is auto-fetched from the official Colombian TRM (Tasa Representativa del
// Mercado) via the datos.gov.co Socrata dataset. The validity RANGE
// (vigenciadesde..vigenciahasta) already covers weekends/holidays, so a given
// calendar date always resolves to exactly one rate — no "nearest business
// day" fallback needed. Every other currency is manual-entry only (handled by
// the caller, not here). The adapter NEVER fabricates or approximates a rate:
// any failure returns null so the caller can require manual entry.
//
// Source verified live 2026-07-04 (see the multi-funder design spec).

import Decimal from 'decimal.js'

export const COP_TRM_ENDPOINT = 'https://www.datos.gov.co/resource/32sa-8pi3.json'
export const COP_TRM_SOURCE = 'Superintendencia Financiera de Colombia — TRM oficial (datos.gov.co)'

// USD amounts carry 4 decimals, matching the numeric(20,4) money columns.
const USD_DP = 4

export interface CopTrmResult {
  /** Units of COP per 1 USD, as returned by the TRM (e.g. "4158.1"). */
  rateToUsd: string
  /** Citation stored on the fx_rates row. */
  source: string
  /** The calendar date the rate was requested for (YYYY-MM-DD). */
  rateDate: string
}

/** Normalize a Date or loose ISO string to a YYYY-MM-DD (UTC) day key. */
function toIsoDate(date: Date | string): string {
  if (typeof date === 'string') {
    const m = date.match(/^\d{4}-\d{2}-\d{2}/)
    if (m) return m[0]
    date = new Date(date)
  }
  return date.toISOString().slice(0, 10)
}

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
 * Fetch the official COP→USD TRM for a given date. Returns null on ANY failure
 * (source down, non-ok HTTP, no row, missing/invalid valor) — the caller must
 * then require manual entry rather than proceed with a fabricated rate.
 *
 * `fetchImpl` is injectable so tests never touch the real endpoint.
 */
export async function fetchCopTrmRate(
  date: Date | string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopTrmResult | null> {
  try {
    const iso = toIsoDate(date)
    const stamp = `${iso}T00:00:00.000`
    const where = `vigenciadesde <= '${stamp}' AND vigenciahasta >= '${stamp}'`
    const url = `${COP_TRM_ENDPOINT}?$where=${encodeURIComponent(where)}&$limit=1`

    const res = await fetchImpl(url)
    if (!res.ok) return null

    const rows: unknown = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) return null

    const valor = (rows[0] as { valor?: unknown })?.valor
    if (valor == null || valor === '') return null
    if (!/^-?\d+(\.\d+)?$/.test(String(valor))) return null

    return { rateToUsd: String(valor), source: COP_TRM_SOURCE, rateDate: iso }
  } catch {
    return null
  }
}
