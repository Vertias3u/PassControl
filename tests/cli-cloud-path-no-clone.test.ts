import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Cloud path must never fetch a repository.
//
// `npm i -g passcontrol` cannot clone — scripts/build-cli-package.mjs copies an
// explicit CARRIED_FIELDS allowlist into the published manifest and `scripts` is
// not on it, so there is no install hook. But the CLI itself contains a
// `git clone`, and the invariant that keeps it away from Cloud users is only
// "no one wired it up that way". That held because someone read the code once.
//
// It nearly did not: `start` — which clones unconditionally — sat second in the
// Quick start block, above every Cloud command. A new user's second instruction
// was to fetch the self-host stack.
//
// So this pins the two things that make the Cloud path clone-free: which
// functions may clone, and what the help text puts in front of a new user.

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const rawSource = fs.readFileSync(CLI, "utf8");

/**
 * The CLI with comments removed.
 *
 * `cloningCallers` below is a textual scan, and the prose in bin/passcontrol.mjs
 * legitimately WRITES `ensureAppRoot({ clone: true })` — that is how `openUrl`
 * explains why it exists apart from `openDashboard`. Scanning the raw file made
 * that sentence look like a call and reported `openDashboard` as a cloning
 * caller, which is a false alarm on the one guard that must stay believable.
 *
 * Forbidding the words instead would have deleted the explanation that keeps the
 * mistake from coming back. So: strip, then scan.
 */
const source = rawSource.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

/** The only two commands whose job is to bring up a self-hosted stack. */
const MAY_CLONE = ["startDashboard", "setupLocal"];

/**
 * Every `ensureAppRoot(...)` call that passes `clone: true`, labelled with the
 * function that contains it — found by scanning back to the nearest preceding
 * function declaration. Deliberately textual: bin/passcontrol.mjs is an
 * executable entry point, and the sibling doc guards read it the same way.
 */
function cloningCallers(): string[] {
  const callers: string[] = [];
  for (const match of source.matchAll(/ensureAppRoot\(\{([^}]*)\}/gu)) {
    if (!/\bclone:\s*true\b/u.test(match[1] ?? "")) continue;
    const before = source.slice(0, match.index);
    const declarations = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gu)];
    const enclosing = declarations.at(-1)?.[1];
    callers.push(enclosing ?? "<top level>");
  }
  return [...new Set(callers)].sort();
}

describe("only the self-host commands can clone", () => {
  it("finds the clone sites at all", () => {
    // Non-vacuity: if ensureAppRoot is renamed or its options reshaped, this
    // fails loudly rather than silently asserting over an empty set.
    expect(cloningCallers().length).toBeGreaterThan(0);
  });

  it("is exactly startDashboard and setupLocal", () => {
    expect(cloningCallers()).toEqual([...MAY_CLONE].sort());
  });
});

describe("the help text does not lead with self-hosting", () => {
  const quickStart = /heading\("Quick start"\)\}\n([\s\S]*?)\n\n/u.exec(rawSource)?.[1] ?? "";

  it("parses the Quick start block", () => {
    expect(quickStart).not.toEqual("");
  });

  it("names no command that clones", () => {
    // `start` was here. The commands that reach a `git clone` belong under the
    // self-host heading, where their cost is stated, and nowhere above it.
    const named = [...quickStart.matchAll(/^\s*\$\{cmd\}\s+([a-z][a-z-]*)/gmu)].map(([, name]) => name);
    expect(named).not.toContain("start");
    expect(named).not.toContain("setup");
    expect(named).not.toContain("reset");
  });

  it("offers the passport transports that need no local stack", () => {
    const named = [...quickStart.matchAll(/^\s*\$\{cmd\}\s+([a-z][a-z-]*)/gmu)].map(([, name]) => name);
    expect(named).toContain("sidecar");
    expect(named).toContain("mcp");
  });

  it("states the cost of self-hosting where it is offered", () => {
    const selfHost = /heading\("Self-host[^"]*"\)\}\n([\s\S]*?)\n\n/u.exec(rawSource)?.[1] ?? "";
    expect(selfHost).not.toEqual("");
    expect(selfHost).toMatch(/clone/iu);
    expect(selfHost).toMatch(/Docker/u);
  });
});

// The static guards above say no Cloud command *calls* a cloning function. These
// run the commands for real against a fake `git` and assert it is never invoked.
//
// Be clear about what this pair does and does not prove, because it is weaker
// than it looks. Injecting `ensureAppRoot({ clone: true, yes: true })` as the
// first line of `sidecarCommand` does NOT turn these red: the command refuses on
// the missing passport (cli/config.mjs:276) before reaching it, and `init`
// refuses without a TTY. That early refusal is a real property worth having, but
// it means these cases cannot be driven into a clone even when one is added.
//
// So the call-site allowlist above is the load-bearing guard — it is the one
// that goes red under that mutation. What these two add is coverage an allowlist
// structurally cannot give: an *incidental* git invocation, from a helper or a
// dependency, on the two commands a Cloud user actually runs.
describe("the Cloud commands never invoke git", () => {
  let home = "";
  let shimDir = "";
  let marker = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-shim-"));
    marker = path.join(shimDir, "git-was-called");
    const shim = path.join(shimDir, "git");
    // Records the call and fails, so a clone attempt shows up as both a marker
    // file and a broken command rather than a real network fetch.
    fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`);
    fs.chmodSync(shim, 0o755);
  });

  afterAll(() => {
    for (const dir of [home, shimDir]) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<void> {
    await execFileAsync(process.execPath, [CLI, ...args], {
      // Not this repo: `ensureAppRoot` resolves a *surrounding* checkout before it
      // clones, and the working tree is one — running here would make the guard
      // pass because an app was found, not because none was fetched.
      cwd: home,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        // The shim first, so any `git` the CLI reaches for is ours.
        PATH: [shimDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: home,
      },
      timeout: 60_000,
    }).catch(() => undefined); // Both commands are expected to refuse; only the marker matters.
  }

  it("init does not", async () => {
    // Refuses without a TTY, which is itself the point: the refusal comes before
    // anything is fetched.
    await runCli(["init", "--global", "--yes"]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("sidecar does not", async () => {
    // No gateway and no passport in this HOME, so it fails validation — and it
    // fails there rather than trying to fetch an app checkout first.
    await runCli(["sidecar", "--yes"]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
