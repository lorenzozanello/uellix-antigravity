import { describe, it, expect } from 'vitest'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'

describe('isSafeRedirectPath', () => {
  it('accepts a simple relative path', () => {
    expect(isSafeRedirectPath('/app/dashboard')).toBe(true)
  })

  it('accepts a relative path with query params', () => {
    expect(isSafeRedirectPath('/invite/accept?token=abc123')).toBe(true)
  })

  it('rejects null and undefined', () => {
    expect(isSafeRedirectPath(null)).toBe(false)
    expect(isSafeRedirectPath(undefined)).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isSafeRedirectPath('')).toBe(false)
  })

  it('rejects an absolute URL (open redirect)', () => {
    expect(isSafeRedirectPath('https://evil.example.com')).toBe(false)
  })

  it('rejects a protocol-relative URL (open redirect)', () => {
    expect(isSafeRedirectPath('//evil.example.com')).toBe(false)
  })

  it('rejects a path not starting with /', () => {
    expect(isSafeRedirectPath('app/dashboard')).toBe(false)
  })

  it('rejects a javascript: scheme smuggled after a slash', () => {
    expect(isSafeRedirectPath('/javascript://evil.example.com')).toBe(false)
  })
})
