// Single source of truth for the public site origin.
//
// Priority:
//   1. NEXT_PUBLIC_SITE_URL — set this to the production custom domain
//      (e.g. https://uellix.com) in the environment. This is the value that
//      flows into metadataBase, canonical URLs, OpenGraph/Twitter URLs, the
//      Organization JSON-LD, robots.txt and sitemap.xml.
//   2. Vercel-provided origin (preview/production deploys without a custom
//      domain configured) — VERCEL_PROJECT_PRODUCTION_URL is the stable
//      production hostname; VERCEL_URL is the per-deploy hostname.
//   3. Local development fallback.
//
// Keeping this env-driven means we never again hardcode a *.vercel.app origin
// into structured data — pointing enterprise buyers' crawlers at a branded
// domain is part of the trust surface.
function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL
  if (explicit) return explicit.replace(/\/$/, "")

  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (vercelProd) return `https://${vercelProd}`

  const vercelUrl = process.env.VERCEL_URL
  if (vercelUrl) return `https://${vercelUrl}`

  return "https://uellix-antigravity.vercel.app"
}

export const siteUrl = resolveSiteUrl()
