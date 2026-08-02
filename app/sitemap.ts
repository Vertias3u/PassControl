import type { MetadataRoute } from "next";

const BASE = "https://passcontrol.vertias.eu";

// Emitted at /sitemap.xml. The marketing page's sections are in-page anchors,
// which sitemaps don't enumerate, so only two URLs are listed: the marketing
// page and the public verification entry point.
//
// /verify itself is indexable — it's a lookup form with no passport in it. The
// individual /verify/<passport-id> pages are not, and robots.ts disallows that
// prefix: shareable is not the same as crawlable.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: BASE,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE}/verify`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
