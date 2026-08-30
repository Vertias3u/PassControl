import type { MetadataRoute } from "next";

import { instanceIssuer } from "@/lib/crypto/instanceKey";

// A sitemap is absolute URLs or nothing. A self-hosted deployment's own origin is
// the issuer it already signs receipts under, so that is the one value here that
// cannot be wrong. Unset — no INSTANCE_SIGNING_KEY — means the instance has no
// published identity yet, and an empty sitemap is the honest answer; emitting
// relative URLs, or ours, would both be worse.
const BASE = instanceIssuer() ?? "";

// Emitted at /sitemap.xml. The marketing page's sections are in-page anchors,
// which sitemaps don't enumerate, so only the entry points are listed: the
// marketing page, the public content pages, and two public verification surfaces.
//
// /verify and /verify/receipt are both indexable — they are paste boxes with
// nothing private in the URL. The individual /verify/<passport-id> pages are
// not, and robots.ts disallows that prefix: shareable is not the same as
// crawlable.
// lastmod is a claim, and Google discounts the field on a host that files
// inaccurate ones — which is the opposite of what a site waiting to be recrawled
// wants. `new Date()` at build time asserted "modified right now" for every URL
// on every deploy, including pages that had not changed in weeks. So: a real
// date where the tree knows one, and no field at all where it does not.
// changeFrequency and priority stay, but note Google ignores both.
const latestOf = (dates: readonly string[]): string =>
  dates.reduce((latest, date) => (date > latest ? date : latest), "");


const day = (date: string): Date => new Date(`${date}T00:00:00Z`);

export default function sitemap(): MetadataRoute.Sitemap {
  if (!BASE) return [];
  return [
    {
      url: BASE,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE}/verify`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${BASE}/verify/receipt`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    // Legal pages deliberately stay out of the sitemap until the public service
    // address is resolved and the draft banner can be removed.
  ];
}
