import type { MetadataRoute } from "next";

import { instanceIssuer } from "@/lib/crypto/instanceKey";

// Same reasoning as app/sitemap.ts: the instance's own issuer, or nothing.
const BASE = instanceIssuer() ?? "";

const DISALLOW = ["/dashboard", "/login/verify", "/api/", "/verify/", "/u/"];

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
        // /verify/statement is the same kind of page: a paste box for the published
        // statement format, listed in sitemap.xml and marked index:true in its own
        // metadata. It was missing here, so robots.txt blocked the URL the sitemap
        // submitted. `$` ends the match: without it the rule is a prefix and would also
        // open /verify/statement/badge.svg and any passport id starting "statement".
        // scripts/__tests__/site-seo-consistency.test.ts checks every sitemap URL
        // against these rules.
        allow: ["/", "/verify/receipt", "/verify/statement$", "/@"],
        // The rest of /verify/* is public and meant to be shared in a README or
        // a ticket, but shareable is not indexable: a crawlable index of every
        // passport id anyone ever linked to is not something to hand a search
        // engine.
        // /u/ is the same page as /@ reached by its internal path — middleware
        // rewrites one onto the other. Both would index as duplicate content,
        // so only the canonical /@ form is offered; every page sets
        // alternates.canonical to match.
        disallow: DISALLOW,
      },
    ],
    // Both are absolute-URL fields; with no configured issuer there is no honest
    // value, and Next omits an undefined field rather than emitting an empty one.
    sitemap: BASE ? `${BASE}/sitemap.xml` : undefined,
    host: BASE || undefined,
  };
}
