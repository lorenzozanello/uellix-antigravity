import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db/client'
import { financialProxies } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { getCurrentOrganizationContext } from '@/lib/auth/session'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const ctx = await getCurrentOrganizationContext()
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { organization } = ctx
    const proxyId = params.id

    // Check if proxy exists and belongs to the organization
    const existing = await db.select().from(financialProxies).where(
      and(
        eq(financialProxies.id, proxyId),
        eq(financialProxies.organizationId, organization.id)
      )
    ).limit(1)

    if (!existing.length) {
      return NextResponse.json({ error: 'Proxy not found' }, { status: 404 })
    }

    const proxy = existing[0]

    // Validate if it can be suggested
    if (proxy.reviewStatus !== 'suggested') {
      return NextResponse.json({ error: 'Proxy is already submitted or approved' }, { status: 400 })
    }

    // Update status to pending_review
    await db.update(financialProxies)
      .set({ reviewStatus: 'pending_review', updatedAt: new Date() })
      .where(eq(financialProxies.id, proxyId))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error suggesting proxy:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
