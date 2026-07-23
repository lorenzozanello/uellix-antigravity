import { describe, expect, it } from 'vitest'
import { getApprovedOrganizationLogoUrl } from '@/lib/organizations/logo-url'

const SUPABASE_URL = 'https://project.supabase.co'
const APPROVED_LOGO = `${SUPABASE_URL}/storage/v1/object/public/branding/logo.png`

describe('getApprovedOrganizationLogoUrl', () => {
  it('accepts an HTTPS public Storage object from the configured Supabase origin', () => {
    expect(getApprovedOrganizationLogoUrl(APPROVED_LOGO, SUPABASE_URL)).toBe(APPROVED_LOGO)
  })

  it.each([
    ['third-party origin', 'https://evil.test/logo.png'],
    ['insecure protocol', 'http://project.supabase.co/storage/v1/object/public/branding/logo.png'],
    ['lookalike hostname', 'https://project.supabase.co.evil.test/storage/v1/object/public/branding/logo.png'],
    ['embedded credentials', 'https://user:pass@project.supabase.co/storage/v1/object/public/branding/logo.png'],
    ['non-public storage path', 'https://project.supabase.co/storage/v1/object/sign/branding/logo.png'],
    ['local address', 'https://127.0.0.1/storage/v1/object/public/branding/logo.png'],
  ])('rejects a %s', (_label, value) => {
    expect(getApprovedOrganizationLogoUrl(value, SUPABASE_URL)).toBeNull()
  })

  it('rejects a logo when Supabase is not configured', () => {
    expect(getApprovedOrganizationLogoUrl(APPROVED_LOGO, '')).toBeNull()
  })

  it('treats an empty logo as disabled branding', () => {
    expect(getApprovedOrganizationLogoUrl(null, SUPABASE_URL)).toBeNull()
    expect(getApprovedOrganizationLogoUrl('', SUPABASE_URL)).toBeNull()
  })
})
