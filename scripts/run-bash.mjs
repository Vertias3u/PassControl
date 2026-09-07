#!/usr/bin/env node
// Run a bash script through a bash that actually exists.
//
//   node scripts/run-bash.mjs scripts/dev-stack.sh [args…]
//
// On macOS and Linux this is a thin passthrough to `bash` on PATH. It exists for
// Windows, where `bash` on PATH is usually NOT a shell:
//
//   C:\Users\…\AppData\Local\Microsoft\WindowsApps\bash.exe   ← Store alias stub
//   C:\Windows\System32\bash.exe                              ← the WSL launcher
//   C:\Program Files\Git\usr\bin\bash.exe                     ← the real one, third
//
// The first two shadow Git Bash in the default PATH order, and the WSL launcher
// fails with `execvpe(/bin/bash) failed: No such file or directory` when no
// distro is installed — an error that names bash and says nothing about WSL, so
// it reads as a broken script rather than a wrong interpreter.
//
// Hence: probe candidates and EXECUTE each one. A `where bash` / existsSync
// check passes on exactly the machine this was written for, because both stubs
// are real files. Only running one tells you whether it is a shell.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

// Git for Windows ships two: `Git\bin\bash.exe` (the wrapper the Start Menu uses)
// and `Git\usr\bin\bash.exe` (the MSYS2 binary). Either works for `bash script.sh`.
// Ordered most- to least-conventional install location.
export function windowsCandidates() {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
  ].filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, "Git", "bin", "bash.exe"));
    candidates.push(path.join(root, "Git", "usr", "bin", "bash.exe"));
  }

  // Whatever is on PATH, minus the two known impostors. `where` prints every
  // match, so a Git Bash sitting behind them is still found here — this is what
  // covers a non-default install location.
  try {
    const found = spawnSync("where", ["bash"], { encoding: "utf8" });
    for (const line of (found.stdout || "").split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) continue;
      const lower = entry.toLowerCase();
      if (lower.includes("\\windowsapps\\")) continue;
      if (lower.includes("\\system32\\")) continue;
      candidates.push(entry);
    }
  } catch {
    // `where` missing is not fatal; the conventional paths above still apply.
  }

  return [...new Set(candidates)];
}

// The whole point of this file. `bash -c "echo …"` either prints the sentinel or
// this is not a bash.
export function isWorkingBash(candidate) {
  try {
    const probe = spawnSync(candidate, ["-c", "echo passcontrol_bash_ok"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return probe.status === 0 && (probe.stdout || "").includes("passcontrol_bash_ok");
  } catch {
    return false;
  }
}

export function resolveBash() {
  if (!isWindows) return "bash";
  for (const candidate of windowsCandidates()) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    if (isWorkingBash(candidate)) return candidate;
  }
  return null;
}

const NO_BASH = [
  "✗ No working bash found.",
  "",
  "  The local PassControl stack is driven by bash scripts. On Windows they need",
  "  Git Bash — `bash` on PATH is normally the Windows Store alias or the WSL",
  "  launcher, and neither is a shell you can run these with.",
  "",
  "  Fix: install Git for Windows from https://git-scm.com/download/win",
  "  (the default options are fine), then re-run this command in a NEW terminal.",
  "",
  "  Already installed? Point at it directly:",
  "      set PASSCONTROL_BASH=C:\\Program Files\\Git\\bin\\bash.exe",
].join("\n");

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node scripts/run-bash.mjs <script.sh> [args…]");
    process.exit(2);
  }

  // An explicit override beats every probe — for an unusual install, or a
  // Windows bash we have not thought of. Still verified, so a wrong path says
  // so here instead of failing inside the script.
  const override = process.env.PASSCONTROL_BASH;
  let bash;
  if (override) {
    if (!isWorkingBash(override)) {
      console.error(`✗ PASSCONTROL_BASH is set to ${override}, which did not run as a shell.`);
      process.exit(1);
    }
    bash = override;
  } else {
    bash = resolveBash();
  }

  if (!bash) {
    console.error(NO_BASH);
    process.exit(1);
  }

  const child = spawn(bash, args, { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`✗ Could not run ${bash}: ${error.message}`);
    process.exit(1);
  });
  // Forward the child's fate rather than flattening it to 0/1: dev-stack.sh's
  // exit codes are the difference between "Docker is down" and "the migration
  // ledger was never vetted", and callers branch on them.
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

// Importable for tests without running anything. Compare resolved paths rather
// than matching on the filename: a substring check would also fire under a test
// runner whose own argv happened to end the same way.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
