import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { financialProxies } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import {
  AuthContextError,
  authContextErrorStatus,
  withOrganizationDatabaseContext,
} from '@/lib/auth/database-context'

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const params = await props.params;
    const ctx = await getCurrentOrganizationContext()
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { organization } = ctx
    const proxyId = params.id

    // Check-then-update in ONE transaction: between a separate read and write
    // the proxy could be promoted by an admin, and the update would then
    // silently regress an approved proxy to pending_review.
    const outcome = await withOrganizationDatabaseContext(async () => {
      // Ownership is still asserted in the predicate. RLS scopes the row to
      // organisations this session belongs to; this pins it to THE one.
      const existing = await db.select().from(financialProxies).where(
        and(
          eq(financialProxies.id, proxyId),
          eq(financialProxies.organizationId, organization.id)
        )
      ).limit(1)

      if (!existing.length) return 'not_found' as const

      // Validate if it can be suggested
      if (existing[0].reviewStatus !== 'suggested') return 'already_submitted' as const

      // Update status to pending_review
      await db.update(financialProxies)
        .set({ reviewStatus: 'pending_review', updatedAt: new Date() })
        .where(eq(financialProxies.id, proxyId))

      return 'ok' as const
    })

    if (outcome === 'not_found') {
      return NextResponse.json({ error: 'Proxy not found' }, { status: 404 })
    }
    if (outcome === 'already_submitted') {
      return NextResponse.json({ error: 'Proxy is already submitted or approved' }, { status: 400 })
    }

    return NextResponse.json({ success: true })
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
    console.error('Error suggesting proxy:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
