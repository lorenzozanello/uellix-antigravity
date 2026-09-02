import { NextRequest, NextResponse } from 'next/server'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import {
  AuthContextError,
  authContextErrorStatus,
  withOrganizationDatabaseContext,
} from '@/lib/auth/database-context'
import { updateFinancialProxyReviewStatusForContext } from '@/lib/pipeline/proxies'

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

    const proxyId = params.id

    // W2-B2-R3-NARROW-REMEDIATION / R-B2-10 — this was the fifth reachable
    // live/version transition site: it used to write financial_proxies
    // directly, leaving the current financial_proxy_versions row uncoupled
    // (LIVE_VERSION_STATUS_COUPLING violated) and bypassing the same
    // canApproveProxy gate every other transition site enforces. It now
    // delegates to the canonical governed primitive — the exact function the
    // organisation UI's own "submit for review" action already calls for
    // this transition — inside the SAME locked transaction as the read, so a
    // concurrent status change (e.g. an approval) cannot race the precondition
    // check the way a separate read-then-write would.
    //
    // W2-B2-R4-404-CONTRACT-CORRECTION — this route's own frozen contract is
    // that a proxy id outside the caller's organisation must read exactly
    // like an unknown id (404), never a 403 that would confirm the id
    // belongs to someone else's tenant. `hideCrossTenantAsNotFound: true` is
    // a literal here, never derived from the request, and scopes the
    // primitive's row lock to this session's own organisation so a
    // cross-tenant (or global/system) proxy is never observed to exist.
    const outcome = await withOrganizationDatabaseContext(async () => {
      try {
        await updateFinancialProxyReviewStatusForContext(
          ctx,
          proxyId,
          'pending_review',
          undefined,
          'suggested',
          true,
        )
        return 'ok' as const
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === 'Proxy not found') return 'not_found' as const
          if (err.message === 'Unexpected current status') return 'already_submitted' as const
          if (err.message === 'Forbidden') return 'forbidden' as const
        }
        throw err
      }
    })

    if (outcome === 'not_found') {
      return NextResponse.json({ error: 'Proxy not found' }, { status: 404 })
    }
    if (outcome === 'already_submitted') {
      return NextResponse.json({ error: 'Proxy is already submitted or approved' }, { status: 400 })
    }
    if (outcome === 'forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
