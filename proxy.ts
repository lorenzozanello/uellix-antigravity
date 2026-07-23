import { NextResponse } from 'next/server'
import {
  applySecurityHeaders,
  extractClientIp,
  updateSession,
} from '@/lib/supabase/proxy'
import type { NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  const sessionResponse = await updateSession(request)

  if (
    request.nextUrl.pathname.startsWith('/api/') &&
    process.env.KV_REST_API_URL &&
    process.env.KV_REST_API_TOKEN
  ) {
    try {
      const [{ Ratelimit }, { Redis }] = await Promise.all([
        import('@upstash/ratelimit'),
        import('@upstash/redis'),
      ])
      const redis = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      })
      const rateLimit = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(60, '1 m'),
        analytics: false,
      })
      const { success } = await rateLimit.limit(
        `global_api_${extractClientIp(request)}`
      )

      if (!success) {
        return applySecurityHeaders(
          NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
        )
      }
    } catch (error: unknown) {
      console.error('[proxy] API rate limit check failed', error)
    }
  }

  return sessionResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
