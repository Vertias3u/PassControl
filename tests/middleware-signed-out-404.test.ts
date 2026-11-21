import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A signed-out visitor to an address with no page gets the 404, not the sign-in form.
 *
 * Before this, the gate sent every non-public path to /login, so /pricing, /status and a
 * mistyped /lern all answered "sign in", as if the page existed behind an account. The
 * trust boundary is the part that must not move: a real gated page must still never
 * render to a stranger, and /dashboard/<anything> must still answer the same redirect
 * whether or not the route exists.
 */
const h = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: h.getUser } }),
}));

import { NextRequest } from "next/server";

const { middleware, signedOutAnswer, SIGNED_OUT_NOT_FOUND_PATH } = await import("@/middleware");

/** app/[...missing]: every address no route matches, rendered per request (see its file). */
const CATCH_ALL_DIR = "[...missing]";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** Every page or route handler under app/, with dynamic segments filled in. */
function realRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // The root catch-all only ever answers 404 (checked below); it is not a page.
        if (dir === "app" && entry.name === CATCH_ALL_DIR) continue;
        const seg = /^\(.*\)$/.test(entry.name) ? "" : entry.name.startsWith("[") ? "/sample-value" : `/${entry.name}`;
        walk(`${dir}/${entry.name}`, url + seg);
      } else if (/^(page|route)\.tsx?$/.test(entry.name)) {
        out.push(url || "/");
      }
    }
  };
  walk("app", "");
  // The matcher keeps these away from the gate entirely.
  return [...new Set(out)].filter((p) => !/^\/(api|\.well-known|avatars|llms\.txt)(\/|$)/.test(p));
}

const request = (pathname: string) =>
  new NextRequest(new URL(pathname, "https://passcontrol.vertias.eu"), { headers: { "x-forwarded-for": "203.0.113.7" } });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  h.getUser.mockReset();
  h.getUser.mockResolvedValue({ data: { user: null } });
});

describe("every real route is classified, so none becomes a 404 by accident", () => {
  it("is public or behind the sign-in redirect", () => {
    const routes = realRoutes().filter((r) => r !== SIGNED_OUT_NOT_FOUND_PATH);
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.filter((r) => signedOutAnswer(r) === "not-found")).toEqual([]);
  });

  it("keeps the dashboard behind the redirect", () => {
    const dashboard = realRoutes().filter((r) => r.startsWith("/dashboard"));
    expect(dashboard.length).toBeGreaterThan(0);
    for (const r of dashboard) expect(signedOutAnswer(r), r).toBe("login");
  });

  it("rewrites onto a route that only answers 404, rendered per request for the nonce", () => {
    const page = path.join(ROOT, "app", SIGNED_OUT_NOT_FOUND_PATH.slice(1), "page.tsx");
    expect(existsSync(page)).toBe(true);
    const src = readFileSync(page, "utf8");
    expect(src).toContain('export const dynamic = "force-dynamic";');
    // The body is notFound() and nothing else that could render.
    expect(src.replace(/\/\/.*$/gm, "")).toMatch(/export default function \w+\(\): never \{\s*notFound\(\);\s*\}/);
    expect(signedOutAnswer(SIGNED_OUT_NOT_FOUND_PATH)).toBe("not-found");
  });
});

describe("an address no route matches answers 404 with this request's nonce", () => {
  const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
  const code = (src: string) => src.replace(/\/\/.*$/gm, "");

  it("has a root catch-all that is rendered per request and only calls notFound()", () => {
    const rel = `app/${CATCH_ALL_DIR}/page.tsx`;
    expect(existsSync(path.join(ROOT, rel))).toBe(true);
    const src = source(rel);
    // Without it, a miss gets the prerendered 404, whose scripts carry no nonce: the
    // nonce policy refuses every one (18 CSP errors live on /verify/receipt/extra,
    // and on any unknown address for a signed-in visitor).
    expect(src).toContain('export const dynamic = "force-dynamic";');
    expect(code(src)).toMatch(/export default function \w+\(\): never \{\s*notFound\(\);\s*\}/);
  });

  it.each([`app/${CATCH_ALL_DIR}/page.tsx`, `app${SIGNED_OUT_NOT_FOUND_PATH}/page.tsx`])(
    "%s names itself, so the tab does not change to the site title once the page loads",
    (rel) => {
      // The server HTML takes not-found.tsx's title, but after hydration the browser shows
      // the title of the ROUTE that called notFound(); with none, the root default.
      const src = code(source(rel));
      expect(src).toMatch(/title: "Page not found"/);
      expect(src).toMatch(/robots: \{ index: false, follow: false \}/);
    },
  );
});

describe("signed out", () => {
  it.each(["/pricing", "/status", "/does-not-exist", "/lern", "/dashboardx", "/Dashboard"])(
    "%s is a 404, not the sign-in page",
    async (p) => {
      const res = await middleware(request(p));
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-rewrite")).toBe(`https://passcontrol.vertias.eu${SIGNED_OUT_NOT_FOUND_PATH}`);
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp).toMatch(/nonce-/);
      // The nonce must reach the render too, not only the response header: without the
      // forwarded request headers the 404 page's scripts carry no nonce and are refused.
      const nonce = res.headers.get("x-middleware-request-x-nonce");
      expect(nonce).toBeTruthy();
      expect(csp).toContain(`'nonce-${nonce}'`);
      expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    },
  );

  it("drops the query string from the rewrite", async () => {
    const res = await middleware(request("/pricing?plan=pro"));
    expect(res.headers.get("x-middleware-rewrite")).toBe(`https://passcontrol.vertias.eu${SIGNED_OUT_NOT_FOUND_PATH}`);
  });

  it.each(["/dashboard", "/dashboard/settings", "/dashboard/agents/abc", "/dashboard/no-such-page"])(
    "%s still redirects to /login, whether or not the route exists",
    async (p) => {
      const res = await middleware(request(p));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    },
  );

  it.each(["/", "/login", "/signup", "/verify", "/verify/statement", "/u/someone"])(
    "%s is served as before",
    async (p) => {
      const res = await middleware(request(p));
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    },
  );
});

describe("signed in, nothing changes", () => {
  it.each(["/pricing", "/dashboard/settings", "/dashboard/no-such-page"])("%s reaches the app", async (p) => {
    h.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    const res = await middleware(request(p));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
