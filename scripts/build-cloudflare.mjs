#!/usr/bin/env node

// OpenNext for Cloudflare currently rejects Next routes explicitly marked with
// `runtime = "edge"`, while PassControl intentionally keeps those declarations
// for its existing Vercel deployment. Build in an isolated source copy and
// remove only that runtime hint there. The committed source and its Vercel
// behavior are never mutated.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep the copy immediately below the repository, but without its own lockfile.
// OpenNext then treats the real repository as the monorepo/tracing root and can
// trace the shared node_modules without copying or mutating it.
const tempRoot = fs.mkdtempSync(path.join(repoRoot, ".cloudflare-build-"));

const SOURCE_DIRS = ["app", "cli", "components", "lib", "sdk"];
const MIGRATION_DIR = "db/migrations";
const ROOT_FILES = [
  "components.json",
  "middleware.ts",
  "next.config.mjs",
  "open-next.config.ts",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "wrangler.jsonc",
];

function copy(relativePath) {
  fs.cpSync(path.join(repoRoot, relativePath), path.join(tempRoot, relativePath), {
    recursive: true,
  });
}

function stripEdgeRuntime(directory) {
  let changed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      changed += stripEdgeRuntime(absolute);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const source = fs.readFileSync(absolute, "utf8");
    const transformed = source.replace(
      /^export const runtime\s*=\s*["']edge["'];?\s*$/gm,
      "// Cloudflare build copy: use OpenNext's Node-compatible Workers runtime."
    );
    if (transformed !== source) {
      fs.writeFileSync(absolute, transformed);
      changed += 1;
    }
  }
  return changed;
}

try {
  for (const directory of SOURCE_DIRS) copy(directory);
  // next.config.mjs freezes exact migration bytes at build time, so the
  // isolated source must carry them too. Copy only migrations, never DB dumps
  // or test fixtures.
  copy(MIGRATION_DIR);
  for (const file of ROOT_FILES) copy(file);
  const transformedRoutes = stripEdgeRuntime(tempRoot);
  if (transformedRoutes === 0) {
    throw new Error("Cloudflare build transform found no Edge runtime declarations.");
  }

  console.log(
    `→ Cloudflare compatibility build: ${transformedRoutes} source files transformed in an isolated copy`
  );
  const adapter = path.join(
    repoRoot,
    "node_modules",
    "@opennextjs",
    "cloudflare",
    "dist",
    "cli",
    "index.js"
  );
  const result = spawnSync(process.execPath, [adapter, "build"], {
    cwd: tempRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const output = path.join(repoRoot, ".open-next");
    fs.rmSync(output, { recursive: true, force: true });
    fs.cpSync(path.join(tempRoot, ".open-next"), output, { recursive: true });
    console.log("✓ Cloudflare Worker bundle copied to .open-next/; committed source unchanged");
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
