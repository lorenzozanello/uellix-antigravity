import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Simple health check endpoint to verify Supabase auth is working.
 * No auth required - useful for debugging auth issues.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const { data: { user }, error: userError } = await supabase.auth.getUser()

    return NextResponse.json({
      status: 'ok',
      authenticated: !!user,
      user: user ? {
        id: user.id,
        email: user.email,
        provider: user.app_metadata?.provider,
      } : null,
      error: userError ? userError.message : null,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}
