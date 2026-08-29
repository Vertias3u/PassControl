#!/usr/bin/env node
// Builds the npm artifact for the CLI into dist-cli/.
//
// The root package.json is the Next.js app's manifest: Vercel builds from it, so
// `next`, `react`, `react-dom`, `@sentry/nextjs` and the rest have to be real
// runtime dependencies there. But the published tarball is 14 files that import
// five packages, and npm installs a package's *declared* dependencies whether or
// not anything reaches them — so `npm i -g passcontrol` was pulling 215 packages
// and 563 MB of dashboard to run a CLI.
//
// Worse, it shipped advisories this repo cannot see. postcss and sharp are pinned
// here by `overrides`, and npm honours overrides only from the *root* project — so
// `npm audit` is green in CI and red for anyone who installs. One manifest cannot
// be both the app's and the CLI's; this generates the second one.
//
// The dependency list is derived, never typed: scanned out of the files that are
// actually in the tarball, cross-checked in both directions by
// scripts/check-npm-package.mjs. That reverse direction is the one that catches
// the next `shadcn` — a dependency nothing imports.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "dist-cli");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tsc = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const publicRepoBase = "https://github.com/Vertias3u/PassControl";

// The single source of truth for "what ships": npm's own file resolution against
// the root `files` allowlist. Re-deriving it from a glob here would let the
// tarball and the scanner disagree, which is the whole class of bug being fixed.
export function shippedFiles(cwd = repoRoot) {
  const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd, encoding: "utf8" }));
  return pack.files.map(({ path: file }) => file).sort();
}

// `zod/v4` and `@modelcontextprotocol/sdk/server/mcp.js` are subpaths of one
// package each; npm installs the package, not the subpath.
export function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const BARE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'.][^"']*)["']/g;

export function importedPackages(files, cwd = repoRoot) {
  const found = new Set();
  for (const file of files) {
    if (!/\.(m?js|cjs|ts)$/.test(file)) continue;
    const source = fs.readFileSync(path.join(cwd, file), "utf8");
    for (const [, specifier] of source.matchAll(BARE_IMPORT)) {
      if (specifier.startsWith("node:")) continue;
      found.add(packageOf(specifier));
    }
  }
  return [...found].sort();
}

function filesBelow(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    return entry.isDirectory()
      ? filesBelow(root, absolute)
      : [path.relative(root, absolute).split(path.sep).join("/")];
  }).sort();
}

/** npm ships a deliberately tiny CLI artifact, while the public README also
 * links to app docs, examples and source files that are not in that tarball.
 * Turn only those absent relative targets into stable public-repository URLs;
 * links such as ./LICENSE that really ship stay local to the package. */
export function rewriteNpmReadmeLinks(readme, sourceRoot = repoRoot, packageRoot = outDir) {
  return readme.replace(/(!?\[[^\]]*\]\()((?:\.\/)?[^)#\s][^)]*?)(\))/gu, (whole, prefix, rawTarget, suffix) => {
    const target = rawTarget.trim();
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) return whole;

    const clean = target.replace(/^\.\//u, "").split(/[?#]/u, 1)[0];
    if (!clean || clean.startsWith("../")) return whole;
    if (fs.existsSync(path.join(packageRoot, clean))) return whole;

    const sourcePath = path.join(sourceRoot, clean);
    if (!fs.existsSync(sourcePath)) return whole;
    const encodedPath = clean.split("/").map(encodeURIComponent).join("/");
    if (prefix.startsWith("!")) {
      return `${prefix}https://raw.githubusercontent.com/Vertias3u/PassControl/main/${encodedPath}${suffix}`;
    }
    const view = fs.statSync(sourcePath).isDirectory() ? "tree" : "blob";
    return `${prefix}${publicRepoBase}/${view}/main/${encodedPath}${suffix}`;
  });
}

// Field-by-field from an explicit allowlist, never a spread-and-delete. Copying
// `scripts` wholesale would carry the root's own prepublishOnly guard into the
// staged manifest and the real publish would refuse itself.
const CARRIED_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "homepage",
  "repository",
  "bugs",
  "keywords",
  "engines",
  "publishConfig",
  "bin",
];

function build() {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const files = shippedFiles();

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of files) {
    if (file === "package.json") continue;
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), target);
  }

  // The repository SDK is TypeScript source and is deliberately absent from
  // the root app packlist. Compile it into the generated package so external
  // users receive runnable ESM plus declarations, never raw .ts files.
  execFileSync(tsc, ["-p", "tsconfig.sdk.json"], { cwd: repoRoot, stdio: "inherit" });
  fs.copyFileSync(path.join(repoRoot, "sdk", "README.md"), path.join(outDir, "sdk", "README.md"));

  // npm renders the packaged README, so it must be the SAME document GitHub
  // shows: PUBLIC_README.md, which curate-public.sh publishes as the mirror's
  // README.md. The root README.md is the PRIVATE repo's front page, and shipping
  // that one gave npm a second, unguarded copy of the pitch — which drifted. It
  // lost the kill-switch GIF, the tutorial link, and four of the six providers
  // the public page advertises, on the highest-traffic page a CLI has.
  //
  // Named by both spellings for the same reason check-release-integrity.mjs is:
  // this script ships publicly, and inside the mirror the file has already been
  // renamed to README.md, where the copy is a no-op.
  const readmePath = path.join(outDir, "README.md");
  const publicReadme = path.join(repoRoot, "PUBLIC_README.md");
  if (fs.existsSync(publicReadme)) fs.copyFileSync(publicReadme, readmePath);
  fs.writeFileSync(
    readmePath,
    rewriteNpmReadmeLinks(fs.readFileSync(readmePath, "utf8"), repoRoot, outDir),
  );

  const artifactFiles = filesBelow(outDir);
  const needed = importedPackages(artifactFiles, outDir);
  const dependencies = {};
  const missing = [];
  for (const name of needed) {
    const range = rootManifest.dependencies?.[name];
    // A scanned import with no entry in the root manifest would otherwise ship as
    // an omitted dependency — a package that installs cleanly and crashes on use.
    if (!range) missing.push(name);
    else dependencies[name] = range;
  }
  if (missing.length) {
    throw new Error(
      `Shipped files import packages the root manifest does not declare:\n${missing.map((n) => `  - ${n}`).join("\n")}`
    );
  }

  const manifest = {};
  for (const field of CARRIED_FIELDS) {
    if (rootManifest[field] !== undefined) manifest[field] = rootManifest[field];
  }
  manifest.type = "module";
  manifest.exports = {
    "./sdk": {
      types: "./sdk/index.d.ts",
      import: "./sdk/index.js",
    },
    // Declaring any `exports` map makes every other subpath unreachable, including
    // this one. Bundlers, version probes and license scanners read it routinely, and
    // withholding it buys nothing — the manifest is public on the registry anyway.
    "./package.json": "./package.json",
  };
  manifest.dependencies = dependencies;

  fs.writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Report what the ARTIFACT contains, not the root packlist that seeded it — the
  // compiled SDK is added after that list and the difference is most of the gap
  // between "14 files" and the 23 the release gate counts.
  return { files: filesBelow(outDir), dependencies, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { files, dependencies } = build();
  const names = Object.keys(dependencies);
  console.log(`✓ built dist-cli (${files.length} files, ${names.length} dependencies: ${names.join(", ")})`);
}

export { build, outDir, repoRoot };
