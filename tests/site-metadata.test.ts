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

  // The documentation half of the same rule, and it went wrong the way the code
  // half already had: every public doc opened with "PassControl 0.9.0", pinned
  // `npm install -g passcontrol@0.9.0`, and described behaviour "in 0.9.0" — three
  // releases after 0.9.0. Markdown cannot import lib/version.ts, so the fix is to
  // stop naming a version at all rather than to name a newer one: an unpinned
  // install command and an unversioned title are true in every release.
  //
  // Only two shapes are pinned, deliberately. A blanket x.y.z sweep over these
  // files would flag 127.0.0.1 and every image tag, and a guard that cries wolf
  // gets deleted.
  const VERSIONED_DOCS = [
    "README.md",
    "DOCUMENTATION.md",
    "TUTORIAL.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/budget-recovery.md",
    "docs/integrations/hermes.md",
    "docs/integrations/passport-sdk.md",
    "docs/demo/README.md",
    "docs/deployment/cloudflare.md",
  ];

  it.each(VERSIONED_DOCS)("pins no npm version in %s", async (path) => {
    expect((await source(path)).match(/passcontrol@\d+\.\d+\.\d+/g)).toBeNull();
  });

  // `docs/statement-format.md` is deliberately absent from this list. Its
  // "shipped with PassControl 0.9.0" records WHEN the wire format was introduced,
  // which is a fact about the past and must not float forward with the version.
  it.each(VERSIONED_DOCS)("does not stamp a version onto the product name in %s", async (path) => {
    expect((await source(path)).match(/PassControl\s+\**v?\d+\.\d+\.[\dx]+/g)).toBeNull();
  });

  // A spec's info.version has to be a literal, so this is the one place a number
  // is typed by hand — and therefore the one place that needs a test saying it
  // still agrees with package.json. It had drifted three releases.
  it("keeps openapi.yaml's info.version equal to the package version", async () => {
    const declared = (await source("openapi.yaml")).match(/^\s+version:\s*"([^"]+)"/mu)?.[1];
    expect(declared).toBe(await pkgVersion());
  });
});

