import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateFxRate } from '@/lib/pipeline/fx-rates'
import { getOrCreateSharedCopRate } from '@/lib/pipeline/fx'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

export async function POST(request: NextRequest) {
  try {
    const ctx = await getCurrentOrganizationContext()
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { date, currency } = body

    if (!date) {
      return NextResponse.json({ error: 'Missing date parameter' }, { status: 400 })
    }
    if (!currency) {
      return NextResponse.json({ error: 'Missing currency parameter' }, { status: 400 })
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format. Expected YYYY-MM-DD' }, { status: 400 })
    }

    // Fetch the rate
    let result = null
    try {
      if (currency === 'COP') {
        result = await getOrCreateSharedCopRate(date)
      } else {
        result = await getOrCreateFxRate(currency, date)
      }
    } catch (e) {
      // The service throws an error if it fails to auto-fetch and no manual rate is provided
      console.warn(`FX fetch failed for ${currency} on ${date}:`, e instanceof Error ? e.message : e)
      return NextResponse.json(
        { error: 'Failed to fetch FX rate automatically. Manual entry required.' },
        { status: 502 }
      )
    }

    if (!result) {
      return NextResponse.json(
        { error: 'Failed to fetch FX rate automatically. Manual entry required.' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      rateToUsd: result.rateToUsd,
      source: result.source,
      rateDate: result.rateDate,
    })
  } catch (error) {
    console.error('Error fetching FX rate:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
