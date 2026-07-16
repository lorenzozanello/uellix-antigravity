import { NextRequest, NextResponse } from 'next/server'
import { fetchCopTrmRate } from '@/lib/pipeline/fx'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

export async function POST(request: NextRequest) {
  try {
    const ctx = await getCurrentOrganizationContext()
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { date } = body

    if (!date) {
      return NextResponse.json({ error: 'Missing date parameter' }, { status: 400 })
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format. Expected YYYY-MM-DD' }, { status: 400 })
    }

    // Fetch the COP rate
    const result = await fetchCopTrmRate(date)

    if (!result) {
      return NextResponse.json(
        { error: 'Failed to fetch COP rate from TRM source' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      rateToUsd: result.rateToUsd,
      source: result.source,
      rateDate: result.rateDate,
    })
  } catch (error) {
    console.error('Error fetching COP rate:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
