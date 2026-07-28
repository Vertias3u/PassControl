// Content-Security-Policy for the human-facing pages.
//
// This used to be a static header in next.config.mjs carrying 'unsafe-inline'
// and 'unsafe-eval' in script-src, which on an identity product means the CSP
// bought almost nothing: an injected inline script in the Control Tower runs
// with the operator's session. The policy is now built per request around a
// fresh nonce, so only scripts the server marked can execute.
//
// Kept here rather than in next.config.mjs because middleware.ts (TypeScript,
// edge runtime) is what emits it now, and tsconfig sets allowJs: false — a .mjs
// module cannot be imported from the middleware without breaking `tsc --noEmit`.
// next.config.mjs keeps only the API's own policy, which shares nothing with
// this one.

/**
 * 128 bits of CSPRNG per request, base64 encoded. Web Crypto rather than
 * node:crypto — every route in this app runs on the edge runtime.
 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * connect-src must reach Supabase (REST + realtime WebSocket). Derived from the
 * configured URL so it covers a hosted project (https/wss) and a local Docker
 * stack (http/ws on 127.0.0.1) alike, and stays tighter than a *.supabase.co
 * wildcard. Falls back to the hosted wildcard if the URL is unset/unparseable.
 */
function connectSources(supabaseUrl: string | undefined, isProduction: boolean): string[] {
  let supabase: string[];
  try {
    const url = new URL(supabaseUrl ?? "");
    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    supabase = [url.origin, `${wsScheme}//${url.host}`];
  } catch {
    supabase = ["https://*.supabase.co", "wss://*.supabase.co"];
  }
  // Next's HMR socket only exists in dev.
  const hmr = isProduction ? [] : ["ws://localhost:*", "ws://127.0.0.1:*"];
  return ["'self'", ...supabase, ...hmr];
}

/**
 * Pages that Next statically prerenders, and therefore cannot carry a
 * per-request nonce: their script tags and inline RSC flight-data blocks are
 * baked at build time. Under 'strict-dynamic' every one of those scripts is
 * refused and the page never hydrates — verified in a browser, not assumed.
 *
 * Only the anonymous marketing page is on this list, deliberately. It holds no
 * session and no user data, and keeping it prerendered is what lets a launch
 * spike be absorbed by the CDN instead of by functions. Every page that touches
 * credentials or a session (/login, /signup, /dashboard/**) is dynamically
 * rendered specifically so it can be nonced.
 *
 * If you add a page here, you are choosing 'unsafe-inline' for it. If you make a
 * page static that is NOT here, its scripts will be blocked — make it dynamic
 * (`export const dynamic = "force-dynamic"`) instead of relaxing the policy.
 */
export const PRERENDERED_PUBLIC_PATHS: readonly string[] = ["/"];

export function isPrerenderedPublicPath(pathname: string): boolean {
  return PRERENDERED_PUBLIC_PATHS.includes(pathname);
}

export interface CspOptions {
  nonce: string;
  isProduction?: boolean;
  supabaseUrl?: string;
  /** True for statically prerendered pages — see PRERENDERED_PUBLIC_PATHS. */
  prerendered?: boolean;
}

export function buildContentSecurityPolicy({
  nonce,
  isProduction = process.env.NODE_ENV === "production",
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
  prerendered = false,
}: CspOptions): string {
  // 'self' is retained alongside 'strict-dynamic' deliberately: CSP3 browsers
  // ignore it once 'strict-dynamic' is present, and CSP2-only browsers ignore
  // 'strict-dynamic' and fall back to it. 'unsafe-eval' is dev-only — Next's
  // React Refresh needs it, production must never carry it.
  //
  // A prerendered page cannot use the nonce at all (its scripts were emitted at
  // build time), so it falls back to host allowlisting plus 'unsafe-inline' for
  // Next's inline flight data. That is weaker, and it is why the list of such
  // pages is one anonymous page long. 'unsafe-eval' is gone in production
  // either way — that part is not a tradeoff.
  const scriptSrc = prerendered
    ? ["'self'", "'unsafe-inline'", ...(isProduction ? [] : ["'unsafe-eval'"])]
    : [
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        ...(isProduction ? [] : ["'unsafe-eval'"]),
      ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Next injects framework styles inline and does not nonce them. Style
    // injection is a defacement/exfiltration-via-selector risk, not script
    // execution, so this stays until the framework offers a nonced path.
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSrc.join(" ")}`,
    `connect-src ${connectSources(supabaseUrl, isProduction).join(" ")}`,
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
