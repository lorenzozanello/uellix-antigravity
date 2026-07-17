import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { financialProxies } from '@/db/schema'
import { eq, or, ilike, and, isNull } from 'drizzle-orm'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

export async function GET(request: NextRequest) {
  try {
    const ctx = await getCurrentOrganizationContext()
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q')

    if (!q || q.length < 3) {
      return NextResponse.json({ results: [] })
    }

    const queryStr = `%${q}%`

    // Search global proxies (organizationId IS NULL) that match the query
    const results = await db
      .select()
      .from(financialProxies)
      .where(
        and(
          isNull(financialProxies.organizationId),
          eq(financialProxies.reviewStatus, 'approved'),
          or(
            ilike(financialProxies.name, queryStr),
            ilike(financialProxies.description, queryStr),
            ilike(financialProxies.thematicArea, queryStr),
            ilike(financialProxies.proxyType, queryStr)
          )
        )
      )
      .limit(20)

    return NextResponse.json({ results })
  } catch (error) {
    console.error('Error searching global proxies:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
