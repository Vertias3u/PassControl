import type { MetadataRoute } from "next";

import { instanceIssuer } from "@/lib/crypto/instanceKey";

// Same reasoning as app/sitemap.ts: the instance's own issuer, or nothing.
const BASE = instanceIssuer() ?? "";

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
        // /@handle is the opposite case from /verify/<passportId> below: a
        // public operator profile is opt-in and exists precisely to be found,
        // so it is invited in rather than kept out.
        allow: ["/", "/verify/receipt", "/@"],
        // The rest of /verify/* is public and meant to be shared in a README or
        // a ticket, but shareable is not indexable: a crawlable index of every
        // passport id anyone ever linked to is not something to hand a search
        // engine.
        // /u/ is the same page as /@ reached by its internal path — middleware
        // rewrites one onto the other. Both would index as duplicate content,
        // so only the canonical /@ form is offered; every page sets
        // alternates.canonical to match.
        disallow: ["/dashboard", "/login/verify", "/api/", "/verify/", "/u/"],
      },
    ],
    // Both are absolute-URL fields; with no configured issuer there is no honest
    // value, and Next omits an undefined field rather than emitting an empty one.
    sitemap: BASE ? `${BASE}/sitemap.xml` : undefined,
    host: BASE || undefined,
  };
}
