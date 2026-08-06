import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import { build, importedPackages, packageOf, shippedFiles } from "../scripts/build-cli-package.mjs";

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
  });

  it("stages the same file list the root allowlist produces", () => {
    expect(shippedFiles(built.outDir)).toEqual(shippedFiles(repoRoot));
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
