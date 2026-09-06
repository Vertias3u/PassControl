import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { config as middlewareConfig, isProbePath, middleware } from "@/middleware";

/**
 * Junk paths must not cost a Supabase auth call.
 *
 * `middleware.ts` runs `supabase.auth.getUser()` — a NETWORK ROUND TRIP to
 * Supabase Auth — before it decides anything about the path. So `/.env`,
 * `/wp-admin/`, `/phpmyadmin/` and every other line in a scanner's wordlist each
 * bought one Auth request, and a scanner walking ten thousand paths bought ten
 * thousand, against a free tier, from an unauthenticated stranger. That is the
 * finding recorded in hardening/probe-response.md on 2026-08-12.
 *
 * The fix is the pattern this file already uses twice: return BEFORE
 * `createServerClient`, exactly as the /@handle rewrite does, and exactly why
 * `.well-known` is kept out of the matcher rather than added to PUBLIC_PATHS.
 *
 * THE RISK THIS FILE EXISTS TO CATCH IS A FALSE POSITIVE. A denylist that
 * accidentally matches a real page turns it into a 404 for everyone, with no
 * error anywhere and nothing failing to compile. So the first test below walks
 * the actual app directory and asserts that no route PassControl really serves
 * is treated as a probe — a new page named unluckily fails here rather than in
 * production.
 */
const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** Every non-API route the app actually serves, with dynamic segments filled in. */
function realRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Route groups `(x)` do not appear in the URL; `@slot` is a parallel route.
        const seg = /^\(.*\)$/.test(entry.name)
          ? ""
          : entry.name.startsWith("[")
            ? "/sample-value"
            : `/${entry.name}`;
        walk(`${dir}/${entry.name}`, url + seg);
      } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
        out.push(url || "/");
      }
    }
  };
  walk("app", "");
  return [...new Set(out)].filter((p) => !p.startsWith("/api"));
}

/** Does this path even reach the middleware? The matcher excludes a lot. */
const matched = (pathname: string) =>
  middlewareConfig.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

describe("probe paths are recognised without an auth call", () => {
  it("never treats a route the app actually serves as a probe", () => {
    const routes = realRoutes();
    // Only guards against the walk silently finding nothing and the assertion
    // below passing on an empty list. Deliberately far below the real count
    // (38 private / 26 in the curated mirror, which serves a smaller set) so
    // that pruning a page never fails this test for a reason unrelated to the
    // property it exists to check.
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.filter((r) => isProbePath(r))).toEqual([]);
  });

  it("never treats the hand-written public paths or a profile handle as a probe", () => {
    for (const p of ["/", "/login", "/signup", "/verify", "/updates", "/learn", "/legal", "/u/someone", "/@someone", "/dashboard", "/auth/callback"]) {
      expect(isProbePath(p), `${p} must not be a probe path`).toBe(false);
    }
  });

  it("recognises the wordlist that actually shows up in the logs", () => {
    for (const p of [
      "/.env",
      "/.env.local",
      "/.git/config",
      "/.aws/credentials",
      "/.ssh/id_rsa",
      "/.DS_Store",
      "/wp-admin/",
      "/wp-login.php",
      "/wp-content/uploads/x.php",
      "/phpmyadmin/",
      "/xmlrpc.php",
      "/vendor/phpunit/phpunit/phpunit.xml",
      "/cgi-bin/test.cgi",
      "/backup.sql",
      "/site.bak",
      "/shell.asp",
    ]) {
      expect(isProbePath(p), `${p} should be a probe path`).toBe(true);
    }
  });

  it("never claims a value a stranger chose inside a real route", () => {
    // THE ROUTE WALK ABOVE IS BLIND TO THIS: it substitutes a tame
    // `sample-value` for every dynamic segment, so it cannot see a denylisted
    // extension arriving as user input. /verify/<passportId> hands an
    // UNCONSTRAINED segment to the public passport lookup — the one surface
    // whose whole job is answering strangers about ids we did not choose — so
    // an unanchored extension rule would 404 a legitimate lookup before the
    // page ever ran. Hence the root-segment anchor in PROBE_PATTERNS.
    for (const p of [
      "/verify/abc.old",
      "/verify/some-passport.conf",
      "/learn/getting-started.ini",
      "/u/someone.bak",
      "/dashboard/agents/x.sql",
    ]) {
      expect(isProbePath(p), `${p} is a real route with a hostile-looking value`).toBe(false);
    }
    // The anchor must not cost us the actual root-level junk it exists for.
    expect(isProbePath("/backup.sql")).toBe(true);
    expect(isProbePath("/shell.php")).toBe(true);
    // Deeper junk is still caught, by the prefix rule rather than the extension.
    expect(isProbePath("/wp-content/uploads/x.php")).toBe(true);
    expect(isProbePath("/cgi-bin/test.cgi")).toBe(true);
  });

  it("is case-insensitive, because scanners are not consistent", () => {
    expect(isProbePath("/WP-ADMIN/")).toBe(true);
    expect(isProbePath("/.ENV")).toBe(true);
  });

  it("only claims paths that reach the middleware at all", () => {
    // `.png` and friends are excluded by the matcher, so `/wp-admin/x.png`
    // never gets here. Pinning that keeps the denylist honest about its scope
    // rather than implying it covers requests it never sees.
    expect(matched("/wp-admin/")).toBe(true);
    expect(matched("/wp-admin/x.png")).toBe(false);
    expect(matched("/api/v1/openai/chat")).toBe(false);
  });
});

describe("the short-circuit happens before Supabase is ever contacted", () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  afterEach(() => {
    if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    if (key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = key;
  });

  it("answers a probe with 404 even with no Supabase configuration at all", async () => {
    // THIS IS THE ASSERTION THAT PROVES THE SAVING, and it is why the env is
    // torn out rather than mocked: if the auth call still ran, there would be
    // no client to run it with. A 404 here can only mean the request never got
    // that far. It is also the honest answer — /wp-admin is not a gated page,
    // and 307ing it to /login said it might be.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await middleware(new NextRequest("https://passcontrol.vertias.eu/wp-admin/"));
    expect(res.status).toBe(404);
    // No session cookie work happened on the way out.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still carries the nonce policy, so the gate's own contract is unchanged", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await middleware(new NextRequest("https://passcontrol.vertias.eu/.env"));
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
