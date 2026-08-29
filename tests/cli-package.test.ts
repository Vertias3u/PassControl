import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import { build, importedPackages, packageOf, rewriteNpmReadmeLinks, shippedFiles } from "../scripts/build-cli-package.mjs";

// The published CLI has now shipped the same defect twice from two different
// causes, and neither was visible to any check that existed:
//
//   0.5.0 declared `shadcn` — a scaffolding CLI nothing imports — which pulled
//   undici and five advisories into every install.
//   0.5.1 declared `next`, `react`, `@sentry/nextjs` and the rest of the
//   dashboard, because the app's manifest and the CLI's were the same file. A
//   fresh `npm i -g passcontrol` resolved 215 packages and 563 MB to run 14 files.
//
// Both are *unused* dependencies, so no import ever fails and no test ever goes
// red. They also shipped postcss and sharp advisories this repo cannot observe:
// `overrides` pins them here, and npm honours overrides only from the root
// project — so `npm audit` is green in CI and red for anyone who installs.
//
// The gate is therefore bidirectional. "Every import is declared" catches a
// broken package; "every declaration is imported" catches this.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const rootManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("the CLI package is built from the shipped files, not the app manifest", () => {
  const built = build();
  const manifest = JSON.parse(readFileSync(`${built.outDir}/package.json`, "utf8"));

  it("declares only what the shipped files import", () => {
    const imported = importedPackages(shippedFiles(built.outDir), built.outDir);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(imported);
  });

  it("carries none of the dashboard runtime", () => {
    for (const app of ["next", "react", "react-dom", "@sentry/nextjs", "shadcn", "sharp", "postcss"]) {
      expect(manifest.dependencies).not.toHaveProperty(app);
    }
    // The root still needs them — this is a second manifest, not a removal.
    expect(rootManifest.dependencies).toHaveProperty("next");
  });

  it("resolves subpath imports to the package npm actually installs", () => {
    expect(packageOf("zod/v4")).toBe("zod");
    expect(packageOf("@modelcontextprotocol/sdk/server/mcp.js")).toBe("@modelcontextprotocol/sdk");
    expect(packageOf("jose")).toBe("jose");
  });

  it("copies dependency ranges verbatim from the root rather than inventing them", () => {
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(range).toBe(rootManifest.dependencies[name]);
    }
  });

  it("ships no scripts — a copied prepublishOnly would block its own publish", () => {
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    // overrides are inert in a dependency anyway; leaving them in would imply a
    // protection the installer does not get.
    expect(manifest.overrides).toBeUndefined();
  });

  it("keeps the identity npm needs to publish and resolve it", () => {
    expect(manifest.name).toBe(rootManifest.name);
    expect(manifest.version).toBe(rootManifest.version);
    expect(manifest.bin).toEqual(rootManifest.bin);
    expect(manifest.license).toBe(rootManifest.license);
    expect(manifest.engines).toEqual(rootManifest.engines);
    expect(manifest.type).toBe("module");
    expect(manifest.exports["./sdk"]).toEqual({
      types: "./sdk/index.d.ts",
      import: "./sdk/index.js",
    });
  });

  it("adds only the compiled SDK surface to the root CLI packlist", () => {
    const rootFiles = shippedFiles(repoRoot);
    const builtFiles = shippedFiles(built.outDir);
    expect(builtFiles.filter((file: string) => !rootFiles.includes(file))).toEqual([
      "sdk/README.md",
      "sdk/control.d.ts",
      "sdk/control.js",
      "sdk/gateway.d.ts",
      "sdk/gateway.js",
      "sdk/index.d.ts",
      "sdk/index.js",
      "sdk/passcontrol.d.ts",
      "sdk/passcontrol.js",
      "sdk/verify.d.ts",
      "sdk/verify.js",
    ]);
  }, 15000);

  // ── What `build:cli` prints (was F9) ──────────────────────────────────────
  //
  // The returned count used to be the ROOT packlist that merely seeded the build,
  // so the console line under-reported the artifact by everything added after that
  // list — the whole compiled SDK. An operator reading "14 files" against a release
  // gate counting 23 has no way to tell a build bug from a stale number.
  //
  // Equality with the root packlist is precisely the reverted state, so the
  // inequality is the regression that matters, not the absolute number.
  it("reports the artifact's own file count, not the root packlist that seeded it", () => {
    const onDisk: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else onDisk.push(relative(built.outDir, full).split(sep).join("/"));
      }
    };
    walk(built.outDir);

    expect(built.files.slice().sort()).toEqual(onDisk.sort());
    expect(built.files.length).toBeGreaterThan(shippedFiles(repoRoot).length);
    // package.json is written into the artifact, never copied from the root list.
    expect(built.files).toContain("package.json");
  }, 15000);

  // ── What the manifest exposes (was F10) ───────────────────────────────────
  //
  // Declaring ANY exports map makes every unlisted subpath unreachable, so the
  // map is the whole public surface. `./package.json` is listed because bundlers,
  // version probes and license scanners read it routinely and the registry
  // publishes it anyway; withholding it only breaks tooling.
  it("exports ./package.json alongside the SDK, and nothing else", () => {
    expect(manifest.exports["./package.json"]).toBe("./package.json");
    // Recorded deliberately: the root entry point and the CLI internals are NOT
    // importable subpaths. The CLI is consumed through `bin`, not through an
    // import, and no root export has ever been documented — so adding "." here to
    // make an old report's wording true would create a support surface, not fix one.
    expect(Object.keys(manifest.exports).sort()).toEqual(["./package.json", "./sdk"]);
    // (asserted by key, not toHaveProperty — "." reads as a property PATH there)
    expect(Object.keys(manifest.exports)).not.toContain(".");
    expect(manifest.main).toBeUndefined();
    expect(manifest.bin).toEqual(rootManifest.bin);
  });

  it("ships a runtime-importable SDK rather than repository-only TypeScript", async () => {
    const sdk = await import(new URL(`file://${built.outDir}/sdk/index.js`).href);
    expect(typeof sdk.PassControl).toBe("function");
    expect(typeof sdk.verifyReceipt).toBe("function");
    expect(shippedFiles(built.outDir).some((file: string) => file.endsWith(".ts") && !file.endsWith(".d.ts"))).toBe(false);
  });

  // The gateway boundary has to hold in the ARTIFACT, not just in the repository
  // TypeScript the suite normally imports. `passcontrol/sdk` resolves to the
  // compiled `sdk/index.js` below; a stale or wrongly-compiled dist would ship an
  // installable ControlClient that still hands a `pc_` key to a cleartext host.
  it("enforces the ControlClient gateway boundary in the package that ships", async () => {
    // Resolved through the manifest's own `./sdk` export, so this cannot pass by
    // importing a file the published package does not actually point at.
    const sdk = await import(new URL(manifest.exports["./sdk"].import, `file://${built.outDir}/`).href);
    const seen: string[] = [];
    const authorization: (string | null)[] = [];
    const transport = async (url: string, init: any = {}) => {
      seen.push(String(url));
      authorization.push(new Headers(init?.headers ?? {}).get("authorization"));
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const fakeKey = `pc_${"f".repeat(40)}`;

    for (const gateway of [
      "http://gateway.example",
      "https://trusted.example@attacker.example",
      "https://gw.example.com/control",
    ]) {
      expect(() => new sdk.ControlClient({ gateway, apiKey: fakeKey, fetch: transport })).toThrow(
        /bare HTTPS origin/
      );
    }
    expect(seen).toEqual([]); // refused before the transport was ever reached

    const client = new sdk.ControlClient({
      gateway: "https://gw.example.com",
      apiKey: fakeKey,
      fetch: transport,
    });
    await client.agents.list({ status: "active" });
    expect(seen).toEqual(["https://gw.example.com/api/control/v1/agents?status=active"]);
    expect(authorization).toEqual([`Bearer ${fakeKey}`]);
  });

  it("rewrites repository-only README links instead of publishing package 404s", () => {
    const readme = readFileSync(`${built.outDir}/README.md`, "utf8");
    expect(readme).toContain(
      "https://github.com/Vertias3u/PassControl/blob/main/docs/integrations/hermes.md",
    );
    expect(readme).toContain(
      "https://github.com/Vertias3u/PassControl/blob/main/docs/deployment/cloudflare.md",
    );
    expect(readme).not.toMatch(/\]\((?:\.\/)?docs\//u);
    expect(readme).toContain("](./LICENSE)");
  });

  // npmjs.com renders this file, and for a CLI it is the busiest page the project
  // has. It used to be the root README.md — the PRIVATE repo's front page — so npm
  // got a second copy of the pitch that no guard compared to anything, and it
  // drifted: no kill-switch GIF, no tutorial link, and two of the six providers
  // the public page advertises. Nothing was broken, so nothing went red.
  //
  // Equality against the rewritten public README is the whole property: npm and
  // GitHub render one document, and there is no second copy left to drift.
  it("publishes the same document the public repository does", () => {
    const readme = readFileSync(`${built.outDir}/README.md`, "utf8");
    // Two-name fallback, as docs-integrations.test.ts documents: the source is
    // PUBLIC_README.md here and README.md inside the curated mirror, where
    // curate-public.sh has already renamed it. This file ships, so reading the
    // private name unconditionally would pass here and throw ENOENT publicly —
    // the exact way the mirror's suite has gone red twice before.
    const publicSource = ["../PUBLIC_README.md", "../README.md"].reduce<string | null>(
      (found, candidate) => {
        if (found !== null) return found;
        try {
          return readFileSync(new URL(candidate, import.meta.url), "utf8");
        } catch {
          return null;
        }
      },
      null,
    );
    if (publicSource === null) throw new Error("neither PUBLIC_README.md nor README.md exists — the guard is not reading anything");

    expect(
      readme,
      "the npm README is no longer the public README — npm and GitHub have drifted apart again",
    ).toEqual(rewriteNpmReadmeLinks(publicSource, repoRoot, built.outDir));

    // Named individually so a failure says which asset the npm page lost, not
    // merely that two long strings differ.
    expect(readme, "the npm page lost the kill-switch GIF").toContain(
      "https://raw.githubusercontent.com/Vertias3u/PassControl/main/docs/demo/kill-switch.gif",
    );
    expect(readme, "the npm page lost its link to the tutorial").toContain(
      "https://github.com/Vertias3u/PassControl/blob/main/TUTORIAL.md",
    );
  });
});

describe("the release path cannot fall back to the app manifest", () => {
  it("refuses a publish from the repo root", () => {
    expect(() => execFileSync(npm, ["publish", "--dry-run"], { cwd: repoRoot, encoding: "utf8", stdio: "pipe" })).toThrow(
      /release:cli/
    );
  });

  it("checks the built package, not the repo root", () => {
    expect(rootManifest.scripts["check:npm-pack"]).toContain("build:cli");
    expect(rootManifest.scripts["release:cli"]).toContain("dist-cli");
  });
});
