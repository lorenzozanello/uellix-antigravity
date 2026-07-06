import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Private product surface and auth flows are not for indexing.
      //
      // CONVENTION: a robots.txt Disallow only blocks CRAWLING, not INDEXING —
      // an internally-linked route (e.g. /login, linked from the Navbar) can
      // still be indexed as a bare URL. So every route listed here that renders
      // real HTML MUST also declare `robots: { index: false }` in its own page
      // `metadata` (see app/(public)/login|forgot-password|reset-password and
      // terminos|privacidad). The /app and /admin trees are exempt: they are
      // guarded server-side and 307-redirect anonymous requests to /login, so a
      // crawler never receives indexable HTML from them.
      disallow: ["/app/", "/admin/", "/login", "/reset-password", "/forgot-password"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
