const PUBLIC_STORAGE_PATH_PREFIX = '/storage/v1/object/public/'

/**
 * Returns a normalized logo URL only when it belongs to the configured public
 * Supabase Storage origin. React PDF fetches remote images server-side, so this
 * policy must be applied before passing any organization-provided URL to it.
 */
export function getApprovedOrganizationLogoUrl(
  value: string | null | undefined,
  configuredSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
): string | null {
  if (!value || !configuredSupabaseUrl) return null

  try {
    const logoUrl = new URL(value)
    const supabaseUrl = new URL(configuredSupabaseUrl)

    if (logoUrl.protocol !== 'https:' || supabaseUrl.protocol !== 'https:') return null
    if (logoUrl.origin !== supabaseUrl.origin) return null
    if (logoUrl.username || logoUrl.password) return null
    if (!logoUrl.pathname.startsWith(PUBLIC_STORAGE_PATH_PREFIX)) return null

    return logoUrl.toString()
  } catch {
    return null
  }
}
