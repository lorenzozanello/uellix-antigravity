import { describe, expect, it } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import {
  applySecurityHeaders,
  extractClientIp,
} from '@/lib/supabase/proxy'

describe('proxy security helpers', () => {
  it('applies the required security headers to a response', () => {
    const response = applySecurityHeaders(NextResponse.next())

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=()'
    )
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  it('extracts the first forwarded client address', () => {
    const request = new NextRequest('https://uellix.com/api/health', {
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
    })

    expect(extractClientIp(request)).toBe('203.0.113.10')
  })

  it('falls back to x-real-ip and then anonymous', () => {
    const realIpRequest = new NextRequest('https://uellix.com/api/health', {
      headers: { 'x-real-ip': '198.51.100.8' },
    })
    const anonymousRequest = new NextRequest('https://uellix.com/api/health')

    expect(extractClientIp(realIpRequest)).toBe('198.51.100.8')
    expect(extractClientIp(anonymousRequest)).toBe('anonymous')
  })
})
