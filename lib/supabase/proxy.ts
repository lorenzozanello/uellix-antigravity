import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

export function applySecurityHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value)
  }

  return response
}

export function extractClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  const firstForwardedAddress = forwardedFor?.split(',')[0]?.trim()

  return firstForwardedAddress || request.headers.get('x-real-ip')?.trim() || 'anonymous'
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request: {
              headers: request.headers,
            },
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh the session token. IMPORTANT: do not add logic between createServerClient
  // and auth.getUser() — it may cause random logout issues.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname
  const isProtected =
    pathname.startsWith('/app') || pathname.startsWith('/admin')

  // Unauthenticated users cannot access protected routes
  if (!user && isProtected) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirect', pathname)
    return applySecurityHeaders(NextResponse.redirect(url))
  }

  // Authenticated users should not land on /login
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/app/dashboard'
    return applySecurityHeaders(NextResponse.redirect(url))
  }

  // NOTE: Role-based protection for /admin (super_admin check) is enforced in
  // app/admin/layout.tsx via requireAdminAccess(), which can use Drizzle ORM.
  // The proxy only handles authentication — not authorization.

  return applySecurityHeaders(supabaseResponse)
}
