import type { MetadataRoute } from "next";

const BASE = "https://passcontrol.vertias.eu";

// Emitted at /sitemap.xml. The marketing site is a single indexable page (the
// sections are in-page anchors, which sitemaps don't enumerate).
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: BASE,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
