/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// The page Content-Security-Policy is NOT here any more. It is built per request
// around a fresh nonce in middleware.ts (see lib/csp.ts), because a static header
// cannot carry a nonce. Do not reintroduce a CSP under "/:path*": pages would
// then receive two policies and browsers enforce the intersection, silently
// crippling the nonce policy. tests/csp.test.ts fails if that comes back.
//
// The API keeps its own static policy. Those responses are JSON — nothing to
// execute, embed, or frame — so it is strictly tighter than the page policy and
// shares nothing with it.
const apiCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  // Cross-origin isolation. Safe here — no OAuth popups / cross-origin embeds
  // that COOP/CORP would break.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // HSTS only in prod (localhost ignores it; preload is a real commitment).
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

// Never cache authenticated/sensitive responses.
const noStore = { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" };

const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework — strip the default `X-Powered-By: Next.js`
  // header so responses reveal less about the stack to attackers.
  poweredByHeader: false,
  experimental: {
    // Server Actions are used by the dashboard kill-switch / key management flows.
    serverActions: { bodySizeLimit: "1mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/dashboard/:path*", headers: [noStore] },
      { source: "/dashboard", headers: [noStore] },
      {
        source: "/api/:path*",
        headers: [noStore, { key: "Content-Security-Policy", value: apiCsp }],
      },
      // The JWKS is the one document other deployments are meant to fetch, so
      // the global Cross-Origin-Resource-Policy: same-origin above must not
      // apply to it. The route handler sets these too; this entry keeps the
      // config from contradicting it. Deliberately NOT under /api/:path*, which
      // would attach no-store to a document that should be cached.
      {
        source: "/.well-known/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Content-Security-Policy", value: apiCsp },
        ],
      },
      { source: "/login", headers: [noStore] },
      { source: "/login/:path*", headers: [noStore] },
      { source: "/signup", headers: [noStore] },
    ];
  },
};

export default nextConfig;
