#!/usr/bin/env node
// Gate on the artifact that actually ships. Two independent checks:
//
//   1. The file list matches an allowlist — nothing sneaks into the tarball.
//   2. The declared dependencies and the scanned imports agree *in both
//      directions*.
//
// The second direction is the one worth having. A dependency nothing imports is
// invisible to every other check: 0.5.0 shipped `shadcn` — a scaffolding CLI no
// file references — and with it undici and five advisories. 0.5.1 shipped `next`,
// `react` and the whole dashboard for the same reason. Neither is a missing
// import, so nothing would ever fail; the package just quietly installs 563 MB.
//
// This runs against dist-cli, built by scripts/build-cli-package.mjs. Pointing it
// at the repo root instead would verify a tarball nobody publishes — the same
// mistake as `npm audit` passing in CI while a fresh install is red.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importedPackages } from "./build-cli-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "dist-cli"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!fs.existsSync(path.join(packageDir, "package.json"))) {
  console.error(`No package to check at ${packageDir}. Run \`npm run build:cli\` first.`);
  process.exit(1);
}

const allowed = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "bin/passcontrol.mjs",
  "cli/config.mjs",
  // Imported by the workspace recovery commands. Keeping it explicit here
  // makes the package gate cover the same helper the executable loads.
  "cli/workspace-import-report.mjs",
  // Verification is deliberately shipped in the CLI: `passcontrol verify` is the
  // one command a stranger runs against someone else's deployment, so it must
  // work from a bare `npm i -g passcontrol` with no config and no account.
  "cli/instance-key.mjs",
  // The version capability matrix is imported by both the standalone verifier
  // and compiled SDK verifier; omitting it makes receipt verification fail only
  // after installation.
  "cli/protocols.mjs",
  "cli/protocols.d.mts",
  "cli/verify.mjs",
  "cli/mcp/gateway.mjs",
  "cli/mcp/integration.mjs",
  "cli/mcp/README.md",
  "cli/mcp/server.mjs",
  "cli/presets.mjs",
  // The sidecar's destination policy. Ships because the sidecar refuses to load
  // without it, and because it is the file that decides which hosts a proxied
  // agent may reach — the reviewable half of "PassControl is not an open proxy".
  "cli/proxy-policy.mjs",
  "cli/sidecar.mjs",
  // bin/passcontrol.mjs imports this on every run, so a missing file is not a
  // degraded update notice — it is an install that cannot start at all.
  "cli/update-check.mjs",
  "cli/visa-client.mjs",
  "sdk/README.md",
  "sdk/control.d.ts",
  "sdk/control.js",
  // Internal, and unreachable through the exports map — but it carries the
  // bare-origin rule both credential-bearing clients import, so it must be in
  // the tarball or the published SDK cannot load at all.
  "sdk/gateway.d.ts",
  "sdk/gateway.js",
  "sdk/index.d.ts",
  "sdk/index.js",
  "sdk/passcontrol.d.ts",
  "sdk/passcontrol.js",
  "sdk/verify.d.ts",
  "sdk/verify.js",
]);

const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd: packageDir, encoding: "utf8" }));
const files = pack.files.map(({ path: file }) => file).sort();

const problems = [];
const unexpected = files.filter((file) => !allowed.has(file));
const missing = [...allowed].filter((file) => !files.includes(file));
if (unexpected.length) problems.push(`Unexpected npm package files:\n${unexpected.map((f) => `  - ${f}`).join("\n")}`);
if (missing.length) problems.push(`Missing npm package files:\n${missing.map((f) => `  - ${f}`).join("\n")}`);

// npm renders the packaged README, not the full repository tree. A relative
// link to docs/ or examples/ can therefore pass every file/dependency check and
// still send the first installer to a 404. Relative targets are allowed only
// when the referenced file or directory is actually present in the artifact.
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
for (const markdownFile of files.filter((file) => file.endsWith(".md"))) {
  const markdown = fs.readFileSync(path.join(packageDir, markdownFile), "utf8");
  for (const [, target] of markdown.matchAll(markdownLink)) {
    if (target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const clean = target.replace(/^\.\//u, "").split(/[?#]/u, 1)[0];
    const resolved = path.resolve(packageDir, path.dirname(markdownFile), clean);
    const withinPackage = resolved === packageDir || resolved.startsWith(`${packageDir}${path.sep}`);
    if (!withinPackage || !fs.existsSync(resolved)) {
      problems.push(`Broken relative link in npm artifact: ${markdownFile} -> ${target}`);
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
const declared = Object.keys(manifest.dependencies ?? {}).sort();
const imported = importedPackages(files, packageDir);

const undeclared = imported.filter((name) => !declared.includes(name));
const unused = declared.filter((name) => !imported.includes(name));
if (undeclared.length) {
  problems.push(`Imported but not declared (the package would crash on use):\n${undeclared.map((n) => `  - ${n}`).join("\n")}`);
}
if (unused.length) {
  problems.push(`Declared but never imported (every installer downloads these for nothing):\n${unused.map((n) => `  - ${n}`).join("\n")}`);
}

// The dashboard's runtime has no business in a CLI tarball, and these are the
// packages that dragged the advisories in. Named explicitly so the failure says
// what went wrong rather than just "unused".
const APP_ONLY = ["next", "react", "react-dom", "@sentry/nextjs", "sharp", "postcss", "shadcn"];
const leaked = APP_ONLY.filter((name) => declared.includes(name));
if (leaked.length) {
  problems.push(`Dashboard-only packages in the CLI manifest:\n${leaked.map((n) => `  - ${n}`).join("\n")}`);
}

if (manifest.scripts) {
  problems.push("The published manifest must declare no scripts — the root's prepublishOnly guard would block its own publish.");
}
if (manifest.type !== "module" || manifest.exports?.["./sdk"]?.import !== "./sdk/index.js" || manifest.exports?.["./sdk"]?.types !== "./sdk/index.d.ts") {
  problems.push("The generated manifest must expose the compiled ESM SDK and its declarations at passcontrol/sdk.");
}

if (problems.length) {
  console.error(problems.join("\n\n"));
  process.exit(1);
}

console.log(`✓ npm package verified — ${files.length} files, ${declared.length} dependencies (${declared.join(", ")})`);
