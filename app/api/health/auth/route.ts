import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Simple health check endpoint to verify Supabase auth connectivity.
 * SECURITY: Never exposes user PII (email, id, provider). Returns only
 * a boolean authenticated status to prevent information disclosure.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError) {
      return NextResponse.json({
        status: 'degraded',
        authenticated: false,
        message: 'Authentication service unavailable',
        timestamp: new Date().toISOString(),
      }, { status: 503 })
    }

    return NextResponse.json({
      status: 'ok',
      authenticated: !!user,
      timestamp: new Date().toISOString(),
    })
  } catch {
    return NextResponse.json({
      status: 'error',
      message: 'Internal health check failure',
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}
