import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The page is app/page.selfhost.tsx here and app/page.tsx in the curated public
// repo — scripts/curate-public.sh renames it into the home route on the way out,
// which is the only place it is ever served. So it is named by both, and the
// order is load-bearing: BOTH files exist privately, and the private page.tsx is
// the hosted site, which fails every assertion below. Same reason and same shape
// as the PUBLIC_README.md / README.md fallback in tests/docs-integrations.test.ts.
const CANDIDATES = ["app/page.selfhost.tsx", "app/page.tsx"] as const;

async function resolvePage(): Promise<URL> {
  for (const candidate of CANDIDATES) {
    const url = new URL(`../${candidate}`, import.meta.url);
    try {
      await access(url);
      return url;
    } catch {
      continue;
    }
  }
  throw new Error(`none of ${CANDIDATES.join(" / ")} exists — this guard is reading nothing`);
}

async function source(): Promise<string> {
  return readFile(await resolvePage(), "utf8");
}

// Self-host is one developer on localhost:3000 (owner, 2026-10-05). Whoever opens
// `/` already installed PassControl to get there, so a marketing page telling them
// how to install it was clutter. The home route goes straight to the Control
// Tower; middleware sends a signed-out visitor on to /login from there.
describe("self-host home route", () => {
  it("redirects to the Control Tower instead of rendering a landing page", async () => {
    const page = await source();

    expect(page).toContain('import { redirect } from "next/navigation"');
    expect(page).toContain('redirect("/dashboard")');
    expect(page).not.toContain("home.module.css");
    expect(page).not.toContain("npm install -g passcontrol");
  });

  it("stays free of request-time dependencies", async () => {
    const page = await source();

    for (const serverOnlyDependency of [
      '"use client"',
      "next/headers",
      "cookies(",
      "headers(",
      "getUser(",
      "createServerClient",
      "process.env",
      "PassControlSiteClient",
    ]) {
      expect(page).not.toContain(serverOnlyDependency);
    }
  });
});
