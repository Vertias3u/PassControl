import type { MetadataRoute } from "next";

const BASE = "https://passcontrol.vertias.eu";

// Emitted at /sitemap.xml. The marketing page's sections are in-page anchors,
// which sitemaps don't enumerate, so only the entry points are listed: the
// marketing page and the two public verification surfaces.
//
// /verify and /verify/receipt are both indexable — they are paste boxes with
// nothing private in the URL. The individual /verify/<passport-id> pages are
// not, and robots.ts disallows that prefix: shareable is not the same as
// crawlable.
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
    {
      url: `${BASE}/verify/receipt`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    // Legal pages deliberately stay out of the sitemap until the public service
    // address is resolved and the draft banner can be removed.
  ];
}
