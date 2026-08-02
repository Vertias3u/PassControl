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
} from "@/lib/csp";

// /verify is the public agent verification page (PAVP): a stranger with a
// passport id and no account can ask whether we issued it. It is public but NOT
// prerendered — it is dynamically rendered per request, so it carries a nonce
// like every other dynamic page and must stay out of PRERENDERED_PUBLIC_PATHS.
const PUBLIC_PATHS = ["/", "/login", "/signup", "/auth/callback", "/verify"];
const CSP_HEADER = "Content-Security-Policy";

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
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
