// /@handle — the rewrite, and the three things it must not cost.
//
// `app/@x` is Next's parallel-route syntax and cannot be a literal `@` segment,
// so the public profile lives at /u/[handle] and middleware rewrites /@handle
// onto it. That rewrite runs BEFORE the auth gate, which is where all the risk
// is. This drives the real middleware rather than reading its source, because
// the three properties that matter are behavioural:
//
//   1. It must not call supabase.auth.getUser(). That is a network round trip,
//      and it is exactly the cost .well-known was excluded from the matcher to
//      avoid. If it ran, /@handle would also 302 to /login for a logged-out
//      stranger — which is every single visitor this page exists for.
//   2. It must still carry the CSP and the nonce. Returning early past the
//      block that builds them would leave the page under 'strict-dynamic' with
//      no nonce: every framework script refused, nothing hydrates, and it looks
//      like a styling bug rather than a header one.
//   3. It must not rewrite anything that is not handle-shaped. /@../../dashboard
//      reaches this code, and a rewrite that trusts the segment is a path
//      traversal into the authenticated app.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: h.getUser } }),
}));

import { NextRequest } from "next/server";

const { middleware, config } = await import("@/middleware");

function request(pathname: string) {
  return new NextRequest(new URL(pathname, "https://passcontrol.vertias.eu"), {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
}

const matches = (pathname: string): boolean =>
  config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({ data: { user: null } });
});

describe("the /@handle rewrite", () => {
  it("rewrites onto the real route", async () => {
    const response = await middleware(request("/@vertias_ops"));
    expect(response.headers.get("x-middleware-rewrite")).toContain("/u/vertias_ops");
  });

  // (1) The whole reason this is a rewrite in middleware and not a PUBLIC_PATHS
  // entry. A logged-out stranger is the entire audience for this page.
  it("never asks Supabase who the visitor is", async () => {
    await middleware(request("/@vertias_ops"));
    expect(h.getUser).not.toHaveBeenCalled();
  });

  it("does not redirect a logged-out visitor to /login", async () => {
    const response = await middleware(request("/@vertias_ops"));
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
  });

  // (2) Returning early past the CSP block is the easy mistake, and it fails in
  // a way that looks like CSS rather than headers.
  it("still carries a Content-Security-Policy", async () => {
    const response = await middleware(request("/@vertias_ops"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src");
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/);
  });

  it("lowercases the handle so /@VertiasOps and /@vertiasops are one page", async () => {
    const response = await middleware(request("/@VertiasOps"));
    expect(response.headers.get("x-middleware-rewrite")).toContain("/u/vertiasops");
  });
});

describe("what must NOT be rewritten", () => {
  // (3) Every one of these reaches the rewrite. A rewrite that trusts the
  // segment is a path traversal into the authenticated app, performed by a
  // request that has deliberately skipped the auth gate.
  it.each([
    "/@../../dashboard",
    "/@..%2f..%2fdashboard",
    "/@a/b",
    "/@",
    "/@ab",
    "/@has-hyphen",
    "/@UPPER!",
    "/@" + "a".repeat(400),
  ])("falls through to the normal gate for %s", async (pathname) => {
    await middleware(request(pathname));
    // Falling through means the gate ran — which is the safe direction: it
    // either 404s at the route or redirects, but it never rewrites.
    expect(h.getUser).toHaveBeenCalled();
  });

  it("leaves ordinary pages completely alone", async () => {
    const response = await middleware(request("/dashboard"));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(h.getUser).toHaveBeenCalled();
  });
});

describe("the canonical route", () => {
  // A crawler following the canonical link, or anyone who copies the address
  // out of a rewritten URL bar, hits /u/<handle> directly. It has to be public
  // in its own right or the page 302s to /login for exactly those visitors.
  it("serves /u/<handle> to a logged-out visitor without redirecting", async () => {
    const response = await middleware(request("/u/vertias_ops"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).not.toBe(307);
  });

  it("is covered by the matcher, so it receives a nonce", () => {
    expect(matches("/u/vertias_ops")).toBe(true);
    expect(matches("/@vertias_ops")).toBe(true);
  });

  // "/u" must not accidentally make the whole app public.
  it("does not make an unrelated path public by prefix", async () => {
    const response = await middleware(request("/users"));
    expect(response.headers.get("location")).toContain("/login");
  });
});

describe("robots", () => {
  it("invites crawlers to /@ but not to the internal /u/ duplicate", async () => {
    const { default: robots } = await import("@/app/robots");
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0]! : rules;
    const allow = [rule.allow ?? []].flat();
    const disallow = [rule.disallow ?? []].flat();

    // Unlike /verify/<passportId>, which is deliberately unindexed because a
    // crawlable list of passport ids is not a feature, a public profile is
    // opt-in and the entire point is that it can be found.
    expect(allow).toContain("/@");
    // Both addresses serve the same page. /@ is the canonical one, so the
    // internal path stays out of the index rather than competing with it.
    expect(disallow).toContain("/u/");
    // The dashboard must not have become crawlable along the way.
    expect(disallow).toContain("/dashboard");
  });
});
