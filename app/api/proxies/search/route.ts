import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { financialProxies } from '@/db/schema'
import { eq, or, ilike, and, isNull } from 'drizzle-orm'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import {
  AuthContextError,
  authContextErrorStatus,
  withOrganizationDatabaseContext,
} from '@/lib/auth/database-context'

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
    const results = await withOrganizationDatabaseContext(() =>
      db
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
    )

    return NextResponse.json({ results })
  } catch (error) {
    // A refusal from the identity layer is an authorisation answer with its own
    // status. Letting it fall through to the 500 below would report a 401/403
    // as a server fault — and would hide it from any alerting keyed on 5xx.
    if (error instanceof AuthContextError) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: authContextErrorStatus(error.code) }
      )
    }
    console.error('Error searching global proxies:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
