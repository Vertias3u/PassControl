import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Where middleware rewrites a signed-out request for an address with no page
// (SIGNED_OUT_NOT_FOUND_PATH in middleware.ts). It only ever answers 404.
//
// Why a route and not the root not-found directly: that page is prerendered, so its
// script tags carry no nonce, and the nonce policy middleware sets on the response
// refuses every one of them (17 CSP errors per visit, the failure the legal pages had).
// Rendered per request, notFound() here draws the same app/not-found.tsx with this
// request's nonce. Making not-found.tsx itself dynamic would make every page in the
// app dynamic, the homepage and the guides included.
export const runtime = "edge";
export const dynamic = "force-dynamic";

// After hydration the browser shows the title of the route that called notFound(), not
// not-found.tsx's; without this the tab changed to the site's default title.
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NoSuchPage(): never {
  notFound();
}
