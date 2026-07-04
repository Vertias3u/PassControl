/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// connect-src must allow the browser to reach Supabase (REST + realtime WebSocket).
// Derive it from NEXT_PUBLIC_SUPABASE_URL so it works for BOTH a hosted project
// (https/wss) and a local Docker stack (http/ws on 127.0.0.1) — and it's tighter
// than a *.supabase.co wildcard (only the configured origin). In dev we also allow
// localhost ws for Next's HMR socket. Falls back to the hosted wildcard if the URL
// is unparseable/unset.
const supabaseConnect = (() => {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const wsScheme = u.protocol === "https:" ? "wss:" : "ws:";
    return [u.origin, `${wsScheme}//${u.host}`];
  } catch {
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
})();
const connectSrc = [
  "'self'",
  ...supabaseConnect,
  ...(isProd ? [] : ["ws://localhost:*", "ws://127.0.0.1:*"]),
].join(" ");

// Relaxed-but-verifiable CSP: ship this now, upgrade to a per-request nonce +
// strict-dynamic later. 'unsafe-inline'/'unsafe-eval' are required by Next's
// inline hydration scripts and dev tooling without nonces.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  `connect-src ${connectSrc}`,
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
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
      { source: "/api/:path*", headers: [noStore] },
      { source: "/login", headers: [noStore] },
      { source: "/signup", headers: [noStore] },
    ];
  },
};

export default nextConfig;
