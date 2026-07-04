import type { MetadataRoute } from "next";

const siteUrl = "https://uellix-antigravity.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Private product surface and auth flows are not for indexing.
      disallow: ["/app/", "/admin/", "/login", "/reset-password", "/forgot-password"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
