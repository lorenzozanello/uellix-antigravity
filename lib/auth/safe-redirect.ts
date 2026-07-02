/**
 * lib/auth/safe-redirect.ts
 * Validates a user-supplied `redirect` query param before using it as a
 * post-login destination — prevents open-redirect attacks where an
 * attacker crafts a login link with `?redirect=https://evil.example.com`
 * to phish credentials after a legitimate-looking Uellix login.
 *
 * Only same-origin, path-relative destinations are allowed.
 */
export function isSafeRedirectPath(value: string | null | undefined): value is string {
  if (!value) return false
  // Must start with a single `/` — rejects absolute URLs (https://...),
  // protocol-relative URLs (//evil.example.com), and anything with a
  // scheme (javascript:, data:, etc).
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (value.includes('://')) return false
  return true
}
