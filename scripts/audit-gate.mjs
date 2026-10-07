#!/usr/bin/env node
// Push CI's dependency audit. Usage (CI sets the base):
//
//   AUDIT_BASE_SHA=<commit before this push> node scripts/audit-gate.mjs
//
// `npm audit` judges a lockfile against TODAY's advisories, so as a hard push
// gate it turned commits red that changed no dependency at all: 1.1.0, 1.2.0
// and 1.2.1 each failed on an advisory published after they were written. The
// red X then sat on a release commit that was not the cause, and the fix was a
// follow-up push whose only purpose was to repaint it.
//
// So this fails a push only when the push changed what gets installed, which is
// the part a push is answerable for. An advisory against dependencies the push
// did not touch is a warning here; .github/workflows/audit.yml audits `main`
// daily and opens an issue for it. If the base commit cannot be read (a new
// branch, a force push) the gate stays strict.
//
// "Changed what gets installed" deliberately excludes the `version` fields:
// every release bumps package.json and the lockfile root, and comparing the raw
// files would make every release commit strict again.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MANIFEST_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];

/** What a package.json + package-lock.json pair installs, without the project's own version. */
export function dependencySnapshot(packageJson, packageLock) {
  const pkg = JSON.parse(packageJson);
  const lock = JSON.parse(packageLock);
  const manifest = Object.fromEntries(MANIFEST_FIELDS.map((field) => [field, pkg[field] ?? null]));
  const installed = Object.entries(lock.packages ?? {})
    .filter(([path]) => path !== "")
    .map(([path, entry]) => `${path}@${entry.version ?? ""}`)
    .sort();
  return JSON.stringify({ manifest, installed });
}

export function dependenciesChanged(before, after) {
  return before !== after;
}

/**
 * changed: true or false when the base was readable, null when it was not.
 * Returns the exit code and the GitHub Actions annotation to print.
 */
export function auditVerdict({ auditPassed, changed }) {
  if (auditPassed) return { exitCode: 0, annotation: null };
  if (changed === false) {
    return {
      exitCode: 0,
      annotation:
        "::warning title=Dependency advisory::npm audit reports a high or critical advisory in dependencies this push did not change. " +
        "It was published after they were locked; the daily audit workflow tracks it as an issue. Update the dependency in its own commit.",
    };
  }
  return {
    exitCode: 1,
    annotation:
      changed === null
        ? "::error title=Dependency advisory::npm audit reports a high or critical advisory, and the commit before this push could not be read to tell whether the push introduced it."
        : "::error title=Dependency advisory::This push changes dependencies, and npm audit reports a high or critical advisory in what it installs.",
  };
}

function readBase(sha) {
  if (!sha || /^0+$/.test(sha)) return null;
  try {
    spawnSync("git", ["fetch", "--quiet", "--depth=1", "origin", sha], { stdio: "ignore" });
    const show = (file) => execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return dependencySnapshot(show("package.json"), show("package-lock.json"));
  } catch {
    return null;
  }
}

function main() {
  const audit = spawnSync("npm", ["audit", "--audit-level=high"], { stdio: "inherit" });
  const auditPassed = audit.status === 0;
  let changed = null;
  if (!auditPassed) {
    const before = readBase(process.env.AUDIT_BASE_SHA);
    if (before !== null) {
      const after = dependencySnapshot(readFileSync("package.json", "utf8"), readFileSync("package-lock.json", "utf8"));
      changed = dependenciesChanged(before, after);
    }
  }
  const verdict = auditVerdict({ auditPassed, changed });
  if (verdict.annotation) console.log(verdict.annotation);
  process.exit(verdict.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
