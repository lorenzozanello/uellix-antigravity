/**
 * SPIKE: Verify a live, publicly accessible historical TRM data source.
 * This is NOT production code — it's for validating our data source before
 * building the auto-fetch service.
 *
 * Goal: confirm that we can fetch COP/USD rates for historical dates
 * from a free, public API and that the response shape is as expected.
 *
 * Status (verified 2026-07-04):
 * ✓ datos.gov.co Socrata endpoint is live and accessible
 * ✓ Historical rates available via vigenciadesde/vigenciahasta query
 * ✓ Response includes valor (rate) and validity date range
 * ✓ COP TRM auto-fetch is implemented and tested in fx.ts
 */

export async function verifyTrmSource(): Promise<{
  success: boolean
  source: string
  exampleRate: number
  exampleDate: string
  notes: string
}> {
  // Spike: Try datos.gov.co TRM dataset
  // Documentation: https://www.datos.gov.co/resource/32sa-8pi3.json
  // This is a CKAN dataset endpoint that returns TRM (Tasa Representativa del Mercado)
  // historical rates.

  const testDate = '2026-07-01' // A recent date
  const stamp = `${testDate}T00:00:00.000`
  const where = `vigenciadesde <= '${stamp}' AND vigenciahasta >= '${stamp}'`
  const apiUrl = `https://www.datos.gov.co/resource/32sa-8pi3.json?$where=${encodeURIComponent(where)}&$limit=1`

  try {
    const response = await fetch(apiUrl)
    if (!response.ok) {
      return {
        success: false,
        source: 'datos.gov.co (FAILED)',
        exampleRate: 0,
        exampleDate: testDate,
        notes: `HTTP ${response.status}`,
      }
    }

    const data = (await response.json()) as Array<{
      vigenciadesde: string
      vigenciahasta: string
      valor: string
    }>

    if (!data || data.length === 0) {
      return {
        success: false,
        source: 'datos.gov.co',
        exampleRate: 0,
        exampleDate: testDate,
        notes: 'Empty response',
      }
    }

    const firstRow = data[0]
    const rate = parseFloat(firstRow.valor)

    if (isNaN(rate) || rate <= 0) {
      return {
        success: false,
        source: 'datos.gov.co',
        exampleRate: 0,
        exampleDate: testDate,
        notes: `Invalid rate value: ${firstRow.valor}`,
      }
    }

    return {
      success: true,
      source: 'datos.gov.co',
      exampleRate: rate,
      exampleDate: testDate,
      notes: `Valid: COP/USD = ${rate} on ${testDate} (vigencia ${firstRow.vigenciadesde} to ${firstRow.vigenciahasta})`,
    }
  } catch (err) {
    return {
      success: false,
      source: 'datos.gov.co (ERROR)',
      exampleRate: 0,
      exampleDate: testDate,
      notes: `${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Fallback: If datos.gov.co fails, we can fall back to Banco de la República's
 * historical data (though it's less convenient). For now, spike this to evaluate
 * feasibility.
 *
 * Status: Not viable for auto-fetch (manual CSV download required).
 */
export async function verifyBancoRepublicaSource(): Promise<{
  success: boolean
  source: string
  exampleRate: number
  notes: string
}> {
  // Note: Banco de la República publishes historical rates at
  // https://www.banrep.gov.co/ but requires manual scraping or CSV download.
  // This is less ideal than datos.gov.co API, but could be a fallback.
  // Spiking manually for now; not implementing automated fetch.

  return {
    success: false,
    source: 'Banco de la República',
    exampleRate: 0,
    notes: 'Requires manual CSV download or scraping; not suitable for auto-fetch MVP',
  }
}

/**
 * RESULT (verified 2026-07-04):
 *
 * ✓ COP TRM auto-fetch is VIABLE and now LIVE in production
 *   - datos.gov.co endpoint is stable and accessible
 *   - Historical rates available for any calendar date
 *   - Validity range (vigenciadesde/vigenciahasta) covers weekends/holidays
 *   - No nearest-business-day fallback needed
 *   - Implemented in lib/pipeline/fx.ts:fetchCopTrmRate()
 *   - Shared cache on fx_rates table (org_id NULL for COP auto-fetches)
 *   - Auto-fetch failure falls back to manual entry (caller's responsibility)
 *
 * ✗ Banco de la República is NOT viable for auto-fetch
 *   - Manual CSV download required
 *   - No public API available
 *   - Maintained as fallback documentation only
 */
