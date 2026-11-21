import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Every address no route matches: a signed-in visitor's typo, /verify/receipt/extra,
// /legal/anything. Without this file Next answers those with the prerendered /_not-found,
// whose script tags carry no nonce, so the nonce policy middleware sets refuses every one
// of them (18 CSP errors per visit). Rendered per request, notFound() here draws
// app/not-found.tsx with this request's nonce, the same as app/no-such-page.
//
// The title is set here as well as in not-found.tsx: after hydration the browser shows
// the title of the route that called notFound(), and with none it falls back to the
// site's default title.
export const runtime = "edge";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function MissingPage(): never {
  notFound();
}
