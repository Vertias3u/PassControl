import type { MetadataRoute } from "next";

const BASE = "https://passcontrol.vertias.eu";

// Emitted at /robots.txt. Allow crawling of the public marketing surface; keep
// the authenticated app + API out of the index. Points crawlers at the sitemap.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // /verify/receipt is carved back out of the /verify/ disallow below. It
        // is a paste box, not a per-record page: nothing private can appear in
        // its URL, and it is a legitimate landing page for someone who has been
        // handed a receipt and is searching for how to check it. Crawlers take
        // the longest matching rule, so the explicit allow wins over the prefix.
        allow: ["/", "/verify/receipt"],
        // The rest of /verify/* is public and meant to be shared in a README or
        // a ticket, but shareable is not indexable: a crawlable index of every
        // passport id anyone ever linked to is not something to hand a search
        // engine.
        disallow: ["/dashboard", "/login/verify", "/api/", "/verify/"],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
