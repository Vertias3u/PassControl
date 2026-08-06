import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_JWKS_PATHS,
  PRERENDERED_PUBLIC_PATHS,
  buildContentSecurityPolicy,
  createCspNonce,
  isPrerenderedPublicPath,
  needsExternalJwks,
} from "@/lib/csp";
import { config as middlewareConfig } from "@/middleware";

function directive(policy: string, name: string): string {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? "";
}

describe("content security policy", () => {
  it("production script-src carries no unsafe-inline or unsafe-eval", () => {
    const scriptSrc = directive(
      buildContentSecurityPolicy({ nonce: "n0nc3", isProduction: true }),
      "script-src"
    );
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("production script-src is nonce driven with strict-dynamic", () => {
    const scriptSrc = directive(
      buildContentSecurityPolicy({ nonce: "n0nc3", isProduction: true }),
      "script-src"
    );
    expect(scriptSrc).toContain("'nonce-n0nc3'");
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  // React Refresh needs eval, so dev keeps it — but the nonce still applies, or
  // the dev experience would diverge from what production enforces.
  it("keeps unsafe-eval in development only, still nonced", () => {
    const dev = directive(
      buildContentSecurityPolicy({ nonce: "n0nc3", isProduction: false }),
      "script-src"
    );
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("'nonce-n0nc3'");
    expect(dev).not.toContain("unsafe-inline");
  });

  it("pins the rest of the policy", () => {
    const policy = buildContentSecurityPolicy({ nonce: "n0nc3", isProduction: true });
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("derives connect-src from the configured Supabase origin", () => {
    const connectSrc = directive(
      buildContentSecurityPolicy({
        nonce: "n0nc3",
        isProduction: true,
        supabaseUrl: "https://kmqh.supabase.co",
      }),
      "connect-src"
    );
    expect(connectSrc).toContain("https://kmqh.supabase.co");
    expect(connectSrc).toContain("wss://kmqh.supabase.co");
    expect(connectSrc).not.toContain("localhost");
  });

  // A statically prerendered page cannot use a nonce — its scripts were emitted
  // at build time — so it falls back to host allowlisting. Verified in a real
  // browser: under 'strict-dynamic' every prerendered chunk is refused and the
  // page never hydrates.
  describe("prerendered public pages", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "n0nc3",
      isProduction: true,
      prerendered: true,
    });

    it("drops strict-dynamic so same-origin chunks still load", () => {
      const scriptSrc = directive(policy, "script-src");
      expect(scriptSrc).not.toContain("strict-dynamic");
      expect(scriptSrc).toContain("'self'");
    });

    it("still never carries unsafe-eval in production", () => {
      expect(directive(policy, "script-src")).not.toContain("unsafe-eval");
    });

    it("is limited to the anonymous marketing page", () => {
      expect(PRERENDERED_PUBLIC_PATHS).toEqual(["/"]);
      expect(isPrerenderedPublicPath("/")).toBe(true);
      // Everything that touches a credential or a session must be nonced.
      for (const path of ["/login", "/signup", "/dashboard", "/dashboard/agents/abc"]) {
        expect(isPrerenderedPublicPath(path)).toBe(false);
      }
    });
  });

  it("issues a distinct nonce per request", () => {
    const nonces = new Set(Array.from({ length: 64 }, () => createCspNonce()));
    expect(nonces.size).toBe(64);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("middleware matcher", () => {
  const matches = (pathname: string): boolean =>
    middlewareConfig.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

  // The gateway dies if this ever changes: agents authenticate with a Bearer
  // work-visa, not a cookie, so a gated /api/* 302s every agent call to /login.
  it.each(["/api/v1/anthropic/v1/messages", "/api/auth/challenge", "/api/control/v1/agents"])(
    "never gates %s",
    (pathname) => {
      expect(matches(pathname)).toBe(false);
    }
  );

  // The JWKS is the trust anchor other deployments fetch to verify our receipts
  // and agent tokens. Gating it would 302 every verifier to /login. Excluded in
  // the matcher rather than added to PUBLIC_PATHS, following llms.txt: a
  // PUBLIC_PATHS entry still runs supabase.auth.getUser() on every fetch.
  it("never gates /.well-known/jwks.json", () => {
    expect(matches("/.well-known/jwks.json")).toBe(false);
  });

  it.each(["/dashboard", "/dashboard/agents/abc", "/login", "/"])(
    "still covers %s so it receives a nonce",
    (pathname) => {
      expect(matches(pathname)).toBe(true);
    }
  );
});

// The public receipt page verifies in the BROWSER: it fetches the issuer's
// /.well-known/jwks.json and checks the signature locally. That is the whole
// point — the receipt never reaches Vertias, and the page runs the same
// sdk/verify.ts a third party would run on their own machine.
//
// It needs connect-src to reach an issuer we cannot know in advance, so this one
// route gets `https:`. The alternative — proxying the key fetch through our own
// server — would create an anonymous SSRF surface AND put our server back in the
// trust path, where a lying server could serve a key that makes a forgery pass.
// That is the exact trust this page exists to remove.
describe("external JWKS fetching", () => {
  const widened = buildContentSecurityPolicy({
    nonce: "n0nc3",
    isProduction: true,
    supabaseUrl: "https://kmqh.supabase.co",
    allowExternalJwks: true,
  });
  const normal = buildContentSecurityPolicy({
    nonce: "n0nc3",
    isProduction: true,
    supabaseUrl: "https://kmqh.supabase.co",
  });

  // Token-wise, not substring-wise: the scheme-wide source is the bare token
  // `https:`, and a naive substring check also matches `https://kmqh.supabase.co`
  // — which would make the "not widened" assertion below pass for the wrong
  // reason, i.e. never fail at all.
  const sources = (policy: string) => directive(policy, "connect-src").split(/\s+/).slice(1);

  it("reaches any https issuer when asked", () => {
    expect(sources(widened)).toContain("https:");
  });

  it("does not, by default, anywhere else", () => {
    expect(sources(normal)).not.toContain("https:");
    expect(sources(normal)).toContain("https://kmqh.supabase.co");
  });

  it("keeps Supabase reachable so nothing else on the page breaks", () => {
    expect(directive(widened, "connect-src")).toContain("https://kmqh.supabase.co");
  });

  // The widening is about where the page may TALK, never about what may RUN.
  // If this ever relaxes script-src, an XSS on the one unauthenticated,
  // JavaScript-bearing page in the app becomes executable.
  it("changes nothing about which scripts may execute", () => {
    expect(directive(widened, "script-src")).toBe(directive(normal, "script-src"));
    expect(directive(widened, "script-src")).not.toContain("unsafe-inline");
    expect(directive(widened, "script-src")).not.toContain("unsafe-eval");
  });

  it("leaves every other directive identical", () => {
    for (const name of ["default-src", "object-src", "frame-ancestors", "form-action", "img-src"]) {
      expect(directive(widened, name)).toBe(directive(normal, name));
    }
  });

  // Exact match, not startsWith. A prefix test would hand the widened policy to
  // /verify/receipt-anything, and one careless route later, to more than that.
  it("applies to exactly one route", () => {
    expect(EXTERNAL_JWKS_PATHS).toEqual(["/verify/receipt"]);
    expect(needsExternalJwks("/verify/receipt")).toBe(true);
  });

  it.each([
    "/",
    "/verify",
    "/verify/kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8",
    "/verify/receipt/extra",
    "/verify/receipts",
    "/verify/receipt-forged",
    "/login",
    "/dashboard",
    "/dashboard/agents/abc",
  ])("never leaks to %s", (pathname) => {
    expect(needsExternalJwks(pathname)).toBe(false);
  });

  it("is wired into the middleware, not just exported", async () => {
    const source = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
    expect(source).toContain("needsExternalJwks");
    expect(source).toMatch(/allowExternalJwks:\s*needsExternalJwks\(/);
  });
});

describe("next.config", () => {
  // The page policy moved to middleware. If a static CSP for /:path* comes back,
  // every page would carry two CSP headers and browsers enforce the
  // intersection — the nonce policy would be silently crippled.
  it("no longer emits a page-wide Content-Security-Policy", async () => {
    const source = await readFile(new URL("../next.config.mjs", import.meta.url), "utf8");
    // securityHeaders is the list applied to "/:path*" — i.e. to every page.
    const block = source.match(/const securityHeaders = \[([\s\S]*?)\n\];/)?.[1] ?? "";
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain("Content-Security-Policy");
  });

  // The API's policy is unrelated to the page policy and stays static: JSON
  // responses execute nothing, so it should be strictly tighter, not nonced.
  it("keeps a script-free policy for the API", async () => {
    const source = await readFile(new URL("../next.config.mjs", import.meta.url), "utf8");
    expect(source).toMatch(/source:\s*"\/api\/:path\*"/);
    expect(source).not.toContain("script-src");
  });
});
