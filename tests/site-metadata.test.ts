import { readFile, access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Launch-surface guard. The og/twitter card is how every share on HN, X, Slack and
// LinkedIn renders, and it is invisible in local dev — you only find out it is wrong
// after you have posted the link.
//
// These assert on source text rather than importing the modules: `app/layout.tsx` and
// `app/page.tsx` are JSX, and tsconfig sets `jsx: "preserve"` for Next's compiler, so
// the test runner cannot parse them without a bundler plugin. Pinning the two literals
// that actually regressed is worth more here than the extra dependency.
async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("site metadata (social card surface)", () => {
  it("resolves relative metadata against the production origin", async () => {
    expect(await source("app/layout.tsx")).toContain(
      'metadataBase: new URL("https://passcontrol.vertias.eu")'
    );
  });

  // The regression this file exists for: a page-level `twitter` block replaces the
  // root layout's wholesale, so a card type set correctly in the layout can still
  // ship as the wrong one. The attached image is 1200x630 — `summary` renders it as
  // a thumbnail and wastes the asset.
  it("requests a large twitter card on the page that owns the card image", async () => {
    const home = await source("app/page.tsx");
    expect(home).toContain('card: "summary_large_image"');
    expect(home).not.toContain('card: "summary"');
  });

  it("does not let the home page override the layout down to a small card", async () => {
    const [layout, home] = await Promise.all([source("app/layout.tsx"), source("app/page.tsx")]);
    const cardOf = (s: string) => s.match(/card:\s*"([a-z_]+)"/)?.[1];
    expect(cardOf(home)).toBe(cardOf(layout));
  });

  // File-convention images: nothing imports them, so a rename or an accidental delete
  // would otherwise surface only as a silently image-less card after launch.
  it.each(["app/opengraph-image.png", "app/twitter-image.png"])(
    "ships the %s card image the metadata depends on",
    async (path) => {
      await expect(access(new URL(`../${path}`, import.meta.url))).resolves.toBeUndefined();
    }
  );

  it.each(["app/opengraph-image.alt.txt", "app/twitter-image.alt.txt"])(
    "ships non-empty alt text for %s",
    async (path) => {
      expect((await source(path)).trim().length).toBeGreaterThan(20);
    }
  );

  it.each(["app/opengraph-image.png", "app/twitter-image.png"])(
    "keeps %s at the standard 1200x630 social-card size",
    async (path) => {
      const png = await readFile(new URL(`../${path}`, import.meta.url));
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
    }
  );

  it("ships browser and Apple icon assets through Next's metadata file conventions", async () => {
    for (const path of ["app/favicon.ico", "app/icon.svg", "app/apple-icon.png"]) {
      await expect(access(new URL(`../${path}`, import.meta.url))).resolves.toBeUndefined();
    }

    const apple = await readFile(new URL("../app/apple-icon.png", import.meta.url));
    expect(apple.readUInt32BE(16)).toBe(180);
    expect(apple.readUInt32BE(20)).toBe(180);
  });
});

// Every public version string was typed by hand, so they drifted independently: at
// package 0.4.0 the JSON-LD said 0.2.0, the FAQ said v0.2.x, the footer said v0.1.x,
// and the MCP server announced 0.2.0 to its clients. They all render from one source
// now; these tests fail if a literal grows back.
describe("advertised version", () => {
  const pkgVersion = async () => JSON.parse(await source("package.json")).version as string;

  it("derives both public forms from package.json", async () => {
    const { RELEASE_VERSION, RELEASE_SERIES } = await import("../lib/version");
    const version = await pkgVersion();
    expect(RELEASE_VERSION).toBe(version);
    expect(RELEASE_SERIES).toBe(`v${version.split(".").slice(0, 2).join(".")}.x`);
  });

  // A bare x.y.z / vx.y.z anywhere in these files means someone typed a version again.
  // (The CLI side of this lives in cli/__tests__/version.test.mjs — importing an
  // untyped .mjs from a .ts test breaks `tsc --noEmit`.)
  it.each(["app/page.tsx", "app/llms.txt/route.ts", "cli/mcp/server.mjs"])(
    "hardcodes no version literal in %s",
    async (path) => {
      expect((await source(path)).match(/\bv?\d+\.\d+\.[\dx]+\b/g)).toBeNull();
    }
  );
});
