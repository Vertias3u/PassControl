// Auth gate for the dashboard. Adapted from the Atlas app's proxy.ts to Next.js
// 15's middleware convention (file `middleware.ts`, export `middleware`).
//
// CRITICAL: the matcher excludes /api/* on purpose. Agents authenticate to the
// gateway with a Bearer work-visa (and cron with CRON_SECRET), NOT with a login
// cookie — so the API routes must NOT be redirected to /login. This gate covers
// only the human-facing dashboard pages.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  isPrerenderedPublicPath,
  needsExternalJwks,
} from "@/lib/csp";

// /verify is the public agent verification page (PAVP): a stranger with a
// passport id and no account can ask whether we issued it. It is public but NOT
// prerendered — it is dynamically rendered per request, so it carries a nonce
// like every other dynamic page and must stay out of PRERENDERED_PUBLIC_PATHS.
//
// "/u" is the public operator profile. /@handle rewrites onto it below, but the
// canonical path has to be public in its own right as well: a crawler following
// the canonical link, or anyone who copies the address out of a rewritten URL
// bar, arrives at /u/<handle> directly and would otherwise be sent to /login.
const PUBLIC_PATHS = ["/", "/beta", "/login", "/signup", "/auth/callback", "/verify", "/legal", "/u"];
const CSP_HEADER = "Content-Security-Policy";

/**
 * Handles that /@… may be rewritten with.
 *
 * Deliberately narrower than lib/profile/handle.ts and duplicated rather than
 * imported: this runs before the auth gate, on a path an anonymous caller
 * controls completely, so it must be a plain character-class test that cannot
 * be widened by an edit somewhere else. Everything it rejects — /@../../dashboard,
 * /@..%2f..%2fdashboard, a 400-character segment — falls through to the normal
 * gate instead, which is the safe direction.
 */
const REWRITABLE_HANDLE = /^[a-z0-9_]{3,30}$/;

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(request: NextRequest) {
  // One nonce per request. Setting the policy on the REQUEST headers as well as
  // the response is what makes Next stamp the same nonce onto the scripts it
  // renders; without it 'strict-dynamic' would block the framework's own
  // bootstrap and the page would never hydrate.
  const nonce = createCspNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    prerendered: isPrerenderedPublicPath(request.nextUrl.pathname),
    // Exactly one route verifies a third party's signature in the browser and
    // therefore has to reach an issuer we cannot know in advance. Exact match —
    // see EXTERNAL_JWKS_PATHS for why this is narrow on purpose.
    allowExternalJwks: needsExternalJwks(request.nextUrl.pathname),
  });

  // Rebuilt per call rather than captured once: Supabase's setAll mutates
  // request.cookies below, and the forwarded headers must reflect that.
  const forwardedHeaders = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set(CSP_HEADER, csp);
    return headers;
  };

  const withCsp = (response: NextResponse): NextResponse => {
    response.headers.set(CSP_HEADER, csp);
    return response;
  };

  // ── /@handle, before the auth gate ────────────────────────────────────────
  //
  // `app/@x` is Next's parallel-route syntax and cannot be a literal `@`
  // segment, so the page lives at /u/[handle] and this rewrites onto it.
  //
  // It returns BEFORE createServerClient/getUser, which is the entire point: a
  // logged-out stranger is the whole audience for this page, and running the
  // gate would both cost a network round trip on every visit and 302 them to
  // /login. Same reasoning that keeps .well-known out of the matcher.
  //
  // withCsp and forwardedHeaders are still applied. Returning early past them
  // is the easy mistake here, and it fails in a way that looks like a styling
  // problem: with no nonce under 'strict-dynamic', every framework script is
  // refused and the page simply never hydrates.
  if (request.nextUrl.pathname.startsWith("/@")) {
    const handle = request.nextUrl.pathname.slice(2).toLowerCase();
    if (REWRITABLE_HANDLE.test(handle)) {
      const url = request.nextUrl.clone();
      url.pathname = `/u/${encodeURIComponent(handle)}`;
      return withCsp(
        NextResponse.rewrite(url, { request: { headers: forwardedHeaders() } })
      );
    }
    // Not handle-shaped: fall through and let the ordinary gate answer.
  }

  let supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders() } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]
        ) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders() } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Do not add logic between createServerClient and getUser() — this call
  // refreshes the session cookie; reordering it breaks silent token refresh.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  if (!user && !isPublic(pathname)) {
    return withCsp(NextResponse.redirect(new URL("/login", request.url)));
  }
  if (user && (pathname === "/login" || pathname === "/signup")) {
    return withCsp(NextResponse.redirect(new URL("/dashboard", request.url)));
  }

  return withCsp(supabaseResponse);
}

export const config = {
  // Exclude API routes (visa/secret-authenticated), static assets, and images.
  // .well-known is excluded for the same reason as llms.txt: it is a public
  // machine-readable document. Gating the JWKS would 302 every verifier of our
  // receipts and agent tokens to /login. Excluded here rather than added to
  // PUBLIC_PATHS because a PUBLIC_PATHS entry still runs supabase.auth.getUser()
  // — a network round trip on a document meant to be fetched and cached.
  //
  // `avatars/` joins them, and the trailing slash is load-bearing: it excludes
  // /avatars/<key> without also excluding some future /avatarsomething page. An
  // avatar is an <img src> on a page strangers read, so gating it would 302 the
  // image to /login and render as a broken picture with no clue why.
  matcher: [
    "/((?!api|\\.well-known|avatars/|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
