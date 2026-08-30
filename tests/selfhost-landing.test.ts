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

describe("self-host landing replacement", () => {
  it("exists as a standalone replacement without changing the active home route", async () => {
    await expect(resolvePage()).resolves.toBeInstanceOf(URL);
    expect(await source()).toContain('import styles from "./home.module.css"');
  });

  it("is safe to statically prerender", async () => {
    const page = await source();

    for (const serverOnlyDependency of [
      '"use client"',
      "force-dynamic",
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

  it("points readers at the documented local stack", async () => {
    const page = await source();

    expect(page).toContain("npm install -g passcontrol");
    expect(page).toContain("passcontrol setup");
    expect(page).toContain("Docker Desktop");
    expect(page).toContain("Supabase CLI");
    expect(page).toContain("Node 18+");
  });

  it("allows exactly one absolute hosted alternative without becoming a signup funnel", async () => {
    const page = (await source()).toLowerCase();
    const hostedOrigin = "https://passcontrol.vertias.eu";

    expect(page.match(new RegExp(hostedOrigin, "g"))).toHaveLength(1);
    expect(page).toContain(`href="${hostedOrigin}/beta"`);
    expect(page).not.toMatch(/href=["']\/(?:beta|updates|legal)(?:[/?#"'])/);
    expect(page).not.toMatch(/href=["']\/\/passcontrol\.vertias\.eu/);
    expect(page.match(/invite-only/g)).toHaveLength(1);
    expect(page).not.toMatch(/sign[ -]?up|request (?:an )?invite|join (?:the )?beta/);
    expect(page).toContain("passcontrol cloud");
    expect(page).toContain("postgres, redis, or migrations");
    expect(page).toContain("permanent public issuer");
  });

  it("describes the core control boundary", async () => {
    const page = await source();

    for (const invariant of [
      "provider keys stay server-side",
      "identity",
      "scope",
      "budget",
      "kill",
      "receipt",
    ]) {
      expect(page.toLowerCase()).toContain(invariant);
    }
  });
});
