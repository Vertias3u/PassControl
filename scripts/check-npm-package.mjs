#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const files = pack.files.map(({ path }) => path).sort();
const allowed = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "bin/passcontrol.mjs",
  "cli/config.mjs",
  "cli/sidecar.mjs",
]);
const unexpected = files.filter((file) => !allowed.has(file));
const missing = [...allowed].filter((file) => !files.includes(file));

if (unexpected.length || missing.length) {
  if (unexpected.length) console.error(`Unexpected npm package files:\n${unexpected.map((file) => `  - ${file}`).join("\n")}`);
  if (missing.length) console.error(`Missing npm package files:\n${missing.map((file) => `  - ${file}`).join("\n")}`);
  process.exit(1);
}

console.log(`✓ npm package allowlist verified (${files.length} files)`);
