import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: siteUrl,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${siteUrl}/demo`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    // /privacidad and /terminos are intentionally omitted while they are drafts
    // marked `robots: { index: false }`. Listing a noindexed URL in the sitemap
    // triggers "Submitted URL marked noindex" warnings in Search Console. Re-add
    // them here once legal review is complete and the noindex is lifted.
  ];
}
